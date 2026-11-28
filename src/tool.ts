import type { Image } from './shared/image.ts';

/** What a tool hands back: short text, and pictures in the order the agent should see them. */
export interface ToolResult { text: string; images?: Image[] }
export interface ToolContext { signal: AbortSignal; caller?: TrustedCallerContext }
type ParamType = 'string' | 'number' | 'integer' | 'boolean' | 'object';
export interface ParamSpec { type: ParamType; required?: boolean; description?: string }
export interface JsonSchema { type: 'object'; properties: Record<string, { type: ParamType; description?: string; additionalProperties?: boolean }>; required?: string[]; additionalProperties: false }
/** One tool as any host sees it: a name, a description for the model, a JSON Schema for its input, and the work. */
export interface ToolSpec { name: string; description: string; inputSchema: JsonSchema; execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> }

const typeOk: Record<ParamType, (value: unknown) => boolean> = {
  string: value => typeof value === 'string',
  number: value => typeof value === 'number' && Number.isFinite(value),
  integer: value => Number.isSafeInteger(value),
  boolean: value => typeof value === 'boolean',
  object: value => typeof value === 'object' && value !== null && !Array.isArray(value),
};

/** Checks the arguments against the declared parameters, so a tool's own code only ever sees what it declared. */
export function checkInput(name: string, params: Record<string, ParamSpec>, input: unknown): Record<string, unknown> {
  const args = input === undefined || input === null ? {} : input;
  if (!typeOk.object(args)) throw new Error(`${name} 的参数应该是一个对象`);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    // Hosts send absent optional arguments as null now and then; that is not a value.
    if (value === null || value === undefined) continue;
    const spec = params[key];
    if (!spec) throw new Error(`${name} 不认识参数 ${key}，可用：${Object.keys(params).join('、') || '（没有参数）'}`);
    if (!typeOk[spec.type](value)) throw new Error(`${name} 的参数 ${key} 应该是 ${spec.type}`);
    out[key] = value;
  }
  for (const [key, spec] of Object.entries(params)) if (spec.required && !(key in out)) throw new Error(`${name} 缺少参数 ${key}`);
  return out;
}

type Value<T extends ParamType> = T extends 'string' ? string : T extends 'number' | 'integer' ? number : T extends 'boolean' ? boolean : Record<string, unknown>;
type Required<P extends Record<string, ParamSpec>> = { [K in keyof P]: P[K]['required'] extends true ? K : never }[keyof P];
/** The checked arguments, typed by the parameter list: required ones present, optional ones possibly absent. */
export type Input<P extends Record<string, ParamSpec>> =
  { [K in Required<P>]: Value<P[K]['type']> } & { [K in Exclude<keyof P, Required<P>>]?: Value<P[K]['type']> };

/** A tool from a short parameter list; its input is checked before `execute` runs. */
export function defineTool<const P extends Record<string, ParamSpec>>(spec: {
  name: string; description: string; parameters: P;
  execute(args: Input<P>, context: ToolContext): Promise<ToolResult | string>;
}): ToolSpec {
  const required = Object.entries(spec.parameters).filter(([, param]) => param.required).map(([key]) => key);
  const properties = Object.fromEntries(Object.entries(spec.parameters).map(([key, param]) => [key, {
    type: param.type, ...(param.description ? { description: param.description } : {}), ...(param.type === 'object' ? { additionalProperties: true } : {}),
  }]));
  return {
    name: spec.name, description: spec.description,
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
    async execute(input, context) {
      const result = await spec.execute(checkInput(spec.name, spec.parameters, input) as Input<P>, context);
      return typeof result === 'string' ? { text: result } : result;
    },
  };
}

/** Who is really calling: the host passes this down from a trusted Agent object, never from tool arguments. */
export type TrustIdentity = 'trusted' | 'legacy';
export interface TrustedCallerContext {
  identity: TrustIdentity;
  agentId: string;
  rootAgentId: string;
  depth: number;
  /** One number per Agent lifetime: a resumed session gets a new Agent and so a new lifetime. */
  lifetime: number;
  sessionId?: string;
  /** The host's per-call id, reused as the base of every requestId in that call. */
  callId?: string;
}

/** The caller identity copied onto every event of one action, so overlays and audit agree on who acted. */
export interface ActionActor {
  trust: TrustIdentity;
  agentId: string;
  rootAgentId: string;
  depth: number;
  lifetime: number;
}

/**
 * Lifecycle of one logical desktop action. `queued` and `granted` bracket the global lease wait;
 * `approaching`/`executing`/`progress` are emitted while the input is being delivered; exactly one of
 * `succeeded`/`cancelled`/`failed`/`uncertain` closes it. There is no unqualified "finish".
 */
export type ActionPhase =
  | 'queued'
  | 'granted'
  | 'approaching'
  | 'executing'
  | 'progress'
  | 'succeeded'
  | 'cancelled'
  | 'failed'
  | 'uncertain';

/** Pointer/edge shape, chosen from the action being delivered. */
export type ActionKind = 'move' | 'click' | 'drag' | 'wheel' | 'scroll' | 'type' | 'key' | 'wait' | 'other';

export interface PhysicalPoint { x: number; y: number }

export interface ActionDescriptor {
  kind: ActionKind;
  /** Short human label, e.g. "点击" — the overlay shows it near the pointer. */
  label?: string;
  button?: 'left' | 'right' | 'middle';
  double?: boolean;
}

export type ActionSpace = 'physical' | 'window';

/**
 * One event of one desktop action. `sampleMs` and `at` are absolute epoch milliseconds (never intervals),
 * so a consumer can order events across processes. `path` points each carry their own timing via `sampleMs`.
 */
export interface ActionEvent {
  kind: 'desktop-action';
  requestId: string;
  /** Monotonic per requestId; a consumer sorts by (seq, at). */
  seq: number;
  phase: ActionPhase;
  actor: ActionActor;
  /** Arbitration area: 'global' is the machine-wide FIFO lease; 'hwnd' is reserved for a future per-window area. NOT a pixel rectangle. */
  area: 'global' | 'hwnd';
  action: ActionDescriptor;
  space: ActionSpace;
  /** Target window geometry, when known. Distinct from `area`. */
  windowRect?: { x: number; y: number; width: number; height: number };
  hwnd?: number;
  app?: string;
  exe?: string;
  title?: string;
  /** The global lease this action holds (present from `granted` onward). */
  leaseId?: string;
  clientVersion?: string;
  snapshotVersion?: string;
  /** Pointer origin; for drag/move the start point, for click the hover point. */
  from?: PhysicalPoint;
  /** Pointer destination; the point a click/move/wheel lands on. */
  to?: PhysicalPoint;
  /** Sampled points along a drag path, in order. */
  path?: PhysicalPoint[];
  /** Epoch ms when this sample was taken (a timestamp, never an interval). */
  sampleMs: number;
  /** Planned travel time of the pointer between samples, in milliseconds. */
  motionMs?: number;
  /** Elapsed time of the action up to this event, in milliseconds. */
  durationMs?: number;
  sampleSource?: 'cursor-sink' | 'client-to-screen' | 'post-message' | 'screen';
  /** Epoch ms of the event itself. */
  at: number;
  ok?: boolean;
  reason?: string;
}

export type ActionSink = (event: ActionEvent) => void;
