/**
 * Pointer state writer (task-39).
 *
 * Pure reducer + atomic file writer that turns TRUSTED desktop action events and Agent
 * lifecycle transitions into the discrete "pointer targets" consumed by the native overlay
 * (scripts/windows-takeover.cs -> MultiPointerFrame.RefreshTargets -> MultiPointerAnimator).
 *
 * Design rules (reconciled with src/tool.ts ActionEvent, src/desktop/arbiter.ts, and the C# reader):
 *  - The native side tweens between DISCRETE targets; this module only emits targets.
 *  - Output 'seq' is monotonic PER POINTER (never the event.seq, which resets per requestId),
 *    and 'sampleMs' is non-decreasing, so the C# staleness guard accepts every retarget.
 *  - Pointer identity is epoch-isolated: the state key is agentId + '\u001f' + epoch
 *    (epoch = actor.lifetime), so a reused agentId with a new lifetime does NOT inherit motion.
 *  - Real cursor sampling (spawn departure and release merge) belongs to the native renderer:
 *    this writer never fabricates a point and never writes 0,0. cursorAnchor:'spawn' STAYS on
 *    every row of an (id, epoch) until release: several real writes can land before the native
 *    poll, so the document it finally reads must still tell it to sample the CURRENT cursor and
 *    depart from there. Repeating the anchor is idempotent natively (one sample per key, an
 *    existing tween is never reset). A release row carries cursorAnchor:'release' so the
 *    renderer samples the cursor again and fades there.
 *  - Every move/drag is retargeted from the latest REAL progress point; no path is emitted (the
 *    native side would follow a polyline from its first point, i.e. the previous target, and jump)
 *    and nothing is replayed after an action ends (drag events carry a single real 'to').
 *  - Release fades opacity to 0 over releaseMs and keeps the row in the file until
 *    sweep() removes it after releaseMs + RELEASE_SWEEP_MARGIN_MS (removing early would
 *    make the native side drop it before it ever sampled the release anchor).
 *  - Unknown / legacy / root identity fails closed: no pointer is drawn.
 *
 * This module does not spawn processes, drive the mouse, or write multi-mouse-mode.json /
 * companion-live.json; it writes exactly one pointer state file.
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ActionActor, ActionEvent, ActionPhase, PhysicalPoint } from '../tool.ts'

/** Fallback palette (ARGB-equivalent hex) matching the native fallback colours. */
export const DEFAULT_PALETTE = [
  '#4FC3F7',
  '#FFB74D',
  '#81C784',
  '#F06292',
  '#BA68C8',
  '#4DD0E1',
  '#FFD54F',
  '#A1887F',
] as const

/**
 * Extra time a released row is kept after its fade finishes. The native renderer only sees
 * the file on its own polling tick, so deleting at exactly releaseMs could remove the row
 * before the renderer ever observed the release anchor. Keeping the row slightly longer is
 * harmless: repeated opaque-0 rows with an unchanged seq are ignored by the C# animator.
 */
export const RELEASE_SWEEP_MARGIN_MS = 120

/** Phases that close an action. Exactly one of these ends a requestId. */
export const TERMINAL_PHASES: ReadonlySet<ActionPhase> = new Set<ActionPhase>([
  'succeeded',
  'cancelled',
  'failed',
  'uncertain',
])

export function isTerminalPhase(phase: ActionPhase): boolean {
  return TERMINAL_PHASES.has(phase)
}

/**
 * Native sampling request understood by the renderer (task-42). 'spawn' is written on EVERY row
 * of an (id, epoch) until release (idempotent natively: one cursor sample per key, an existing
 * tween is never reset), so a poll that only sees the newest document still departs from the real
 * cursor. 'release' is written once and asks for a fresh sample to fade back to.
 */
export type CursorAnchor = 'spawn' | 'release'

/**
 * One row of the pointer state file. Keys match what the native reader expects; 'ordinal'
 * is an extra, harmless field that documents draw order (the C# array index is authoritative).
 */
export interface PointerEntry {
  id: string
  epoch: number
  label: string
  color: string
  /** Physical target; absent when the row only asks the renderer to anchor at the cursor. */
  x?: number
  y?: number
  /** 'spawn' = depart from the real cursor (sticky until release), 'release' = merge back to it. */
  cursorAnchor?: CursorAnchor
  seq: number
  sampleMs: number
  motionMs: number
  opacity: number
  ordinal: number
  headingDeg?: number
  headingRestore: boolean
  path?: PhysicalPoint[]
}

export interface PointerStateDocument {
  pointers: PointerEntry[]
}

export interface PointerMeta {
  label?: string
  color?: string
}

export interface PointerStoreOptions {
  /** Clock; defaults to Date.now. */
  now?: () => number
  palette?: readonly string[]
  /** Default tween duration for a retarget, ms (native default 200). */
  defaultMotionMs?: number
  /** Fade-out duration on release, ms. */
  releaseMs?: number
  /** Opacity written at spawn (1 = visible immediately; 0 = seed invisible then reveal on first target). */
  spawnOpacity?: number
  /** Current mode epoch; events carrying an older epoch are expired and dropped. */
  modeEpoch?: () => number | undefined
  /** Label for a pointer when the caller does not supply one. */
  defaultLabel?: (actor: ActionActor, ordinal: number) => string
  /** Pointer epoch; defaults to actor.lifetime (the renderer's lifetime isolation key). */
  epochOf?: (actor: ActionActor) => number
}

/** An ActionEvent as delivered by the gateway, which pins an extra epoch field on it. */
export interface IncomingActionEvent extends ActionEvent {
  epoch?: number
}

/** The trust gate: only a trusted, non-root sub-agent with a finite lifetime may be drawn. */
export function isTrackableActor(actor: unknown): actor is ActionActor {
  if (actor === null || typeof actor !== 'object') return false
  const a = actor as Partial<ActionActor>
  return (
    a.trust === 'trusted' &&
    typeof a.agentId === 'string' &&
    a.agentId.length > 0 &&
    typeof a.rootAgentId === 'string' &&
    a.rootAgentId.length > 0 &&
    a.agentId !== a.rootAgentId &&
    typeof a.depth === 'number' &&
    a.depth > 0 &&
    typeof a.lifetime === 'number' &&
    Number.isInteger(a.lifetime) &&
    a.lifetime > 0
  )
}

export function defaultEpochOf(actor: ActionActor): number {
  return actor.lifetime
}

interface LivePointer {
  key: string
  id: string
  epoch: number
  label: string
  color: string
  ordinal: number
  x?: number
  y?: number
  seq: number
  sampleMs: number
  motionMs: number
  opacity: number
  headingDeg?: number
  headingRestore: boolean
  cursorAnchor?: CursorAnchor
  path?: PhysicalPoint[]
  lastSampleMs: number
  lastSeqByRequest: Map<string, number>
  closedRequests: Set<string>
  releasing: boolean
  releaseAt: number
}

function finitePoint(p: PhysicalPoint | null | undefined): PhysicalPoint | null {
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
  return { x: p.x, y: p.y }
}

export interface PointerStore {
  spawn(actor: ActionActor, meta?: PointerMeta): boolean
  ingest(event: IncomingActionEvent): boolean
  /**
   * Mark a pointer for merge: it keeps its last target, opacity fades to 0 over releaseMs and
   * the row carries cursorAnchor:'release'. The native renderer samples the real cursor and
   * tweens there; the writer removes the row after releaseMs via sweep().
   */
  release(actor: ActionActor): boolean
  sweep(now?: number): boolean
  /** Remove every pointer immediately (task switch / mode off / epoch reset). */
  clear(): boolean
  snapshot(): PointerEntry[]
  payload(): string
  size(): number
  has(actor: ActionActor): boolean
  get(actor: ActionActor): PointerEntry | undefined
}

export function createPointerStore(options: PointerStoreOptions): PointerStore {
  const clock = options.now ?? Date.now
  const palette = options.palette && options.palette.length > 0 ? options.palette : DEFAULT_PALETTE
  const defaultMotionMs = options.defaultMotionMs ?? 200
  const releaseMs = options.releaseMs ?? 200
  const spawnOpacity = options.spawnOpacity ?? 1
  const epochOf = options.epochOf ?? defaultEpochOf
  const defaultLabel = options.defaultLabel ?? ((_actor: ActionActor, ordinal: number) => 'Agent ' + ordinal)

  const pointers = new Map<string, LivePointer>()
  // Keys whose row has been retired (released and swept, or replaced by a newer lifetime).
  // The native renderer must never see the same (id, epoch) appear again after its row was
  // deleted: that would look like a new pointer resurrecting an old one.
  const retiredKeys = new Set<string>()
  let nextOrdinal = 1

  function retire(key: string): void {
    retiredKeys.add(key)
    if (retiredKeys.size > 4096) {
      const oldest = retiredKeys.values().next().value
      if (typeof oldest === 'string') retiredKeys.delete(oldest)
    }
  }

  function keyOf(actor: ActionActor): string {
    return actor.agentId + '\u001f' + String(epochOf(actor))
  }

  function colorFor(ordinal: number): string {
    return palette[(ordinal - 1) % palette.length]
  }

  function toEntry(live: LivePointer): PointerEntry {
    const entry: PointerEntry = {
      id: live.id,
      epoch: live.epoch,
      label: live.label,
      color: live.color,
      seq: live.seq,
      sampleMs: live.sampleMs,
      motionMs: live.motionMs,
      opacity: live.opacity,
      ordinal: live.ordinal,
      headingRestore: live.headingRestore,
    }
    // Never write x/y:null: the native side treats a missing coordinate as "anchor at cursor".
    if (typeof live.x === 'number' && typeof live.y === 'number') {
      entry.x = live.x
      entry.y = live.y
    }
    if (live.cursorAnchor) entry.cursorAnchor = live.cursorAnchor
    if (typeof live.headingDeg === 'number') entry.headingDeg = live.headingDeg
    if (live.path && live.path.length >= 2) entry.path = live.path.map((p) => ({ x: p.x, y: p.y }))
    return entry
  }

  function spawn(actor: ActionActor, meta?: PointerMeta): boolean {
    if (!isTrackableActor(actor)) return false
    const key = keyOf(actor)
    if (retiredKeys.has(key)) return false
    if (pointers.has(key)) return false
    const epoch = epochOf(actor)
    // A stale event from an older lifetime must never resurrect that epoch: if a newer
    // lifetime for the same agent id already exists, refuse to spawn the old one.
    for (const [, other] of pointers) {
      if (other.id === actor.agentId && other.epoch > epoch) return false
    }
    // A reused agent id with a new lifetime must never inherit the old pointer's motion:
    // drop older-epoch rows for the same id before the new lifetime appears.
    for (const [otherKey, other] of pointers) {
      if (other.id === actor.agentId && otherKey !== key) {
        pointers.delete(otherKey)
        retire(otherKey)
      }
    }
    const ordinal = nextOrdinal++
    const live: LivePointer = {
      key,
      id: actor.agentId,
      epoch: epochOf(actor),
      label: meta?.label ?? defaultLabel(actor, ordinal),
      color: meta?.color ?? colorFor(ordinal),
      ordinal,
      // No fabricated coordinate: the renderer samples the real cursor on this anchor. The anchor
      // is not consumed by the first target (see applyTarget): it stays until release.
      seq: 1,
      sampleMs: 0,
      motionMs: 0,
      opacity: spawnOpacity,
      headingRestore: true,
      cursorAnchor: 'spawn',
      lastSampleMs: 0,
      lastSeqByRequest: new Map<string, number>(),
      closedRequests: new Set<string>(),
      releasing: false,
      releaseAt: 0,
    }
    pointers.set(key, live)
    return true
  }

  function isExpired(event: IncomingActionEvent): boolean {
    if (!options.modeEpoch) return false
    const current = options.modeEpoch()
    if (typeof event.epoch !== 'number' || typeof current !== 'number') return false
    return event.epoch < current
  }

  function targetPointFor(event: IncomingActionEvent): PhysicalPoint | null {
    // path is never sent by the driver; drag uses phase 'progress' with a single real 'to'.
    const to = finitePoint(event.to)
    if (to) return to
    const from = finitePoint(event.from)
    if (from) return from
    const path = Array.isArray(event.path) ? event.path[event.path.length - 1] : undefined
    return finitePoint(path)
  }

  function applyTarget(live: LivePointer, point: PhysicalPoint, event: IncomingActionEvent): void {
    // Read the previous point once so the coordinate check below narrows these locals instead of
    // repeated optionals on the live record; no coordinate is invented when there is none.
    const previousX = live.x
    const previousY = live.y
    const hasPrevious = typeof previousX === 'number' && typeof previousY === 'number'
    const moved = !hasPrevious || point.x !== previousX || point.y !== previousY
    let motionMs: number
    if (typeof event.motionMs === 'number' && Number.isFinite(event.motionMs)) {
      motionMs = Math.max(0, event.motionMs)
    } else if (event.phase === 'progress' && live.lastSampleMs > 0 && event.sampleMs > live.lastSampleMs) {
      motionMs = Math.max(16, Math.min(defaultMotionMs, event.sampleMs - live.lastSampleMs))
    } else {
      motionMs = defaultMotionMs
    }
    // Direction of real travel on screen (x right, y down); the renderer converts it to the
    // canonical tip rotation. Only meaningful when we have a previous physical point; on the
    // first target the native side derives it from the sampled cursor to the target instead.
    if (moved && typeof previousX === 'number' && typeof previousY === 'number') {
      live.headingDeg = (Math.atan2(point.y - previousY, point.x - previousX) * 180) / Math.PI
    } else if (!hasPrevious) {
      live.headingDeg = undefined
    }
    // Never emit a path: the renderer follows a path polyline from its FIRST point, which is the
    // previous target, not the pointer's current mid-tween pixel; streaming one two-point path per
    // real progress event would visibly jump each segment. Each progress event is a plain retarget
    // from the current screen position, so the real path is followed without replay.
    live.path = undefined
    live.x = point.x
    live.y = point.y
    live.seq += 1
    live.motionMs = motionMs
    const sampleMs = Number.isFinite(event.sampleMs) ? event.sampleMs : clock()
    live.sampleMs = Math.max(sampleMs, live.lastSampleMs)
    live.lastSampleMs = live.sampleMs
    live.opacity = 1
    live.headingRestore = true
    // The spawn anchor is deliberately NOT cleared here. Real writes are flushed per event, and
    // several of them can land before the native side polls the file (it reads at ~16ms); if the
    // anchor were consumed by an earlier write, the document the renderer finally sees would no
    // longer ask it to depart from the real cursor and the pointer would pop onto its target.
    // Keeping the anchor is safe: the native resolver samples once per (id, epoch) and never
    // resets an existing tween for a repeated spawn row.
  }

  function ingest(event: IncomingActionEvent): boolean {
    if (!event || event.kind !== 'desktop-action') return false
    const actor = event.actor
    if (!isTrackableActor(actor)) return false // root / legacy / unknown -> fail closed
    if (isExpired(event)) return false
    if (typeof event.requestId !== 'string' || event.requestId.length === 0) return false

    const point = targetPointFor(event)
    const terminal = isTerminalPhase(event.phase)

    const key = keyOf(actor)
    let live = pointers.get(key)
    if (!live) {
      // No real point yet (queued / granted / type / key / wait, or a terminal event without a
      // position): creating a row here would leak an unpositioned ghost into a later full-payload
      // flush and the renderer would park it at the real cursor forever. Also never retire the
      // key here: the same lifetime must still be able to anchor on its first real target.
      if (!point) return false
      if (!spawn(actor)) return false
      live = pointers.get(key)
      if (!live) return false
    }

    if (live.releasing) return false // merge in progress: the pointer must not come back
    if (live.closedRequests.has(event.requestId)) return false
    const lastSeq = live.lastSeqByRequest.get(event.requestId)
    if (typeof lastSeq === 'number' && event.seq <= lastSeq) return false
    if (Number.isFinite(event.sampleMs) && live.lastSampleMs > 0 && event.sampleMs < live.lastSampleMs) {
      return false // older sample than we already applied
    }
    live.lastSeqByRequest.set(event.requestId, event.seq)

    if (point) applyTarget(live, point, event)

    if (terminal) {
      live.closedRequests.add(event.requestId)
      if (point) {
        live.path = undefined
        live.headingDeg = undefined
        live.opacity = 1
      }
    }
    return point !== null || terminal
  }

  function release(actor: ActionActor): boolean {
    if (!isTrackableActor(actor)) return false
    const key = keyOf(actor)
    const live = pointers.get(key)
    if (!live || live.releasing) return false
    // A pointer that never received a real coordinate cannot fade anywhere meaningful:
    // remove it instead of parking it on the renderer's sampled cursor.
    if (typeof live.x !== 'number' || typeof live.y !== 'number') {
      pointers.delete(key)
      retire(key)
      return true
    }
    const now = clock()
    // The renderer samples the real cursor itself when it sees cursorAnchor:'release'; the
    // writer only requests the merge and keeps the last target for the fade bookkeeping.
    live.seq += 1
    live.path = undefined
    live.headingDeg = undefined
    live.headingRestore = true
    live.opacity = 0
    live.motionMs = releaseMs
    live.cursorAnchor = 'release'
    live.sampleMs = Math.max(now, live.lastSampleMs)
    live.lastSampleMs = live.sampleMs
    live.releasing = true
    live.releaseAt = live.sampleMs + releaseMs + RELEASE_SWEEP_MARGIN_MS
    return true
  }

  function sweep(now?: number): boolean {
    const t = typeof now === 'number' ? now : clock()
    let changed = false
    for (const [key, live] of pointers) {
      if (live.releasing && t >= live.releaseAt) {
        pointers.delete(key)
        retire(key)
        changed = true
      }
    }
    return changed
  }

  function clear(): boolean {
    if (pointers.size === 0) return false
    pointers.clear()
    return true
  }

  function snapshot(): PointerEntry[] {
    return [...pointers.values()]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((live) => toEntry(live))
  }

  function payload(): string {
    const doc: PointerStateDocument = { pointers: snapshot() }
    return JSON.stringify(doc)
  }

  return {
    spawn,
    ingest,
    release,
    sweep,
    clear,
    snapshot,
    payload,
    size: () => pointers.size,
    has: (actor: ActionActor) => pointers.has(keyOf(actor)),
    get: (actor: ActionActor) => {
      const live = pointers.get(keyOf(actor))
      return live ? toEntry(live) : undefined
    },
  }
}

/**
 * Atomically write a pointer state file: write a unique temp then rename over the target.
 *
 * The native reader polls this file with a short-lived open; on Windows a reader that does not
 * share delete can transiently block the rename (EPERM/EBUSY/EACCES). Retry briefly so a spawn
 * row carrying the departure anchor is never lost to one polling tick; the payload still lands
 * in one atomic rename.
 */
export function writeStateAtomic(statePath: string, text: string): void {
  const dir = dirname(statePath)
  mkdirSync(dir, { recursive: true })
  const tmp =
    statePath + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2) + '.tmp'
  writeFileSync(tmp, text, 'utf8')
  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES'])
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, statePath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt < 4 && typeof code === 'string' && retryable.has(code)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8 * (attempt + 1))
        continue
      }
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      throw error
    }
  }
}

export interface PointerStateWriterOptions extends PointerStoreOptions {
  /** Destination pointer state file (read by the native overlay). */
  statePath: string
}

export interface PointerStateWriter {
  readonly store: PointerStore
  readonly statePath: string
  spawn(actor: ActionActor, meta?: PointerMeta): boolean
  ingest(event: IncomingActionEvent, meta?: PointerMeta | (() => PointerMeta)): boolean
  release(actor: ActionActor): boolean
  dispose(actor: ActionActor): boolean
  sweep(now?: number): boolean
  /** Remove every pointer immediately (task switch / mode off / epoch reset). */
  clear(): boolean
  flush(): void
  snapshot(): PointerEntry[]
  payload(): string
}

/**
 * Wrap a store with an atomic state file. Every mutating call that changes state flushes the
 * file so the native overlay always observes the latest discrete targets.
 */
export function createPointerStateWriter(options: PointerStateWriterOptions): PointerStateWriter {
  const { statePath, ...storeOptions } = options
  const store = createPointerStore(storeOptions)
  let lastPayload: string | null = null

  function flush(): void {
    const next = store.payload()
    if (next === lastPayload) return
    writeStateAtomic(statePath, next)
    lastPayload = next
  }

  const writer: PointerStateWriter = {
    store,
    statePath,
    spawn(actor: ActionActor, meta?: PointerMeta): boolean {
      const changed = store.spawn(actor, meta)
      if (changed) {
        // An anchor-only row: the renderer samples the real cursor and holds the pointer there
        // until a real target arrives. The anchor stays on the row afterwards.
        flush()
      }
      return changed
    },
    ingest(event: IncomingActionEvent, meta?: PointerMeta | (() => PointerMeta)): boolean {
      // One write per action event: a brand-new (id, epoch) row carries cursorAnchor:'spawn'
      // together with its first real target, so the renderer can sample the real cursor and
      // glide to that target in the same Sync. Do NOT use two flushes: a 16ms poll can skip
      // an anchor-only write and the departure would be lost.
      if (event && event.kind === 'desktop-action' && isTrackableActor(event.actor)) {
        // Validate the request id before the lazy spawn: store.ingest rejects an empty id, and a
        // pre-spawned (unflushed) row would otherwise leak into the next flush of another pointer.
        if (typeof event.requestId !== 'string' || event.requestId.length === 0) return false
        if (typeof options.modeEpoch === 'function' && typeof event.epoch === 'number') {
          const current = options.modeEpoch()
          if (typeof current === 'number' && event.epoch < current) return false // expired epoch: never spawn a stray anchor
        }
        // queued/granted/approaching/type/key/wait events routinely carry no position. They must
        // NOT create a row: an in-memory row with no x/y would leak into the next flush of some
        // other pointer and the renderer would park a ghost at the cursor. They must also NOT
        // release/retire the key, or the same lifetime could never draw its first real target.
        const hasTarget = Boolean(event.to || event.from || (Array.isArray(event.path) && event.path.length > 0))
        const known = store.has(event.actor)
        // Unknown identity + no point: nothing to draw. A live pointer may still receive a terminal
        // event without a point; that must close the request (no ghost is created either way).
        if (!hasTarget && !known) return false
        if (!known) {
          const resolved = typeof meta === 'function' ? meta() : meta
          if (!store.spawn(event.actor, resolved)) return false // in memory only, no flush yet
        }
      }
      const changed = store.ingest(event)
      if (changed) {
        // The file now holds the anchor together with the first real target (or a later target).
        // The anchor is intentionally left on the row for the whole (id, epoch): see applyTarget.
        flush()
      }
      return changed
    },
    release(actor: ActionActor): boolean {
      const changed = store.release(actor)
      if (changed) flush()
      return changed
    },
    dispose(actor: ActionActor): boolean {
      const changed = store.release(actor)
      if (changed) flush()
      return changed
    },
    sweep(now?: number): boolean {
      const changed = store.sweep(now)
      if (changed) flush()
      return changed
    },
    clear(): boolean {
      const changed = store.clear()
      if (changed) flush()
      return changed
    },
    flush,
    snapshot: () => store.snapshot(),
    payload: () => store.payload(),
  }
  return writer
}
