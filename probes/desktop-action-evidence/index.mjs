/**
 * 验收专用动作事件观察器（旁路，默认关闭，可显式卸载）。
 *
 * 只做一件事：把 multi-mouse runtime 已经公开的 action 事件（bus 投影）追加进本次运行
 * 独占的 JSONL，供真机验收把 actor → requestId → leaseId 串起来看。
 * 不注入输入、不改模式/task/root/epoch、不注册工具、不 dispose 共享 runtime，
 * 除 subscribe() 与 getMode() 之外不碰它。
 *
 * 必须与证据一起引用的边界（不能夸大）：
 * 1. 这是 bus 投影，不是动作的权威记录：runtime 只在 root 已开启时 emit('action')
 *    （plugin/lib/multi-mouse-runtime.mjs:459-460），且只发通过自身 epoch/seq/生命期
 *    门禁的那一部分（:429-453）。关闭期间的桌面动作在总线上完全不可见。
 * 2. leaseId 是 arbiter 进程内的租约 token（src/desktop/arbiter.ts:629 'lease:'+uuid，
 *    :635 在 gate.acquire 之后才写进事件）。它只证明“过了本进程的 FIFO gate”，
 *    不证明 broker 侧的 marker/租约持久化成功，broker 也不回显。
 *    cancelled/failed 可能发生在拿到租约之前（:642-645），那时 leaseId 为空。
 * 3. 应用响应（窗口变化、截图、工具返回值）不在这条总线上，也没有 requestId，
 *    只能来自 audit-*.jsonl / shots/*.png / 宿主工具结果，与本文件只能按时间窗与
 *    坐标近似对齐。缺 physical 坐标的网页动作不能据此宣称 A16/Q5 通过。
 * 4. 只记白名单字段：不落 label/app/reason/text/URL/页面内容/凭据，也不读 audit、
 *    profile 或浏览器状态。
 *
 * 证据根固定由本模块位置推导（<包根>/artifacts/desktop-action-evidence），不接受配置
 * 传入任意路径；每次运行新建不可覆盖的 run 目录（open 'wx'），从不覆盖已有记录。
 */
import { randomBytes } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA = 1
const KIT = 'probes/desktop-action-evidence/index.mjs'
const KIT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(KIT_DIR, '..', '..')
const RUNTIME_SPECIFIER = new URL('../../plugin/lib/multi-mouse-runtime.mjs', import.meta.url).href
const EVIDENCE_SEGMENTS = Object.freeze(['artifacts', 'desktop-action-evidence'])
const EVIDENCE_FILE = 'action-events.jsonl'
const RUN_ID = /^run-[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/
const DEFAULT_DURATION_MS = 300000
const MIN_DURATION_MS = 1000
const MAX_DURATION_MS = 600000
const DEFAULT_MAX_EVENTS = 4000
const MAX_ALLOWED_EVENTS = 5000
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
const MIN_MAX_BYTES = 512
const MAX_ALLOWED_BYTES = 32 * 1024 * 1024
const MAX_PATH_POINTS = 96

function errorText(error) {
  return error && error.message ? String(error.message) : String(error)
}

function clean(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) : text
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function integer(value) {
  return Number.isInteger(value) ? value : null
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null
}

function pointOf(value) {
  if (!value || typeof value !== 'object') return null
  const x = finite(value.x)
  const y = finite(value.y)
  return x === null || y === null ? null : { x, y }
}

function rectOf(value) {
  if (!value || typeof value !== 'object') return null
  const x = finite(value.x)
  const y = finite(value.y)
  const width = finite(value.width)
  const height = finite(value.height)
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height }
}

function clamp(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function defaultLog(message) {
  try { console.warn('[desktop-action-evidence] ' + message) } catch { /* 日志失败也不能影响调用方 */ }
}

/** 只保留白名单字段，逐项做值域收敛；缺什么就留 null/空，绝不补造。 */
function projectAction(evt) {
  const path = []
  if (Array.isArray(evt.path)) {
    for (const entry of evt.path.slice(0, MAX_PATH_POINTS)) {
      const point = pointOf(entry)
      if (point) path.push(point)
    }
  }
  return {
    trust: 'trusted',
    rootId: clean(evt.rootId, 160),
    agentId: clean(evt.agentId, 160),
    depth: integer(evt.depth),
    lifetime: integer(evt.lifetime),
    requestId: clean(evt.requestId, 200) || null,
    seq: integer(evt.seq),
    leaseId: clean(evt.leaseId, 200) || null,
    phase: clean(evt.phase, 40),
    kind: clean(evt.kind, 40),
    button: clean(evt.button, 16),
    space: clean(evt.space, 16),
    epoch: integer(evt.epoch),
    from: pointOf(evt.from),
    to: pointOf(evt.to),
    path,
    sampleMs: integer(evt.sampleMs),
    motionMs: integer(evt.motionMs),
    durationMs: integer(evt.durationMs),
    double: boolOrNull(evt.double),
    windowRect: rectOf(evt.windowRect),
    ok: boolOrNull(evt.ok),
  }
}

/** 目录归属：存在就必须是真实目录（不跟随符号链接），缺失才算可以新建。 */
function directoryState(path) {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink() ? 'dir' : 'other'
  } catch (error) {
    return error && error.code === 'ENOENT' ? 'missing' : 'error'
  }
}

function prepareEvidenceDir(base) {
  if (directoryState(base) !== 'dir') return { ok: false, why: 'evidence-base' }
  let dir = base
  for (const segment of EVIDENCE_SEGMENTS) {
    dir = join(dir, segment)
    const state = directoryState(dir)
    if (state === 'dir') continue
    if (state !== 'missing') return { ok: false, why: 'evidence-root' }
    try { mkdirSync(dir) } catch { return { ok: false, why: 'evidence-root' } }
  }
  return { ok: true, dir }
}

function readModeSnapshot(runtime, rootId, log) {
  if (typeof runtime.getMode !== 'function') return null
  try {
    const mode = runtime.getMode(rootId)
    if (!mode || typeof mode !== 'object') return null
    const snapshot = {}
    if (typeof mode.enabled === 'boolean') snapshot.enabled = mode.enabled
    if (Number.isInteger(mode.epoch) && mode.epoch > 0) snapshot.epoch = mode.epoch
    return Object.keys(snapshot).length > 0 ? snapshot : null
  } catch (error) {
    log('cannot read the mode snapshot: ' + errorText(error))
    return null
  }
}

function mintRunId(stamp) {
  return 'run-' + stamp + '-' + randomBytes(4).toString('hex')
}

/**
 * 公开、可单测的观察函数：给一个能 subscribe 的对象就工作，不依赖宿主。
 * options: { runtime, config, evidenceRoot?, runId?, now?, timers?, io?, log? }
 *   evidenceRoot/runId/now/timers/io 只在单测里注入；生产 apply() 不传，
 *   因此证据根永远由模块位置推导，运行号随机且不可覆盖。
 */
export function createActionEvidence(options = {}) {
  const config = options.config && typeof options.config === 'object' ? options.config : {}
  const log = typeof options.log === 'function' ? options.log : defaultLog
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const timers = options.timers && typeof options.timers.setTimeout === 'function'
    ? options.timers
    : { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) }
  const io = options.io && typeof options.io.open === 'function'
    ? options.io
    : { open: (file) => openSync(file, 'wx'), write: (fd, text) => writeSync(fd, text), close: (fd) => closeSync(fd) }

  const counts = { events: 0, bytes: 0, rejected: 0, notes: 0 }
  const unsubscribes = []
  let state = 'recording'
  let reason = ''
  let closed = false
  let fd = null
  let timer = null
  let runId = null
  let file = null
  let baseEpoch = null
  let activeSeen = false
  const startMono = now()

  const mono = () => Math.max(0, Math.round(now() - startMono))
  const stampOf = (value) => new Date(value).toISOString()

  function status() {
    return {
      ok: state === 'recording',
      state,
      reason,
      runId,
      file,
      activeSeen,
      counts: { ...counts },
    }
  }

  const handle = {
    get ok() { return state === 'recording' },
    get state() { return state },
    get reason() { return reason },
    get runId() { return runId },
    get file() { return file },
    status,
    stop: (why) => stop(typeof why === 'string' && why ? why : 'stop-requested'),
  }

  function reject(why, message) {
    state = 'rejected'
    reason = why
    if (message) log(message)
    return handle
  }

  function note(kind, detail) {
    if (closed || fd === null) return
    const line = { schema: SCHEMA, type: 'note', runId, note: kind, at: stampOf(now()), monoMs: mono(), detail }
    const text = JSON.stringify(line) + '\n'
    const size = Buffer.byteLength(text)
    if (counts.bytes + size > maxBytes) return
    try {
      io.write(fd, text)
      counts.bytes += size
      counts.notes += 1
    } catch (error) {
      stop('io-error', { message: errorText(error) })
    }
  }

  function stop(why, detail) {
    if (closed) return
    closed = true
    state = 'stopped'
    reason = why
    if (timer !== null) {
      try { timers.clearTimeout(timer) } catch { /* 清不掉也要继续收尾 */ }
      timer = null
    }
    for (const off of unsubscribes.splice(0)) {
      try { off() } catch (error) { log('unsubscribe failed: ' + errorText(error)) }
    }
    if (fd !== null) {
      const line = {
        schema: SCHEMA,
        type: 'stop',
        runId,
        reason: why,
        stoppedAt: stampOf(now()),
        monoMs: mono(),
        counts: { ...counts },
        ...(detail ? { detail } : {}),
      }
      try { io.write(fd, JSON.stringify(line) + '\n') } catch (error) { log('cannot write the stop line: ' + errorText(error)) }
      try { io.close(fd) } catch (error) { log('cannot close the evidence file: ' + errorText(error)) }
      fd = null
    }
  }

  if (config.enabled !== true) {
    state = 'disabled'
    reason = 'disabled'
    return handle
  }

  const rootId = clean(config.rootId, 160)
  if (!rootId) return reject('no-root', 'enabled without an exact rootId; nothing is recorded')

  const runtime = options.runtime
  if (!runtime || typeof runtime.subscribe !== 'function') {
    return reject('no-runtime', 'no runtime exposing subscribe(); nothing is recorded')
  }

  const durationMs = clamp(config.durationMs, DEFAULT_DURATION_MS, MIN_DURATION_MS, MAX_DURATION_MS)
  const maxEvents = clamp(config.maxEvents, DEFAULT_MAX_EVENTS, 1, MAX_ALLOWED_EVENTS)
  const maxBytes = clamp(config.maxBytes, DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_ALLOWED_BYTES)

  const base = (() => {
    try { return options.evidenceRoot ? resolve(options.evidenceRoot) : REPO_ROOT } catch { return REPO_ROOT }
  })()
  const prepared = prepareEvidenceDir(base)
  if (!prepared.ok) return reject(prepared.why, 'the evidence directory is not usable (' + prepared.why + '); refusing to write anywhere else')

  const wanted = typeof options.runId === 'string' ? options.runId.trim() : ''
  const runDir = (() => {
    if (wanted) {
      if (!RUN_ID.test(wanted)) return { ok: false, why: 'run-invalid' }
      const escaped = relative(prepared.dir, join(prepared.dir, wanted))
      if (!escaped || escaped.startsWith('..') || escaped.includes(sep)) return { ok: false, why: 'run-invalid' }
      try { mkdirSync(join(prepared.dir, escaped)) } catch (error) {
        return { ok: false, why: error && error.code === 'EEXIST' ? 'run-exists' : 'run-create' }
      }
      return { ok: true, id: wanted, dir: join(prepared.dir, escaped) }
    }
    const stamp = new Date(now()).toISOString().replace(/-/g, '').replace(/:/g, '').replace(/\.\d+Z$/, 'Z')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = mintRunId(stamp)
      const dir = join(prepared.dir, candidate)
      try { mkdirSync(dir); return { ok: true, id: candidate, dir } } catch (error) {
        if (!error || error.code !== 'EEXIST') return { ok: false, why: 'run-create' }
      }
    }
    return { ok: false, why: 'run-exists' }
  })()
  if (!runDir.ok) return reject(runDir.why, 'cannot create a fresh run folder (' + runDir.why + '); refusing to reuse or overwrite')
  runId = runDir.id

  file = join(runDir.dir, EVIDENCE_FILE)
  try {
    fd = io.open(file)
  } catch (error) {
    const why = error && error.code === 'EEXIST' ? 'file-exists' : 'file-open'
    return reject(why, 'cannot create the evidence file (' + errorText(error) + '); refusing to overwrite')
  }

  const snapshot = readModeSnapshot(runtime, rootId, log)
  if (snapshot && Number.isInteger(snapshot.epoch)) baseEpoch = snapshot.epoch

  const startLine = {
    schema: SCHEMA,
    type: 'start',
    runId,
    kit: KIT,
    pid: process.pid,
    rootId,
    limits: { durationMs, maxEvents, maxBytes },
    startedAt: stampOf(now()),
    monoMs: 0,
    snapshot,
    snapshotNote: 'attach-time mode snapshot; not a live action event',
  }
  const startText = JSON.stringify(startLine) + '\n'
  try {
    io.write(fd, startText)
    counts.bytes += Buffer.byteLength(startText)
  } catch (error) {
    try { io.close(fd) } catch { /* 关不掉也只能返回失败 */ }
    fd = null
    return reject('io-error', 'cannot write the start line: ' + errorText(error))
  }

  function attach(type, handler) {
    const off = runtime.subscribe(type, (payload) => {
      if (closed) return
      try { handler(payload) } catch (error) {
        counts.rejected += 1
        log('event handler failed for ' + type + ': ' + errorText(error))
      }
    })
    if (typeof off !== 'function') throw new Error('subscribe(' + type + ') returned no unsubscribe function')
    unsubscribes.push(off)
  }

  function onAction(evt) {
    if (closed) return
    if (!evt || typeof evt !== 'object') { counts.rejected += 1; return }
    if (clean(evt.trust, 16) !== 'trusted') { counts.rejected += 1; return }
    if (clean(evt.rootId, 160) !== rootId) { counts.rejected += 1; return }
    const agentId = clean(evt.agentId, 160)
    const depth = integer(evt.depth)
    if (!agentId || agentId === rootId || depth === null || depth < 1) { counts.rejected += 1; return }
    const epoch = integer(evt.epoch)
    if (epoch !== null && epoch > 0) {
      if (baseEpoch === null) {
        baseEpoch = epoch
      } else if (epoch !== baseEpoch) {
        if (activeSeen) {
          stop('epoch-changed', { expectedEpoch: baseEpoch, observedEpoch: epoch })
          return
        }
        note('epoch-rebased', { from: baseEpoch, to: epoch })
        baseEpoch = epoch
      }
    }
    if (counts.events >= maxEvents) {
      stop('max-events', { maxEvents })
      return
    }
    const line = {
      schema: SCHEMA,
      type: 'action',
      runId,
      n: counts.events + 1,
      receivedAt: stampOf(now()),
      monoMs: mono(),
      srcAt: integer(evt.at),
      event: projectAction(evt),
    }
    const text = JSON.stringify(line) + '\n'
    const size = Buffer.byteLength(text)
    if (counts.bytes + size > maxBytes) {
      stop('max-bytes', { maxBytes })
      return
    }
    try {
      io.write(fd, text)
    } catch (error) {
      stop('io-error', { message: errorText(error) })
      return
    }
    counts.bytes += size
    counts.events += 1
    activeSeen = true
  }

  function onMode(evt) {
    if (closed || !evt || typeof evt !== 'object') return
    if (clean(evt.rootId, 160) !== rootId) return
    if (evt.enabled === false && activeSeen) stop('mode-off')
  }

  function onReset(evt) {
    if (closed) return
    const id = evt && typeof evt === 'object' ? clean(evt.rootId, 160) : ''
    if (id && id !== rootId) return
    const epoch = evt && typeof evt === 'object' ? integer(evt.epoch) : null
    // runtime.dispose() 先置 closed 再发 reset（plugin/lib/multi-mouse-runtime.mjs:672-696），
    // 所以“runtime 被释放”在这里表现为带 reason:'dispose' 的 reset。单独命名，
    // 免得把它和普通重置写成一个原因。
    if (evt && typeof evt === 'object' && evt.reason === 'dispose') {
      stop('runtime-disposed', { epoch })
      return
    }
    stop('reset', id ? { epoch } : { note: 'reset without a rootId' })
  }

  state = 'recording'
  try {
    attach('action', onAction)
    attach('reset', onReset)
    attach('mode', onMode)
  } catch (error) {
    log('cannot subscribe: ' + errorText(error))
    stop('attach-failed', { message: errorText(error) })
    return handle
  }

  timer = timers.setTimeout(() => stop('duration'), durationMs)
  if (timer && typeof timer.unref === 'function') timer.unref()
  log('recording action events of root "' + rootId + '" into ' + runId)
  return handle
}

/** 生产入口：cordis Host plugin，默认关闭；只有 enabled === true 且给了精确 rootId 才动手。 */
export const name = 'desktop-action-evidence'
export const inject = []

export function apply(ctx, config = {}) {
  return mountActionEvidence(ctx, config)
}

/**
 * 可测试的挂载缝：deps.loadRuntime / deps.evidenceRoot / deps.now / deps.timers / deps.io / deps.log
 * 只给单测用；apply() 不传，因此生产路径永远加载共享 runtime 单例、写死证据根。
 */
export async function mountActionEvidence(ctx, config = {}, deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : defaultLog
  const settings = config && typeof config === 'object' ? config : {}
  if (settings.enabled !== true) return { ok: false, state: 'disabled', reason: 'disabled' }
  const rootId = typeof settings.rootId === 'string' ? settings.rootId.trim() : ''
  if (!rootId) {
    log('enabled without an exact rootId; nothing is recorded')
    return { ok: false, state: 'rejected', reason: 'no-root' }
  }
  let observer = null
  let stopped = false
  const cleanup = () => {
    stopped = true
    if (observer) {
      observer.stop('unmounted')
      observer = null
    }
  }
  if (ctx && typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  else if (ctx && typeof ctx.on === 'function') ctx.on('dispose', cleanup)
  const load = typeof deps.loadRuntime === 'function' ? deps.loadRuntime : defaultLoadRuntime
  try {
    const runtime = await load()
    if (stopped) return { ok: false, state: 'stopped', reason: 'unmounted' }
    observer = createActionEvidence({
      config: settings,
      runtime,
      log,
      ...(deps.evidenceRoot ? { evidenceRoot: deps.evidenceRoot } : {}),
      ...(typeof deps.now === 'function' ? { now: deps.now } : {}),
      ...(deps.timers && typeof deps.timers.setTimeout === 'function' ? { timers: deps.timers } : {}),
      ...(deps.io && typeof deps.io.open === 'function' ? { io: deps.io } : {}),
    })
    if (!observer.ok) log('not recording: ' + observer.reason)
    return observer
  } catch (error) {
    log('cannot load the overlay runtime: ' + errorText(error))
    return { ok: false, state: 'rejected', reason: 'no-runtime' }
  }
}

async function defaultLoadRuntime() {
  const module = await import(RUNTIME_SPECIFIER)
  if (!module || typeof module.getMultiMouseRuntime !== 'function') {
    throw new Error('the overlay runtime exports no getMultiMouseRuntime')
  }
  return module.getMultiMouseRuntime()
}
