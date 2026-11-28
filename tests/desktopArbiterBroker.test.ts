// The production input arbiter is a cross-process broker (src/desktop/arbiter.ts: a named-pipe server, one reader
// thread, one lease at a time). These tests exercise that broker over its real wire protocol, with real processes and
// no desktop: no helper, no PowerShell, no mouse or keyboard.
//
// What is production and what is a fixture:
//   · createArbiter() and its BrokerGate are the production client — every test below goes through them;
//   · the holder fixture runs the production arbiter in a *separate process*, which is the only way to lose a socket
//     while the lease is still held;
//   · the server fixture does not describe the broker at all: it reads the BROKER_SOURCE literal out of
//     src/desktop/arbiter.ts, evaluates that literal and runs it, so grant/finish/drop/handle are the shipped code. It
//     only tees each socket's bytes, reports the protocol lines it saw, and prints the sha1 of the source it ran —
//     Bench.start() compares that against its own reading of the same literal, so a copy of the broker cannot pass.
//
// Every test uses its own pipe name, so a developer's real arbiter (\\\\.\\pipe\\evolution-cu-arbiter-<user>) is never touched.
// The production client also tries to spawn a broker of its own (spawnBroker) the first time it connects; because the
// bench server already owns the pipe, that spawn finds the name taken and exits, so nothing outlives the test.
// Cleanup is owned as soon as a child exists (registered before the first await, so a broker that never reports
// listening still gets closed), and stop() closes every process before it reports the ones that outlived SIGKILL: an
// exit timeout is never treated as a clean exit, an 'error' is never treated as one either, and "still running" is read
// from the confirmed 'exit' state so a process that leaves late is not reported as a leak.
// NOTE: not executed yet — the sandbox has no working executor. `npm test` runs this file through node --test.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CancelledError, UncertainError, createArbiter, currentSignal, type Arbiter,
} from '../src/desktop/arbiter.ts';
import type { ActionDescriptor, ActionEvent, TrustedCallerContext } from '../src/tool.ts';

// The broker path, never the in-process gate: this file is about what two processes share.
delete process.env.EVOLUTION_CU_ARBITER;

const fixture = (name: string): string => fileURLToPath(new URL('./fixtures/' + name, import.meta.url));
// The holder fixture imports the production .ts source, so a child process needs the same loader flag this test ran with.
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

let pipes = 0;
function uniquePipe(): string {
  pipes += 1;
  return '\\\\.\\pipe\\evolution-cu-arbiter-test-' + process.pid + '-' + pipes;
}

/** The exact file the broker derives from a pipe: sha1 of the full pipe name, under the per-user state directory. */
function markerFor(pipe: string): string {
  return join(homedir(), '.evolution-computer-use', 'arbiter',
    'evolution-cu-arbiter-lease-' + createHash('sha1').update(pipe).digest('hex') + '.marker');
}

/**
 * Plant the fence a crashed predecessor would leave behind, at the exact path the broker derives, so the next acquire is
 * refused by the production takeMarker() rather than by something the test decides.
 */
function plantMarker(marker: string): string {
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ pipe: 'planted-by-test', id: 'lease:planted-by-test', pid: process.pid, at: Date.now() }));
  return marker;
}

async function waitFor(check: () => boolean, budgetMs: number, message: string): Promise<void> {
  const end = Date.now() + budgetMs;
  while (Date.now() < end) { if (check()) return; await delay(20); }
  assert.equal(check(), true, message);
}

/** The literal the runtime spawns, read from the source the same way the fixture reads it. */
function productionBroker(): { lines: number; sha1: string } {
  const text = readFileSync(new URL('../src/desktop/arbiter.ts', import.meta.url), 'utf8');
  const opening = 'const BROKER_SOURCE = [';
  const closing = "].join('\\n');";
  const start = text.indexOf(opening);
  assert.ok(start >= 0, 'BROKER_SOURCE is not where this test looks for it');
  let end = text.indexOf(closing, start);
  if (end < 0) {
    // Same tolerance the fixture has for a reformat of the join() call, so both read the same literal.
    const close = /\n\]/.exec(text.slice(start));
    assert.ok(close, 'BROKER_SOURCE has no closing bracket this test can find');
    end = start + close.index + 1;
  }
  assert.ok(end > start, 'BROKER_SOURCE is not where this test looks for it');
  const parts: unknown = new Function('return ' + text.slice(start + opening.length - 1, end + 1))();
  assert.ok(Array.isArray(parts) && parts.every(one => typeof one === 'string'), 'BROKER_SOURCE is not a string array');
  const source = (parts as string[]).join('\n');
  return { lines: source.split('\n').length, sha1: createHash('sha1').update(source).digest('hex') };
}

const move: ActionDescriptor = { kind: 'move' };
const caller = (callId: string): TrustedCallerContext => ({
  identity: 'trusted', agentId: 'agent-a', rootAgentId: 'agent-root', depth: 0, lifetime: 1, sessionId: 's1', callId,
});

/** One JSON object per line on a child's stdout, with a bounded wait so a stuck broker fails instead of hanging. */
class Tail {
  readonly events: Record<string, unknown>[] = [];
  private buffer = '';
  private stderr = '';
  private cursor = 0;
  private readonly waiting: { match: (event: Record<string, unknown>) => boolean; resolve: (event: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }[] = [];
  /** Set only by the real 'exit' event: nothing else proves the process is gone. */
  exited = false;
  /** A spawn that never produced a pid leaves no process to wait for; every other error is only an error. */
  private neverStarted = false;
  /** The last error this child reported, so a failed kill is visible in the leak report instead of vanishing. */
  private failure: string | undefined;
  private readonly hadPid: boolean;

  readonly child: ChildProcess;
  readonly label: string;

  constructor(child: ChildProcess, label: string) {
    this.child = child;
    this.label = label;
    this.hadPid = typeof child.pid === 'number';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.feed(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { this.stderr += chunk; });
    child.on('exit', () => { this.exited = true; });
    child.on('error', (error: Error) => {
      // A failed kill, or a write to an already closed pipe, reports here too: an error is evidence of a problem, never
      // evidence of an exit. Only a child that never had a pid has nothing left to exit.
      this.failure = String(error && error.message ? error.message : error);
      if (!this.hadPid) this.neverStarted = true;
    });
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      this.events.push(message);
      for (const entry of [...this.waiting]) {
        if (!entry.match(message)) continue;
        this.waiting.splice(this.waiting.indexOf(entry), 1);
        clearTimeout(entry.timer);
        // Everything up to this event is consumed for good: a later wait must not see it again.
        this.cursor = this.events.length;
        entry.resolve(message);
      }
    }
  }

  /** Wait for the next event (after the last one returned) that matches, or fail with what was seen instead. */
  next(match: (event: Record<string, unknown>) => boolean, timeoutMs = 8000): Promise<Record<string, unknown>> {
    for (; this.cursor < this.events.length; this.cursor += 1) {
      const event = this.events[this.cursor];
      if (!match(event)) continue;
      this.cursor += 1;
      return Promise.resolve(event);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiting.findIndex(entry => entry.timer === timer);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(new Error(this.label + ' never reported what the test waited for.\nseen: ' + JSON.stringify(this.events) +
          (this.stderr ? '\nstderr: ' + this.stderr : '')));
      }, timeoutMs);
      this.waiting.push({ match, resolve, reject, timer });
    });
  }

  send(text: string): void {
    this.child.stdin?.write(text + '\n');
  }

  /** Read from the confirmed exit state, so a process that exits after a timeout stops being reported as a leak. */
  get stillRunning(): boolean {
    return !this.exited && !this.neverStarted;
  }

  /** What this child last reported as an error, if anything; never used as proof that it exited. */
  get lastError(): string | undefined {
    return this.failure;
  }

  /** Close the socket and let the process leave on its own; a process that will not leave is escalated, then reported. */
  async quit(): Promise<void> {
    if (!this.stillRunning) return;
    try { this.child.stdin?.end(); this.child.kill(); } catch { /* already gone */ }
    if (await this.done()) return;
    try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
    await this.done(1500);
  }

  /** Terminate now: the socket closes while whatever it holds is still held. */
  async kill(): Promise<void> {
    if (!this.stillRunning) return;
    try { this.child.kill(); } catch { /* already gone */ }
    if (await this.done()) return;
    try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
    await this.done(1500);
  }

  /** Wait for the real exit event and say whether it arrived; a timeout is never reported as an exit. */
  private async done(budgetMs = 3000): Promise<boolean> {
    if (this.exited || this.neverStarted) return true;
    const left = await new Promise<boolean>(resolve => {
      let timer: NodeJS.Timeout;
      const onExit = (): void => { clearTimeout(timer); resolve(true); };
      timer = setTimeout(() => { this.child.removeListener('exit', onExit); resolve(false); }, budgetMs);
      this.child.once('exit', onExit);
    });
    return left || this.exited || this.neverStarted;
  }
}

/** A hermetic broker: the production source, one fixture server per test, plus whatever clients that test needs. */
class Bench {
  readonly pipe = uniquePipe();
  private server: Tail | undefined;
  private readonly children: Tail[] = [];
  /** Every process this bench ever started, including a broker that crash() took off this.server: all must exit. */
  private readonly started: Tail[] = [];
  private readonly arbiters: Arbiter[] = [];
  private cleanupRegistered = false;

  async start(t: test.TestContext, env?: NodeJS.ProcessEnv, args: string[] = []): Promise<void> {
    // Owned before the first await: a broker that never reports listening, or a sha1 mismatch, still gets cleaned up.
    if (!this.cleanupRegistered) { t.after(() => this.stop()); this.cleanupRegistered = true; }
    await this.launch(env, args);
  }

  private async launch(env?: NodeJS.ProcessEnv, args: string[] = []): Promise<void> {
    const child = spawn(process.execPath, [...NODE_FLAGS, fixture('arbiter-broker-server.mjs'), this.pipe, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const server = new Tail(child, 'broker');
    this.started.push(server);
    this.server = server;
    const listening = await server.next(event => event.event === 'listening');
    const production = productionBroker();
    assert.equal(listening.sha1, production.sha1, 'the broker under test must be the runtime own BROKER_SOURCE, not a copy');
    assert.equal(listening.lines, production.lines);
  }

  /** Kill the current broker outright: its sockets close with whatever it held still held, and nothing cleans up. */
  async crash(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await server.kill();
    await delay(80);
  }

  /** Bring a fresh broker up on the same pipe, as a restart after a crash would. */
  async restart(env?: NodeJS.ProcessEnv): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await server.quit();
    await delay(80);
    await this.launch(env);
  }

  /** A second broker on the same pipe, to prove it can never hand out a second grant while the marker stands. */
  async secondServer(): Promise<Tail> {
    const child = spawn(process.execPath, [...NODE_FLAGS, fixture('arbiter-broker-server.mjs'), this.pipe], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const tail = new Tail(child, 'broker-2');
    this.started.push(tail);
    this.children.push(tail);
    return tail;
  }

  /** The exact lease marker this bench's pipe derives. */
  markerPath(): string { return markerFor(this.pipe); }

  get broker(): Tail {
    assert.ok(this.server, 'the bench has not started');
    return this.server;
  }

  /** A protocol-only client: it can acquire, wait, cancel, and be killed without touching the arbiter at all. */
  async client(id: string): Promise<Tail> {
    const child = spawn(process.execPath, [...NODE_FLAGS, fixture('arbiter-broker-client.mjs'), this.pipe, id], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const tail = new Tail(child, 'client ' + id);
    this.started.push(tail);
    this.children.push(tail);
    await tail.next(event => event.event === 'connected');
    return tail;
  }

  /** The production arbiter in its own process, so the test can take its socket away mid-lease. */
  async holder(): Promise<Tail> {
    const child = spawn(process.execPath, [...NODE_FLAGS, fixture('arbiter-broker-holder.mjs'), this.pipe], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const tail = new Tail(child, 'holder');
    this.started.push(tail);
    this.children.push(tail);
    return tail;
  }

  arbiter(events: ActionEvent[] = []): Arbiter {
    process.env.EVOLUTION_CU_BROKER_PIPE = this.pipe;
    const mine = createArbiter({ sink: event => events.push(event) });
    this.arbiters.push(mine);
    return mine;
  }

  /**
   * Clean every process this bench started, then report what refused to leave: one stuck child never hides the rest.
   * The lease marker is removed only after every process has a confirmed exit and every arbiter socket is closed:
   * deleting it while a process may still hold the lease would let the next broker grant the same slot.
   */
  async stop(): Promise<void> {
    const problems: string[] = [];
    let clientsClosed = true;
    // dispose() is what closes an arbiter socket without abandoning a lease: a live socket would keep this test process alive.
    for (const one of this.arbiters) {
      try { one.dispose(); } catch (error) {
        clientsClosed = false;
        problems.push('an arbiter socket could not be closed: ' + String(error));
      }
    }
    // Every process this bench ever started is here, including a broker that crash() removed from this.server.
    for (const child of [...this.started].reverse()) {
      try { await child.quit(); } catch (error) { problems.push(child.label + ' could not be closed: ' + String(error)); }
      if (child.stillRunning) problems.push(child.label + ' never exited after kill');
      // Only while there is no confirmed exit: an error from a process that did leave (a write to its closed pipe) is
      // not a leak, and reporting it would fail the test for nothing.
      if (!child.exited && child.lastError) problems.push(child.label + ' reported ' + child.lastError);
    }
    const allGone = clientsClosed && this.started.every(child => child.exited);
    if (allGone) {
      // Remove only this bench's exact marker: a leftover would fence the next run on the same pipe.
      try { rmSync(markerFor(this.pipe), { force: true, recursive: true }); } catch { /* best effort: the exact file only */ }
    } else {
      problems.push('the lease marker was kept because a process this bench started, or a client socket it opened, has no confirmed exit');
    }
    delete process.env.EVOLUTION_CU_BROKER_PIPE;
    assert.deepEqual(problems, [], 'every child this bench started has to be gone before the test ends, and its marker may only be removed after that');
  }
}

test('the broker grants one lease at a time across processes', { timeout: 30_000 }, async t => {
  const bench = new Bench();
  await bench.start(t);
  const holder = await bench.holder();
  await holder.next(event => event.event === 'held');
  const first = await bench.broker.next(event => event.event === 'out' && event.op === 'granted');
  const holderSock = first.sock;

  const order: string[] = [];
  const mine = bench.arbiter();
  const action = mine.withCall(caller('call-second'), undefined, () => mine.runAction(move, async () => {
    order.push('second-start');
    await delay(10);
    order.push('second-end');
  }));

  await delay(200);
  assert.deepEqual(order, [], 'the second action must not start while another process holds the lease');
  await bench.broker.next(event => event.event === 'in' && event.op === 'acquire' && event.sock !== holderSock);
  assert.deepEqual(order, [], 'the second process asked for the lease and is still waiting for it');

  holder.send('release');
  await action;
  assert.deepEqual(order, ['second-start', 'second-end'], 'the second action runs once, after the holder released');
  await bench.broker.next(event => event.event === 'in' && event.op === 'release' && event.sock !== holderSock);

  const events = bench.broker.events;
  const granted = events.filter(event => event.event === 'out' && event.op === 'granted');
  const released = events.filter(event => event.event === 'in' && event.op === 'release');
  assert.equal(granted.length, 2, 'exactly two grants: the holder and then this process');
  assert.notEqual(granted[0].sock, granted[1].sock, 'the two grants went to two different processes');
  assert.equal(released.length, 2, 'each holder hands the slot back explicitly');
  assert.ok(events.indexOf(released[0]) < events.indexOf(granted[1]), 'the second grant follows the first hand-back');
});

test('cancelling a waiter leaves the running lease alone', { timeout: 30_000 }, async t => {
  const bench = new Bench();
  await bench.start(t);
  const order: string[] = [];
  let release: (() => void) | undefined;
  const mine = bench.arbiter();
  const running = mine.withCall(caller('call-a'), undefined, () => mine.runAction({ kind: 'drag' }, async () => {
    order.push('a-start');
    await new Promise<void>(resolve => { release = resolve; });
    order.push('a-end');
  }));
  const granted = await bench.broker.next(event => event.event === 'out' && event.op === 'granted');
  const mineSock = granted.sock;

  const waiter = await bench.client('waiter-1');
  waiter.send('acquire');
  await bench.broker.next(event => event.event === 'in' && event.op === 'acquire' && event.id === 'waiter-1');
  waiter.send('cancel');
  await bench.broker.next(event => event.event === 'in' && event.op === 'cancel' && event.id === 'waiter-1');
  await delay(100);

  const events = bench.broker.events;
  assert.equal(events.some(event => event.event === 'in' && event.op === 'release'), false,
    'a cancelled waiter must not hand the slot back');
  assert.equal(events.some(event => event.event === 'out' && event.op === 'granted' && event.id === 'waiter-1'), false,
    'a cancelled waiter is never granted');
  assert.equal(events.some(event => event.event === 'out' && event.op === 'granted' && event.sock !== mineSock), false,
    'nobody else got the slot while the first holder still had it');
  assert.deepEqual(order, ['a-start'], 'the running action was not disturbed');

  release!();
  await running;
  assert.deepEqual(order, ['a-start', 'a-end']);
});

test('a holder that disappears keeps the lease closed instead of granting the next one', { timeout: 30_000 }, async t => {
  const bench = new Bench();
  await bench.start(t);
  const holder = await bench.holder();
  await holder.next(event => event.event === 'held');
  const first = await bench.broker.next(event => event.event === 'out' && event.op === 'granted');

  let ran = false;
  const mine = bench.arbiter();
  const queued = mine.withCall(caller('call-b'), undefined, () => mine.runAction({ kind: 'click' }, async () => {
    ran = true;
  }));
  const settled = queued.then(() => 'ran', (error: Error) => error);
  await bench.broker.next(event => event.event === 'in' && event.op === 'acquire' && event.sock !== first.sock);

  await holder.kill();
  const error = await settled;
  assert.ok(error instanceof UncertainError, 'a lease whose holder vanished is unknown, not failed and not granted');
  assert.match((error as Error).message, /结果不明/);
  assert.equal(ran, false, 'the queued action never got to run');
  assert.match(mine.poisonedReason() ?? '', /断开了/, 'this process knows the lease state is unknown');

  const events = bench.broker.events;
  assert.ok(events.some(event => event.event === 'out' && event.op === 'lost'), 'the broker tells every waiter the slot is closed');
  assert.equal(events.filter(event => event.event === 'out' && event.op === 'granted').length, 1,
    'the vanished holder was never replaced');

  const late = await bench.client('late-1');
  late.send('acquire');
  await late.next(event => event.event === 'lost');
  await delay(100);
  assert.equal(events.some(event => event.event === 'out' && event.op === 'granted' && event.id === 'late-1'), false,
    'a new process is refused while the orphaned holder may still be injecting');
});

test('reset hands the lease back with abandon so the next process can go', { timeout: 30_000 }, async t => {
  const bench = new Bench();
  await bench.start(t);
  const waiter = await bench.client('after-reset');

  const mine = bench.arbiter();
  let entered: () => void = () => undefined;
  let finish: () => void = () => undefined;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const held = mine.withGlobalLease(async () => {
    entered();
    await new Promise<void>(resolve => { finish = resolve; });
  });
  await arrived;
  const mineSock = (await bench.broker.next(event => event.event === 'out' && event.op === 'granted')).sock;

  waiter.send('acquire');
  await bench.broker.next(event => event.event === 'in' && event.op === 'acquire' && event.id === 'after-reset');

  mine.reset();
  const abandon = await bench.broker.next(event => event.event === 'in' && event.op === 'abandon');
  const handed = await bench.broker.next(event => event.event === 'out' && event.op === 'granted' && event.sock !== mineSock);
  assert.ok(bench.broker.events.indexOf(abandon) < bench.broker.events.indexOf(handed),
    'the abandoned lease is handed back only after the explicit abandon');
  await waiter.next(event => event.event === 'granted');

  finish!();
  await held;
});

test('a stop reaches a lease taken without an action, and the lease is not handed over early', { timeout: 30_000 }, async t => {
  const bench = new Bench();
  await bench.start(t);
  const mine = bench.arbiter();

  let seen: AbortSignal | undefined;
  let finish: () => void = () => undefined;
  const running = mine.withGlobalLease(async () => {
    seen = currentSignal();
    await new Promise<void>(resolve => { finish = resolve; });
    return 'done';
  });
  const first = await bench.broker.next(event => event.event === 'out' && event.op === 'granted');
  const firstSock = first.sock;

  let secondRan = false;
  const queued = mine.withGlobalLease(async () => { secondRan = true; });
  const settled = queued.then(() => 'ran', (error: Error) => error);
  await bench.broker.next(event => event.event === 'in' && event.op === 'acquire' && event.id !== first.id);

  assert.equal(mine.cancelCurrent(), true, 'a stop reaches the lease that has no action around it');
  assert.equal(seen?.aborted, true, 'the helper sees its cancel flag: the signal the lease handed out is aborted');
  const error = await settled;
  assert.ok(error instanceof CancelledError, 'the waiter that never started is cancelled, not failed');
  assert.equal(secondRan, false);
  assert.equal(bench.broker.events.some(event => event.event === 'in' && event.op === 'release'), false,
    'the lease is not handed back before the stopped step has finished');

  finish!();
  assert.equal(await running, 'done');
  await bench.broker.next(event => event.event === 'in' && event.op === 'release' && event.sock === firstSock);
});

test('an arbiter that exits while it holds the lease keeps the slot closed and abandons nothing', { timeout: 30_000 }, async t => {
  const bench = new Bench();
  await bench.start(t);
  const events: ActionEvent[] = [];
  const mine = bench.arbiter(events);

  let release!: () => void;
  const running = mine.withCall(caller('call-a'), undefined, () => mine.runAction(move, () => new Promise<void>(resolve => { release = resolve; })));
  const granted = await bench.broker.next(event => event.event === 'out' && event.op === 'granted');

  // Somebody else wants the machine-wide input while this process holds it, and this process then goes away mid-lease.
  const next = await bench.client('next-1');
  next.send('acquire');
  await bench.broker.next(event => event.event === 'in' && event.op === 'acquire' && event.sock !== granted.sock);

  mine.dispose();
  const lost = await next.next(event => event.event === 'lost');
  assert.equal(lost.event, 'lost', 'the waiter is told the slot is closed rather than handed to it');

  const broker = bench.broker.events;
  assert.equal(broker.some(event => event.event === 'in' && event.op === 'abandon'), false,
    'shutting down must not abandon the lease: that would hand the slot to the next waiter');
  assert.equal(broker.filter(event => event.event === 'out' && event.op === 'granted').length, 1,
    'the lease that disappeared was never replaced');
  const spoken = broker.filter(event => event.event === 'in').length;

  release();
  await running;
  assert.ok(events.some(event => event.phase === 'succeeded'), 'the step that was interrupted still reports its own end');
  assert.equal(events.some(event => event.phase === 'uncertain'), false, 'nothing was called unknown by this exit alone');
  // The step settles after the exit: it must not talk to a gate this instance no longer has, which would spawn a broker.
  assert.equal(broker.filter(event => event.event === 'in').length, spoken,
    'a late settlement neither releases nor acquires anything');
});

test('an arbiter that exits with nothing held closes its connection and leaves the slot usable', { timeout: 30_000 }, async t => {
  const bench = new Bench();
  await bench.start(t);
  const mine = bench.arbiter();

  await mine.runAction(move, async () => { /* one clean step, released as it finishes */ });
  mine.dispose();
  mine.dispose();
  assert.equal(bench.broker.events.some(event => event.event === 'in' && event.op === 'abandon'), false,
    'an idle exit has nothing to abandon');

  const after = await bench.client('after-1');
  after.send('acquire');
  const granted = await after.next(event => event.event === 'granted');
  assert.equal(granted.event, 'granted', 'a closed connection does not leave a lease behind');
});

// ---- persistent lease marker: the fence that outlives the broker process ---------------------------------------------

test('a grant writes the lease marker and a clean release removes it before the next holder', { timeout: 30_000 }, async t => {
  const bench = new Bench();
  await bench.start(t);
  const marker = bench.markerPath();

  const first = await bench.client('first');
  first.send('acquire');
  const granted = await first.next(event => event.event === 'granted');
  assert.equal(granted.event, 'granted');
  assert.ok(existsSync(marker), 'granting creates the lease marker');

  const second = await bench.client('second');
  second.send('acquire');
  await bench.broker.next(event => event.event === 'in' && event.op === 'acquire' && event.id === 'second');
  first.send('release');
  const handoff = await second.next(event => event.event === 'granted' || event.event === 'lost');
  assert.equal(handoff.event, 'granted', 'a clean release hands the slot to the next waiter');
  assert.ok(existsSync(marker), 'the hand-off writes the marker for its new holder');

  second.send('release');
  await bench.broker.next(event => event.event === 'in' && event.op === 'release' && event.id === 'second');
  await waitFor(() => !existsSync(marker), 2000, 'the marker is gone once the last lease is released');
});

test('a trusted client that withdraws a granted token before its work runs hands the slot back and clears the marker', { timeout: 30_000 }, async t => {
  const bench = new Bench();
  await bench.start(t);
  const marker = bench.markerPath();

  const first = await bench.client('first');
  first.send('acquire');
  await first.next(event => event.event === 'granted');
  assert.ok(existsSync(marker));

  const second = await bench.client('second');
  second.send('acquire');
  await bench.broker.next(event => event.event === 'in' && event.op === 'acquire' && event.id === 'second');

  // This is the race BrokerGate.acquire documents: the grant crossed an abort, so the token never started work and the
  // client withdraws it with cancel. That is a real hand-back and must clear the marker, exactly like release.
  first.send('cancel');
  await bench.broker.next(event => event.event === 'in' && event.op === 'cancel' && event.id === 'first');
  const handoff = await second.next(event => event.event === 'granted' || event.event === 'lost');
  assert.equal(handoff.event, 'granted', 'a withdrawn (never-started) grant hands the slot to the next waiter');
  assert.ok(existsSync(marker), 'the hand-off writes the marker for the new holder');

  second.send('release');
  await waitFor(() => !existsSync(marker), 2000, 'the marker clears on the final release');
});

for (const [label, content] of [['an empty', ''], ['a junk-filled', 'not-a-lease']] as const) {
  test('a pre-existing ' + label + ' marker keeps the pipe closed', { timeout: 30_000 }, async t => {
    const bench = new Bench();
    await bench.start(t);
    const marker = bench.markerPath();
    writeFileSync(marker, content);
    try {
      const blocked = await bench.client('blocked');
      blocked.send('acquire');
      const answer = await blocked.next(event => event.event === 'granted' || event.event === 'lost');
      assert.equal(answer.event, 'lost', 'an existing marker is a fence, whatever it holds');
      assert.ok(existsSync(marker), 'the refused acquire leaves the old marker untouched');
      assert.equal(bench.broker.events.filter(event => event.event === 'out' && event.op === 'granted').length, 0,
        'nothing is granted while a marker stands');
    } finally {
      rmSync(marker, { force: true });
    }
  });
}

test('a marker left by a killed broker keeps a restarted broker from granting', { timeout: 30_000 }, async t => {
  const bench = new Bench();
  await bench.start(t);
  const marker = bench.markerPath();

  const holder = await bench.client('gen1');
  holder.send('acquire');
  await holder.next(event => event.event === 'granted');
  assert.ok(existsSync(marker), 'the generation that was killed wrote its marker before it died');

  await bench.crash();
  await holder.next(event => event.event === 'closed');
  assert.ok(existsSync(marker), 'a crash leaves the marker in place');

  await bench.restart();
  assert.equal(bench.broker.events.filter(event => event.event === 'out' && event.op === 'granted').length, 0,
    'the fresh generation has granted nothing yet');

  const next = await bench.client('gen2');
  next.send('acquire');
  const answer = await next.next(event => event.event === 'granted' || event.event === 'lost');
  assert.equal(answer.event, 'lost', 'the restarted broker refuses while the old marker exists');
  assert.equal(bench.broker.events.filter(event => event.event === 'out' && event.op === 'granted').length, 0,
    'the new generation never granted');
  assert.ok(existsSync(marker), 'the marker is never cleared by a pid check or a timeout');
});

test('a marker that cannot be created never becomes a grant', { timeout: 30_000 }, async t => {
  // Give the broker a fake home whose ".evolution-computer-use" is a regular file, so the state directory cannot be made
  // and open(..., "wx") fails: a create failure must be a lost lease, not a grant.
  const fakeHome = join(tmpdir(), 'ecu-arbiter-home-' + process.pid + '-' + Date.now());
  mkdirSync(fakeHome, { recursive: true });
  writeFileSync(join(fakeHome, '.evolution-computer-use'), 'not a directory');
  t.after(() => { try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* already gone */ } });
  const bench = new Bench();
  await bench.start(t, { USERPROFILE: fakeHome, HOME: fakeHome });

  const blocked = await bench.client('blocked');
  blocked.send('acquire');
  const answer = await blocked.next(event => event.event === 'granted' || event.event === 'lost');
  assert.equal(answer.event, 'lost', 'a marker that cannot be written is a lost lease');
  assert.equal(bench.broker.events.filter(event => event.event === 'out' && event.op === 'granted').length, 0,
    'no grant without a marker');
});

test('a release whose marker cannot be removed fences the next waiter instead of handing it the slot', { timeout: 30_000 }, async t => {
  const bench = new Bench();
  await bench.start(t);
  const marker = bench.markerPath();

  const holder = await bench.client('holder');
  holder.send('acquire');
  await holder.next(event => event.event === 'granted');
  assert.ok(existsSync(marker));

  const waiter = await bench.client('waiter');
  waiter.send('acquire');
  await bench.broker.next(event => event.event === 'in' && event.op === 'acquire' && event.id === 'waiter');

  // Keep a copy of the real marker, then put a directory at its path so unlink cannot succeed (not ENOENT).
  const parked = marker + '.parked';
  renameSync(marker, parked);
  mkdirSync(marker);
  t.after(() => {
    try { rmSync(marker, { recursive: true, force: true }); } catch { /* already gone */ }
    try { rmSync(parked, { force: true }); } catch { /* already gone */ }
  });

  holder.send('release');
  const answer = await waiter.next(event => event.event === 'granted' || event.event === 'lost');
  assert.equal(answer.event, 'lost', 'a failed marker removal does not release the next waiter');
  assert.equal(bench.broker.events.filter(event => event.event === 'out' && event.op === 'granted').length, 1,
    'only the original grant exists');
});

test('a second broker on the same pipe can never hand out a second grant', { timeout: 30_000 }, async t => {
  const bench = new Bench();
  await bench.start(t);
  const marker = bench.markerPath();

  const holder = await bench.client('holder');
  holder.send('acquire');
  await holder.next(event => event.event === 'granted');
  assert.ok(existsSync(marker));

  // The second listener may refuse the pipe (EADDRINUSE) or accept it; either way the marker must keep it from granting.
  const second = await bench.secondServer();
  // Both servers are real and tracked: the second either bound the pipe or exited on EADDRINUSE. Neither outcome may ever
  // produce a second grant while the marker stands.
  await waitFor(() => second.exited || second.events.some(event => event.event === 'listening'), 5000,
    'the second broker is either listening or gone, and tracked either way');
  for (const id of ['intruder-1', 'intruder-2']) {
    const one = await bench.client(id);
    one.send('acquire');
  }
  await delay(600);

  const totalGranted = bench.broker.events.filter(event => event.event === 'out' && event.op === 'granted').length
    + second.events.filter(event => event.event === 'out' && event.op === 'granted').length;
  assert.equal(totalGranted, 1, "across both servers there is exactly one grant: the holder's");
  assert.equal(second.events.filter(event => event.event === 'out' && event.op === 'granted').length, 0,
    'the second broker never granted while the marker stands');
  assert.ok(existsSync(marker), 'the marker still stands under a second broker');
});

// ---- diagnosis detail: which side of the lease a step was on, and why it was refused --------------------------------
// Every refusal below is produced by the production BROKER_SOURCE (a planted marker, a vanished holder, a stripped
// reason), and the client's own classification is read off the error it raises. Nothing here changes
// grant/finish/drop/handle, and nothing is asserted from a message alone: each case also proves the work never ran.

test('a fenced broker names its reason, the step never runs, and two later refusals repeat it without stacking suffixes',
  { timeout: 30_000 }, async t => {
    const bench = new Bench();
    await bench.start(t);
    plantMarker(bench.markerPath());
    const wire = bench.broker.events;
    const mine = bench.arbiter();

    let ran = false;
    const refused: unknown = await mine.withCall(caller('call-refused-1'), undefined,
      () => mine.runAction(move, async () => { ran = true; })).then(() => undefined, (error: unknown) => error);
    assert.ok(refused instanceof UncertainError, 'a fenced broker is unknown, never failed and never granted');
    assert.equal(refused.message,
      '输入仲裁服务断开了，这一步的结果不明。（source=broker-lost; phase=waiting-grant; reason=marker-create-failed）');
    assert.deepEqual(refused.detail, { source: 'broker-lost', phase: 'waiting-grant', reason: 'marker-create-failed' });
    assert.equal(ran, false, 'the acquire was refused, so the work behind it never ran');
    const lost = wire.filter(event => event.event === 'out' && event.op === 'lost');
    assert.equal(lost.length, 1, 'the broker refused the one acquire it saw');
    assert.equal(lost[0].reason, 'marker-create-failed', 'the reason comes from the production takeMarker failure');
    assert.equal(wire.filter(event => event.event === 'out' && event.op === 'granted').length, 0, 'nothing was granted');

    const refusal = async (id: string): Promise<unknown> => mine.withCall(caller(id), undefined,
      () => mine.runAction(move, async () => { ran = true; })).then(() => undefined, (error: unknown) => error);
    const second: unknown = await refusal('call-refused-2');
    const third: unknown = await refusal('call-refused-3');
    assert.ok(second instanceof UncertainError, 'the second call is refused without reaching the broker');
    assert.ok(third instanceof UncertainError, 'the third call is refused the same way');
    assert.equal(second.message, '输入仲裁服务断开了，这一步的结果不明。'
      + '（source=poison; phase=refused-before-start; origin=broker-lost/waiting-grant/marker-create-failed; reason=marker-create-failed）');
    assert.equal(third.message, second.message,
      'a refusal of a refusal repeats the first origin; the suffix is never stacked a second time');
    assert.deepEqual(second.detail, {
      source: 'poison', phase: 'refused-before-start',
      origin: { source: 'broker-lost', phase: 'waiting-grant', reason: 'marker-create-failed' },
      reason: 'marker-create-failed',
    });
    assert.deepEqual(third.detail, second.detail, 'the nested origin survives the next refusal instead of collapsing to poison');
    assert.equal(ran, false);
    assert.equal(wire.filter(event => event.event === 'in' && event.op === 'acquire').length, 1,
      'the poison refuses in this process: no further acquire reaches the broker');
  });

test('a holder that vanishes tells the queued step the orphan reason, and the orphaned slot stays closed',
  { timeout: 30_000 }, async t => {
    const bench = new Bench();
    await bench.start(t);
    const wire = bench.broker.events;
    const holder = await bench.holder();
    await holder.next(event => event.event === 'held');
    await bench.broker.next(event => event.event === 'out' && event.op === 'granted');

    let ran = false;
    const mine = bench.arbiter();
    const pending = mine.withCall(caller('call-orphan'), undefined,
      () => mine.runAction({ kind: 'click' }, async () => { ran = true; })).then(() => undefined, (error: unknown) => error);
    await bench.broker.next(event => event.event === 'in' && event.op === 'acquire');
    assert.equal(ran, false, 'the queue can not run while the holder lives');
    await holder.kill();

    const error = await pending;
    assert.ok(error instanceof UncertainError, 'a queue behind a vanished holder is unknown, not failed and not granted');
    assert.deepEqual(error.detail, { source: 'broker-lost', phase: 'waiting-grant', reason: 'orphan' });
    assert.equal(ran, false, 'the queued action never got to run');
    const lost = wire.filter(event => event.event === 'out' && event.op === 'lost');
    assert.equal(lost.length, 1);
    assert.equal(lost[0].reason, 'orphan', 'the broker says why it closed the slot');
    assert.equal(wire.filter(event => event.event === 'out' && event.op === 'granted').length, 1,
      'the vanished holder was never replaced');

    // A fresh instance has no poison of its own, so this proves the refusal is the broker's, not a cached error.
    const fresh = bench.arbiter();
    const again: unknown = await fresh.withCall(caller('call-orphan-2'), undefined,
      () => fresh.runAction(move, async () => { ran = true; })).then(() => undefined, (error: unknown) => error);
    assert.ok(again instanceof UncertainError);
    assert.deepEqual(again.detail, { source: 'broker-lost', phase: 'waiting-grant', reason: 'orphan' });
    assert.equal(ran, false);
  });

test('an older broker that sends no reason is still fail-closed and reports the reason as unknown',
  { timeout: 30_000 }, async t => {
    const bench = new Bench();
    await bench.start(t, undefined, ['--legacy-lost']);
    plantMarker(bench.markerPath());
    const wire = bench.broker.events;
    const mine = bench.arbiter();

    let ran = false;
    const refused: unknown = await mine.withCall(caller('call-legacy'), undefined,
      () => mine.runAction(move, async () => { ran = true; })).then(() => undefined, (error: unknown) => error);
    assert.ok(refused instanceof UncertainError);
    assert.deepEqual(refused.detail, { source: 'broker-lost', phase: 'waiting-grant', reason: 'unknown' });
    assert.equal(refused.message,
      '输入仲裁服务断开了，这一步的结果不明。（source=broker-lost; phase=waiting-grant; reason=unknown）');
    assert.equal(ran, false, 'a missing reason must never turn a refusal into a grant');
    const lost = wire.filter(event => event.event === 'out' && event.op === 'lost');
    assert.equal(lost.length, 1);
    assert.equal('reason' in lost[0], false, 'the older broker sent no reason at all');
    assert.equal(lost[0].downgraded, true, 'the fixture stripped exactly that field; every other byte is production');
    assert.equal(wire.filter(event => event.event === 'out' && event.op === 'granted').length, 0);
  });

test('a lease lost while it is held keeps the lease-held origin while a queued step is told it never started',
  { timeout: 30_000 }, async t => {
    const bench = new Bench();
    await bench.start(t);
    const wire = bench.broker.events;
    const mine = bench.arbiter();

    let releaseHeld: () => void = () => undefined;
    const heldWork = new Promise<void>(resolve => { releaseHeld = resolve; });
    let heldStarted = false;
    const held = mine.withCall(caller('call-held'), undefined,
      () => mine.runAction(move, async () => { heldStarted = true; await heldWork; })).then(() => undefined, (error: unknown) => error);
    await waitFor(() => heldStarted, 8000, 'the held step never started');
    assert.equal(wire.filter(event => event.event === 'out' && event.op === 'granted').length, 1);

    let queuedRan = false;
    const queued = mine.withCall(caller('call-queued'), undefined,
      () => mine.runAction(move, async () => { queuedRan = true; })).then(() => undefined, (error: unknown) => error);
    await waitFor(() => wire.filter(event => event.event === 'in' && event.op === 'acquire').length === 2,
      5000, 'the second step never asked for the lease');

    await bench.crash();

    const queuedError = await queued;
    assert.ok(queuedError instanceof UncertainError);
    assert.deepEqual(queuedError.detail, { source: 'broker-close', phase: 'waiting-grant' },
      'the queued step never held the lease, so its phase is waiting-grant');
    assert.equal(queuedRan, false, 'the queued step never ran');

    releaseHeld();
    assert.equal(await held, undefined, 'the step that held the lease finished its own work normally');

    const after: unknown = await mine.withCall(caller('call-after'), undefined,
      () => mine.runAction(move, async () => { queuedRan = true; })).then(() => undefined, (error: unknown) => error);
    assert.ok(after instanceof UncertainError);
    assert.equal(after.detail?.source, 'poison');
    assert.equal(after.detail?.phase, 'refused-before-start');
    assert.equal(after.detail?.origin?.source, 'broker-close');
    assert.equal(after.detail?.origin?.phase, 'lease-held',
      'the lost lease was held: the cached origin keeps lease-held instead of the later waiting-grant step');
    assert.equal(after.detail?.reason, undefined, 'a socket close carries no reason');
    assert.match(after.message, /（source=poison; phase=refused-before-start; origin=broker-close\/lease-held; reason=未提供）$/);
    assert.equal(queuedRan, false);
  });

test('a step that becomes unknown while holding the lease is cached as step/lease-held, not as a refusal to start',
  { timeout: 30_000 }, async t => {
    const bench = new Bench();
    await bench.start(t);
    const mine = bench.arbiter();

    let ran = false;
    const error: unknown = await mine.withCall(caller('call-step'), undefined,
      () => mine.runAction(move, async () => { ran = true; throw new UncertainError(); }))
      .then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof UncertainError);
    assert.equal(error.message, '这一步的结果不明。', 'the step reports its own message without a diagnosis suffix');
    assert.equal(error.detail, undefined, 'the arbiter does not rewrite the error it rethrows');
    assert.equal(ran, true, 'the work really ran before it became unknown');

    let secondRan = false;
    const next: unknown = await mine.withCall(caller('call-step-2'), undefined,
      () => mine.runAction(move, async () => { secondRan = true; })).then(() => undefined, (caught: unknown) => caught);
    assert.ok(next instanceof UncertainError);
    assert.equal(next.detail?.source, 'poison');
    assert.equal(next.detail?.origin?.source, 'step');
    assert.equal(next.detail?.origin?.phase, 'lease-held', 'the unknown outcome happened with the lease in hand');
    assert.match(next.message, /（source=poison; phase=refused-before-start; origin=step\/lease-held; reason=未提供）$/);
    assert.equal(secondRan, false, 'the poisoned arbiter refuses before it starts anything');
  });

test('an arbiter disposed while holding the lease orphans the slot instead of handing it to the queued step',
  { timeout: 30_000 }, async t => {
    const bench = new Bench();
    await bench.start(t);
    const wire = bench.broker.events;
    const mine = bench.arbiter();

    let releaseHeld: () => void = () => undefined;
    const heldWork = new Promise<void>(resolve => { releaseHeld = resolve; });
    let heldStarted = false;
    const held = mine.withCall(caller('call-dispose-held'), undefined,
      () => mine.runAction(move, async () => { heldStarted = true; await heldWork; })).then(() => undefined, (error: unknown) => error);
    await waitFor(() => heldStarted, 8000, 'the disposing holder never started');

    const other = bench.arbiter();
    let otherRan = false;
    const blocked = other.withCall(caller('call-blocked'), undefined,
      () => other.runAction({ kind: 'click' }, async () => { otherRan = true; })).then(() => undefined, (error: unknown) => error);
    await waitFor(() => wire.filter(event => event.event === 'in' && event.op === 'acquire').length === 2,
      5000, 'the second arbiter never asked for the lease');
    const queuedAcquire = wire.filter(event => event.event === 'in' && event.op === 'acquire').at(-1);
    const queuedSocket = queuedAcquire?.sock;
    const queuedId = queuedAcquire?.id;
    if (typeof queuedSocket !== 'number' || typeof queuedId !== 'string') {
      throw new Error('the queued acquire is not on a socket the broker can answer by request id');
    }

    mine.dispose();

    const error = await blocked;
    assert.ok(error instanceof UncertainError, 'a dispose never grants: the queue hears an unknown outcome');
    assert.deepEqual(error.detail, { source: 'broker-lost', phase: 'waiting-grant', reason: 'orphan' });
    assert.equal(otherRan, false);
    // The queued arbiter learns of the refusal over its own socket, while the fixture's stdout copy of the same broker
    // line travels on a separate OS stream with no ordering guarantee. Wait for the broker's own words on that exact
    // socket before reading the wire, instead of racing the two streams.
    const refusal = await bench.broker.next(event => event.event === 'out' && event.op === 'lost'
      && event.sock === queuedSocket, 5000);
    assert.equal(refusal.reason, 'orphan', 'the refusal names why the queued step never starts');
    assert.equal('id' in refusal, false, 'the lost line answers the queued socket; it carries no request id to invent');
    assert.equal(wire.filter(event => event.event === 'out' && event.op === 'granted').length, 1,
      'the disposed holder was never replaced');
    const lost = wire.filter(event => event.event === 'out' && event.op === 'lost');
    assert.equal(lost.length, 1);
    assert.equal(lost[0].reason, 'orphan');
    assert.equal(lost[0].sock, queuedSocket, 'the refusal landed on the socket of the queued request');
    assert.equal(wire.some(event => event.event === 'out' && event.op === 'granted'
      && (event.sock === queuedSocket || event.id === queuedId)), false,
      'the queued request was never granted, by socket or by its own id');
    assert.equal(wire.some(event => event.event === 'in' && event.op === 'abandon'), false,
      'a dispose neither releases nor abandons: the broker orphans the slot on its own');

    releaseHeld();
    await held.catch(() => undefined);
  });

test('a reset that fails a waiting step with a plain unknown error is cached as step, not as lease-held',
  { timeout: 30_000 }, async t => {
    const bench = new Bench();
    await bench.start(t);
    const wire = bench.broker.events;
    const mine = bench.arbiter();

    let releaseHeld: () => void = () => undefined;
    const heldWork = new Promise<void>(resolve => { releaseHeld = resolve; });
    let heldStarted = false;
    const held = mine.withCall(caller('call-reset-held'), undefined,
      () => mine.runAction(move, async () => { heldStarted = true; await heldWork; })).then(() => undefined, (error: unknown) => error);
    await waitFor(() => heldStarted, 8000, 'the held step never started');

    let queuedRan = false;
    const queued = mine.withCall(caller('call-reset-queued'), undefined,
      () => mine.runAction(move, async () => { queuedRan = true; })).then(() => undefined, (error: unknown) => error);
    await waitFor(() => wire.filter(event => event.event === 'in' && event.op === 'acquire').length === 2,
      5000, 'the waiting step never asked for the lease');

    mine.reset();

    const queuedError = await queued;
    assert.ok(queuedError instanceof UncertainError, 'a reset fails the waiter as unknown, not as cancelled');
    assert.match(queuedError.message, /^输入仲裁被重置了，这一步的结果不明。/);
    assert.equal(queuedError.detail, undefined, 'the step itself is rethrown untouched');
    assert.equal(queuedRan, false);

    releaseHeld();
    await held.catch(() => undefined);

    const after: unknown = await mine.withCall(caller('call-reset-after'), undefined,
      () => mine.runAction(move, async () => { queuedRan = true; })).then(() => undefined, (error: unknown) => error);
    assert.ok(after instanceof UncertainError);
    assert.equal(after.detail?.source, 'poison');
    assert.equal(after.detail?.origin?.source, 'step',
      'an acquire that failed without a lease must not be cached as lease-held');
    assert.match(after.message, /（source=poison; phase=refused-before-start; origin=step; reason=未提供）$/);
    assert.equal(queuedRan, false);
  });
