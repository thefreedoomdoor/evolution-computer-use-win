/**
 * The in-process ("native") transport of this plugin: the same computer-use tools the MCP server serves, registered
 * in the host's own tool service, one set per live agent, with the calling agent proven from the host's execution
 * context instead of from anything the model can type into an argument.
 *
 * The gateway also owns the two files the user drives the desktop with, exactly as the MCP server does: the shared
 * desktop-mode.json (polled read-only and broadcast to every agent) and the desktop-stopped stop sign (while it is
 * there every tool call is refused). Desktop actions reported by a runtime are forwarded to the overlay's
 * process-wide pointer runtime, an agent that goes away has its overlay pointers released through that same runtime,
 * and a `multi_mouse` tool toggles the overlay for the caller's subagent tree.
 *
 * Nothing here imports a host package. The host types are structural, so this module builds and unit-tests without
 * a running DSH.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { isDesktopMode } from './desktop/mode.ts';
import { STOPPED } from './desktop/turns.ts';
import type { Image } from './shared/image.ts';
import type { ActionActor, ActionEvent, ToolResult, ToolSpec, TrustedCallerContext } from './tool.ts';

export type { TrustedCallerContext } from './tool.ts';

/** One live agent as the host hands it to a tool registration or a tool call. */
export interface NativeAgent {
  readonly id: string;
  readonly ctx?: NativeAgentContext;
  readonly session?: { readonly header?: unknown };
}

/** The agent-scoped context; tools registered here belong to that agent and unwind with it. */
export interface NativeAgentContext {
  readonly tools: NativeToolsService;
}

export interface NativeToolsService {
  register(definition: unknown, options?: NativeRegisterOptions): () => void;
}

export interface NativeRegisterOptions {
  when?(context: NativeActivation): boolean | Promise<boolean>;
  [key: string]: unknown;
}

export interface NativeActivation {
  readonly agent: NativeAgent;
  readonly signal?: AbortSignal;
}

export interface NativeAgentsService {
  get(id: string): NativeAgent | undefined;
  list?(): NativeAgent[];
}

export interface NativeSubagentsService {
  rootOf(agent: NativeAgent): NativeAgent;
}

/** A picture the host has stored: what goes into the result value and back out as an image block. */
export interface NativeImageAttachmentRef {
  readonly attachmentId: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly name?: string;
  readonly originalDimensions?: { readonly width: number; readonly height: number };
}

export interface NativeAttachmentStore {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<NativeImageAttachmentRef>;
}

/** What the host context has to offer this gateway. Everything is optional and checked before use: fail closed. */
export interface NativeGatewayContext {
  readonly agents?: NativeAgentsService;
  readonly subagents?: NativeSubagentsService;
  get?(name: string): unknown;
  on?(event: 'agent/created' | 'agent/disposed', listener: (payload: { agent: NativeAgent }) => void | Promise<void>): () => void;
}

/** The part of the host's tool execution this gateway reads. */
export interface NativeExecution {
  readonly signal: AbortSignal;
  readonly agent?: unknown;
  readonly callId?: string;
}

export type NativeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: NativeImageAttachmentRef };

/** What a tool call resolves to; it must match NATIVE_OUTPUT_SCHEMA exactly, because the host validates it. */
export interface NativeImageValue {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
  caption?: string;
}

export interface NativeToolValue {
  text: string;
  images: NativeImageValue[];
}

/**
 * Whose desktop a call touches, proven by this gateway from host state (the live agent object, the live-agent
 * registry and the subagent root) and passed to the runtime as its optional fourth argument. The contract itself
 * lives in src/tool.ts (TrustedCallerContext) because the input layer keys window-level arbitration on it; the agent
 * object never leaves the gateway.
 */

/**
 * Per-lifetime paths: shared data for installed apps and procedures, and a private browser profile plus message log
 * that belong to exactly one runtime lifetime. A new lifetime of the same agent id never inherits them.
 */
export interface NativeAgentPaths {
  readonly dataDir: string;
  readonly profileDir: string;
  readonly messagesPath: string | null;
  readonly proceduresDir: string | null;
}

/** The slice of the repo's ComputerUse this gateway needs; keeps the gateway testable without a desktop. */
export interface NativeComputer {
  /**
   * True only when this runtime really hands the trusted caller to the desktop layer: the gateway refuses to
   * register tools for a runtime that would silently ignore the extra argument (and with it the agent's identity).
   */
  readonly acceptsCaller?: boolean;
  tools(): ToolSpec[];
  call(name: string, args: unknown, signal: AbortSignal, caller?: TrustedCallerContext): Promise<ToolResult>;
  stop(): void | Promise<void>;
  halt?(): void | Promise<void>;
  release?(): void | Promise<void>;
  autoInit?(): void;
  desktopMode?(): string;
  setDesktopMode?(mode: string): void;
}

/** What the gateway hands a runtime so each desktop action can be shown while it happens. */
export interface NativeRuntimeHooks {
  /** One action as the desktop layer reports it; forwarded unchanged to the overlay runtime. */
  onAction?(event: ActionEvent): void;
  /** The user pressed stop inside this runtime; the gateway raises the shared stop sign so every agent stops too. */
  onHalt?(): void;
}

export type NativeComputerFactory = (
  paths: NativeAgentPaths,
  agent: NativeAgent,
  hooks: NativeRuntimeHooks,
) => NativeComputer | Promise<NativeComputer>;

/** The desktop mode patch the overlay merges per root: absent fields keep their value, enabled changes the epoch. */
export interface NativeModePatch {
  enabled?: boolean;
  task?: string;
}

/** The overlay's process-wide pointer runtime (plugin/lib/multi-mouse-runtime.mjs); only what the gateway calls. */
export interface NativeMultiMouseRuntime {
  publishAction?(event: ActionEvent): void;
  publishMode?(rootId: string, patch: NativeModePatch): unknown;
  getMode?(rootId: string): { rootId: string; enabled: boolean; task: string; epoch: number } | undefined;
  /**
   * Announce one live agent so the overlay knows a pointer may belong to it (label, colour, lifetime).
   * Paired with publishActorDisposed; together they are the lifecycle the pointer writer cannot infer by itself.
   */
  publishActorLive?(actor: ActionActor): unknown;
  /**
   * Release the pointers one agent owns once that agent is gone. The fade position is the renderer's job: it samples
   * the real cursor on the C# side, so the gateway never hands over a cached point it cannot vouch for.
   */
  publishActorDisposed?(actor: ActionActor): unknown;
}

export interface NativeGatewayOptions {
  /** Shared data directory: installed-app index, init reports, procedures. Defaults to ~/.evolution-computer-use. */
  dataRoot?: string;
  /** Where procedures live; string to share one library, false for none. Defaults to <dataRoot>/procedures. */
  proceduresDir?: string | false;
  /** Mode every runtime starts in; the user's mode file can change it afterwards. */
  desktopMode?: string;
  /** Per-agent conversation log; false turns logging off. Defaults to on. */
  messages?: boolean;
  /**
   * Run one incremental scan when the gateway mounts (parity with the MCP server, which scans on startup). The scan
   * runs on a runtime of its own so it happens even before the first tool call; off unless asked.
   */
  autoInit?: boolean;
  /** The user's desktop mode file, polled read-only like the MCP server does; false turns polling off. */
  modeFile?: string | false;
  /** The stop sign a user sets to stop every agent; defaults to <dataRoot>/desktop-stopped. false disables it. */
  stopFile?: string | false;
  /** How often the two files above are read. Defaults to 800ms, the interval the MCP server uses. */
  pollMs?: number;
  /**
   * The overlay's pointer runtime. Missing or false leaves the gateway working without the overlay; production
   * loads it lazily from plugin/lib/multi-mouse-runtime.mjs because the runtime is one process-wide singleton.
   */
  multiMouse?: NativeMultiMouseRuntime | false;
  /** Builds an agent's runtime; tests swap in a fake. */
  createComputer?: NativeComputerFactory;
  /** How long dispose() waits for runtimes to stop before giving up on them (default 10s; 0 waits forever). */
  shutdownGraceMs?: number;
  log?(text: string): void;
}

export interface NativeGateway {
  /** Unwind every registration, stop every runtime and stop adopting new agents. */
  dispose(): Promise<void>;
  /** The agent's registered tool names, or every name currently registered. */
  toolNames(agentId?: string): string[];
  /** How many agents the gateway runs. */
  size(): number;
  /** Apply a desktop mode to every current and future runtime (the user's global switch). */
  setDesktopMode(mode: string): void;
  /** Whether the user's stop sign is up, which refuses every tool call until it is removed. */
  halted(): boolean;
}

const PREFIX = '[evolution-computer-use] ';

/** Where the settings page records the user's global desktop mode; the MCP server polls the same file. */
const SHARED_MODE_FILE = join(homedir(), '.evolution-computer-use', 'desktop-mode.json');

/** The MCP server's interval for the mode file and the stop sign. */
const DEFAULT_POLL_MS = 800;

/**
 * How long shutdown waits for runtimes to stop. A browser that never answers its stop, or a factory that never
 * resolves, must not keep the host from unloading the plugin; the wait is abandoned and reported instead.
 */
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

/** The error a tool call fails with when the host state does not prove whose desktop it would touch. */
export class NativeGatewayError extends Error {
  readonly code: string;

  constructor(message: string, code = 'TOOL_CONTEXT_UNAVAILABLE', options?: ErrorOptions) {
    super(PREFIX + message, options);
    this.name = 'NativeGatewayError';
    this.code = code;
  }
}

/** The value schema; the host validates every resolved value against it before rendering. */
export const NATIVE_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          name: { type: 'string' },
          caption: { type: 'string' },
        },
        required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
        additionalProperties: false,
      },
    },
  },
  required: ['text', 'images'],
  additionalProperties: false,
};

/** The overlay toggle. Its root is proven, not typed: no agentId/rootId is ever a model argument. */
const MULTI_MOUSE_SPEC: ToolSpec = {
  name: 'multi_mouse',
  description:
    '把本子 Agent 树里各 Agent 的指针和动作叠加显示在用户的桌面上（只影响调用者所在的那棵树，默认关闭）。' +
    'enabled 打开或关闭；task 是显示条上的任务文案，不要写 App 名。不要传 agentId 或 rootId：网关按调用者身份决定。',
  inputSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', description: 'true 打开显示，false 关闭' },
      task: { type: 'string', description: '显示条上的任务文案，例如「整理季度报表」；不要写 App 名' },
    },
    required: ['enabled'],
    additionalProperties: false,
  },
  execute: async (): Promise<ToolResult> => {
    throw new Error('multi_mouse runs through the gateway, not through a ComputerUse runtime');
  },
};

interface ToolHandle {
  dispose: () => void;
  fingerprint: string;
}

/** The root an agent was proven to belong to, together with the frozen trusted caller built from it exactly once. */
interface AgentStateIdentity {
  readonly root: NativeAgent;
  readonly caller: TrustedCallerContext;
}

interface AgentState {
  readonly key: string;
  readonly agent: NativeAgent;
  readonly tools: NativeToolsService;
  readonly paths: NativeAgentPaths;
  /** The lifetime drawn once for this state (never reused); the caller built on first proof carries it. */
  readonly lifetime: number;
  /**
   * The proven identity, committed in one assignment the first time a call really resolves this agent's root. It stays
   * null until then: a delegated child is announced before the host has entered it into the subagent tree, so its root
   * cannot be resolved at creation. Keeping the root and the caller together means the announced actor and the caller
   * handed to a runtime can never disagree, and `lifetime` above stays independent of it.
   */
  identity: AgentStateIdentity | null;
  computer: NativeComputer | null;
  readonly handles: Map<string, ToolHandle>;
  disposed: boolean;
  /** True once the overlay was told this agent exists; only then is there anything to release. */
  live: boolean;
  syncing: boolean;
  pending: boolean;
  /** The in-flight unwind of this state, shared by every caller so one stop is never awaited twice or lost. */
  teardown: Promise<void> | null;
}

function isAgent(value: unknown): value is NativeAgent {
  if (typeof value !== 'object' || value === null) return false;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0;
}

function depthOf(agent: NativeAgent): number {
  const header = agent.session?.header as { delegationDepth?: unknown } | undefined;
  const depth = header?.delegationDepth;
  return typeof depth === 'number' && Number.isSafeInteger(depth) && depth >= 0 ? depth : 0;
}

function fingerprintOf(spec: ToolSpec): string {
  return JSON.stringify({ description: spec.description, schema: spec.inputSchema });
}

/** A stable, filesystem-safe directory name per agent id. */
export function agentKey(agentId: string): string {
  if (/^[A-Za-z0-9._-]{1,96}$/.test(agentId)) return agentId;
  return 'agent-' + Buffer.from(agentId, 'utf8').toString('hex').slice(0, 96);
}

/**
 * A random, filesystem-safe directory name for one gateway instance. Two gateways on the same data directory (a
 * reloaded plugin next to a runtime that is still shutting down, or two hosts sharing ~/.evolution-computer-use) never
 * land in the same directory, so a profile or log of one instance can never be opened by another.
 */
function newNamespace(): string {
  return 'gw-' + randomBytes(6).toString('hex');
}

/**
 * The shared lifetime counter. The overlay's pointer runtime outlives a gateway instance (plugin/lib/multi-mouse-runtime.mjs
 * keeps every released lifetime as a tombstone and drops any action whose lifetime is not newer), so a per-install
 * counter that restarts at 1 would hand a new runtime of the same agent id a lifetime the shared runtime already
 * retired: announcing it succeeds, yet every real action is dropped.
 *
 * The counter lives on `globalThis` under a registered symbol, so every gateway installed from this module in the
 * same JavaScript realm shares one sequence, and an ESM re-import (plugin reload) of this module finds the same slot
 * instead of a fresh zero. The guarantee is limited to that realm: another worker, VM context or process has its own
 * `globalThis` and its own overlay runtime, so no sequence is promised across them. Whether a real host's HMR keeps
 * one realm is not proven here and stays a live-acceptance item.
 */
const LIFETIME_SLOT = Symbol.for('evolution-computer-use.native-lifetime-sequence');

/** The slot the lifetime sequence is kept in; exported so a test can read and restore it. */
export const LIFETIME_SEQUENCE_SLOT: symbol = LIFETIME_SLOT;

/**
 * Take the next shared lifetime: a positive safe integer, strictly greater than every lifetime this realm handed out
 * before. It is a pure counter — never derived from tool arguments, page content or the host identity — so no caller
 * can choose, reuse or replay a lifetime, and the shared runtime's "a newer lifetime supersedes the old one" rule
 * keeps working across gateway installs.
 *
 * A missing slot is the only value that means "nothing handed out yet". Any other value that is not a non-negative
 * safe integer is corruption, and so is an exhausted counter: both fail closed. Silently treating them as zero would
 * hand out lifetimes the shared runtime has already retired, which is exactly the failure this counter prevents.
 */
function nextLifetime(): number {
  const bag = globalThis as unknown as Record<symbol, unknown>;
  // Presence, not value: an own property that exists but holds undefined (or anything else unusable) is a damaged
  // slot, not an empty one. Only a slot that is genuinely absent may start at 1.
  if (!Object.hasOwn(bag, LIFETIME_SLOT)) {
    bag[LIFETIME_SLOT] = 1;
    return 1;
  }
  const current = bag[LIFETIME_SLOT];
  if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 0) {
    throw new NativeGatewayError(
      'the shared runtime lifetime sequence is corrupt: expected a non-negative safe integer, got ' + describeValue(current),
    );
  }
  if (current >= Number.MAX_SAFE_INTEGER) {
    // Never wrap around into a lifetime the shared runtime may have retired: fail closed instead of reusing a number.
    throw new NativeGatewayError('the shared runtime lifetime sequence is exhausted');
  }
  const next = current + 1;
  bag[LIFETIME_SLOT] = next;
  return next;
}

/** A short, log-safe description of a corrupt slot value (never echoes a huge payload into a tool error). */
function describeValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value.slice(0, 32));
  if (value === null) return 'null';
  return typeof value;
}

/**
 * Read a host service without depending on a static inject list: the declared accessor first, then a defensive
 * property read. A host that has not provided the service yet yields undefined instead of throwing.
 */
function serviceOf<T>(ctx: NativeGatewayContext, name: string): T | undefined {
  const getter = ctx.get;
  if (typeof getter === 'function') {
    try {
      const value = getter.call(ctx, name);
      if (value) return value as T;
    } catch {
      // not provided yet; fall through to the direct read
    }
  }
  try {
    const value = (ctx as unknown as Record<string, unknown>)[name];
    return value ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new NativeGatewayError('the tool call was cancelled', 'ABORTED');
}

function assertComputer(value: unknown, agent: NativeAgent): NativeComputer {
  if (typeof value !== 'object' || value === null) throw new NativeGatewayError('the computer runtime for agent "' + agent.id + '" was not created');
  const candidate = value as Partial<NativeComputer>;
  if (typeof candidate.tools !== 'function' || typeof candidate.call !== 'function' || typeof candidate.stop !== 'function') {
    throw new NativeGatewayError('the computer runtime for agent "' + agent.id + '" is missing tools/call/stop');
  }
  return candidate as NativeComputer;
}

function renderValue(_args: unknown, value: unknown): NativeContentBlock[] {
  const result = value as NativeToolValue;
  const blocks: NativeContentBlock[] = [{ type: 'text', text: result.text }];
  for (const image of result.images) {
    if (image.caption) blocks.push({ type: 'text', text: image.caption });
    blocks.push({ type: 'image', attachment: imageAttachment(image) });
  }
  return blocks;
}

function imageAttachment(image: NativeImageValue): NativeImageAttachmentRef {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name ? { name: image.name } : {}),
  };
}

function imageName(toolName: string, index: number, mediaType: string): string {
  const extension = mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : mediaType === 'image/gif' ? 'gif' : 'png';
  return toolName + '-' + (index + 1) + '.' + extension;
}

/**
 * Run one teardown step. A registration that refuses to unwind must not keep the others registered, and a runtime
 * whose stop is asynchronous must not leave an unhandled rejection or a dangling promise behind: the rejection is
 * reported through the same log as everything else, and the caller may still await the work it started.
 */
function safeDispose(action: () => unknown, log?: (text: string) => void): void {
  try {
    const result = action();
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result as PromiseLike<unknown>).catch(error => {
        log?.('a runtime did not unwind cleanly: ' + (error instanceof Error ? error.message : String(error)));
      });
    }
  } catch (error) {
    log?.('a runtime did not unwind cleanly: ' + (error instanceof Error ? error.message : String(error)));
  }
}

/** Phases after which one desktop action is over for good; the epoch pinned for it is dropped with them. */
const FINAL_PHASES = new Set<string>(['succeeded', 'cancelled', 'failed', 'uncertain']);

/**
 * One action is one (root, request) pair: every phase the desktop layer reports for that request carries the same
 * pair, so it is also the key under which the overlay epoch of that action is pinned.
 */
function epochKeyOf(event: ActionEvent): string | null {
  const actor = event.actor;
  if (!actor || typeof actor.rootAgentId !== 'string' || typeof event.requestId !== 'string') return null;
  return actor.rootAgentId + '\u0000' + event.requestId;
}

/**
 * Mount the native gateway on a host context. Tools appear per agent, on that agent's own scoped tool service, so a
 * subagent sees its own list, keeps its own browser profile, and loses both when the agent goes away. Every runtime
 * lifetime gets a fresh profile and message log under this instance's own random namespace: nothing is ever reused,
 * so a runtime that is still shutting down can never be reopened by its successor.
 */
export function installNativeGateway(ctx: NativeGatewayContext, options: NativeGatewayOptions = {}): NativeGateway {
  const dataRoot = options.dataRoot ?? join(homedir(), '.evolution-computer-use');
  const proceduresDir = options.proceduresDir === false ? null : options.proceduresDir ?? join(dataRoot, 'procedures');
  const log = options.log ?? ((text: string) => { process.stderr.write(PREFIX + text + '\n'); });
  const modeFile = options.modeFile === false ? null : options.modeFile ?? SHARED_MODE_FILE;
  const stopFile = options.stopFile === false ? null : options.stopFile ?? join(dataRoot, 'desktop-stopped');
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const graceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  /** This instance's directory namespace: one random name per installNativeGateway call. */
  const namespace = newNamespace();

  const states = new WeakMap<object, AgentState>();
  const byId = new Map<string, AgentState>();
  /**
   * Agents whose own runtime was already refused for dropping the trusted caller. The adoption sweep and the
   * agent/created event both start one agent, so without this memo the refusal path (which unwinds its state and dies)
   * would build and stop a second runtime for the same still-live object. Keyed by the live agent object, so a brand-new
   * lifetime of the same id (a fresh object) may still try its own runtime.
   */
  const refused = new WeakSet<object>();
  /**
   * Unwinds that are still running. A disposed state leaves byId immediately, so this is the only record of a stop
   * that has not finished yet: a new Agent reusing the id waits for it (its own paths are fresh either way, the wait
   * only keeps two runtimes of one id from overlapping), and dispose() awaits it.
   */
  const teardowns = new Map<string, Promise<void>>();
  /** Starts in flight, per agent id; dispose() waits for them so a runtime built during shutdown is stopped too. */
  const starting = new Map<string, Promise<AgentState | null>>();
  const listeners: Array<() => void> = [];
  let mode = options.desktopMode;
  let disposing = false;
  let halted = stopFile ? existsSync(stopFile) : false;
  let supervisor: NativeComputer | null = null;
  let initStarted = false;
  let multiMouse: NativeMultiMouseRuntime | null = options.multiMouse === false ? null : options.multiMouse ?? null;
  let multiMouseLoading = options.multiMouse !== false && !multiMouse;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  function fail(message: string, code?: string, cause?: ErrorOptions): never {
    throw new NativeGatewayError(message, code, cause);
  }

  /**
   * The overlay drops an event whose epoch is older than the current epoch of its root. The desktop layer reports one
   * action across several callbacks (queued, granted, executing, …), so the epoch is read once for the request and
   * repeated on every phase: switching task in the middle must never re-stamp a running action with the new epoch,
   * which would draw it as part of the new task.
   */
  const epochOfRequest = new Map<string, number>();

  function pinEpoch(event: ActionEvent, runtime: NativeMultiMouseRuntime): ActionEvent {
    const key = epochKeyOf(event);
    if (!key) return event;
    let epoch = epochOfRequest.get(key);
    if (epoch === undefined) {
      let now: { epoch?: unknown } | undefined;
      try {
        now = typeof runtime.getMode === 'function' ? runtime.getMode(event.actor.rootAgentId) : undefined;
      } catch {
        now = undefined;
      }
      if (!now || typeof now.epoch !== 'number') return event;
      epoch = now.epoch;
      epochOfRequest.set(key, epoch);
      if (epochOfRequest.size > 512) {
        // One action that never reports a final phase must not keep the map growing forever.
        const oldest = epochOfRequest.keys().next();
        if (!oldest.done) epochOfRequest.delete(oldest.value);
      }
    }
    return { ...event, epoch } as ActionEvent;
  }

  /** One frozen identity, shared by the actor we announce and the one we release. */
  function actorOf(caller: TrustedCallerContext): ActionActor {
    return {
      trust: 'trusted',
      agentId: caller.agentId,
      rootAgentId: caller.rootAgentId,
      depth: caller.depth,
      lifetime: caller.lifetime,
    };
  }

  /**
   * Announce one live agent. Returns false only when the overlay explicitly refused it — then there is nothing drawn to
   * release. A missing method or a throw is best effort: the release stays harmless, so it is still attempted.
   */
  function publishActorLive(caller: TrustedCallerContext): boolean {
    const runtime = multiMouse;
    if (!runtime || typeof runtime.publishActorLive !== 'function') return true;
    try {
      return runtime.publishActorLive(actorOf(caller)) !== false;
    } catch (error) {
      log('cannot announce agent "' + caller.agentId + '" to the overlay: ' + (error instanceof Error ? error.message : String(error)));
      return true;
    }
  }

  function publishAction(event: ActionEvent): void {
    const runtime = multiMouse;
    if (!runtime || typeof runtime.publishAction !== 'function') return;
    try {
      runtime.publishAction(pinEpoch(event, runtime));
      const key = epochKeyOf(event);
      if (key && FINAL_PHASES.has(event.phase)) epochOfRequest.delete(key);
    } catch (error) {
      log('cannot publish a desktop action to the overlay: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  function publishMode(rootId: string, patch: NativeModePatch): void {
    const runtime = multiMouse;
    if (!runtime || typeof runtime.publishMode !== 'function') fail('the overlay pointer runtime is not available', 'TOOL_UNAVAILABLE');
    try {
      runtime.publishMode(rootId, patch);
    } catch (error) {
      fail('cannot reach the overlay pointer runtime', 'TOOL_UNAVAILABLE', { cause: error });
    }
  }

  /**
   * The overlay runtime is one process-wide singleton, so the gateway joins it instead of creating one; until it
   * loads (or if the plugin is not installed) desktop actions simply are not published and multi_mouse stays absent.
   */
  async function ensureMultiMouse(): Promise<void> {
    if (!multiMouseLoading || multiMouse) return;
    multiMouseLoading = false;
    let loaded: { getMultiMouseRuntime?: (options?: unknown) => NativeMultiMouseRuntime };
    try {
      const specifier = new URL('../plugin/lib/multi-mouse-runtime.mjs', import.meta.url).href;
      loaded = (await import(specifier)) as { getMultiMouseRuntime?: (options?: unknown) => NativeMultiMouseRuntime };
    } catch (error) {
      log('the overlay pointer runtime is not installed; multi_mouse stays off (' + (error instanceof Error ? error.message : String(error)) + ')');
      return;
    }
    const factory = loaded.getMultiMouseRuntime;
    if (typeof factory !== 'function') {
      log('the overlay pointer runtime exports no getMultiMouseRuntime; multi_mouse stays off');
      return;
    }
    try {
      if (disposing) return;
      multiMouse = factory() ?? null;
      if (multiMouse) {
        for (const state of byId.values()) {
          // Agents that came up before the overlay did are announced now, in the same order the writer will see. A
          // child with no resolvable root yet has no identity, so announceIdentity leaves it for its first proven call.
          if (state.disposed) continue;
          announceIdentity(state);
          registerTools(state);
        }
      }
    } catch (error) {
      log('cannot start the overlay pointer runtime: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  function applyMode(value: string): void {
    mode = value;
    for (const state of byId.values()) {
      if (state.disposed || !state.computer) continue;
      safeDispose(() => state.computer!.setDesktopMode?.(value), log);
    }
  }

  function applyHalt(value: boolean): void {
    if (halted === value) return;
    halted = value;
    for (const state of byId.values()) {
      if (state.disposed || !state.computer) continue;
      const computer = state.computer;
      safeDispose(() => (value ? computer.halt?.() : computer.release?.()), log);
    }
  }

  /**
   * The user pressed stop inside one runtime. The stop sign is the file on disk, as it is for the MCP server, so it
   * outlasts the agent that was stopped and every other agent honours it; until it is gone, every call is refused.
   */
  function raiseStop(): void {
    if (halted) return;
    applyHalt(true);
    if (!stopFile) return;
    try {
      mkdirSync(dirname(stopFile), { recursive: true });
      writeFileSync(stopFile, new Date().toISOString());
    } catch (error) {
      log('cannot write the stop sign at ' + stopFile + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  /**
   * Read the user's two files. Both are shared with the MCP server and the settings page: this gateway only reads
   * them and broadcasts what it sees, exactly like the server's 800ms poll. A file caught mid-write is ignored.
   */
  async function poll(): Promise<void> {
    if (polling || disposing) return;
    polling = true;
    try {
      if (stopFile) {
        let present: boolean;
        try {
          present = existsSync(stopFile);
        } catch {
          present = halted;
        }
        applyHalt(present);
      }
      if (modeFile) {
        let text: string | null = null;
        try {
          text = await readFile(modeFile, 'utf8');
        } catch {
          text = null;
        }
        if (text) {
          let wanted: unknown;
          try {
            wanted = (JSON.parse(text) as { desktopMode?: unknown }).desktopMode;
          } catch {
            wanted = undefined;
          }
          if (typeof wanted === 'string' && isDesktopMode(wanted) && wanted !== mode) applyMode(wanted);
        }
      }
    } finally {
      polling = false;
    }
  }

  function pathsOf(key: string): NativeAgentPaths {
    return {
      dataDir: dataRoot,
      profileDir: join(dataRoot, 'browser', namespace, key),
      messagesPath: options.messages === false ? null : join(dataRoot, 'agents', namespace, key, 'messages.jsonl'),
      proceduresDir,
    };
  }

  async function create(agent: NativeAgent, paths: NativeAgentPaths): Promise<NativeComputer> {
    const factory = options.createComputer ?? defaultComputer;
    const hooks: NativeRuntimeHooks = {
      onAction: event => publishAction(event),
      onHalt: () => raiseStop(),
    };
    return assertComputer(await factory(paths, agent, hooks), agent);
  }

  /**
   * Prove the calling agent from the host's execution context and return the trusted caller it is bound to. The first
   * call that really resolves the root commits that root and caller once and announces the actor; later calls only
   * re-check it. Anything that fails here — a foreign or dead agent, an unresolvable or non-live root, a root that
   * changed, a cancelled or halted call — fails before any binding or announce, so a failed call never leaves a new
   * actor behind.
   */
  function prove(state: AgentState, exec: NativeExecution | undefined): TrustedCallerContext {
    if (disposing) fail('the native gateway is shutting down', 'TOOL_CONTEXT_UNAVAILABLE');
    if (state.disposed) fail('this agent\'s computer-use runtime was disposed', 'TOOL_CONTEXT_UNAVAILABLE');
    const caller = exec?.agent;
    if (!isAgent(caller)) fail('the call has no calling agent; refusing to guess whose desktop it would touch');
    if (caller !== state.agent) fail('the calling agent does not own this tool registration');
    const agents = serviceOf<NativeAgentsService>(ctx, 'agents');
    if (!agents || typeof agents.get !== 'function') fail('this host exposes no live-agent registry');
    if (agents.get(caller.id) !== caller) fail('agent "' + caller.id + '" is not the live agent (disposed or replaced)');
    const subagents = serviceOf<NativeSubagentsService>(ctx, 'subagents');
    let root: unknown = undefined;
    try {
      root = subagents?.rootOf?.(caller);
    } catch (error) {
      fail('cannot resolve the calling agent\'s root agent', 'TOOL_CONTEXT_UNAVAILABLE', { cause: error });
    }
    if (!isAgent(root)) fail('cannot resolve the calling agent\'s root agent');
    if (agents.get(root.id) !== root) fail('the calling agent\'s root agent is not live');
    if (state.identity) {
      if (root !== state.identity.root) fail('the calling agent\'s root changed since this runtime was created', 'TOOL_ROOT_CHANGED');
    }
    const signal = exec?.signal;
    if (!signal || typeof signal !== 'object' || typeof signal.aborted !== 'boolean') {
      fail('the call has no cancellation signal');
    }
    if (signal.aborted) throw abortReason(signal);
    // The stop sign refuses every call: desktop input, browser tools (the agent's own browser included) and the
    // overlay toggle. Nothing runs again until the user removes the file, which releases every runtime in poll().
    if (halted) fail(STOPPED + '（停下期间不执行任何桌面操作；等用户解除后再来。）', 'TOOL_STOPPED');
    const wasBound = state.identity !== null;
    const bound = bindIdentity(state, root);
    // Only the call that first bound the identity announces it; a state bound early in begin was announced there.
    if (!wasBound) announceIdentity(state);
    return bound;
  }

  /**
   * Commit the proven root and the caller built from it in a single synchronous step, so a reader never sees one
   * without the other. A state that is already bound keeps its identity and this returns the same caller. It never
   * announces: begin announces an early bind at the point it always did, and prove announces a first-call bind above.
   */
  function bindIdentity(state: AgentState, root: NativeAgent): TrustedCallerContext {
    const bound = state.identity;
    if (bound) return bound.caller;
    const caller: TrustedCallerContext = Object.freeze({
      identity: 'trusted',
      agentId: state.agent.id,
      rootAgentId: root.id,
      depth: depthOf(state.agent),
      lifetime: state.lifetime,
      sessionId: state.agent.id,
    });
    state.identity = { root, caller };
    return caller;
  }

  /**
   * Tell the overlay this agent exists, once. A state with no identity yet (a delegated child whose root was not
   * resolvable at creation) is announced later, by its first proven call, never here without an identity.
   */
  function announceIdentity(state: AgentState): void {
    if (state.live || !state.identity) return;
    state.live = publishActorLive(state.identity.caller);
  }

  async function toValue(toolName: string, result: ToolResult): Promise<NativeToolValue> {
    const text = typeof result?.text === 'string' ? result.text : String(result?.text ?? '');
    const images = Array.isArray(result?.images) ? result.images : [];
    if (!images.length) return { text, images: [] };
    let store: NativeAttachmentStore | undefined;
    try {
      store = ctx.get?.('attachments') as NativeAttachmentStore | undefined;
    } catch {
      // A host that does not provide the attachment store must not lose the picture silently; fail closed below.
      store = undefined;
    }
    if (!store || typeof store.saveImage !== 'function') {
      fail('this host cannot store images, so a screenshot would be lost', 'TOOL_CONTEXT_UNAVAILABLE');
    }
    const saved: NativeImageValue[] = [];
    const list: Image[] = images;
    for (const [index, image] of list.entries()) {
      const ref = await store.saveImage({ data: image.data, mediaType: image.mediaType, name: imageName(toolName, index, image.mediaType) });
      saved.push({
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name ? { name: ref.name } : {}),
        ...(image.caption ? { caption: image.caption } : {}),
      });
    }
    return { text, images: saved };
  }

  function definitionFor(state: AgentState, spec: ToolSpec): Record<string, unknown> {
    return {
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
      output: { schema: NATIVE_OUTPUT_SCHEMA, render: renderValue },
      // Never marked concurrency-safe: the host must not run two desktop calls for one agent at the same time.
      execute: (args: unknown, exec: NativeExecution): Promise<NativeToolValue> =>
        spec.name === MULTI_MOUSE_SPEC.name ? executeMultiMouse(state, args, exec) : executeTool(state, spec.name, args, exec),
    };
  }

  async function executeTool(state: AgentState, name: string, args: unknown, exec: NativeExecution): Promise<NativeToolValue> {
    try {
      const proven = prove(state, exec);
      const signal = exec.signal;
      const computer = state.computer;
      if (!computer) fail('this agent\'s computer runtime is not ready', 'TOOL_CONTEXT_UNAVAILABLE');
      if (!computer.tools().some(spec => spec.name === name)) {
        fail('tool "' + name + '" is not enabled for this agent', 'TOOL_UNAVAILABLE');
      }
      // The caller is built per call so it carries this call's id; identity itself was proven above, never typed by
      // the model. A runtime created before this fourth parameter existed keeps its three-argument shape.
      const caller: TrustedCallerContext = Object.freeze({
        ...proven,
        ...(typeof exec.callId === 'string' && exec.callId ? { callId: exec.callId } : {}),
      });
      // Desktop actions themselves are reported by the runtime through NativeRuntimeHooks.onAction, which forwards
      // the layer's complete ActionEvent; the gateway never invents one.
      const result: ToolResult = await computer.call(name, args, signal, caller);
      if (signal.aborted) throw abortReason(signal);
      return await toValue(name, result);
    } finally {
      if (!state.disposed && !disposing) registerTools(state);
    }
  }

  async function executeMultiMouse(state: AgentState, args: unknown, exec: NativeExecution): Promise<NativeToolValue> {
    const identity = prove(state, exec);
    const input = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
    for (const key of Object.keys(input)) {
      if (key !== 'enabled' && key !== 'task') fail('unknown argument "' + key + '" for multi_mouse', 'INVALID_ARGUMENT');
    }
    const enabled = input.enabled;
    if (typeof enabled !== 'boolean') fail('multi_mouse needs "enabled": true or false', 'INVALID_ARGUMENT');
    const task = input.task;
    if (task !== undefined && typeof task !== 'string') fail('multi_mouse "task" must be text', 'INVALID_ARGUMENT');
    const runtime = multiMouse;
    const before = runtime && typeof runtime.getMode === 'function' ? runtime.getMode(identity.rootAgentId) : undefined;
    publishMode(identity.rootAgentId, { enabled, ...(typeof task === 'string' ? { task } : {}) });
    const now = runtime && typeof runtime.getMode === 'function' ? runtime.getMode(identity.rootAgentId) : undefined;
    // The overlay owns the epoch rule (a change of task must invalidate the old pointers too); this only notices when
    // the runtime it is talking to still bumps the epoch for the switch alone.
    const wantedTask = typeof task === 'string' ? task : before?.task;
    if (before && now && before.enabled === now.enabled && wantedTask !== before.task && now.epoch <= before.epoch) {
      log('the overlay did not bump the epoch for the task change on root "' + identity.rootAgentId + '"');
    }
    const shown = now ? (now.enabled ? '已打开' : '已关闭') : (enabled ? '已打开' : '已关闭');
    const detail = now?.task ? '，任务「' + now.task + '」' : typeof task === 'string' && task ? '，任务「' + task + '」' : '';
    return { text: '多指针显示' + shown + '（只影响本子 Agent 树' + detail + '）', images: [] };
  }

  function registerTools(state: AgentState): void {
    if (state.disposed || disposing) return;
    if (state.syncing) {
      state.pending = true;
      return;
    }
    const computer = state.computer;
    if (!computer) return;
    state.syncing = true;
    try {
      let specs: ToolSpec[];
      try {
        specs = computer.tools();
      } catch (error) {
        log('cannot read tools for agent "' + state.agent.id + '": ' + (error instanceof Error ? error.message : String(error)));
        return;
      }
      const wanted = new Map(specs.map(spec => [spec.name, spec] as const));
      // multi_mouse belongs to this gateway, not to the runtime: it toggles the overlay for the proven tree.
      if (multiMouse && typeof multiMouse.publishMode === 'function') wanted.set(MULTI_MOUSE_SPEC.name, MULTI_MOUSE_SPEC);
      for (const [name, handle] of [...state.handles]) {
        const spec = wanted.get(name);
        if (spec && fingerprintOf(spec) === handle.fingerprint) continue;
        safeDispose(handle.dispose);
        state.handles.delete(name);
      }
      for (const [name, spec] of wanted) {
        if (state.handles.has(name)) continue;
        try {
          const dispose = state.tools.register(definitionFor(state, spec));
          if (typeof dispose !== 'function') throw new Error('the host did not return a registration disposer');
          state.handles.set(name, { dispose, fingerprint: fingerprintOf(spec) });
        } catch (error) {
          log('cannot register "' + name + '" for agent "' + state.agent.id + '": ' + (error instanceof Error ? error.message : String(error)));
        }
      }
    } finally {
      state.syncing = false;
      if (state.pending) {
        state.pending = false;
        queueMicrotask(() => registerTools(state));
      }
    }
  }

  /**
   * Unwind one agent. The sync half (registrations, map entries, the release call) happens at once so nothing new can
   * register or resolve through this state; the async half (a runtime whose stop returns a promise) runs behind one
   * shared promise that every caller awaits, and that outlives the state's map entries, so a stop is never duplicated,
   * dropped, or left dangling.
   */
  function disposeState(state: AgentState): Promise<void> {
    if (state.teardown) return state.teardown;
    if (state.disposed) return Promise.resolve();
    state.disposed = true;
    for (const handle of state.handles.values()) safeDispose(handle.dispose, log);
    state.handles.clear();
    states.delete(state.agent);
    // A newer lifetime of the same id may already own the entry; only ever drop this state's own.
    if (byId.get(state.agent.id) === state) byId.delete(state.agent.id);
    const computer = state.computer;
    state.computer = null;
    const pointers = releasePointers(state);
    const id = state.agent.id;
    const teardown = trackTeardown(id, (async () => {
      if (computer) await settle(() => computer.stop(), 'cannot stop the runtime of agent "' + id + '"');
      await pointers;
    })());
    state.teardown = teardown;
    return teardown;
  }

  /** Remember an unwind by agent id until it settles, so a later lifetime and dispose() can await it. */
  function trackTeardown(id: string, teardown: Promise<void>): Promise<void> {
    teardowns.set(id, teardown);
    const forget = () => {
      if (teardowns.get(id) === teardown) teardowns.delete(id);
    };
    void teardown.then(forget, forget);
    return teardown;
  }

  /**
   * Stop a runtime that only appeared after its state was already unwound (the factory resolved late). The stop is
   * folded into the state's own teardown, so a new lifetime of the same id does not start on top of a browser that is
   * still closing (its own profile is separate, so the wait only avoids two runtimes of one agent overlapping).
   */
  async function retireRuntime(state: AgentState, computer: NativeComputer, what: string): Promise<void> {
    const prior = disposeState(state);
    const stopping = (async () => {
      await settle(() => computer.stop(), what);
      await prior;
    })();
    state.teardown = trackTeardown(state.agent.id, stopping);
    await stopping;
  }

  /**
   * Wait (bounded) for the previous lifetime of this agent id to finish stopping, so two runtimes of one agent do not
   * overlap. The next lifetime does not inherit anything from it: its profile and log are new directories, so a
   * predecessor that is stuck or refuses to stop costs time, never correctness.
   */
  async function waitForTeardown(agentId: string): Promise<void> {
    const running = teardowns.get(agentId);
    if (!running) return;
    await bounded(running, 'the previous runtime of agent "' + agentId + '"');
  }

  /**
   * Tell the overlay that this agent is gone so its pointers fade out. Through the runtime, never straight into the
   * pointer writer: the runtime stays the only writer of the overlay files.
   */
  async function releasePointers(state: AgentState): Promise<void> {
    // A runtime that never got accepted has nothing drawn on screen; releasing it would name an actor the overlay
    // never saw.
    if (!state.live || !state.identity) return;
    const runtime = multiMouse;
    if (!runtime || typeof runtime.publishActorDisposed !== 'function') return;
    const actor = actorOf(state.identity.caller);
    await settle(
      () => runtime.publishActorDisposed!(actor),
      'cannot release the pointers of agent "' + actor.agentId + '"',
    );
  }

  /**
   * Await shutdown work, but never past the grace period: a browser that ignores its stop, or a factory that never
   * resolves, must not keep the host from unloading the plugin. Returns true when the work finished in time.
   */
  async function bounded(work: Promise<unknown>, what: string, limitMs = graceMs): Promise<boolean> {
    const failure = (error: unknown) => {
      log(what + ': ' + (error instanceof Error ? error.message : String(error)));
    };
    if (!Number.isFinite(limitMs)) {
      try {
        await work;
      } catch (error) {
        failure(error);
      }
      return true;
    }
    if (limitMs <= 0) {
      log(what + ' was still running when shutdown ran out of time');
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<boolean>(resolve => {
      const handle = setTimeout(() => {
        log(what + ' did not finish within ' + Math.round(limitMs) + 'ms; giving up on it');
        resolve(false);
      }, limitMs);
      handle.unref?.();
      timer = handle;
    });
    try {
      return await Promise.race([work.then(() => true, error => { failure(error); return true; }), limit]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Await one teardown step, reporting a rejection instead of letting it escape as an unhandled promise. */
  async function settle(action: () => unknown, what: string): Promise<void> {
    try {
      await action();
    } catch (error) {
      log(what + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  /**
   * Start one agent's runtime. Two triggers can fire for the same agent (adoption while the gateway mounts and the
   * agent/created event), so starts are chained per agent id: the second one waits for the first and then finds its
   * state instead of building a second runtime that nothing would ever stop.
   */
  function start(agent: NativeAgent): Promise<AgentState | null> {
    const previous = starting.get(agent.id);
    const run = (async () => {
      if (previous) await previous.catch(() => null);
      return begin(agent);
    })();
    starting.set(agent.id, run);
    const forget = () => {
      if (starting.get(agent.id) === run) starting.delete(agent.id);
    };
    void run.then(forget, forget);
    return run;
  }

  async function begin(agent: NativeAgent): Promise<AgentState | null> {
    if (disposing) return null;
    // This very agent object already produced a runtime that ignored the trusted caller. Creating another would just
    // be refused and stopped again, so the second start of one agent is a no-op instead of a duplicate side effect.
    if (refused.has(agent)) return null;
    const agents = serviceOf<NativeAgentsService>(ctx, 'agents');
    if (!agents || typeof agents.get !== 'function') fail('this host exposes no live-agent registry');
    const existing = byId.get(agent.id);
    // Only the very same live object owns a state. A new lifetime of the same session id (cold resume, restart) never
    // inherits the previous lifetime's registrations, caller or runtime: the predecessor is unwound, and the new
    // runtime only starts once that unwind has really finished. Its profile and log are its own either way.
    if (existing) {
      if (existing.agent === agent) {
        if (!existing.disposed) return existing;
        await bounded(disposeState(existing), 'the previous runtime of agent "' + agent.id + '"');
      } else if (agents.get(existing.agent.id) !== existing.agent) {
        // The registry already moved on, so this state belongs to a lifetime that is gone: unwind it before the new
        // lifetime takes the id.
        await bounded(disposeState(existing), 'the previous runtime of agent "' + agent.id + '"');
      } else {
        // A stale object is asking for the id a live agent still owns.
        fail('agent "' + agent.id + '" is not the live agent');
      }
    }
    // Wait for the previous runtime of this id to finish stopping, so two runtimes of one agent never overlap. The
    // wait does not decide any path: every lifetime gets fresh paths below, whatever the predecessor did.
    await waitForTeardown(agent.id);
    if (disposing) return null;
    if (agents.get(agent.id) !== agent) fail('agent "' + agent.id + '" is not the live agent');
    const scoped = agent.ctx?.tools;
    if (!scoped || typeof scoped.register !== 'function') fail('agent "' + agent.id + '" has no agent-scoped tool service');
    const subagents = serviceOf<NativeSubagentsService>(ctx, 'subagents');
    // Try to resolve the root now. A root agent, or a child the host has already entered into the subagent tree,
    // resolves here and is bound exactly as the first call would bind it; begin announces it at the point it always
    // did. A delegated child is announced before the host enters it, so rootOf throws — that is "not yet", not a
    // failure, and the first call that can resolve it binds and announces then. No check is loosened: whatever is bound
    // now must still be a live agent object, and a later root that differs is refused with TOOL_ROOT_CHANGED.
    let earlyRoot: NativeAgent | null = null;
    try {
      const root = subagents?.rootOf?.(agent);
      if (isAgent(root) && agents.get(root.id) === root) earlyRoot = root;
    } catch {
      earlyRoot = null;
    }
    // One lifetime per runtime, taken from the process-wide sequence: a number is never reused in this process, so a
    // new runtime of an agent id the shared overlay already retired still gets a newer lifetime and its real actions
    // are accepted, and the per-instance namespace plus a never-reused number keep the truncated name unique.
    const lifetime = nextLifetime();
    const key = agentKey(agent.id).slice(0, 48) + '-l' + lifetime;
    const paths = pathsOf(key);
    const state: AgentState = {
      key,
      agent,
      tools: scoped,
      paths,
      lifetime,
      identity: null,
      computer: null,
      handles: new Map(),
      disposed: false,
      live: false,
      syncing: false,
      pending: false,
      teardown: null,
    };
    if (earlyRoot) bindIdentity(state, earlyRoot);
    states.set(agent, state);
    byId.set(agent.id, state);
    try {
      const computer = await create(agent, paths);
      // Creating a runtime takes real time (browser, procedures, desktop helper), and the agent can be disposed or
      // replaced while it runs. Re-prove the very same live objects before registering anything, so a torn-down state
      // never comes back to life with a runtime behind it.
      if (state.disposed || disposing || !stillOwned(state, agents)) {
        await retireRuntime(state, computer, 'cannot stop a runtime that outlived its agent');
        return null;
      }
      // Fail closed on a runtime that does not consume the trusted caller: registering its tools would let every
      // call run under no identity at all, which is exactly what this transport exists to prevent.
      if (computer.acceptsCaller !== true) {
        // Remember this live object as refused before unwinding, so the other start of the same agent (adoption vs the
        // created event) cannot build a second runtime of the same kind.
        refused.add(agent);
        await retireRuntime(state, computer, 'cannot stop a runtime that ignores the trusted caller');
        fail(
          'the computer runtime does not accept a trusted caller (computer.acceptsCaller is not true), so "' +
            agent.id +
            '" would run tools without a desktop identity',
          'TOOL_CONTEXT_UNAVAILABLE',
        );
      }
      if (disposing) {
        await retireRuntime(state, computer, 'cannot stop a runtime created during shutdown');
        return null;
      }
      state.computer = computer;
      if (mode) computer.setDesktopMode?.(mode);
      // A runtime created while the stop sign is up starts halted, exactly like the MCP server does on startup.
      if (halted) safeDispose(() => computer.halt?.(), log);
      // Tell the overlay a trusted agent exists (its identity bus for the pointer writer); the runtime decides who
      // ends up on screen. The real cursor anchor is sampled by the C# renderer, so nothing is cached here.
      // Announce now only when the identity was bound above (early bind). A delegated child with no resolvable root has
      // no identity yet, so announceIdentity leaves it for its first proven call. Never a duplicate announce.
      announceIdentity(state);
      registerTools(state);
    } catch (error) {
      await disposeState(state);
      throw error;
    }
    return state;
  }

  /**
   * True when the state's own agent is still the live registry entry and, once a root is bound, that root has not
   * changed. An unbound state (a delegated child whose root was not resolvable at creation) is not proof of loss — it is
   * kept, and its root is checked against the bound one on the first call that resolves it.
   */
  function stillOwned(state: AgentState, agents: NativeAgentsService): boolean {
    if (agents.get(state.agent.id) !== state.agent) return false;
    if (!state.identity) return true;
    let root: unknown = undefined;
    try {
      root = serviceOf<NativeSubagentsService>(ctx, 'subagents')?.rootOf?.(state.agent);
    } catch {
      return false;
    }
    return root === state.identity.root;
  }
  async function onCreated(payload: { agent?: unknown } | undefined): Promise<void> {
    const agent = payload?.agent;
    if (!isAgent(agent)) return;
    try {
      await start(agent);
    } catch (error) {
      log('cannot attach the computer-use runtime to agent "' + (isAgent(agent) ? agent.id : '?') + '": ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  function onDisposed(payload: { agent?: unknown } | undefined): void {
    const agent = payload?.agent;
    if (!isAgent(agent)) return;
    // Matched on the object, not the id: a late event for an older lifetime of the same session id must never unwind
    // the state that replaced it.
    const state = states.get(agent);
    if (state) {
      void disposeState(state).catch(error => {
        log('cannot unwind agent "' + agent.id + '": ' + (error instanceof Error ? error.message : String(error)));
      });
    }
  }

  const on = ctx.on;
  if (typeof on === 'function') {
    const stopCreated = on('agent/created', onCreated);
    if (typeof stopCreated === 'function') listeners.push(stopCreated);
    const stopDisposed = on('agent/disposed', onDisposed);
    if (typeof stopDisposed === 'function') listeners.push(stopDisposed);
  }

  // Agents that already existed when the plugin loaded get the tools too; each is adopted in the background.
  const existing = serviceOf<NativeAgentsService>(ctx, 'agents')?.list?.() ?? [];
  for (const agent of existing) {
    if (!isAgent(agent)) continue;
    void onCreated({ agent });
  }

  void ensureInit();
  void ensureMultiMouse();

  if ((modeFile || stopFile) && pollMs >= 50) {
    pollTimer = setInterval(() => { void poll(); }, pollMs);
    pollTimer.unref?.();
    void poll();
  }

  /** The startup scan runs on a runtime of its own so it happens even before the first tool call. */
  async function ensureInit(): Promise<void> {
    if (options.autoInit !== true || initStarted || disposing) return;
    initStarted = true;
    try {
      const computer = await create({ id: '_gateway' }, {
        dataDir: dataRoot,
        profileDir: join(dataRoot, 'browser', namespace, '_gateway'),
        messagesPath: null,
        proceduresDir,
      });
      if (disposing) {
        await settle(() => computer.stop(), 'cannot stop the startup scan runtime');
        return;
      }
      supervisor = computer;
      await supervisor.autoInit?.();
    } catch (error) {
      log('startup scan failed: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  return {
    async dispose(): Promise<void> {
      if (disposing) return;
      disposing = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      for (const stop of listeners.splice(0)) safeDispose(stop, log);
      // Both halves run now: the registrations and map entries clear synchronously, the runtimes' own stops are
      // awaited below so a Promise-returning stop is never left dangling. States that already left byId still have
      // their unwind recorded, so a stop that started before this call is awaited too rather than orphaned.
      // One deadline covers the whole shutdown, so a stuck browser cannot multiply the wait per runtime.
      const deadline = graceMs > 0 ? Date.now() + graceMs : Number.POSITIVE_INFINITY;
      const budget = () => deadline - Date.now();
      const unwinding = [...byId.values()].map(state => disposeState(state));
      const supervisorRuntime = supervisor;
      supervisor = null;
      if (supervisorRuntime) {
        await bounded(settle(() => supervisorRuntime.stop(), 'cannot stop the startup scan runtime'), 'the startup scan runtime', budget());
      }
      // A start that was still awaiting its factory saw disposing and stops its own runtime, but it only learns that
      // after this point, so wait for it and for every unwind it recorded. Rounds are bounded in count and in time:
      // a rejected start, a factory that never resolves or a stop that never settles must not turn shutdown into an
      // endless wait, and whatever is left is reported rather than silently dropped.
      for (let round = 0; round < 8; round += 1) {
        const pending: Array<Promise<unknown>> = [...unwinding, ...starting.values(), ...teardowns.values()];
        if (pending.length === 0) break;
        if (budget() <= 0) {
          log('agent runtimes were still unwinding when shutdown gave up waiting');
          break;
        }
        await bounded(Promise.allSettled(pending), 'unwinding agent runtimes', budget());
        if (starting.size === 0 && teardowns.size === 0) break;
      }
      epochOfRequest.clear();
      // The overlay runtime is a process-wide singleton owned by the settings plugin: never disposed from here.
      multiMouse = null;
    },
    toolNames(agentId?: string): string[] {
      if (typeof agentId === 'string') {
        const state = byId.get(agentId);
        return state ? [...state.handles.keys()] : [];
      }
      return [...byId.values()].flatMap(state => [...state.handles.keys()]);
    },
    size(): number {
      return byId.size;
    },
    setDesktopMode(value: string): void {
      applyMode(value);
    },
    halted(): boolean {
      return halted;
    },
  };
}

/** The production runtime: the repo's own ComputerUse, with a private browser profile and log per lifetime. */
async function defaultComputer(paths: NativeAgentPaths, agent: NativeAgent, hooks: NativeRuntimeHooks): Promise<NativeComputer> {
  const { createComputerUse } = await import('./computer.ts');
  const { createJsonlSink } = await import('./procedures/messages.ts');
  type ComputerOptions = Parameters<typeof createComputerUse>[0];
  const computer = createComputerUse({
    dataDir: paths.dataDir,
    profileDir: paths.profileDir,
    ...(paths.proceduresDir ? { proceduresDir: paths.proceduresDir } : {}),
    messages: paths.messagesPath ? createJsonlSink(paths.messagesPath) : false,
    name: agent.id,
    // The runtime's arbiter reports every phase of a desktop action through `onAction`; the gateway forwards each
    // one unchanged to the overlay's pointer runtime. `onHalt` fires when the user presses stop in this runtime.
    onAction: (event: ActionEvent) => hooks.onAction?.(event),
    onHalt: () => hooks.onHalt?.(),
  } as ComputerOptions);
  return computer;
}
