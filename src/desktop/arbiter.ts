import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { userInfo } from 'node:os';
import { errorText } from '../shared/faults.ts';
import type {
  ActionActor, ActionDescriptor, ActionEvent, ActionPhase, ActionSink, ActionSpace, PhysicalPoint, TrustedCallerContext,
} from '../tool.ts';

/**
 * The user stopped this step: nothing more is sent, and whatever the helper had pressed has been released before it returned.
 * A cancelled step is finished and its lease is handed back — unlike an uncertain one.
 */
export class CancelledError extends Error {
  constructor(message = '用户取消了这一步。') { super(message); this.name = 'CancelledError'; }
}
/**
 * Where an uncertain outcome came from and how far its step got. Diagnosis only: it changes nothing about what is sent,
 * granted or refused, and the error's type and instanceof stay exactly what they were. The message keeps its original
 * sentence first and appends these codes, so a caller that only shows the message still sees them.
 */
export interface UncertainDetail {
  /** Who reported it: the broker's own 'lost', this client's socket closing, an existing poison, or the step itself. */
  source: 'broker-lost' | 'broker-close' | 'poison' | 'step';
  /** How far the step got: waiting for the slot (nothing was sent), holding it, or refused by a poison before it started. */
  phase: 'waiting-grant' | 'lease-held' | 'refused-before-start';
  /** Only on a refusal: what had poisoned the instance. Absent when this error is the failure itself. */
  origin?: { source: 'broker-lost' | 'broker-close' | 'poison' | 'step'; phase?: 'waiting-grant' | 'lease-held'; reason?: string };
  /** The reason this broker gave with its 'lost'. 'unknown' when an older broker sends none: never guessed from a marker. */
  reason?: string;
}
/** The outcome of this step is unknown (helper hung, lost, or a timeout). The gate is poisoned: nothing else is sent until it is reset. */
export class UncertainError extends Error {
  readonly detail?: UncertainDetail;
  /** The message without the diagnosis suffix, so a later refusal repeats the reason without stacking suffixes. */
  readonly base: string;
  constructor(message = '这一步的结果不明。', detail?: UncertainDetail) {
    super(message + detailText(detail)); this.name = 'UncertainError'; this.base = message;
    if (detail) this.detail = detail;
  }
}
/**
 * The origin a step's own uncertain outcome leaves in the poison record. Never invents one: without a detail it is the
 * step itself, and 'lease-held' is only said when this step really held the lease. An error that is already a refusal
 * keeps the origin it carries instead of collapsing back to 'poison'.
 */
function originOf(error: UncertainError, heldLease: boolean): UncertainDetail['origin'] {
  const detail = error.detail;
  if (!detail) return heldLease ? { source: 'step', phase: 'lease-held' } : { source: 'step' };
  if (detail.phase === 'refused-before-start') return detail.origin ?? { source: detail.source, reason: detail.reason };
  return { source: detail.source, phase: detail.phase, reason: detail.reason };
}
/**
 * A lost lease under a held slot explains more than a queued waiter's failure: when both were on one gate, the waiter's
 * rejection arrives a microtask later and must not overwrite the 'lease-held' origin the onLost record already holds.
 */
function mergeOrigin(
  current: UncertainDetail['origin'] | undefined,
  incoming: UncertainDetail['origin'] | undefined,
): UncertainDetail['origin'] | undefined {
  return current?.phase === 'lease-held' ? current : incoming;
}
/**
 * The diagnosis a person or a log actually reads: appended to the message as codes, because a message is all a caller
 * normally shows. The original sentence stays first, so an old reader still recognises it.
 */
function detailText(detail?: UncertainDetail): string {
  if (!detail) return '';
  const parts = ['source=' + detail.source, 'phase=' + detail.phase];
  const origin = detail.origin;
  if (origin) parts.push('origin=' + origin.source + (origin.phase ? '/' + origin.phase : '') + (origin.reason ? '/' + origin.reason : ''));
  parts.push('reason=' + (detail.reason ?? '未提供'));
  return '（' + parts.join('; ') + '）';
}

export interface ActionWindowInfo { app?: string; exe?: string; title?: string; windowRect?: { x: number; y: number; width: number; height: number } }
export interface ActionPatch {
  space?: 'physical' | 'window';
  from?: PhysicalPoint; to?: PhysicalPoint; path?: PhysicalPoint[];
  sampleMs?: number; motionMs?: number; durationMs?: number;
  sampleSource?: 'cursor-sink' | 'client-to-screen' | 'post-message' | 'screen';
  hwnd?: number; window?: ActionWindowInfo; reason?: string; ok?: boolean;
}
/** What one whole logical desktop action carries: who is doing it, on which window/area, and how to reach it. */
export interface ActionScope {
  requestId: string; seq: number; actor: ActionActor; action: ActionDescriptor;
  area: 'global' | 'hwnd'; hwnd?: number; window?: ActionWindowInfo;
  clientVersion?: string; snapshotVersion?: string; leaseId?: string; signal?: AbortSignal;
  /** Internal: the sink this action was created with, so late progress lines never cross into another instance. */
  sink?: ActionSink;
  /** Internal: lets halt() abort a long press/drag without waiting for its natural hold to end. */
  abort?: AbortController;
}
interface CallCtx { caller?: TrustedCallerContext; signal?: AbortSignal; callId: string; action?: ActionScope; arbiter?: Arbiter }
export interface ArbiterOptions { sink?: ActionSink; clientVersion?: string; snapshotVersion?: string }
export interface RunActionOptions {
  signal?: AbortSignal; area?: 'global' | 'hwnd'; hwnd?: number; window?: ActionWindowInfo;
  /**
   * Which space this action's coordinates are in. Real input sent to a page has no physical screen position unless a
   * measurement proved the mapping, so the browser passes 'window' there and the audit carries no position at all.
   */
  space?: ActionSpace;
}

/** One desktop-input arbiter, owned by one ComputerUse. State (sink, versions, gate, poison, request counter) is per instance. */
export interface Arbiter {
  configure(options: ArbiterOptions): void;
  withCall<T>(caller: TrustedCallerContext | undefined, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T>;
  runAction<T>(descriptor: ActionDescriptor, work: (scope: ActionScope) => Promise<T>, options?: RunActionOptions): Promise<T>;
  withGlobalLease<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /**
   * Wait, at most `budgetMs`, for the leases this instance really took to finish their own cleanup, the release attempt
   * included, and say whether they all did. Observational only: it never takes a lease, releases one, sends the broker
   * anything or clears the poison, and `true` only means the calls of this instance are over — not that the broker
   * confirmed a release.
   */
  settled(budgetMs: number): Promise<boolean>;
  /** Abort the action running now (halt), so a long press/drag lets go at once. */
  cancelCurrent(): boolean;
  poison(reason?: string): void;
  poisonedReason(): string | undefined;
  /** Clear poison and drop the gate connection. Only after the owner's helpers are confirmed gone. */
  reset(): void;
  /**
   * Close this instance for good, as the owner's last act when it shuts down. The gate connection is dropped, queued work
   * is cancelled instead of granted, and no new action is accepted; the poison is kept, because a shutdown proves nothing
   * about input that was already in flight. Idempotent. This never sends the broker an 'abandon': that would hand the slot
   * to the next waiter, and a lease whose state is unknown has to stay closed, so the socket is simply destroyed and the
   * broker's own drop path decides.
   */
  dispose(): void;
}

const storage = new AsyncLocalStorage<CallCtx>();

function mintCallId(): string { return 'call-' + randomUUID(); }
function actorOf(caller?: TrustedCallerContext): ActionActor {
  const trust = caller?.identity ?? 'legacy';
  const agentId = caller?.agentId ?? 'legacy';
  return { trust, agentId, rootAgentId: caller?.rootAgentId ?? agentId, depth: caller?.depth ?? 0, lifetime: caller?.lifetime ?? 0 };
}

function buildEvent(scope: ActionScope, phase: ActionPhase, patch: ActionPatch): ActionEvent {
  const now = Date.now();
  const event: ActionEvent = {
    kind: 'desktop-action', requestId: scope.requestId, seq: scope.seq, phase, actor: scope.actor,
    area: scope.area, action: scope.action, space: patch.space ?? 'window',
    sampleMs: patch.sampleMs ?? now, at: now,
  };
  if (scope.hwnd !== undefined) event.hwnd = scope.hwnd;
  if (patch.hwnd !== undefined) event.hwnd = patch.hwnd;
  if (scope.clientVersion !== undefined) event.clientVersion = scope.clientVersion;
  if (scope.snapshotVersion !== undefined) event.snapshotVersion = scope.snapshotVersion;
  if (scope.leaseId !== undefined) event.leaseId = scope.leaseId;
  const window = { ...(scope.window ?? {}), ...(patch.window ?? {}) };
  if (window.app !== undefined) event.app = window.app;
  if (window.exe !== undefined) event.exe = window.exe;
  if (window.title !== undefined) event.title = window.title;
  if (window.windowRect !== undefined) event.windowRect = window.windowRect;
  if (patch.from !== undefined) event.from = patch.from;
  if (patch.to !== undefined) event.to = patch.to;
  if (patch.path !== undefined) event.path = patch.path;
  if (patch.motionMs !== undefined) event.motionMs = patch.motionMs;
  if (patch.durationMs !== undefined) event.durationMs = patch.durationMs;
  if (patch.sampleSource !== undefined) event.sampleSource = patch.sampleSource;
  if (patch.ok !== undefined) event.ok = patch.ok;
  if (patch.reason !== undefined) event.reason = patch.reason;
  return event;
}
/**
 * Emit one phase. Every event under the same requestId gets a strictly larger seq: the runtime drops seq <= lastSeq, so a
 * single fixed seq would hide every phase after `queued`. The counter belongs to the request (the captured scope).
 */
function emit(scope: ActionScope, phase: ActionPhase, patch: ActionPatch = {}): void {
  const sink = scope.sink;
  if (!sink) return;
  scope.seq += 1;
  try { sink(buildEvent(scope, phase, patch)); } catch { /* a broken sink never breaks the action */ }
}

/** Attach geometry (or another phase) to the action that is running right now. No-op outside an action. */
export function emitPhase(phase: ActionPhase, patch: ActionPatch = {}): void {
  const scope = currentAction();
  if (scope) emit(scope, phase, patch);
}
/** Emit a phase into a scope captured earlier, for a helper line that arrives on another async context (drag progress). */
export function emitFor(scope: ActionScope, phase: ActionPhase, patch: ActionPatch = {}): void { emit(scope, phase, patch); }
/** Record the window this action targets (set from desktop's resolved current().hwnd). */
export function bindWindow(hwnd: number): void { const scope = currentAction(); if (scope) scope.hwnd = hwnd; }
/** Record the app/exe/title/rect of the target window so every phase says which window it was. */
export function setWindowInfo(info: ActionWindowInfo): void {
  const scope = currentAction();
  if (!scope) return;
  scope.window = { ...(scope.window ?? {}), ...info };
}
export function currentAction(): ActionScope | undefined { return storage.getStore()?.action; }
export function currentSignal(): AbortSignal | undefined {
  const ctx = storage.getStore();
  return ctx?.action?.signal ?? ctx?.signal;
}
/**
 * Whether this work was started by a tool call, i.e. whether there is a call context an action can belong to. Web input
 * reached from a tool joins the chain and is audited; a page embedded on its own has no request and no trusted caller to
 * speak for, and must not have one invented for it.
 */
export function inCallChain(): boolean { return storage.getStore() !== undefined; }

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface Waiter { token: string; resolve(): void; reject(error: Error): void; signal?: AbortSignal; onAbort?: () => void }
interface Gate {
  acquire(token: string, signal?: AbortSignal): Promise<void>;
  release(token: string): Promise<void>;
  forceClose(reason?: string): void;
  /**
   * Close the connection without deciding anything about the lease that is held: queued waiters are told their step never
   * started, and a held lease is left to the far side's own disconnect path (the broker orphans it, which is the closed
   * outcome). Used by dispose() and nowhere else.
   */
  disconnect(): void;
}

/** One process's own FIFO: used by unit tests (EVOLUTION_CU_ARBITER=inproc) and as the shape the broker copies. */
class LocalGate implements Gate {
  private active: string | undefined;
  private queue: Waiter[] = [];
  acquire(token: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { token, resolve, reject };
      if (signal) {
        if (signal.aborted) { reject(new CancelledError('取消了，这一步还没轮到。')); return; }
        waiter.signal = signal;
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new CancelledError('取消了，这一步还没轮到。'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      if (this.active === undefined) this.grant(waiter); else this.queue.push(waiter);
    });
  }
  private grant(waiter: Waiter): void {
    this.active = waiter.token;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.resolve();
  }
  release(token: string): Promise<void> {
    if (this.active !== token) return Promise.resolve();
    this.active = undefined;
    const next = this.queue.shift();
    if (next) this.grant(next);
    return Promise.resolve();
  }
  forceClose(reason = '输入仲裁被重置了，这一步的结果不明。'): void {
    this.active = undefined;
    for (const waiter of this.queue.splice(0)) waiter.reject(new UncertainError(reason));
  }
  disconnect(): void {
    // Nothing is held for certain here: the one action that might still be running is this same process's and it is told
    // to stop through its own signal. Waiters never started, so they are cancelled, not called unknown.
    for (const waiter of this.queue.splice(0)) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.reject(new CancelledError('这一步还没轮到，实例已经退出了。'));
    }
  }
}

/**
 * The cross-process gate: every Agent process connects to one detached broker over a named pipe. The broker is the single
 * reader, so the order it sees acquire requests in is the FIFO order; it grants exactly one at a time. Release hands the
 * single slot to the oldest waiter. This is what makes "one action at a time, machine-wide" true across processes.
 */
class BrokerGate implements Gate {
  private socket: Socket | undefined;
  private connecting: Promise<Socket> | undefined;
  private waiters = new Map<string, Waiter>();
  private held: string | undefined;
  private dead = false;
  private disposed = false;
  private readonly onLost: (reason: string, detail?: UncertainDetail) => void;
  constructor(onLost: (reason: string, detail?: UncertainDetail) => void) { this.onLost = onLost; }
  private attach(sock: Socket): void {
    sock.setEncoding('utf8');
    let buffer = '';
    sock.on('data', chunk => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        const id = typeof message.id === 'string' ? message.id : '';
        if (message.op === 'granted') {
          const waiter = this.waiters.get(id);
          if (waiter) { this.waiters.delete(id); this.held = id; waiter.resolve(); }
        } else if (message.op === 'lost') {
          const reason = '输入仲裁服务断开了，这一步的结果不明。';
          // Only a string the broker actually sent counts as its reason. An older broker sends none: that is 'unknown',
          // never a guess from the marker or a pid.
          const reported = typeof message.reason === 'string' && message.reason ? message.reason : 'unknown';
          const why: UncertainDetail = { source: 'broker-lost', phase: 'waiting-grant', reason: reported };
          for (const waiter of this.waiters.values()) waiter.reject(new UncertainError(reason, why));
          this.waiters.clear();
          if (this.held) { this.held = undefined; this.onLost(reason, { source: 'broker-lost', phase: 'lease-held', reason: reported }); }
        }
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (this.socket !== sock) return;
      this.socket = undefined; this.dead = true;
      const reason = '输入仲裁服务断开了，这一步的结果不明。';
      const why: UncertainDetail = { source: 'broker-close', phase: 'waiting-grant' };
      for (const waiter of this.waiters.values()) waiter.reject(new UncertainError(reason, why));
      this.waiters.clear();
      if (this.held) { this.held = undefined; this.onLost(reason, { source: 'broker-close', phase: 'lease-held' }); }
    });
  }
  private connect(): Promise<Socket> {
    if (this.disposed) return Promise.reject(new Error('输入仲裁已经退出了，这一步没有开始。'));
    if (this.socket && !this.dead) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<Socket>((resolve, reject) => {
      let attempt = 0;
      const tryOnce = () => {
        const sock = connect(pipePath());
        const onError = () => {
          sock.destroy();
          if (++attempt >= 60) { reject(new Error('输入仲裁服务连不上，这一步没有开始。')); return; }
          spawnBroker();
          setTimeout(tryOnce, 100);
        };
        sock.once('error', onError);
        sock.once('connect', () => {
          sock.off('error', onError);
          this.socket = sock; this.dead = false;
          this.attach(sock);
          resolve(sock);
        });
      };
      spawnBroker();
      tryOnce();
    });
    const starting = this.connecting;
    void starting.then(() => { if (this.connecting === starting) this.connecting = undefined; },
      () => { if (this.connecting === starting) this.connecting = undefined; });
    return starting;
  }
  private send(message: Record<string, unknown>): void {
    try { this.socket?.write(JSON.stringify(message) + '\n'); } catch { /* a dead socket is handled by 'close' */ }
  }
  async acquire(token: string, signal?: AbortSignal): Promise<void> {
    const socket = await this.connect();
    if (!socket.destroyed) this.dead = false;
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { token, resolve, reject };
      const abort = () => {
        if (!this.waiters.has(token)) return; // already granted: the action itself handles the abort
        this.waiters.delete(token);
        this.send({ op: 'cancel', id: token });
        reject(new CancelledError('取消了，这一步还没轮到。'));
      };
      if (signal) {
        if (signal.aborted) { reject(new CancelledError('取消了，这一步还没轮到。')); return; }
        waiter.signal = signal; waiter.onAbort = abort;
        signal.addEventListener('abort', abort, { once: true });
      }
      this.waiters.set(token, waiter);
      this.send({ op: 'acquire', id: token });
    });
  }
  release(token: string): Promise<void> {
    if (this.held !== token) return Promise.resolve();
    this.held = undefined;
    this.send({ op: 'release', id: token });
    return Promise.resolve();
  }
  forceClose(): void {
    if (this.held) { this.send({ op: 'abandon', id: this.held }); this.held = undefined; }
    const sock = this.socket;
    this.socket = undefined; this.dead = true;
    try { sock?.destroy(); } catch { /* already gone */ }
    for (const waiter of this.waiters.values()) waiter.reject(new UncertainError('输入仲裁被重置了，这一步的结果不明。'));
    this.waiters.clear();
  }
  disconnect(): void {
    this.disposed = true;
    // Waiters never received the slot, so nothing was sent for them: tell them the step did not start rather than call it
    // unknown. A held lease is deliberately not abandoned — the broker's own drop path orphans it, which keeps the slot
    // closed for everybody else instead of handing it on. Clearing this.socket first makes the 'close' that follows a
    // no-op, so no onLost fires here and the poison this instance already carries survives.
    const sock = this.socket;
    this.socket = undefined; this.dead = true;
    for (const waiter of this.waiters.values()) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.reject(new CancelledError('这一步还没轮到，实例已经退出了。'));
    }
    this.waiters.clear();
    try { sock?.destroy(); } catch { /* already gone */ }
  }
}

function pipePath(): string {
  const override = process.env.EVOLUTION_CU_BROKER_PIPE;
  if (override) return override;
  let name = 'user';
  try { name = userInfo().username || 'user'; } catch { /* keep the default */ }
  return '\\\\.\\pipe\\evolution-cu-arbiter-' + name.replace(/[^A-Za-z0-9._-]/g, '_');
}

// The broker runs as a detached plain-Node child (ELECTRON_RUN_AS_NODE), so nothing else has to ship beside it.
//
// Alongside the socket the broker keeps one lease marker file, derived from a stable hash of the full pipe name, in the
// per-user state directory. A grant creates it exclusively (open "wx"); any failure to create or write it is a lost lease, never a
// grant. A clean release/abandon with the matching id and socket removes it; a drop, orphan or crash leaves it in place,
// so the next broker on the same pipe refuses every acquire instead of granting input no one can account for. The marker
// is checked on every grant, not once at startup, because a listener can start after a previous holder has already died.
//
// A cancel is a real hand-back too, but only on the trusted-client contract: BrokerGate.acquire sends cancel only while its
// token is still ungranted from its own view. When a grant and an abort race, the client treats the token as never started
// and cancels it; the broker may already hold it, and returning the slot is correct because no input ran. A raw client is
// out of scope here — release itself is equally unverifiable over this user-owned pipe.
const BROKER_SOURCE = [
  '"use strict";',
  'const net = require("node:net");',
  'const fs = require("node:fs");',
  'const os = require("node:os");',
  'const path = require("node:path");',
  'const crypto = require("node:crypto");',
  'const pipe = process.env.EVOLUTION_CU_BROKER_PIPE;',
  'if (!pipe) { process.exit(1); }',
  'let active = null; const wait = []; let fenced = null;',
  'const stateDir = path.join(os.homedir(), ".evolution-computer-use", "arbiter");',
  'try { fs.mkdirSync(stateDir, { recursive: true }); } catch (error) {}',
  'const marker = path.join(stateDir, "evolution-cu-arbiter-lease-" + crypto.createHash("sha1").update(pipe).digest("hex") + ".marker");',
  'function send(sock, message) { try { sock.write(JSON.stringify(message) + "\\n"); } catch (error) {} }',
  'function failClosed(code) { if (!fenced) fenced = code; for (const waiter of wait) send(waiter.sock, { op: "lost", reason: code }); wait.length = 0; }',
  'function takeMarker(entry) { let fd; try { fd = fs.openSync(marker, "wx"); } catch (error) { return false; } try { fs.writeSync(fd, JSON.stringify({ pipe: pipe, id: entry.id, pid: process.pid, at: Date.now() })); return true; } catch (error) { return false; } finally { try { fs.closeSync(fd); } catch (error) {} } }',
  'function dropMarker() { try { fs.unlinkSync(marker); return true; } catch (error) { if (error && error.code === "ENOENT") return true; return false; } }',
  'function grant() { if (active || fenced) return; while (wait.length) { const next = wait.shift(); if (!next || next.sock.destroyed) continue; if (!takeMarker(next)) { failClosed("marker-create-failed"); send(next.sock, { op: "lost", reason: "marker-create-failed" }); return; } active = next; send(next.sock, { op: "granted", id: next.id }); return; } }',
  'function finish() { if (!dropMarker()) { active = null; failClosed("marker-remove-failed"); return; } active = null; grant(); }',
  'function drop(sock) {',
  '  if (active && active.sock === sock) {',
  '    // Fail closed: the holder may still be injecting through a helper that outlived the socket. Never grant a second one.',
  '    active.orphan = true;',
  '    for (const waiter of wait) send(waiter.sock, { op: "lost", reason: "orphan" });',
  '    wait.length = 0;',
  '    return;',
  '  }',
  '  const index = wait.findIndex(function (item) { return item.sock === sock; });',
  '  if (index >= 0) wait.splice(index, 1);',
  '}',
  'function handle(sock, message) {',
  '  if (message.op === "acquire") { if (fenced) { send(sock, { op: "lost", reason: fenced }); return; } if (active && active.orphan) { send(sock, { op: "lost", reason: "orphan" }); return; } wait.push({ sock: sock, id: message.id }); grant(); }',
  '  else if (message.op === "release") { if (active && active.id === message.id && active.sock === sock) { finish(); } }',
  '  else if (message.op === "cancel") { if (active && active.id === message.id && active.sock === sock) { finish(); return; } const index = wait.findIndex(function (item) { return item.id === message.id; }); if (index >= 0) wait.splice(index, 1); }',
  '  else if (message.op === "abandon") { if (active && active.id === message.id && active.sock === sock) { finish(); } }',
  '}',
  'const server = net.createServer(function (sock) {',
  '  sock.setEncoding("utf8"); let buffer = "";',
  '  sock.on("data", function (chunk) { buffer += chunk; let index; while ((index = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; let message; try { message = JSON.parse(line); } catch (error) { continue; } handle(sock, message); } });',
  '  sock.on("error", function () {});',
  '  sock.on("close", function () { drop(sock); });',
  '});',
  'server.on("error", function () { process.exit(1); });',
  'server.listen(pipe);',
].join('\n');

function spawnBroker(): void {
  try {
    const child = spawn(process.execPath, ['-e', BROKER_SOURCE], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', EVOLUTION_CU_BROKER_PIPE: pipePath() },
    });
    child.unref();
  } catch { /* connect keeps retrying and finally reports */ }
}

export function createArbiter(options: ArbiterOptions = {}): Arbiter {
  let sink: ActionSink | undefined = options.sink;
  let clientVersion: string | undefined = options.clientVersion;
  let snapshotVersion: string | undefined = options.snapshotVersion;
  let requestCounter = 0;
  let poisoned: string | undefined;
  /** What poisoned this instance, kept only for the diagnosis later refusals carry. Safety behaviour is unchanged. */
  let poisonOrigin: UncertainDetail['origin'] | undefined;
  let gate: Gate | undefined;
  // Every action of this instance that has not finished yet — queued *and* the one that holds the lease — kept outside
  // AsyncLocalStorage: a helper's own stop line arrives on a readline callback with no caller context, so cancelCurrent()
  // must still find the action whose input is in flight. `active` is only the one that really holds the lease.
  let active: ActionScope | undefined;
  const live = new Set<ActionScope>();
  /** Controllers of leases taken without an action scope, so a stop can still abort them. */
  const bare = new Set<AbortController>();
  /** Set by dispose(): this instance belongs to a ComputerUse that has shut down and must never take input again. */
  let retired = false;
  /**
   * Leases of this instance whose call has not finished yet: counted in before the lease is asked for and counted out
   * after the release attempt in the matching finally. Not `live` or `bare`, which forget a scope or a controller
   * before its release runs. A shutdown waits on this, so it does not retire the instance — and so skip the release —
   * while a step it just cancelled is still unwinding.
   */
  let pending = 0;
  /** Everyone waiting for `pending` to come back to zero; each is told exactly once, when the last lease finishes. */
  const settleWaiters = new Set<(all: boolean) => void>();
  const leaseEntered = (): void => { pending += 1; };
  const leaseLeft = (): void => {
    pending -= 1;
    if (pending > 0) return;
    const waiting = [...settleWaiters];
    settleWaiters.clear();
    for (const wake of waiting) wake(true);
  };

  const theGate = (): Gate => {
    if (!gate) gate = process.env.EVOLUTION_CU_ARBITER === 'inproc'
      ? new LocalGate()
      : new BrokerGate((reason, detail) => {
        poisoned = reason;
        poisonOrigin = detail
          ? { source: detail.source, phase: detail.phase === 'refused-before-start' ? undefined : detail.phase, reason: detail.reason }
          : undefined;
      });
    return gate;
  };

  /**
   * Aborts every unfinished action of this instance, the one that holds the lease first, then every bare lease: the one
   * body behind both a stop and a shutdown. A shutdown aborts before it drops the gate, because an action left to keep
   * sending input after its owner is gone is exactly what closing down must not leave behind.
   */
  const haltEverything = (): boolean => {
    // Abort every unfinished action of this instance, the one that holds the lease first: with two turns queues
    // (desktop and screen) or a window still appearing, the newest scope can be waiting for the lease while an older
    // one is pressing. Taking only the newest leaves the real input pressing until its hold runs out, and its own
    // cleanup would then clear the record of the action that is still running, so every later stop finds nothing.
    const scopes: ActionScope[] = [];
    if (active) scopes.push(active);
    for (const scope of live) if (scope !== active) scopes.push(scope);
    if (scopes.length === 0) { const scope = currentAction(); if (scope) scopes.push(scope); }
    let any = false;
    for (const scope of scopes) {
      if (!scope.abort) continue;
      scope.abort.abort();
      any = true;
    }
    for (const controller of bare) { controller.abort(); any = true; }
    return any;
  };

  const instance: Arbiter = {
    configure(next: ArbiterOptions): void {
      if ('sink' in next) sink = next.sink;
      if ('clientVersion' in next) clientVersion = next.clientVersion;
      if ('snapshotVersion' in next) snapshotVersion = next.snapshotVersion;
    },
    poison(reason = '上一步结果不明，状态未知。'): void { poisoned = reason; poisonOrigin = { source: 'poison' }; },
    poisonedReason(): string | undefined { return poisoned; },
    reset(): void {
      // `pending` is not touched here either: clearing the poison and dropping the gate says nothing about leases that
      // are still unwinding, and claiming they settled would let a waiter report `true` for unfinished work.
      poisoned = undefined; poisonOrigin = undefined; requestCounter = 0; active = undefined; live.clear(); bare.clear();
      const old = gate; gate = undefined;
      try { old?.forceClose(); } catch { /* already gone */ }
    },
    dispose(): void {
      // Shutdown, not a recovery: the poison stays exactly as it was, because the owner going away says nothing about
      // input that may still be in flight. The gate connection is dropped without a release or an abandon, so a lease
      // this instance held is left for the broker to orphan (closed) rather than handed to somebody else, and a release
      // that arrives from an action settling late finds this instance retired and no gate to talk to.
      retired = true;
      // Abort first: an action that keeps sending input after its owner has gone is the one thing a shutdown must not
      // leave behind. Their own release is skipped once retired, so nothing is handed back through a gate about to close.
      haltEverything();
      const old = gate; gate = undefined;
      try { old?.disconnect(); } catch { /* already gone */ }
      active = undefined; live.clear(); bare.clear();
      // `pending` stays as it is for the same reason: those calls are still unwinding, and their own finally counts them
      // out once the release attempt has run (or been skipped because this instance is now retired).
    },
    cancelCurrent(): boolean {
      return haltEverything();
    },
    withCall<T>(caller: TrustedCallerContext | undefined, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
      const parent = storage.getStore();
      const callId = caller?.callId ?? parent?.callId ?? mintCallId();
      const ctx: CallCtx = { caller: caller ?? parent?.caller, signal: signal ?? parent?.signal, callId, arbiter: instance };
      return storage.run(ctx, fn);
    },
    async withGlobalLease<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const ctx = storage.getStore();
      if (ctx?.action) return fn();
      if (poisoned) throw new UncertainError(poisoned, { source: 'poison', phase: 'refused-before-start', origin: poisonOrigin, reason: poisonOrigin?.reason });
      if (retired) throw new UncertainError('这个输入仲裁已经退出了，这一步没有开始。');
      const token = 'lease:' + randomUUID();
      // A lease taken without a surrounding action (a raw driver call) must still be cancellable from outside, otherwise a
      // stop would wait out a hold with no action scope to abort.
      const outer = signal ?? ctx?.signal;
      const controller = new AbortController();
      let detach: (() => void) | undefined;
      if (outer) {
        if (outer.aborted) controller.abort();
        else {
          const onAbort = () => controller.abort();
          outer.addEventListener('abort', onAbort, { once: true });
          detach = () => outer.removeEventListener('abort', onAbort);
        }
      }
      bare.add(controller);
      let hold = false;
      // Counted in before the lease is asked for, so a shutdown that arrives while this acquire is still queued sees the
      // step as unfinished rather than settled.
      leaseEntered();
      try { await theGate().acquire(token, controller.signal); }
      catch (error) {
        bare.delete(controller); detach?.();
        // No lease was taken, but the call is over: a cancelled or failed acquire settles right here.
        leaseLeft();
        if (error instanceof UncertainError) { poisoned = error.base; poisonOrigin = mergeOrigin(poisonOrigin, originOf(error, false)); }
        throw error;
      }
      // The lease's own controller becomes the signal the work sees, so anything armed inside (the helper's cancel file)
      // is raised by a stop even when no action scope exists.
      const inner: CallCtx = { caller: ctx?.caller, signal: controller.signal, callId: ctx?.callId ?? mintCallId(), arbiter: instance };
      try { return await storage.run(inner, fn); }
      catch (error) { if (error instanceof UncertainError) { poisoned = error.base; poisonOrigin = mergeOrigin(poisonOrigin, originOf(error, true)); hold = true; } throw error; }
      finally {
        bare.delete(controller); detach?.();
        // A disposed instance has no gate left: asking for one would spawn a fresh broker for a shutdown that is over.
        if (!hold && !retired) await theGate().release(token);
        // Counted out only now: the release attempt above is part of settling, and a waiter that returned earlier would
        // tell a shutdown it is safe to retire while this lease was still being handed back.
        leaseLeft();
      }
    },
    settled(budgetMs: number): Promise<boolean> {
      if (pending === 0) return Promise.resolve(true);
      // A budget that is not a positive finite number is not a licence to wait forever: it means "look now".
      if (!Number.isFinite(budgetMs) || budgetMs <= 0) return Promise.resolve(false);
      // One bounded timer per waiter, never a poll loop: the last lease to finish wakes everyone at once, and a waiter
      // that runs out of time takes itself off the list so a later settlement does not resolve it a second time.
      return new Promise<boolean>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wake = (all: boolean): void => {
          settleWaiters.delete(wake);
          if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
          resolve(all);
        };
        settleWaiters.add(wake);
        timer = setTimeout(() => { if (settleWaiters.delete(wake)) resolve(false); }, budgetMs);
      });
    },
    async runAction<T>(descriptor: ActionDescriptor, work: (scope: ActionScope) => Promise<T>, runOptions: RunActionOptions = {}): Promise<T> {
      const ctx = storage.getStore();
      const running = ctx?.action;
      if (running) return work(running);
      if (poisoned) throw new UncertainError(poisoned, { source: 'poison', phase: 'refused-before-start', origin: poisonOrigin, reason: poisonOrigin?.reason });
      if (retired) throw new UncertainError('这个输入仲裁已经退出了，这一步没有开始。');
      const outer = runOptions.signal ?? ctx?.signal;
      const controller = new AbortController();
      let detach: (() => void) | undefined;
      if (outer) {
        if (outer.aborted) controller.abort();
        else {
          const onAbort = () => controller.abort();
          outer.addEventListener('abort', onAbort, { once: true });
          detach = () => outer.removeEventListener('abort', onAbort);
        }
      }
      const callBase = ctx?.callId ?? mintCallId();
      requestCounter += 1;
      const scope: ActionScope = {
        requestId: callBase + ':' + requestCounter,
        seq: 0,
        actor: actorOf(ctx?.caller),
        action: descriptor,
        area: runOptions.area ?? 'global',
        hwnd: runOptions.hwnd,
        window: runOptions.window,
        clientVersion,
        snapshotVersion,
        signal: controller.signal,
        abort: controller,
        sink,
      };
      live.add(scope);
      // A caller that sends real input to a page passes 'window': its CSS coordinates are not screen pixels, and the audit
      // must never pretend they are. A desktop action keeps the physical default.
      const space: ActionSpace = runOptions.space ?? 'physical';
      emit(scope, 'queued', { space });
      let hold = false;
      const token = 'lease:' + randomUUID();
      // Counted in before the lease is asked for and, unlike `live`, counted out only after the release attempt below:
      // a step cancelled while it is still queued behind the lease is unfinished until its acquire fails and it returns.
      leaseEntered();
      try {
        await theGate().acquire(token, scope.signal);
        scope.leaseId = token;
        active = scope;
        emit(scope, 'granted', { space, sampleMs: Date.now() });
        const base: CallCtx = { caller: ctx?.caller, signal: scope.signal, callId: callBase, arbiter: instance };
        const result = await storage.run({ ...base, action: scope }, () => work(scope));
        emit(scope, 'succeeded', { space, sampleMs: Date.now(), ok: true });
        return result;
      } catch (error) {
        if (error instanceof CancelledError) emit(scope, 'cancelled', { space, reason: error.message, ok: false });
        // The same catch covers the acquire and the work: a lease is held only once the acquire returned, so an Uncertain
        // from a failed acquire is not marked lease-held.
        else if (error instanceof UncertainError) { poisoned = error.base; poisonOrigin = mergeOrigin(poisonOrigin, originOf(error, scope.leaseId !== undefined)); hold = true; emit(scope, 'uncertain', { space, reason: error.message, ok: false }); }
        else emit(scope, 'failed', { space, reason: errorText(error), ok: false });
        throw error;
      } finally {
        live.delete(scope);
        if (active === scope) active = undefined;
        detach?.();
        if (!hold && !retired && scope.leaseId !== undefined) {
          try { await theGate().release(scope.leaseId); } catch { /* the broker is gone, and poison already covers it */ }
        }
        leaseLeft();
      }
    },
  };
  return instance;
}

// One shared fallback instance for code paths that never ran through ComputerUse.withCall (tests, direct driver use).
let fallback: Arbiter | undefined;
function defaultArbiter(): Arbiter { if (!fallback) fallback = createArbiter(); return fallback; }
function activeArbiter(): Arbiter { return storage.getStore()?.arbiter ?? defaultArbiter(); }

export function configureArbiter(options: ArbiterOptions): void { defaultArbiter().configure(options); }
export function poison(reason = '上一步结果不明，状态未知。'): void { activeArbiter().poison(reason); }
export function poisonedReason(): string | undefined { return activeArbiter().poisonedReason(); }
export function resetArbiter(): void { defaultArbiter().reset(); }
export function withCall<T>(caller: TrustedCallerContext | undefined, signal: AbortSignal | undefined, fn: () => Promise<T>, arbiter?: Arbiter): Promise<T> {
  if (arbiter) return arbiter.withCall(caller, signal, fn);
  return activeArbiter().withCall(caller, signal, fn);
}
export function withGlobalLease<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> { return activeArbiter().withGlobalLease(fn, signal); }
export function runAction<T>(descriptor: ActionDescriptor, work: (scope: ActionScope) => Promise<T>, options?: RunActionOptions): Promise<T> {
  return activeArbiter().runAction(descriptor, work, options);
}
