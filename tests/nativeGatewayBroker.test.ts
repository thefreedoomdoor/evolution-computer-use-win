// Cross-lifetime integration: the real native gateway (installNativeGateway) driving a real per-Computer Arbiter
// against the real broker (BROKER_SOURCE) running in a separate process. The runtime below is fake only in that it
// never sends desktop input: it still owns a real BrokerGate/lease, so the lifetime and arbitration semantics under
// test are the production ones. The broker fixture reads and evaluates the shipped BROKER_SOURCE literal and reports
// the sha1 of the source it actually ran, which this test cross-checks against the file on disk.
//
// Author-note: written, NOT executed here. Run with: npm test -- tests/nativeGatewayBroker.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installNativeGateway } from '../src/native-tools.ts';
import { createArbiter, UncertainError } from '../src/desktop/arbiter.ts';
import type {
  NativeAgent, NativeAgentPaths, NativeComputer, NativeGatewayContext, NativeRuntimeHooks, TrustedCallerContext,
} from '../src/native-tools.ts';
import type { ActionDescriptor, ActionEvent, ActionSink, ToolResult, ToolSpec } from '../src/tool.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'arbiter-broker-server.mjs');
const GRACE_MS = 60;

// ------------------------------------------------------------------------------------------------------------------
// Broker process harness: spawns the fixture, records every wire line it tees, and offers event-driven waits only.
// ------------------------------------------------------------------------------------------------------------------

interface WireEvent {
  event: string;
  op?: string;
  id?: string;
  sock?: number;
  pipe?: string;
  sha1?: string;
  reason?: string;
  [key: string]: unknown;
}

interface Waiter {
  predicate: (event: WireEvent) => boolean;
  resolve: (hit: { event: WireEvent; index: number }) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WireCounts {
  acquire: number;
  granted: number;
  release: number;
  abandon: number;
  cancel: number;
}

class Broker {
  readonly events: WireEvent[] = [];
  sha1 = '';
  private buffer = '';
  private stderr = '';
  private exited = false;
  private readonly waiters: Waiter[] = [];
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;

  readonly pipe: string;
  private readonly child: ChildProcess;

  private constructor(pipe: string, child: ChildProcess) {
    this.pipe = pipe;
    this.child = child;
    this.exitPromise = new Promise<void>(resolve => { this.resolveExit = resolve; });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onData(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { this.stderr += chunk; });
    // Every way a spawn can end settles the same promise, so a failure before 'exit' (ENOENT/EACCES, close without exit)
    // fails the startup wait immediately instead of hanging until the listening timeout.
    child.on('exit', () => this.settleExit());
    child.on('close', () => this.settleExit());
    child.on('error', (error: Error) => { this.stderr += '\nspawn error: ' + error.message; this.settleExit(); });
  }

  private settleExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.resolveExit();
  }

  static async start(pipe: string): Promise<Broker> {
    let broker: Broker | undefined;
    try {
      const child = spawn(process.execPath, [FIXTURE, pipe], { stdio: ['ignore', 'pipe', 'pipe'] });
      broker = new Broker(pipe, child);
      const current = broker;
      const armed = current.armWait(event => event.event === 'listening', 10_000, 'broker listening');
      const exited = current.exitPromise.then(() => {
        throw new Error('the broker fixture exited before it was listening; ' + current.diagnostics);
      });
      // A later (normal) exit after we have started listening must not become an unhandled rejection.
      exited.catch(() => {});
      let listening: { event: WireEvent; index: number };
      try {
        listening = await Promise.race([armed.promise, exited]);
      } finally {
        armed.cancel();
      }
      current.sha1 = String(listening.event.sha1 ?? '');
      if (!current.sha1) throw new Error('the broker fixture did not report the sha1 of the source it ran');
      return current;
    } catch (error) {
      // The handshake happens before the caller's try/finally, so a failed start must not leave the fixture behind.
      if (broker) {
        try {
          await broker.stop();
        } catch (stopError) {
          throw new Error('broker start failed (' + (error as Error).message + ') and the fixture did not stop: '
            + (stopError as Error).message + '; ' + broker.diagnostics);
        }
      }
      throw error;
    }
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  get diagnostics(): string {
    return 'pid=' + this.pid + ' stderr=' + JSON.stringify(this.stderr.slice(-400));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (let at = this.buffer.indexOf('\n'); at >= 0; at = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (!line.trim()) continue;
      let event: WireEvent;
      try { event = JSON.parse(line) as WireEvent; } catch { continue; }
      this.push(event);
    }
  }

  private push(event: WireEvent): void {
    this.events.push(event);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(event)) continue;
      clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve({ event, index: this.events.length - 1 });
    }
  }

  /** Same as waitFor, but the caller can cancel the timer and waiter when it no longer needs the wait. */
  private armWait(
    predicate: (event: WireEvent) => boolean,
    timeoutMs: number,
    what: string,
  ): { promise: Promise<{ event: WireEvent; index: number }>; cancel: () => void } {
    for (let index = 0; index < this.events.length; index += 1) {
      if (predicate(this.events[index])) {
        return { promise: Promise.resolve({ event: this.events[index], index }), cancel: () => {} };
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiter: Waiter | undefined;
    const promise = new Promise<{ event: WireEvent; index: number }>((resolve, reject) => {
      timer = setTimeout(() => {
        if (waiter) {
          const at = this.waiters.indexOf(waiter);
          if (at >= 0) this.waiters.splice(at, 1);
          waiter = undefined;
        }
        reject(new Error('timed out after ' + timeoutMs + 'ms waiting for ' + what + '; last events=' + JSON.stringify(this.events.slice(-14)) + '; ' + this.diagnostics));
      }, timeoutMs);
      waiter = { predicate, resolve, timer: timer as ReturnType<typeof setTimeout> };
      this.waiters.push(waiter);
    });
    const cancel = (): void => {
      if (timer) clearTimeout(timer);
      if (waiter) {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        waiter = undefined;
      }
    };
    return { promise, cancel };
  }

  waitFor(predicate: (event: WireEvent) => boolean, timeoutMs: number, what: string): Promise<{ event: WireEvent; index: number }> {
    return this.armWait(predicate, timeoutMs, what).promise;
  }

  /** Resolves with the event if it arrives within windowMs, otherwise null. Event-driven, no busy loop. */
  async tryWait(predicate: (event: WireEvent) => boolean, windowMs: number): Promise<WireEvent | null> {
    try {
      return (await this.waitFor(predicate, windowMs, 'an event that must not arrive')).event;
    } catch {
      return null;
    }
  }

  counts(): WireCounts {
    const totals: WireCounts = { acquire: 0, granted: 0, release: 0, abandon: 0, cancel: 0 };
    for (const event of this.events) {
      if (event.event !== 'in' && event.event !== 'out') continue;
      const key = event.op as keyof WireCounts | undefined;
      if (key && key in totals) totals[key] += 1;
    }
    return totals;
  }

  async stop(): Promise<void> {
    if (this.exited) {
      assert.ok(this.exited, 'broker process must have emitted exit; ' + this.diagnostics);
      return;
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try { this.child.kill(); } catch { /* already gone */ }
    try {
      killTimer = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* already gone */ } }, 2000);
      await Promise.race([
        this.exitPromise,
        new Promise<void>((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error('broker did not exit in time; ' + this.diagnostics)), 5000);
        }),
      ]);
    } finally {
      // Both timers must go, whether we exited on our own or timed out; otherwise the test process stays alive.
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
    assert.ok(this.exited, 'broker process must have emitted exit; ' + this.diagnostics);
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Small helpers.
// ------------------------------------------------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function markerFor(pipe: string): string {
  const hash = createHash('sha1').update(pipe).digest('hex');
  return join(homedir(), '.evolution-computer-use', 'arbiter', 'evolution-cu-arbiter-lease-' + hash + '.marker');
}

/** Recompute the sha1 of the shipped BROKER_SOURCE exactly the way the fixture does, so the trace is provably real. */
function shippedBrokerSha1(): string {
  const text = readFileSync(join(HERE, '..', 'src', 'desktop', 'arbiter.ts'), 'utf8');
  const opening = 'const BROKER_SOURCE = [';
  const closing = "].join('\\n');";
  const start = text.indexOf(opening);
  if (start < 0) throw new Error('BROKER_SOURCE is not where the test looks for it');
  let end = text.indexOf(closing, start);
  if (end < 0) {
    const close = /\n\]/.exec(text.slice(start));
    if (!close) throw new Error('BROKER_SOURCE has no closing bracket the test can find');
    end = start + close.index + 1;
  }
  const parts = new Function('return ' + text.slice(start + opening.length - 1, end + 1))() as unknown;
  if (!Array.isArray(parts) || parts.some(one => typeof one !== 'string')) throw new Error('BROKER_SOURCE is not a string array');
  return createHash('sha1').update((parts as string[]).join('\n')).digest('hex');
}

/** Set the broker pipe for this process and hand back a restorer that puts the original values back verbatim. */
function usePipe(pipe: string): () => void {
  const previousPipe = process.env.EVOLUTION_CU_BROKER_PIPE;
  const previousArbiter = process.env.EVOLUTION_CU_ARBITER;
  process.env.EVOLUTION_CU_BROKER_PIPE = pipe;
  delete process.env.EVOLUTION_CU_ARBITER;
  return () => {
    if (previousPipe === undefined) delete process.env.EVOLUTION_CU_BROKER_PIPE;
    else process.env.EVOLUTION_CU_BROKER_PIPE = previousPipe;
    if (previousArbiter === undefined) delete process.env.EVOLUTION_CU_ARBITER;
    else process.env.EVOLUTION_CU_ARBITER = previousArbiter;
  };
}

function toolSpec(name: string): ToolSpec {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
    async execute() { return { text: name + ' done' }; },
  };
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error('missing ' + what);
  return value;
}

/** Await a rejection and return it; fails loudly if the promise resolves instead. */
async function rejectsWith(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected the call to reject, but it resolved');
}

// ------------------------------------------------------------------------------------------------------------------
// Fake host + fake runtime. The runtime has a real Arbiter (real BrokerGate) and real leases; the only fake part is
// that "work" is a controllable gate instead of desktop input.
// ------------------------------------------------------------------------------------------------------------------

interface DefinitionLike {
  name: string;
  execute(args: Record<string, unknown>, exec: { agent?: NativeAgent; signal?: AbortSignal; callId?: string }): Promise<{ text: string }>;
}

interface Registration {
  agent: NativeAgent;
  definition: DefinitionLike;
  disposed: boolean;
}

type Listener = (payload: { agent: NativeAgent }) => void | Promise<void>;

class Runtime implements NativeComputer {
  readonly acceptsCaller = true;
  readonly sinkEvents: ActionEvent[] = [];
  readonly arbiter = createArbiter({ sink: ((event: ActionEvent) => { this.sinkEvents.push(event); }) as ActionSink });
  enterCount = 0;
  caller: TrustedCallerContext | undefined;
  stopCalls = 0;
  readonly entered = deferred<void>();
  readonly workGate = deferred<void>();
  readonly stopped = deferred<void>();

  readonly paths: NativeAgentPaths;
  readonly agent: NativeAgent;
  readonly hooks: NativeRuntimeHooks;

  constructor(paths: NativeAgentPaths, agent: NativeAgent, hooks: NativeRuntimeHooks) {
    this.paths = paths;
    this.agent = agent;
    this.hooks = hooks;
  }

  tools(): ToolSpec[] {
    return [toolSpec('computer_use')];
  }

  async call(name: string, _args: unknown, signal: AbortSignal, caller?: TrustedCallerContext): Promise<ToolResult> {
    this.caller = caller;
    return this.arbiter.withCall(caller, signal, () => this.arbiter.runAction(
      { kind: 'other', label: name } as ActionDescriptor,
      async () => {
        this.enterCount += 1;
        this.entered.resolve();
        await this.workGate.promise;
        return { text: 'ok' };
      },
    ));
  }

  stop(): Promise<void> {
    this.stopCalls += 1;
    return this.stopped.promise;
  }

  phase(name: string): number {
    return this.sinkEvents.filter(event => event.phase === name).length;
  }
}

class Host {
  readonly agents = new Map<string, NativeAgent>();
  readonly registrations: Registration[] = [];
  readonly runtimes: Runtime[] = [];
  private readonly roots = new Map<NativeAgent, NativeAgent>();
  private readonly listeners = new Map<'agent/created' | 'agent/disposed', Listener[]>();
  readonly ctx: NativeGatewayContext;

  constructor() {
    this.ctx = {
      agents: { get: (id: string) => this.agents.get(id), list: () => [...this.agents.values()] },
      subagents: { rootOf: (agent: NativeAgent) => this.roots.get(agent) ?? agent },
      get: () => undefined,
      on: (event, listener) => {
        const entry = listener as Listener;
        const bucket = this.listeners.get(event) ?? [];
        bucket.push(entry);
        this.listeners.set(event, bucket);
        return () => {
          const current = this.listeners.get(event);
          if (!current) return;
          const at = current.indexOf(entry);
          if (at >= 0) current.splice(at, 1);
        };
      },
    };
  }

  addAgent(id: string): NativeAgent {
    const box: { agent?: NativeAgent } = {};
    const agent = {
      id,
      ctx: { tools: { register: (definition: unknown) => {
        const registration: Registration = { agent: box.agent as NativeAgent, definition: definition as DefinitionLike, disposed: false };
        this.registrations.push(registration);
        return () => { registration.disposed = true; };
      } } },
      session: { header: { id, delegationDepth: 0 } },
    } as unknown as NativeAgent;
    box.agent = agent;
    this.agents.set(id, agent);
    return agent;
  }

  async emit(event: 'agent/created' | 'agent/disposed', payload: { agent: NativeAgent }): Promise<void> {
    for (const listener of [...(this.listeners.get(event) ?? [])]) await listener(payload);
  }

  definitionOf(agent: NativeAgent, name: string): DefinitionLike {
    for (let index = this.registrations.length - 1; index >= 0; index -= 1) {
      const registration = this.registrations[index];
      if (!registration.disposed && registration.agent === agent && registration.definition.name === name) return registration.definition;
    }
    throw new Error('no live "' + name + '" definition for agent ' + agent.id);
  }

  factory = (paths: NativeAgentPaths, agent: NativeAgent, hooks: NativeRuntimeHooks): NativeComputer => {
    const runtime = new Runtime(paths, agent, hooks);
    this.runtimes.push(runtime);
    return runtime;
  };
}

interface GatewayHandle { dispose(): unknown }

function install(host: Host, dataRoot: string): GatewayHandle {
  return installNativeGateway(host.ctx, {
    dataRoot,
    shutdownGraceMs: GRACE_MS,
    createComputer: host.factory,
    log() { /* quiet */ },
    modeFile: false,
    stopFile: false,
    multiMouse: false,
  }) as unknown as GatewayHandle;
}

/** Everything a single test must unwind, bounded, even when an assertion fails mid-flight. */
interface Teardown {
  host: Host;
  gateway: GatewayHandle;
  broker: Broker;
  dataRoot: string;
  marker: string;
  restoreEnv: () => void;
  settles: Promise<unknown>[];
}

async function unwind(state: Teardown): Promise<void> {
  for (const runtime of state.host.runtimes) {
    try { runtime.workGate.resolve(); } catch { /* already resolved */ }
    try { runtime.stopped.resolve(); } catch { /* already resolved */ }
  }
  for (const pending of state.settles) {
    await Promise.race([pending.then(() => undefined, () => undefined), delay(3000)]);
  }
  for (const runtime of state.host.runtimes) {
    try { runtime.arbiter.dispose(); } catch { /* idempotent */ }
  }
  try { await Promise.resolve(state.gateway.dispose()); } catch { /* bounded inside the gateway */ }
  await state.broker.stop();
  state.restoreEnv();
  rmSync(state.marker, { force: true });
  rmSync(state.dataRoot, { recursive: true, force: true });
}

// ------------------------------------------------------------------------------------------------------------------
// Fixture self-check: the Host must deliver each gateway event only to that event's listeners. A regression here once
// ran the gateway's 'agent/disposed' listener on 'agent/created' and tore the new runtime/tools down immediately,
// which could make the lifetime scenarios pass for the wrong reason.
test('the host fixture delivers created and disposed only to their own listeners', async () => {
  const host = new Host();
  let created = 0;
  let disposed = 0;
  const offCreated = host.ctx.on!('agent/created', () => { created += 1; });
  host.ctx.on!('agent/disposed', () => { disposed += 1; });
  const agent = host.addAgent('fixture-sess');

  await host.emit('agent/created', { agent });
  assert.equal(created, 1, 'created reached exactly the created listener once');
  assert.equal(disposed, 0, 'created must not reach the disposed listener');

  offCreated();
  await host.emit('agent/created', { agent });
  assert.equal(created, 1, 'the returned disposer removes only its own listener');

  await host.emit('agent/disposed', { agent });
  assert.equal(created, 1, 'disposed must not reach the created listener');
  assert.equal(disposed, 1, 'disposed reached only the disposed listener');
});

// Scenario 1: a hung predecessor stop lets a fresh lifetime be created, but its work is refused the lease until the
// old broker lease is really released — and then granted exactly once, strictly after the release.
// ------------------------------------------------------------------------------------------------------------------

test('a new lifetime starts after a hung stop but queues behind the old lease until it is released', async () => {
  const pipe = '\\\\.\\pipe\\evocu-t94-' + randomUUID();
  const marker = markerFor(pipe);
  const dataRoot = mkdtempSync(join(tmpdir(), 'evocu-t94-'));
  const restoreEnv = usePipe(pipe);
  const broker = await Broker.start(pipe);
  const host = new Host();
  const gateway = install(host, dataRoot);
  const state: Teardown = { host, gateway, broker, dataRoot, marker, restoreEnv, settles: [] };

  try {
    assert.equal(broker.sha1, shippedBrokerSha1(), 'the fixture must have run the shipped BROKER_SOURCE, not a copy');

    // ---- First lifetime: it takes a real lease and its work then hangs (the "UP not yet confirmed" moment).
    const a1 = host.addAgent('sess-1');
    await host.emit('agent/created', { agent: a1 });
    assert.equal(host.runtimes.length, 1, 'first lifetime must create exactly one runtime');
    const rt1 = host.runtimes[0];
    assert.ok(rt1.paths.profileDir.startsWith(dataRoot), 'profile lives under the temp data root');

    const p1 = host.definitionOf(a1, 'computer_use').execute({}, { agent: a1, signal: new AbortController().signal });
    state.settles.push(p1);
    await rt1.entered.promise;
    assert.equal(rt1.enterCount, 1, 'A1 work entered exactly once');

    const grant1 = await broker.waitFor(event => event.event === 'out' && event.op === 'granted', 10_000, 'A1 granted');
    const lease1 = must(grant1.event.id, 'lease id for A1');
    assert.ok(lease1.startsWith('lease:'), 'granted a lease token, got ' + lease1);
    assert.equal(broker.counts().acquire, 1, 'exactly one acquire so far');

    // A marker for this lease must exist now (the broker wrote it before granting).
    assert.ok(existsSync(marker), 'the lease marker must exist while A1 holds the lease');
    const markerBody = JSON.parse(readFileSync(marker, 'utf8')) as { pipe?: string; id?: string };
    assert.equal(markerBody.pipe, pipe, 'marker belongs to this pipe');
    assert.equal(markerBody.id, lease1, 'marker names the live lease');

    // ---- Same session id, a new live agent object, while rt1.stop() never completes.
    const a2 = host.addAgent('sess-1');
    await host.emit('agent/created', { agent: a2 });
    assert.equal(host.runtimes.length, 2, 'a bounded stop must not block the new lifetime from being created');
    const rt2 = host.runtimes[1];
    assert.notEqual(rt2, rt1);
    assert.notEqual(rt2.paths.profileDir, rt1.paths.profileDir, 'the new lifetime gets a fresh profile');
    // dataDir is the gateway-wide scratch root (src/native-tools.ts:747 dataDir:dataRoot), not per lifetime;
    // only profileDir is keyed by lifetime (src/native-tools.ts:748). Assert that shared root instead.
    assert.equal(rt2.paths.dataDir, dataRoot, 'dataDir is the configured gateway scratch root');
    assert.equal(rt2.paths.dataDir, rt1.paths.dataDir, 'both lifetimes share the gateway-wide scratch root');
    assert.ok(rt1.stopCalls >= 1, 'the predecessor runtime was asked to stop');
    assert.equal(rt2.stopCalls, 0, 'agent/created alone must not stop the new runtime');
    assert.equal(
      host.registrations.filter(entry => entry.agent === a2 && !entry.disposed && entry.definition.name === 'computer_use').length,
      1,
      'agent/created must leave the new computer_use definition live',
    );
    assert.equal(host.definitionOf(a2, 'computer_use').name, 'computer_use');

    // ---- A2 tries to act. Its acquire must reach the real broker, and the broker must NOT grant it yet.
    const p2 = host.definitionOf(a2, 'computer_use').execute({}, { agent: a2, signal: new AbortController().signal });
    state.settles.push(p2);

    const acq2 = await broker.waitFor(
      event => event.event === 'in' && event.op === 'acquire' && event.id !== lease1,
      10_000,
      'A2 acquire at the broker',
    );
    const lease2 = must(acq2.event.id, 'lease id for A2');
    assert.notEqual(lease2, lease1);

    const premature = await broker.tryWait(event => event.event === 'out' && event.op === 'granted' && event.id === lease2, 300);
    assert.equal(premature, null, 'A2 must not be granted while A1 still holds the lease');
    assert.equal(rt2.enterCount, 0, 'A2 work must not run before the lease is free');
    assert.ok(rt2.phase('queued') >= 1, 'A2 reported queued');
    assert.equal(rt2.phase('granted'), 0, 'A2 has not been granted locally either');

    // ---- Confirm A1's work really finished; only then does the lease go back and A2 get it.
    rt1.workGate.resolve();
    await p1;
    const release1 = await broker.waitFor(event => event.event === 'in' && event.op === 'release' && event.id === lease1, 10_000, 'A1 release');
    const grant2 = await broker.waitFor(event => event.event === 'out' && event.op === 'granted' && event.id === lease2, 10_000, 'A2 granted');

    // Strict ordering on the real broker trace.
    assert.ok(acq2.index < release1.index, 'A2 acquire arrived while A1 still held the lease');
    assert.ok(release1.index < grant2.index, 'A2 was granted only after A1 released');

    await rt2.entered.promise;
    // While A2 holds the lease its marker names lease2; releasing it on success removes the marker.
    const markerMid = JSON.parse(readFileSync(marker, 'utf8')) as { id?: string };
    assert.equal(markerMid.id, lease2, 'the marker follows the live lease');
    rt2.workGate.resolve();
    await p2;
    assert.equal(rt2.enterCount, 1, 'A2 work ran exactly once');
    assert.equal(rt1.enterCount, 1, 'A1 work ran exactly once');
    assert.equal(rt1.phase('succeeded'), 1);
    assert.equal(rt2.phase('granted'), 1);
    assert.equal(rt2.phase('succeeded'), 1);

    // Exactly one grant per lease token.
    const grantedFor = (id: string) => broker.events.filter(event => event.event === 'out' && event.op === 'granted' && event.id === id).length;
    assert.equal(grantedFor(lease1), 1, 'lease1 granted exactly once');
    assert.equal(grantedFor(lease2), 1, 'lease2 granted exactly once');

    // Trusted identity and a strictly larger lifetime — fresh profile is not what made this safe.
    assert.equal(rt1.caller?.identity, 'trusted');
    assert.equal(rt2.caller?.identity, 'trusted');
    assert.equal(rt1.caller?.agentId, 'sess-1');
    assert.equal(rt2.caller?.agentId, 'sess-1');
    assert.equal(rt1.caller?.sessionId, 'sess-1');
    assert.ok((rt2.caller?.lifetime ?? -1) > (rt1.caller?.lifetime ?? -1), 'the new lifetime must have a larger number');

  } finally {
    await unwind(state);
  }
});

// ------------------------------------------------------------------------------------------------------------------
// Scenario 2: the holder's socket drops without a clean release. The shared broker must stay fenced: a new lifetime
// gets Uncertain, runs nothing, and is never silently granted/abandoned/released.
// ------------------------------------------------------------------------------------------------------------------

test('a dropped holder fences the broker: a new lifetime is refused, not reset', async () => {
  const pipe = '\\\\.\\pipe\\evocu-t94-' + randomUUID();
  const marker = markerFor(pipe);
  const dataRoot = mkdtempSync(join(tmpdir(), 'evocu-t94-'));
  const restoreEnv = usePipe(pipe);
  const broker = await Broker.start(pipe);
  const host = new Host();
  const gateway = install(host, dataRoot);
  const state: Teardown = { host, gateway, broker, dataRoot, marker, restoreEnv, settles: [] };

  try {
    assert.equal(broker.sha1, shippedBrokerSha1());

    // ---- A1 takes the lease; its work stays in flight, so its outcome is genuinely unknown when the socket drops.
    const a1 = host.addAgent('sess-2');
    await host.emit('agent/created', { agent: a1 });
    const rt1 = host.runtimes[0];
    const p1 = host.definitionOf(a1, 'computer_use').execute({}, { agent: a1, signal: new AbortController().signal });
    state.settles.push(p1);
    await rt1.entered.promise;

    const grant1 = await broker.waitFor(event => event.event === 'out' && event.op === 'granted', 10_000, 'A1 granted');
    const lease1 = must(grant1.event.id, 'lease id for A1');
    const holderSock = grant1.event.sock;
    await broker.waitFor(event => event.event === 'socket' && event.sock === holderSock, 1000, 'holder socket id').catch(() => undefined);
    assert.ok(existsSync(marker), 'marker exists while the lease is held');

    // Drop the holder without releasing: dispose closes the broker connection; the broker marks the lease orphan.
    rt1.arbiter.dispose();
    await broker.waitFor(event => event.event === 'gone', 10_000, 'holder socket gone');

    // ---- New lifetime, same id, fresh profile.
    const a2 = host.addAgent('sess-2');
    await host.emit('agent/created', { agent: a2 });
    assert.equal(host.runtimes.length, 2);
    const rt2 = host.runtimes[1];
    assert.notEqual(rt2.paths.profileDir, rt1.paths.profileDir, 'fresh profile is not a safety argument');
    assert.equal(rt2.stopCalls, 0, 'agent/created alone must not stop the new runtime');
    assert.equal(
      host.registrations.filter(entry => entry.agent === a2 && !entry.disposed && entry.definition.name === 'computer_use').length,
      1,
      'agent/created must leave the new computer_use definition live',
    );

    const before = broker.counts();

    // First attempt: must be an Uncertain outcome from the real broker, not an entering work unit.
    const error1 = await rejectsWith(host.definitionOf(a2, 'computer_use').execute({}, { agent: a2, signal: new AbortController().signal }));
    assert.ok(error1 instanceof UncertainError, 'expected UncertainError, got ' + (error1 instanceof Error ? error1.name + ': ' + error1.message : String(error1)));
    assert.equal(rt2.enterCount, 0, 'no work may enter against a fenced broker');
    assert.ok(rt2.arbiter.poisonedReason(), 'the new lifetime is poisoned after the lost lease');
    assert.equal(rt2.phase('uncertain'), 1, 'the arbiter reported the uncertain outcome');

    const afterFirst = broker.counts();
    assert.equal(afterFirst.acquire, before.acquire + 1, 'the first attempt really asked the broker (no local shortcut)');
    assert.equal(afterFirst.granted, before.granted, 'no new grant on the fenced broker');
    assert.equal(afterFirst.release, before.release, 'nothing was released');
    assert.equal(afterFirst.abandon, before.abandon, 'nothing was abandoned');

    // Second attempt: still refused, and still no grant/release/abandon — the boundary is the real broker, not a guess.
    const error2 = await rejectsWith(host.definitionOf(a2, 'computer_use').execute({}, { agent: a2, signal: new AbortController().signal }));
    assert.ok(error2 instanceof UncertainError, 'second attempt must also be Uncertain, got ' + String(error2));
    assert.equal(rt2.enterCount, 0);
    assert.ok(rt2.arbiter.poisonedReason());

    const afterSecond = broker.counts();
    assert.equal(afterSecond.granted, afterFirst.granted, 'no grant ever reached the refused lifetime');
    assert.equal(afterSecond.release, afterFirst.release, 'no release was fabricated');
    assert.equal(afterSecond.abandon, afterFirst.abandon, 'no abandon was fabricated');
    assert.equal(afterSecond.cancel, afterFirst.cancel, 'no cancel was fabricated');

    // No grant for any token other than the original lease1, and no release/abandon at all.
    assert.equal(
      broker.events.filter(event => event.event === 'out' && event.op === 'granted' && event.id !== lease1).length,
      0,
      'the fenced broker granted nobody else',
    );
    assert.equal(broker.events.filter(event => event.event === 'in' && (event.op === 'release' || event.op === 'abandon')).length, 0);

    // The marker must survive: it is the durable fence, so a later process cannot silently take the lease.
    assert.ok(existsSync(marker), 'the orphan marker must be kept');
    const markerBody = JSON.parse(readFileSync(marker, 'utf8')) as { pipe?: string; id?: string };
    assert.equal(markerBody.pipe, pipe);
    assert.equal(markerBody.id, lease1, 'the marker still names the orphaned lease');

    // The old work, once we let it settle, must not turn into a release (retired arbiter).
    rt1.workGate.resolve();
    await Promise.race([p1.then(() => undefined, () => undefined), delay(3000)]);
    assert.equal(broker.events.filter(event => event.event === 'in' && event.op === 'release').length, 0, 'a disposed holder must not release');
    assert.ok(existsSync(marker), 'the marker still stands after the old work settles');
  } finally {
    await unwind(state);
  }
});
