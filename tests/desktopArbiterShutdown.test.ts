// What Computer.stop() does to the input lease of a step that was already running, and what that leaves behind for the
// next agent. Two cases sit on either side of one line, and both must be settled the same way from the outside:
//
//   · the step held the lease but had not sent a single input yet (it was measuring where the tab is on the screen), and
//     the stop cancelled it after the connection was dropped — its outcome is known: it was cancelled, nothing ran;
//   · the step pressed the button and the release could not be confirmed — its outcome is unknown, and it must stay so.
//
// "Cancelled" is two events, not one, and the first case pins both. What the caller hears first is the browser's queue
// stopping the step — src/browser/browser.ts:153 lets the stop win the race while the step is still inside the
// measurement — so the rejection it reads is the queue's plain stop error: not a cancellation, and not an unknown
// outcome. The step's own record is the second event: the aborted measurement returns, the page refuses to send input
// under an aborted scope (src/browser/page.ts:346), and the arbiter records the cancelled phase. Nothing the caller
// reads reports that second event, so this file waits for it with a bound instead of assuming it from the first — and
// since the fix the stop waits for the same settlement itself, which is what lets that release happen.
//
// The invariant: a lease nobody can be using is given back, and a lease whose helper may still be injecting is kept. This
// file pins only the first case — the second is here so a fix for it cannot quietly become fail-open.
//
// What is production here: createComputerUse (and the arbiter it makes, Computer.stop, its tool table and its audit),
// createBrowser, createPage, createQueue, and the broker. The broker is the shipped one: the fixture reads the
// BROKER_SOURCE literal out of src/desktop/arbiter.ts and runs it in its own process over a pipe name this file owns, so
// grant/finish/drop/handle and the lease marker are the code the runtime ships.
// What is a fake, and why: the CDP socket (a page needs a browser; the socket itself is the only part that must be
// invented) and the answer to "which processes serve this tab's port" (in production the browser names them and the
// desktop helper proves that one of them was started with the profile). The desktop side is never turned on in this
// file: no helper, no PowerShell, no real mouse or keyboard, and no user profile.
//
// The measurement chain itself is shipped code: the step measures through the real resolver (browserGeometry plus
// createGeometryResolver), and only the outermost query — the process list — is answered here, with an empty list after
// a short wait. With no candidates the resolver returns null at src/browser/geometry.ts:480, before the desktop helper
// or the page is asked at all, which is the same shape production reaches when desktop control is off (there the helper
// throws instead, src/computer.ts:205). The wait is the one thing this file controls: it keeps the step inside the
// measurement while the stop arrives, so the stop has a lease to deal with at all. What the stop does with that lease is
// the subject: before the fix it answered at once and disposed the arbiter, so the step settled against a retired
// instance and its release was skipped; now the stop waits, bounded, for the instance's own calls to finish
// (arbiter.settled, awaited in src/computer.ts) and retires only after that, so the release happens inside the stop's
// own call stack. That makes this a contract regression — it pins the order of those two events — not a reproduction of
// a timing observed on a real machine.
//
// One deviation from a production wiring, which does not touch the invariant under test: the browser is injected
// (ComputerUseOptions.browser), so it brings its own arbiter instead of sharing the computer's. The page step is inside
// this computer's call chain, so its lease is still taken on the computer's arbiter — the instance Computer.stop()
// disposes last — and both are poisoned by the same outcome.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Faults } from '../src/shared/faults.ts';
import { CancelledError, UncertainError, createArbiter } from '../src/desktop/arbiter.ts';
import { createBrowser } from '../src/browser/browser.ts';
import { browserGeometry, createComputerUse } from '../src/computer.ts';
import type { Cdp, Target } from '../src/browser/cdp.ts';
import type { ActionEvent, TrustedCallerContext } from '../src/tool.ts';

// The cross-process broker, never the in-process gate: what is under test is the lease the broker hands out and keeps.
delete process.env.EVOLUTION_CU_ARBITER;

const fixture = (name: string): string => fileURLToPath(new URL('./fixtures/' + name, import.meta.url));
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

async function until(ready: () => boolean, ms: number, message: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ready()) return;
    await delay(10);
  }
  assert.equal(ready(), true, message);
}

/** A pipe nobody else listens on, and nothing an earlier run left behind: the name carries a fresh nonce. */
function uniquePipe(): string {
  return '\\\\.\\pipe\\evolution-cu-arbiter-shutdown-' + randomBytes(8).toString('hex');
}

/** The exact marker file the broker derives from a pipe: sha1 of the full pipe name, under that process's state dir. */
function markerUnder(home: string, pipe: string): string {
  return join(home, '.evolution-computer-use', 'arbiter',
    'evolution-cu-arbiter-lease-' + createHash('sha1').update(pipe).digest('hex') + '.marker');
}

const OPENING = 'const BROKER_SOURCE = [';
const CLOSING = "].join('\\n');";

/** The literal the runtime spawns, read from the source the same way the fixture reads it. */
function productionBroker(): string {
  const text = readFileSync(new URL('../src/desktop/arbiter.ts', import.meta.url), 'utf8');
  const start = text.indexOf(OPENING);
  assert.ok(start >= 0, 'BROKER_SOURCE is not where this test looks for it');
  let end = text.indexOf(CLOSING, start);
  if (end < 0) {
    const close = /\n\]\.join\(/.exec(text.slice(start));
    assert.ok(close, 'BROKER_SOURCE has no closing bracket this test can find');
    end = start + close.index + 1;
  }
  assert.ok(end > start, 'BROKER_SOURCE is not where this test looks for it');
  const parts: unknown = new Function('return ' + text.slice(start + OPENING.length - 1, end + 1))();
  assert.ok(Array.isArray(parts) && parts.every(one => typeof one === 'string'), 'BROKER_SOURCE is not a string array');
  return (parts as string[]).join('\n');
}

/** One JSON object per line on the fixture's stdout, with bounded waits so a stuck broker fails instead of hanging. */
class Broker {
  readonly pipe: string;
  readonly home: string;
  private readonly base: string;
  private readonly child: ChildProcess;
  private readonly events: Record<string, unknown>[] = [];
  private buffer = '';
  private stderr = '';
  private cursor = 0;
  private exited = false;
  private readonly waiting: {
    match: (event: Record<string, unknown>) => boolean;
    resolve: (event: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];

  private constructor(pipe: string, base: string, child: ChildProcess) {
    this.pipe = pipe;
    this.base = base;
    this.home = join(base, 'home');
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { this.feed(chunk); });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { this.stderr += chunk; });
    child.on('exit', () => { this.exited = true; });
  }

  /** Starts the shipped broker on a pipe nobody else uses, with its state directory under this file's own base dir. */
  static async start(pipe: string, base: string): Promise<Broker> {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const child = spawn(process.execPath, [...NODE_FLAGS, fixture('arbiter-broker-server.mjs'), pipe], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      // The broker derives its marker from its own home; pointing that at a temp directory keeps the real state
      // directory untouched by this file.
      env: { ...process.env, USERPROFILE: home, HOME: home },
    });
    const broker = new Broker(pipe, base, child);
    try {
      const listening = await broker.next(event => event.event === 'listening');
      assert.equal(listening.pipe, pipe, 'the fixture reported listening on another pipe');
      assert.equal(listening.sha1, createHash('sha1').update(productionBroker()).digest('hex'),
        'the broker that ran is not the literal src/desktop/arbiter.ts ships');
    } catch (error) {
      // A half-started broker must not outlive the test that failed to start it.
      await broker.stop().catch(() => {});
      throw error;
    }
    return broker;
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    for (let index = this.buffer.indexOf('\n'); index >= 0; index = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      this.events.push(message);
      for (const entry of [...this.waiting]) {
        if (!entry.match(message)) continue;
        this.waiting.splice(this.waiting.indexOf(entry), 1);
        clearTimeout(entry.timer);
        this.cursor = this.events.length;
        entry.resolve(message);
      }
    }
  }

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
        reject(new Error('the broker never reported what the test waited for. seen: ' + JSON.stringify(this.events) +
          (this.stderr ? '\nstderr: ' + this.stderr : '')));
      }, timeoutMs);
      this.waiting.push({ match, resolve, reject, timer });
    });
  }

  /** The marker this bench's pipe derives, in the throwaway home the broker was given. */
  marker(): string { return markerUnder(this.home, this.pipe); }

  /**
   * Ends the broker first and confirms it is gone, and only then removes the one marker this pipe derives — inside this
   * file's own temp base. A live broker owns that marker, so nothing is deleted under a running process, and the real
   * user's state directory is never read or written by this file.
   */
  async stop(): Promise<void> {
    if (!this.exited) {
      this.child.kill();
      const end = Date.now() + 4000;
      while (!this.exited && Date.now() < end) await delay(20);
      assert.equal(this.exited, true, 'the fixture broker did not exit after SIGKILL');
    }
    const marker = this.marker();
    assert.equal(resolve(marker).startsWith(resolve(this.base) + sep), true,
      'refusing to delete a marker outside this test own base directory: ' + marker);
    try { unlinkSync(marker); } catch { /* never written, or already taken by the base cleanup */ }
  }
}

interface Sent { name: string; method: string; params: Record<string, unknown> }
type Hang = (method: string, params: Record<string, unknown>) => boolean;

const TAB: Target = { id: 'tab-1', type: 'page', url: 'about:blank', title: '', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/tab-1' };

const CALLER: TrustedCallerContext = {
  identity: 'trusted', agentId: 'agent-a', rootAgentId: 'lead', depth: 1, lifetime: 1, sessionId: 's1', callId: 'call-a',
};

/** Only what the page primitives read: the element at a point, and the layout they need for it. */
function answer(method: string, params: Record<string, unknown>): unknown {
  if (method === 'Page.getLayoutMetrics') {
    return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, visualViewport: { scale: 1 } };
  }
  if (method !== 'Runtime.evaluate') return {};
  const expression = typeof params.expression === 'string' ? params.expression : '';
  if (expression.includes('__evolutionCU.point')) return { result: { value: { x: 42, y: 24 } } };
  if (expression.includes('__evolutionCU.focus')) return { result: { value: 'ok' } };
  // page_click reports where it landed by reading the page again (src/tools.ts:69 -> page.brief -> snapshot), so the
  // brief needs the real Snapshot shape (src/browser/page.ts:12), not null: an empty but well-formed page.
  if (expression.includes('__evolutionCU.snapshot')) {
    return { result: { value: { url: 'about:blank', title: 'page', controls: [], text: '' } } };
  }
  return { result: { value: null } };
}

/**
 * A CDP socket with the shipped connection's semantics (src/browser/cdp.ts:14-48): requests in flight are rejected with
 * "浏览器连接已断开" when the close event arrives, not when close() is called, and anything sent after that is rejected
 * the same way — so a release still waiting for an answer cannot outlive the connection. Never a real browser.
 */
function fakeCdp(sent: Sent[], hang?: Hang): Cdp {
  let closed = false;
  const pending = new Set<{ timer: NodeJS.Timeout | undefined; reject: (error: Error) => void }>();
  const shakeOff = (error: Error): void => {
    for (const entry of [...pending]) {
      pending.delete(entry);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  };
  return {
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (closed) throw new Error('浏览器连接已断开');
      sent.push({ name: 'tab', method, params });
      if (!hang?.(method, params)) return answer(method, params) as T;
      return await new Promise<T>((_resolve, reject) => {
        const entry: { timer: NodeJS.Timeout | undefined; reject: (error: Error) => void } = { timer: undefined, reject };
        entry.timer = setTimeout(() => {
          pending.delete(entry);
          reject(new Error(method + ': 浏览器没有回应'));
        }, 15_000);
        pending.add(entry);
      });
    },
    on() { return () => {}; },
    close() {
      if (closed) return;
      // A socket close is an event, not a call: the state and the rejections land on the next turn of the loop.
      setImmediate(() => {
        if (closed) return;
        closed = true;
        shakeOff(new Error('浏览器连接已断开'));
      });
    },
    get closed() { return closed; },
  };
}

const mouseTypes = (sent: Sent[]): unknown[] =>
  sent.filter(one => one.method === 'Input.dispatchMouseEvent').map(one => one.params.type);
const phases = (events: ActionEvent[]): string[] => events.map(one => one.phase);

/**
 * One agent's computer over a fake browser: every step it runs is the shipped page code and the shipped arbiter, and its
 * screen measurement runs the shipped resolver. Only the process-list query at the top of that resolver is answered
 * here, because the real one asks the browser and a desktop helper.
 */
function agentOver(root: string, options: {
  helper: (op: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  browserPids: (port: number) => Promise<number[]>;
  hang?: Hang;
}) {
  const sent: Sent[] = [];
  const events: ActionEvent[] = [];
  // One fault table, as in production, so a browser problem and a desktop problem land in the same place.
  const faults = new Faults();
  const computer = createComputerUse({
    dataDir: join(root, 'computer'),
    // proceduresDir is a path override, not a switch (src/computer.ts:36); only messages takes false (:38).
    // A folder inside this test own temp base keeps the isolation the false was standing in for.
    proceduresDir: join(root, 'procedures'),
    messages: false,
    inbox: false,
    faults,
    onAction: (event: ActionEvent) => { events.push(event); },
    browser: createBrowser({
      profileDir: join(root, 'browser'),
      faults,
      geometryResolver: browserGeometry({ helper: options.helper, browserPids: options.browserPids }),
      find: () => 'fake-chrome',
      running: async () => 9333,
      targets: async () => [TAB],
      open: async () => TAB,
      close: async () => {},
      connect: async () => fakeCdp(sent, options.hang),
    }),
  });
  return { computer, sent, events };
}

/** Asks the broker for the machine-wide lease through the production client, exactly as the next agent would. */
async function takeLease(): Promise<{ error?: unknown }> {
  const probe = createArbiter();
  try {
    await probe.runAction({ kind: 'move' }, async () => {});
    return {};
  } catch (error) {
    return { error };
  } finally {
    probe.dispose();
  }
}

function root(): string { return mkdtempSync(join(tmpdir(), 'evolution-cu-shutdown-')); }

/** Removes a directory only if this file can prove it made it: a fresh mkdtemp name directly under the temp dir. */
function discard(base: string): void {
  assert.equal(resolve(base).startsWith(resolve(tmpdir()) + sep), true,
    'refusing to delete outside the temp directory: ' + base);
  assert.equal(basename(base).startsWith('evolution-cu-shutdown-'), true,
    'refusing to delete a directory this file did not create: ' + base);
  rmSync(base, { recursive: true, force: true });
}

/** The text createQueue() rejects with when it is stopped: src/shared/queue.ts:13 builds it from the queue's name. */
const QUEUE_STOP = '浏览器已停止'; // src/browser/browser.ts:49 — createQueue('浏览器', …)

/**
 * The error a step that was stopped before it sent anything comes back with, read strictly:
 *   · one plain Error per level — the queue's stop, wrapped once by Computer.call (src/computer.ts:507);
 *   · neither level a CancelledError or an UncertainError: this step's outcome is neither, and a failure that reported
 *     either would be a different bug, not a detail of this one;
 *   · the queue's own text. Computer.call appends its asides to the outer message after a newline, so the outer message
 *     may merely begin with it; the cause is the queue's error itself and must match exactly.
 */
function queueStopped(error: unknown): boolean {
  const plain = (value: unknown, exact: boolean): boolean => {
    if (!(value instanceof Error)) return false;
    if (value instanceof CancelledError || value instanceof UncertainError) return false;
    const text = value.message;
    return exact ? text === QUEUE_STOP : text === QUEUE_STOP || text.startsWith(QUEUE_STOP + '\n');
  };
  if (!plain(error, false)) return false;
  return plain((error as { cause?: unknown }).cause, true);
}

/**
 * Who was thrown, what it said, and what it wrapped. Bounded to three levels: a wrong cause chain is exactly what has to
 * be readable here, and an unbounded walk of a cyclic cause would hang the run instead of reporting it.
 */
function chainText(value: unknown, depth = 0): string {
  if (value instanceof Error) {
    const head = (value.constructor?.name ?? 'Error') + ' (name ' + value.name + '): ' + value.message;
    const cause = (value as { cause?: unknown }).cause;
    if (cause === undefined || depth >= 2) return head;
    return head + '\n    caused by ' + chainText(cause, depth + 1);
  }
  if (typeof value === 'string') return 'string ' + JSON.stringify(value);
  try {
    return (value === null ? 'null' : typeof value) + ' ' + JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** What the audit recorded, in order: the phase sequence is what tells a cancelled step from an uncertain one. */
function auditLine(events: ActionEvent[]): string {
  if (events.length === 0) return 'action events: (none)';
  return 'action events: ' + events.map(one => one.seq + ':' + one.phase + '/' + one.area
    + (one.reason === undefined ? '' : ' (' + one.reason + ')')).join(' -> ');
}

/**
 * The same judgement assert.rejects makes with the same predicate, but a red run says what actually came back. A false
 * predicate otherwise prints only "Missing expected rejection", which is the one line that cannot distinguish a
 * cancelled step from an uncertain one; the constructor, name, message, cause chain and the audit can. Nothing is
 * swallowed: a mismatch fails this test with the real rejection in the message.
 */
async function rejectsAs(
  work: Promise<unknown>,
  predicate: (error: unknown) => boolean,
  message: string,
  detail: () => string[],
): Promise<void> {
  const settled = await work.then(
    (value): { rejected: false; value: unknown } => ({ rejected: false, value }),
    (error): { rejected: true; error: unknown } => ({ rejected: true, error }),
  );
  const notes = detail().map(one => '\n  ' + one).join('');
  if (!settled.rejected) {
    assert.fail(message + '\n  but the step resolved with ' + chainText(settled.value) + notes);
  }
  let verdict: boolean | string;
  try {
    verdict = predicate(settled.error);
  } catch (thrown) {
    verdict = 'the predicate threw ' + chainText(thrown);
  }
  if (verdict === true) return;
  assert.fail(message + '\n  the rejection that came back was ' + chainText(settled.error)
    + (verdict === false ? '' : '\n  ' + verdict) + notes);
}

test('a step that never sent input gives the lease back after the stop', async () => {
  const base = root();
  const pipe = uniquePipe();
  process.env.EVOLUTION_CU_BROKER_PIPE = pipe;
  const broker = await Broker.start(pipe, base);
  let announce = (): void => {};
  const measuring = new Promise<void>(resolve => { announce = resolve; });
  // The shipped resolver asks two things: which processes serve the tab's port, then — for each of them — the desktop
  // helper. Here the first question answers with no processes after a short wait, so the resolver stops at
  // src/browser/geometry.ts:480 and the helper is never asked. That is the shape production reaches with desktop control
  // off, where the helper throws instead (src/computer.ts:205). The wait is short next to the stop's own bounded
  // settlement wait (SETTLE_BUDGET_MS in src/computer.ts), so the stop is the one that waits here: it answers only after
  // this step has returned into its own scope and tried to give the lease back. It is also far shorter than the
  // three-second bound the measurement itself is given.
  const helperCalls: string[] = [];
  const helper = async (op: string, _args?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    helperCalls.push(op);
    throw new Error('the desktop helper must not be asked in this file');
  };
  const browserPids = async (_port: number): Promise<number[]> => { announce(); await delay(150); return []; };
  const { computer, sent, events } = agentOver(base, { helper, browserPids });
  let step: Promise<unknown> | undefined;
  let stopped = false;

  try {
    assert.equal(computer.desktopOn(), false, 'the desktop helper must not be involved in this file');
    const clicked = computer.call('page_click', { ref: 1 }, undefined, CALLER);
    step = clicked;
    let settled = false;
    clicked.then(() => { settled = true; }, () => { settled = true; });

    // The step is inside the measurement: the broker already granted it the lease, and no input has gone out.
    await measuring;
    await until(() => phases(events).includes('granted'), 5000, 'the step never got the lease');
    assert.deepEqual(mouseTypes(sent), [], 'nothing may be sent before the position is known');
    assert.equal(existsSync(broker.marker()), true,
      'the broker must show the lease as taken, or this test is not exercising a held lease');

    // A stop against a step that has already settled would prove nothing, so the window is checked, not assumed.
    assert.equal(settled, false, 'the step settled before the stop: the measurement answered too early');

    // Computer.stop() with that step in flight. Nothing was sent, so its own outcome is known: cancelled, not unknown.
    await computer.stop();
    stopped = true;

    // What the caller hears is the browser's queue stopping the step — a plain stop error with the queue's own text, not
    // a cancellation and not an unknown outcome (queueStopped says exactly which). Same predicate, same message: only
    // the report on a mismatch changes, so the first failure says what really came back and what the audit recorded.
    await rejectsAs(clicked, queueStopped,
      "the caller hears the browser's queue stop the step, not an unknown or cancelled outcome",
      () => [
        auditLine(events),
        'mouse events sent: ' + (mouseTypes(sent).length === 0 ? '(none)' : mouseTypes(sent).join(', ')),
        'helper calls: ' + (helperCalls.length === 0 ? '(none)' : helperCalls.join(', ')),
        'desktop control on: ' + String(computer.desktopOn()),
      ]);

    // The step's own record is what proves the cancellation itself happened: the aborted measurement returns, the page
    // code refuses to carry on under an aborted scope (src/browser/page.ts:346) and the arbiter records the phase. Nothing
    // the caller reads reports it — that error was the queue's, not the step's — so it is waited for, bounded, and never
    // assumed: if it does not come, this fails on the audit it did record. The bounded wait of the stop above settles on
    // this same event, so by now it is normally recorded already, and this wait costs nothing.
    await until(() => phases(events).includes('cancelled'), 5000,
      'the audit never recorded the cancellation, so nothing here proves the step was cancelled rather than dropped\n  '
      + auditLine(events));
    assert.equal(phases(events).includes('uncertain'), false, 'no input was ever sent, so nothing can be unknown');
    assert.equal(phases(events).includes('cancelled'), true, 'the audit must record the cancellation');
    assert.deepEqual(mouseTypes(sent), [], 'a stop must not invent input');
    assert.deepEqual(helperCalls, [], 'the measurement must have stopped before the helper: no desktop control was used');

    // The point of the file: a lease nobody can be using goes back. Before the fix the stop retired the instance first,
    // so the step settled against a retired arbiter and its release was skipped; now the stop waits for that settlement,
    // and the release happens inside it. If the marker still stands, the next agent is locked out.
    await until(() => !existsSync(broker.marker()), 2000,
      'the lease was never given back: the broker still holds a marker for a step that never sent input');
    const next = await takeLease();
    assert.equal(next.error, undefined,
      'the next agent must get the lease after a cancelled step that never sent input, but got: ' +
      String((next.error as Error)?.message ?? ''));
  } finally {
    // Stop first: a step still waiting on input settles on that abort, so awaiting it before stopping could hang.
    if (!stopped) await computer.stop().catch(() => {});
    if (step) await step.catch(() => {});
    await broker.stop();
    discard(base);
  }
});

test('a step whose release could not be confirmed keeps the lease unknown', async () => {
  const base = root();
  const pipe = uniquePipe();
  process.env.EVOLUTION_CU_BROKER_PIPE = pipe;
  const broker = await Broker.start(pipe, base);
  // A press that went out and a release whose answer never comes back — the connection is closed while it waits, so the
  // socket rejects it: the one case where the outcome really is unknown.
  const hang: Hang = (method, params) => method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased';
  // The same shipped resolver as above, answering at once with no processes, so the step runs with no position at all
  // and never asks the desktop helper.
  const helperCalls: string[] = [];
  const helper = async (op: string, _args?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    helperCalls.push(op);
    throw new Error('the desktop helper must not be asked in this file');
  };
  const { computer, sent, events } = agentOver(base, { helper, browserPids: async () => [], hang });
  let step: Promise<unknown> | undefined;
  let stopped = false;

  try {
    const clicked = computer.call('page_click', { ref: 1 }, undefined, CALLER);
    step = clicked;
    clicked.catch(() => {});
    await until(() => mouseTypes(sent).includes('mousePressed'), 5000, 'the click never pressed');
    assert.equal(existsSync(broker.marker()), true, 'the broker must show the lease as taken');

    await computer.stop();
    stopped = true;
    await assert.rejects(clicked,
      (error: unknown) => error instanceof Error && error.cause instanceof UncertainError,
      'a stop that could not put the button back must reach the caller as an unknown outcome');
    assert.equal(phases(events).includes('uncertain'), true,
      'a press nobody could confirm releasing is an unknown outcome, never a cancellation');

    // The other side of the same line: the helper may still be injecting, so nobody else may be let in.
    const next = await takeLease();
    assert.ok(next.error instanceof UncertainError,
      'the next agent must be refused while a pressed button may still be held, but got: ' +
      (next.error === undefined ? 'the lease' : String((next.error as Error)?.message)));
    assert.equal(existsSync(broker.marker()), true,
      'the marker must still stand while the outcome is unknown');
    assert.deepEqual(helperCalls, [], 'no desktop control may be used by this file');
  } finally {
    // Stop first: a step still waiting on input settles on that abort, so awaiting it before stopping could hang.
    if (!stopped) await computer.stop().catch(() => {});
    if (step) await step.catch(() => {});
    await broker.stop();
    discard(base);
  }
});

/**
 * Two ComputerUse instances in one process, one exclusive broker pipe. The first is stopped while it holds the lease but
 * has sent no input; until it hands the lease back, the second must not start, must not send a single event, and must not
 * interleave with the first step. After the handoff the second runs alone. The order array is the whole proof: it only
 * ever sees one instance measuring at a time.
 */
test('a second ComputerUse in the same process cannot run while the first holds the lease, and then runs alone', async () => {
  const base = root();
  const pipe = uniquePipe();
  process.env.EVOLUTION_CU_BROKER_PIPE = pipe;
  const broker = await Broker.start(pipe, base);
  const order: string[] = [];
  let releaseHeldMeasurement: () => void = () => undefined;
  const heldMeasurement = new Promise<void>(resolve => { releaseHeldMeasurement = resolve; });
  const helper = async (_op: string, _args?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    throw new Error('the desktop helper must not be asked in this file');
  };
  const one = agentOver(join(base, 'one'), {
    helper,
    browserPids: async () => { order.push('one-measuring'); await heldMeasurement; return []; },
  });
  const two = agentOver(join(base, 'two'), {
    helper,
    browserPids: async () => { order.push('two-measuring'); return []; },
  });
  let oneStep: Promise<unknown> | undefined;
  let twoStep: Promise<unknown> | undefined;
  let oneStopped = false;

  try {
    const oneClick = one.computer.call('page_click', { ref: 1 }, undefined, CALLER);
    oneStep = oneClick;
    oneClick.catch(() => {});
    assert.equal(one.computer.desktopOn(), false, 'the desktop helper must not be involved in this file');
    await until(() => order.includes('one-measuring'), 8000, 'the first computer never began measuring');
    await until(() => phases(one.events).includes('granted'), 8000, 'the first computer never took the lease');
    assert.equal(existsSync(broker.marker()), true, 'the broker must show the lease as taken');
    assert.deepEqual(mouseTypes(one.sent), [], 'a step that is only measuring has sent nothing');

    const twoClick = two.computer.call('page_click', { ref: 1 }, undefined, CALLER);
    twoStep = twoClick;
    twoClick.catch(() => {});
    await delay(300);
    assert.deepEqual(order, ['one-measuring'], 'the second computer must not begin while the first holds the lease');
    assert.equal(phases(two.events).includes('granted'), false, 'the second computer was never granted a lease');
    assert.deepEqual(mouseTypes(two.sent), [], 'the second computer sent no input while it was queued');

    const stopping = one.computer.stop();
    releaseHeldMeasurement();
    await stopping;
    oneStopped = true;
    await rejectsAs(oneClick, queueStopped,
      'a stop during measurement reaches the first caller as a known cancellation',
      () => [
        auditLine(one.events),
        'mouse events sent: ' + (mouseTypes(one.sent).length === 0 ? '(none)' : mouseTypes(one.sent).join(', ')),
        'desktop control on: ' + String(one.computer.desktopOn()),
      ]);
    await until(() => phases(one.events).includes('cancelled'), 5000, 'the first step was never cancelled');

    await until(() => order.includes('two-measuring'), 8000, 'the lease was never handed to the second computer');
    await twoClick;
    assert.deepEqual(order, ['one-measuring', 'two-measuring'],
      'strictly one at a time: the second only measured after the first had handed the lease back');
    assert.equal(phases(two.events).includes('granted'), true, 'the second computer took the lease once it was free');
    assert.ok(mouseTypes(two.sent).length > 0, 'the second step really ran once the lease was free');
    assert.equal(existsSync(broker.marker()), false, 'the second step gave the lease back when it finished');
  } finally {
    releaseHeldMeasurement();
    if (!oneStopped) await one.computer.stop().catch(() => undefined);
    await two.computer.stop().catch(() => undefined);
    await oneStep?.catch(() => undefined);
    await twoStep?.catch(() => undefined);
    await broker.stop();
    delete process.env.EVOLUTION_CU_BROKER_PIPE;
    discard(base);
  }
});
/**
 * The same two instances, but this time the first is stopped while its own input is unconfirmed. A release that cannot
 * be confirmed must never turn into a handoff: the second instance has to be refused, send nothing, and the fence must
 * survive. This is the dispose-while-holding shape at the ComputerUse layer; the broker-level proof is task-140 E2.
 */
test('a ComputerUse stopped with an unconfirmed input leaves the shared slot closed to a second ComputerUse', async () => {
  const base = root();
  const pipe = uniquePipe();
  process.env.EVOLUTION_CU_BROKER_PIPE = pipe;
  const broker = await Broker.start(pipe, base);
  const helper = async (_op: string, _args?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    throw new Error('the desktop helper must not be asked in this file');
  };
  const unconfirmed = (method: string, params: Record<string, unknown>): boolean =>
    method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased';
  const one = agentOver(join(base, 'one'), { helper, browserPids: async () => [], hang: unconfirmed });
  const two = agentOver(join(base, 'two'), { helper, browserPids: async () => [] });
  let oneStep: Promise<unknown> | undefined;
  let twoStep: Promise<unknown> | undefined;

  try {
    oneStep = one.computer.call('page_click', { ref: 1 }, undefined, CALLER);
    oneStep.catch(() => {});
    await until(() => mouseTypes(one.sent).includes('mousePressed'), 8000,
      'the first step never reached the mouse press it could not release');
    assert.equal(existsSync(broker.marker()), true, 'the held lease must be fenced on disk');

    twoStep = two.computer.call('page_click', { ref: 1 }, undefined, CALLER);
    twoStep.catch(() => {});
    // The first acquire belongs to the holder; the second is the instance under test reaching the shared broker.
    await broker.next(event => event.event === 'in' && event.op === 'acquire');
    await broker.next(event => event.event === 'in' && event.op === 'acquire');
    assert.equal(phases(two.events).includes('granted'), false, 'no lease was granted before the stop');
    assert.deepEqual(mouseTypes(two.sent), [], 'the queued instance sent nothing before the stop');

    await one.computer.stop();
    await assert.rejects(oneStep, (error: unknown) =>
      error instanceof Error && error.cause instanceof UncertainError,
    'a stop whose release cannot be confirmed keeps the first step unknown');
    await until(() => phases(one.events).includes('uncertain'), 8000, 'the first step was never recorded unknown');

    const twoError: unknown = await twoStep.then(() => undefined, (error: unknown) => error);
    assert.ok(twoError instanceof Error, 'the second instance must fail rather than wait forever');
    assert.ok(twoError.cause instanceof UncertainError, 'the refusal has to be the arbiter unknown, not a grant');
    assert.equal((twoError.cause as UncertainError).detail?.source, 'broker-lost');
    assert.equal((twoError.cause as UncertainError).detail?.phase, 'waiting-grant');
    assert.equal((twoError.cause as UncertainError).detail?.reason, 'orphan',
      'the orphaned slot must be named, never silently handed over');
    assert.equal(phases(two.events).includes('granted'), false, 'the second instance was never granted the orphaned slot');
    assert.deepEqual(mouseTypes(two.sent), [], 'the second instance sent no input at all');
    assert.equal(existsSync(broker.marker()), true, 'the unconfirmed lease keeps its fence');
  } finally {
    await one.computer.stop().catch(() => undefined);
    await two.computer.stop().catch(() => undefined);
    await oneStep?.catch(() => undefined);
    await twoStep?.catch(() => undefined);
    await broker.stop();
    delete process.env.EVOLUTION_CU_BROKER_PIPE;
    discard(base);
  }
});
