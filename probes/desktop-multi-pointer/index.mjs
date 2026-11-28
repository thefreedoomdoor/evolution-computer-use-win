/** Read-only multi-pointer overlay for DSH subagents. It never injects input. */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'desktop-multi-pointer'
export const inject = ['agents', 'subagents']

const COLORS = ['#4FC3F7', '#FFB74D', '#81C784', '#F06292', '#BA68C8', '#4DD0E1', '#FFD54F', '#A1887F']

// Process-wide owner marker: a second probe instance must never become a second writer for the
// same state file (two writers would fight over seq/sampleMs and could erase the newer state).
const WRITER_OWNER = Symbol.for('evolution-computer-use.multi-pointer.writerOwner')

// Module-level fallback for the same rule when the probe runs without the runtime singleton
// (or two mounts in one process): only the first mounted instance may write the state file.
let moduleWriter = null

function isAgent(value) {
  return value !== null && typeof value === 'object' && typeof value.id === 'string'
}

function headerOf(agent) {
  const header = agent?.session?.header
  return header && typeof header === 'object' ? header : null
}

/** Root sessions have no subagent origin; direct and nested children do. */
export function shouldTrackAgent(agent, ctx) {
  if (!isAgent(agent)) return false
  const header = headerOf(agent)
  if (header && typeof header.origin === 'string') return header.origin === 'subagent'
  if (header && Object.prototype.hasOwnProperty.call(header, 'origin')) return false
  try {
    const root = ctx?.subagents?.rootOf?.(agent)
    return isAgent(root) && root !== agent
  } catch {
    return false
  }
}

export function pointerLabel(agent, ordinal) {
  const id = isAgent(agent) ? agent.id : ''
  return id ? ('Agent ' + ordinal + ' - ' + id.slice(0, 6)) : ('Agent ' + ordinal)
}

/**
 * The probe is the ONE creator of the pointer state writer (task-39) plus the original single
 * render helper (scripts/multi-pointer.ps1, which only READS state.json). It starts no cursor
 * subprocess and depends on no sampling API: the existing C# renderer samples GetCursorPos
 * itself when it sees cursorAnchor "spawn" or "release". "spawn" stays on every row of an
 * (id, epoch) until release, because several real writes can be flushed before the native side
 * polls the file; the native resolver samples the cursor once per key and never resets a tween.
 *
 * All pointer coordinates come from REAL trusted ActionEvents published on the runtime bus
 * (gateway -> publishAction). The probe only adapts the runtime's flat event shape into
 * src/tool.ts ActionEvent and feeds the writer; it never invents trajectories, never samples
 * the cursor, and never fabricates a 0,0 origin.
 *
 * The writer implementation is loaded ONLY from the built ../../lib/desktop/pointerState.js.
 * If that artifact is missing, empty or stale the probe warns and fails closed: it starts no
 * writer and no renderer helper, and it never falls back to src, in-process compilation or a
 * scripted trajectory.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  ctx.effect(() => {
    let closed = false
    const cleanups = []
    const teardown = () => {
      closed = true
      const pending = cleanups.splice(0).reverse()
      for (const fn of pending) {
        try {
          fn()
        } catch {
          /* ignore */
        }
      }
    }
    // Fail closed when the built writer artifact is absent or stale: no src fallback, no
    // in-process compilation, no writer and no renderer helper are started in that case.
    const warn = (message) => {
      try {
        if (typeof ctx.warn === 'function') {
          ctx.warn(message)
          return
        }
      } catch {
        /* fall through to console */
      }
      try {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(message)
      } catch {
        /* ignore */
      }
    }
    Promise.all([
      import('../../plugin/lib/multi-mouse-runtime.mjs'),
      import('../../lib/desktop/pointerState.js'),
    ])
      .then(([runtimeMod, writerMod]) => {
        if (closed) return
        const createPointerStateWriter = writerMod && writerMod.createPointerStateWriter
        if (typeof createPointerStateWriter !== 'function') {
          throw new Error(
            'built lib/desktop/pointerState.js has no createPointerStateWriter export (stale or empty build) - run npm run build',
          )
        }
        const runtime =
          runtimeMod && typeof runtimeMod.getMultiMouseRuntime === 'function' ? runtimeMod.getMultiMouseRuntime() : null
        // Without the runtime bus the probe can never receive an action event; starting a writer
        // and renderer helper anyway would leave an empty overlay process behind.
        if (!runtime || typeof runtime.subscribe !== 'function') {
          warn('desktop-multi-pointer: multi-mouse runtime singleton is unavailable; pointer overlay disabled (no writer/helper started)')
          return
        }
        mount(ctx, config, runtime, createPointerStateWriter, cleanups)
      })
      .catch((err) => {
        if (closed) return
        const message = err && err.message ? err.message : String(err)
        warn(
          'desktop-multi-pointer: pointer overlay disabled: ' +
            message +
            ' - the built module is required (run npm run build); no src fallback is attempted',
        )
      })
    return teardown
  })
}

function finitePoint(p) {
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
  return { x: p.x, y: p.y }
}

/** Adapt the runtime bus's flat 'action' payload into a src/tool.ts ActionEvent. */
function toActionEvent(evt) {
  if (!evt || typeof evt !== 'object') return null
  if (typeof evt.agentId !== 'string' || evt.agentId.length === 0) return null
  if (typeof evt.rootId !== 'string' || evt.rootId.length === 0) return null
  const event = {
    kind: 'desktop-action',
    requestId: evt.requestId,
    seq: evt.seq,
    phase: evt.phase,
    actor: {
      trust: evt.trust === 'trusted' ? 'trusted' : 'legacy',
      agentId: evt.agentId,
      rootAgentId: evt.rootId,
      depth: Number.isInteger(evt.depth) ? evt.depth : 1,
      lifetime: evt.lifetime,
    },
    area: 'global',
    action: { kind: typeof evt.kind === 'string' ? evt.kind : 'other', double: evt.double === true },
    space: evt.space === 'window' ? 'window' : 'physical',
    sampleMs: typeof evt.sampleMs === 'number' && Number.isFinite(evt.sampleMs) ? evt.sampleMs : Date.now(),
    at: typeof evt.at === 'number' && Number.isFinite(evt.at) ? evt.at : Date.now(),
  }
  if (evt.label) event.action.label = evt.label
  if (evt.button) event.action.button = evt.button
  const from = finitePoint(evt.from)
  if (from) event.from = from
  const to = finitePoint(evt.to)
  if (to) event.to = to
  if (Array.isArray(evt.path)) {
    const path = evt.path.map(finitePoint).filter(Boolean)
    if (path.length >= 2) event.path = path
  }
  if (typeof evt.motionMs === 'number' && Number.isFinite(evt.motionMs)) event.motionMs = evt.motionMs
  if (typeof evt.durationMs === 'number' && Number.isFinite(evt.durationMs)) event.durationMs = evt.durationMs
  if (typeof evt.epoch === 'number') event.epoch = evt.epoch
  if (typeof evt.leaseId === 'string' && evt.leaseId.length > 0) event.leaseId = evt.leaseId
  if (typeof evt.ok === 'boolean') event.ok = evt.ok
  if (typeof evt.reason === 'string') event.reason = evt.reason
  return event
}

function mount(ctx, config, runtime, createPointerStateWriter, cleanups) {
  // Single-writer mount guard. The probe owns the state file, so a second mount must not attach a
  // competing writer (which would overwrite the live state of the instance that got there first).
  if (ctx && ctx.pointerWriter) {
    safeCall(() => {
      if (typeof ctx.warn === 'function') ctx.warn('desktop-multi-pointer: pointer writer already mounted; not starting a second one')
    })
    return
  }
  if (runtime && runtime[WRITER_OWNER]) {
    safeCall(() => {
      if (typeof ctx.warn === 'function') ctx.warn('desktop-multi-pointer: this runtime already has a pointer writer; not starting a second one')
    })
    return
  }
  if (moduleWriter) {
    safeCall(() => {
      if (typeof ctx.warn === 'function') ctx.warn('desktop-multi-pointer: a pointer writer is already mounted in this process; not starting a second one')
    })
    return
  }

  const runtimeStatePath =
    runtime && typeof runtime.pointerStatePath === 'function' ? safeCall(() => runtime.pointerStatePath()) : null
  const ownStateDir = !config.statePath && typeof runtimeStatePath !== 'string'
  const stateDir = config.stateDir || (ownStateDir ? join(tmpdir(), 'dsh-multi-pointer-' + process.pid) : '')
  const statePath = config.statePath || (typeof runtimeStatePath === 'string' ? runtimeStatePath : join(stateDir, 'state.json'))
  const logPath = config.logPath || join(stateDir || tmpdir(), 'helper.log')
  const scriptPath = config.scriptPath || fileURLToPath(new URL('../../scripts/multi-pointer.ps1', import.meta.url))
  const powershell = join(
    process.env.SystemRoot || 'C:/Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const releaseMs = typeof config.releaseMs === 'number' ? config.releaseMs : 200

  // Only the explicitly selected, enabled root may produce pointers. A stale event from a root
  // that is not selected (or whose mode was switched off) is expired before it can draw.
  const selectedModeEpoch = () => {
    if (!runtime || typeof runtime.activeRootId !== 'function') return undefined
    const rootId = safeCall(() => runtime.activeRootId())
    if (typeof rootId !== 'string' || rootId.length === 0) return undefined
    const mode = safeCall(() => runtime.getMode(rootId))
    return mode && typeof mode.epoch === 'number' ? mode.epoch : undefined
  }

  const writer = createPointerStateWriter({
    statePath,
    palette: COLORS,
    releaseMs,
    defaultMotionMs: typeof config.defaultMotionMs === 'number' ? config.defaultMotionMs : 200,
    modeEpoch: typeof config.modeEpoch === 'function' ? config.modeEpoch : selectedModeEpoch,
    defaultLabel: (_actor, ordinal) => 'Agent ' + ordinal,
  })
  ctx.pointerWriter = writer
  moduleWriter = writer
  try {
    if (runtime) runtime[WRITER_OWNER] = writer
  } catch {
    /* ignore */
  }

  let active = true
  let nextOrdinal = 0
  let helper = null
  let helperAttempts = 0
  let restartTimer = null
  let sweepTimer = null
  const agentById = new Map()
  const ordinalByKey = new Map()
  const actorByKey = new Map()
  let lastMode = null

  if (ownStateDir) safeCall(() => mkdirSync(stateDir, { recursive: true }))
  safeCall(() => writer.flush())

  function stopHelper() {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (helper) {
      const child = helper
      helper = null
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
  }

  function startHelper() {
    if (!active || helper || helperAttempts >= 4) return
    helperAttempts += 1
    try {
      helper = spawn(
        powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          '-StatePath',
          statePath,
          '-LogPath',
          logPath,
        ],
        { windowsHide: true, stdio: 'ignore' },
      )
    } catch {
      helper = null
      return
    }
    if (helper && typeof helper.on === 'function') {
      helper.on('exit', () => {
        helper = null
        if (!active) return
        if (writer.store.size() > 0) {
          restartTimer = setTimeout(() => {
            restartTimer = null
            startHelper()
          }, 1000)
          if (restartTimer && typeof restartTimer.unref === 'function') restartTimer.unref()
        }
      })
    }
  }

  function scheduleSweep() {
    if (sweepTimer) return
    const delay = Math.max(120, Math.floor(releaseMs))
    sweepTimer = setTimeout(() => {
      sweepTimer = null
      if (!active) return
      safeCall(() => writer.sweep())
    }, delay + 40)
    if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref()
  }

  function actorForEvent(event) {
    return {
      trust: 'trusted',
      agentId: event.actor.agentId,
      rootAgentId: event.actor.rootAgentId,
      depth: event.actor.depth,
      lifetime: event.actor.lifetime,
    }
  }

  function labelFor(actor) {
    const key = actor.agentId + '\u001f' + actor.lifetime
    let ordinal = ordinalByKey.get(key)
    if (typeof ordinal !== 'number') {
      ordinal = ++nextOrdinal
      ordinalByKey.set(key, ordinal)
    }
    const agent = agentById.get(actor.agentId)
    return { ordinal, label: agent ? pointerLabel(agent, ordinal) : 'Agent ' + ordinal }
  }

  function activeRootId() {
    if (!runtime || typeof runtime.activeRootId !== 'function') return null
    return safeCall(() => runtime.activeRootId())
  }

  function handleAction(flat) {
    if (!active || !flat) return
    const event = toActionEvent(flat)
    if (!event) return
    // Only the selected root may draw: a background root must not appear merely because its own
    // mode row says enabled. Without a selected root this fails closed.
    if (runtime && typeof runtime.activeRootId === 'function') {
      const selected = activeRootId()
      if (typeof selected !== 'string' || selected !== flat.rootId) return
    }
    // Expire events from a disabled or replaced mode epoch before they can resurrect a pointer.
    if (runtime && typeof runtime.getMode === 'function') {
      const mode = safeCall(() => runtime.getMode(flat.rootId))
      if (!mode || mode.enabled !== true) return
      if (typeof mode.epoch === 'number') {
        // Fail closed: an unpinned/unknown epoch cannot be proven current.
        if (typeof event.epoch !== 'number' || event.epoch < mode.epoch) return
      }
    }
    const actor = actorForEvent(event)
    // No in-memory pre-spawn here. Events without a real point (queued / granted / type / key /
    // wait) must leave no row at all, otherwise the next full-payload flush of some other
    // pointer would carry an unpositioned row to the renderer and park a ghost at the cursor.
    // writer.ingest spawns lazily, only when the event carries a real target, and writes ONE
    // atomic snapshot carrying cursorAnchor "spawn" + that target. The anchor then stays on the
    // row (no clearAnchor anywhere), so even if several real writes land before the native poll,
    // the document it reads still departs from the real cursor instead of popping onto a target.
    writer.ingest(event, () => {
      const { ordinal, label } = labelFor(actor)
      return { label, color: COLORS[(ordinal - 1) % COLORS.length] }
    })
  }

  function handleReset() {
    if (!active) return
    ordinalByKey.clear()
    actorByKey.clear()
    safeCall(() => writer.clear())
  }

  function isTrustedSubagent(actor) {
    if (!actor || typeof actor !== 'object') return false
    if (actor.trust !== 'trusted') return false
    const agentId = actor.agentId
    const rootAgentId = actor.rootAgentId
    return (
      typeof agentId === 'string' &&
      agentId.length > 0 &&
      typeof rootAgentId === 'string' &&
      rootAgentId.length > 0 &&
      agentId !== rootAgentId &&
      typeof actor.depth === 'number' &&
      actor.depth > 0 &&
      Number.isInteger(actor.lifetime) &&
      actor.lifetime > 0
    )
  }

  // The runtime replays live actors on late subscribe and dedupes per (agentId, lifetime).
  // This is the SAME lifetime the gateway published; the probe never derives lifetime/depth
  // from a bare agent/created event.
  function handleActorLive(payload) {
    if (!active || !payload) return
    const actor = payload.actor && typeof payload.actor === 'object' ? payload.actor : payload
    if (!isTrustedSubagent(actor)) return
    actorByKey.set(actor.agentId + '\u001f' + actor.lifetime, {
      trust: 'trusted',
      agentId: actor.agentId,
      rootAgentId: actor.rootAgentId,
      depth: actor.depth,
      lifetime: actor.lifetime,
    })
  }

  function handleMode(payload) {
    if (!active || !payload) return
    const rootId = typeof payload.rootId === 'string' ? payload.rootId : null
    const selected = activeRootId()
    if (rootId && typeof selected === 'string' && selected !== rootId) return
    const next = {
      rootId,
      enabled: payload.enabled === true,
      task: typeof payload.task === 'string' ? payload.task : null,
    }
    const changed =
      !lastMode || lastMode.rootId !== next.rootId || lastMode.task !== next.task || lastMode.enabled !== next.enabled
    lastMode = next
    // Mode switch (enable/disable, task change or root switch) invalidates every pointer and
    // every request id from the previous epoch.
    if (changed || !next.enabled) handleReset()
  }

  function handleActorDisposed(payload) {
    if (!active || !payload) return
    const key = typeof payload.agentId === 'string' ? payload.agentId + '\u001f' + payload.lifetime : null
    if (key) {
      ordinalByKey.delete(key)
      actorByKey.delete(key)
    }
    // The runtime forwards this to pointerWriter.dispose(actor) when attached. Without that hook
    // we release here, still keyed by (agentId, lifetime) so a new lifetime is never touched.
    if (!attachedWriter) {
      const actor = {
        trust: 'trusted',
        agentId: payload.agentId,
        rootAgentId: payload.rootId != null ? payload.rootId : payload.rootAgentId,
        depth: payload.depth,
        lifetime: payload.lifetime,
      }
      if (isTrustedSubagent(actor)) safeCall(() => writer.dispose(actor))
    }
    // The faded row must stay in the file for releaseMs so the renderer can finish its tail
    // animation; the sweep removes it afterwards (the interval is the backstop).
    scheduleSweep()
  }

  const unsubscribe = []
  function subscribe(type, handler) {
    if (!runtime || typeof runtime.subscribe !== 'function') return
    try {
      const off = runtime.subscribe(type, handler)
      if (typeof off === 'function') unsubscribe.push(off)
    } catch {
      /* ignore */
    }
  }

  subscribe('actor-live', handleActorLive)
  subscribe('action', handleAction)
  subscribe('reset', handleReset)
  subscribe('mode', handleMode)
  subscribe('actor-disposed', handleActorDisposed)

  let detachWriter = null
  let attachedWriter = false
  if (runtime && typeof runtime.attachPointerWriter === 'function') {
    detachWriter = safeCall(() => runtime.attachPointerWriter(writer))
    attachedWriter = typeof detachWriter === 'function'
  }

  function onCreated(payload) {
    const agent = payload && payload.agent ? payload.agent : payload
    if (!isAgent(agent) || agentById.has(agent.id)) return
    if (!shouldTrackAgent(agent, ctx)) return
    agentById.set(agent.id, agent)
    startHelper()
  }

  function onDisposed(payload) {
    const agent = payload && payload.agent ? payload.agent : payload
    if (isAgent(agent)) agentById.delete(agent.id)
    // Actual pointer removal is epoch-keyed and driven by runtime.publishActorDisposed(actor)
    // -> pointerWriter.dispose(actor); a bare lifecycle id has no lifetime, so we never guess one
    // here (the fallback above runs only before the runtime's writer hook is attached).
    scheduleSweep()
  }

  const bindCreated = bind(ctx, 'agent/created', onCreated)
  const bindDisposed = bind(ctx, 'agent/disposed', onDisposed)
  if (bindCreated) cleanups.push(bindCreated)
  if (bindDisposed) cleanups.push(bindDisposed)

  const interval = setInterval(() => {
    if (!active) return
    safeCall(() => writer.sweep())
  }, Math.max(200, Math.floor(releaseMs) + 80))
  if (interval && typeof interval.unref === 'function') interval.unref()

  startHelper()

  cleanups.push(() => {
    active = false
    stopHelper()
    if (sweepTimer) {
      clearTimeout(sweepTimer)
      sweepTimer = null
    }
    clearInterval(interval)
    for (const off of unsubscribe.splice(0)) {
      try {
        off()
      } catch {
        /* ignore */
      }
    }
    // Only clear the shared state file while this instance still owns it; a later mounted
    // instance must never lose its rows to an older instance's teardown.
    const ownsState = moduleWriter === writer && (!runtime || runtime[WRITER_OWNER] === writer)
    if (ownsState) safeCall(() => writer.clear())
    if (moduleWriter === writer) moduleWriter = null
    if (typeof detachWriter === 'function') {
      try {
        detachWriter()
      } catch {
        /* ignore */
      }
    }
    try {
      if (runtime && runtime[WRITER_OWNER] === writer) delete runtime[WRITER_OWNER]
    } catch {
      /* ignore */
    }
    try {
      if (ctx.pointerWriter === writer) delete ctx.pointerWriter
    } catch {
      /* ignore */
    }
    if (ownStateDir && stateDir) safeCall(() => rmSync(stateDir, { recursive: true, force: true }))
  })
}

function bind(ctx, type, handler) {
  if (!ctx || typeof ctx.on !== 'function') return null
  try {
    const off = ctx.on(type, handler)
    return typeof off === 'function' ? off : null
  } catch {
    return null
  }
}

function safeCall(fn) {
  try {
    return fn()
  } catch {
    return null
  }
}
