/**
 * 行为回归：验收专用动作事件观察器（probes/desktop-action-evidence/index.mjs）。
 *
 * 用纯假 runtime（只有 subscribe/getMode，外加一个测试侧 emit 推事件）+ 临时目录驱动
 * 公开的 createActionEvidence / mountActionEvidence，断言它：
 *   · 默认不记录、缺 root 不记录、没有 runtime 不记录；
 *   · 只记同 root 的可信子孙事件，只写白名单字段（不落 label/app/reason/text/URL）；
 *   · 不改原事件、不往共享 runtime 注入任何东西；
 *   · 冷态等首次 active；之后 mode-off / reset / epoch 变化 / 上限 / 定时 / 卸载都收尾；
 *   · 订阅部分失败、IO 失败都不外抛；退出后零订阅零写入；
 *   · 证据根不可逃逸、不覆盖既有文件。
 *
 * 只覆盖模块自身行为：不启真实 runtime、不做真实输入、不证明已装进任何 DSH，
 * 也不证明真实 bus 与应用响应（那属于 root 的真机验证）。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, createActionEvidence, inject, mountActionEvidence, name } from '../probes/desktop-action-evidence/index.mjs'

const ROOT = 'session-root'
const AGENT = 'agent-a'
const made = []

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'evo-action-evidence-'))
  made.push(dir)
  return dir
}

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function clock(start = 1700000000000) {
  let value = start
  return { now: () => { value += 1000; return value }, peek: () => value }
}

function fakeTimers() {
  let nextId = 0
  const pending = new Map()
  return {
    pending,
    setTimeout(fn, ms) { nextId += 1; pending.set(nextId, { fn, ms }); return nextId },
    clearTimeout(id) { pending.delete(id) },
    fireAll() { const entries = [...pending.values()]; pending.clear(); for (const entry of entries) entry.fn() },
  }
}

/** 只有 subscribe/getMode 是生产接口；其余名字一旦被调用就记进 forbidden，测试直接失败。 */
function fakeRuntime(options = {}) {
  const handlers = new Map()
  const calls = []
  const forbidden = []
  const runtime = {
    calls,
    forbidden,
    subscribe(type, handler) {
      calls.push(['subscribe', type])
      if (options.subscribeThrows && options.subscribeThrows[type]) throw new Error('subscribe ' + type + ' failed')
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type).add(handler)
      return () => { const set = handlers.get(type); if (set) set.delete(handler) }
    },
    getMode(rootId) {
      calls.push(['getMode', rootId])
      if (options.getModeThrows) throw new Error('getMode failed')
      const modes = options.modes || {}
      return modes[rootId] || { rootId, enabled: false, task: '', epoch: 1 }
    },
    emit(type, payload) {
      const set = handlers.get(type)
      if (!set) return
      for (const handler of [...set]) handler(payload)
    },
    listeners(type) { const set = handlers.get(type); return set ? set.size : 0 },
    allListeners() { let total = 0; for (const set of handlers.values()) total += set.size; return total },
  }
  for (const forbiddenName of [
    'publishAction', 'publishActorLive', 'publishActorDisposed', 'publishMode',
    'selectRoot', 'attachPointerWriter', 'publishCompanion', 'reset', 'dispose', 'setDesktopMode',
  ]) {
    runtime[forbiddenName] = (...args) => { forbidden.push([forbiddenName, ...args]) }
  }
  return runtime
}

/** bus 投影的典型形状；带 SECRET-* 的敏感字段必须一条都不落盘。 */
function actionEvent(overrides = {}) {
  return {
    rootId: ROOT,
    agentId: AGENT,
    depth: 1,
    lifetime: 3,
    requestId: 'call-1:1',
    seq: 1,
    leaseId: 'lease:abc',
    phase: 'granted',
    kind: 'click',
    button: 'left',
    space: 'physical',
    epoch: 2,
    from: { x: 10, y: 20 },
    to: { x: 30, y: 40 },
    path: [],
    sampleMs: 1700000000123,
    motionMs: 5,
    durationMs: 9,
    double: false,
    ok: true,
    windowRect: { x: 0, y: 0, width: 800, height: 600 },
    trust: 'trusted',
    at: 1700000000100,
    label: 'SECRET-LABEL',
    app: 'SECRET-APP',
    reason: 'SECRET-REASON',
    text: 'SECRET-TEXT',
    url: 'https://SECRET.example/',
    content: 'SECRET-CONTENT',
    token: 'SECRET-TOKEN',
    actor: { agentId: AGENT, lifetime: 3, trust: 'trusted' },
    ...overrides,
  }
}

function begin(options = {}) {
  const base = options.base || temp()
  const runtime = options.runtime || fakeRuntime(options.runtimeOptions)
  const timers = options.timers || fakeTimers()
  const handle = createActionEvidence({
    runtime,
    config: { enabled: true, rootId: ROOT, durationMs: 60000, ...(options.config || {}) },
    evidenceRoot: base,
    now: clock().now,
    timers,
    log() {},
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.io ? { io: options.io } : {}),
  })
  return { base, runtime, timers, handle }
}

function records(handle) {
  return readFileSync(handle.file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

test('模块声明：验收用 host-only 插件，不注入任何宿主服务', () => {
  assert.equal(name, 'desktop-action-evidence')
  assert.deepEqual(inject, [])
  assert.equal(typeof apply, 'function')
  assert.equal(typeof mountActionEvidence, 'function')
})

test('默认不记录：未显式 enabled 时零订阅、零目录、零文件', () => {
  const base = temp()
  const runtime = fakeRuntime()
  const handle = createActionEvidence({ runtime, config: {}, evidenceRoot: base, timers: fakeTimers(), log() {} })
  assert.equal(handle.ok, false)
  assert.equal(handle.state, 'disabled')
  assert.equal(handle.reason, 'disabled')
  runtime.emit('action', actionEvent())
  assert.equal(runtime.allListeners(), 0)
  assert.deepEqual(runtime.calls, [])
  assert.equal(existsSync(join(base, 'artifacts')), false)
})

test('缺 rootId 时拒绝：不猜 root、不订阅、不建文件', () => {
  const base = temp()
  const runtime = fakeRuntime()
  const handle = createActionEvidence({ runtime, config: { enabled: true }, evidenceRoot: base, timers: fakeTimers(), log() {} })
  assert.equal(handle.state, 'rejected')
  assert.equal(handle.reason, 'no-root')
  assert.deepEqual(runtime.calls, [])
  assert.equal(existsSync(join(base, 'artifacts')), false)
})

test('没有可用 runtime 时拒绝，且不建文件', () => {
  const base = temp()
  for (const runtime of [undefined, {}, { subscribe: 1 }]) {
    const handle = createActionEvidence({ runtime, config: { enabled: true, rootId: ROOT }, evidenceRoot: base, timers: fakeTimers(), log() {} })
    assert.equal(handle.state, 'rejected')
    assert.equal(handle.reason, 'no-runtime')
  }
  assert.equal(existsSync(join(base, 'artifacts')), false)
})

test('只记同 root 的可信子孙事件', () => {
  const { runtime, handle } = begin({ runtimeOptions: { modes: { [ROOT]: { enabled: true, epoch: 2 } } } })
  runtime.emit('action', actionEvent({ rootId: 'session-other' }))
  runtime.emit('action', actionEvent({ agentId: ROOT, depth: 0 }))
  runtime.emit('action', actionEvent({ agentId: ROOT, depth: 1 }))
  runtime.emit('action', actionEvent({ trust: 'legacy' }))
  runtime.emit('action', actionEvent({ depth: 0 }))
  assert.equal(handle.status().counts.events, 0)
  assert.equal(handle.status().counts.rejected, 5)
  runtime.emit('action', actionEvent())
  assert.equal(handle.status().counts.events, 1)
  const lines = records(handle)
  assert.equal(lines[0].type, 'start')
  assert.equal(lines[1].type, 'action')
  assert.equal(lines[1].event.agentId, AGENT)
  handle.stop('test-end')
})

test('白名单：只写身份与动作关联值，不落敏感字段', () => {
  const { runtime, handle } = begin({ runtimeOptions: { modes: { [ROOT]: { enabled: true, epoch: 2 } } } })
  runtime.emit('action', actionEvent())
  const action = records(handle).find(line => line.type === 'action')
  const text = JSON.stringify(action)
  for (const forbidden of ['SECRET', '"label"', '"app"', '"reason"', '"text"', '"url"', '"content"', '"token"', '"actor"']) {
    assert.equal(text.includes(forbidden), false, forbidden + ' must not be recorded')
  }
  assert.deepEqual(Object.keys(action.event).sort(), [
    'agentId', 'button', 'depth', 'double', 'durationMs', 'epoch', 'from', 'kind', 'leaseId',
    'lifetime', 'motionMs', 'ok', 'path', 'phase', 'requestId', 'rootId', 'sampleMs', 'seq',
    'space', 'to', 'trust', 'windowRect',
  ])
  assert.equal(action.event.trust, 'trusted')
  assert.equal(action.event.requestId, 'call-1:1')
  assert.equal(action.event.leaseId, 'lease:abc')
  assert.equal(action.event.space, 'physical')
  assert.deepEqual(action.event.from, { x: 10, y: 20 })
  assert.deepEqual(action.event.to, { x: 30, y: 40 })
  assert.deepEqual(action.event.windowRect, { x: 0, y: 0, width: 800, height: 600 })
  assert.equal(action.event.ok, true)
  assert.equal(action.event.double, false)
  assert.equal(action.srcAt, 1700000000100)
  assert.equal(typeof action.n, 'number')
  assert.equal(typeof action.monoMs, 'number')
  handle.stop('test-end')
})

test('空 leaseId 不杜撰，也不凭空补 hwnd/area', () => {
  const { runtime, handle } = begin({ runtimeOptions: { modes: { [ROOT]: { enabled: true, epoch: 2 } } } })
  runtime.emit('action', actionEvent({ leaseId: undefined }))
  const action = records(handle).find(line => line.type === 'action')
  assert.equal(action.event.leaseId, null)
  assert.equal('hwnd' in action.event, false)
  assert.equal('area' in action.event, false)
  handle.stop('test-end')
})

test('不注入、不改共享 runtime，也不改原事件对象', () => {
  const { runtime, handle } = begin({ runtimeOptions: { modes: { [ROOT]: { enabled: true, epoch: 2 } } } })
  const event = actionEvent()
  const before = structuredClone(event)
  runtime.emit('action', event)
  assert.deepEqual(event, before)
  assert.deepEqual(runtime.forbidden, [])
  assert.equal(runtime.calls[0][0], 'getMode')
  assert.deepEqual([...new Set(runtime.calls.map(call => call[0]))].sort(), ['getMode', 'subscribe'])
  assert.deepEqual(runtime.calls.filter(call => call[0] === 'subscribe').map(call => call[1]), ['action', 'reset', 'mode'])
  handle.stop('test-end')
})

test('getMode 抛错时仍能开始记录，只是没有快照', () => {
  const { runtime, handle } = begin({ runtimeOptions: { getModeThrows: true } })
  const start = records(handle)[0]
  assert.equal(start.snapshot, null)
  runtime.emit('action', actionEvent())
  assert.equal(handle.status().counts.events, 1)
  handle.stop('test-end')
})

test('冷态等待首次 enabled：快照不是 live 事件，也不自毁', () => {
  const { runtime, handle } = begin({ runtimeOptions: { modes: { [ROOT]: { enabled: false, epoch: 2 } } } })
  const start = records(handle)[0]
  assert.deepEqual(start.snapshot, { enabled: false, epoch: 2 })
  assert.equal(start.snapshotNote, 'attach-time mode snapshot; not a live action event')
  runtime.emit('mode', { rootId: ROOT, enabled: false, epoch: 2 })
  assert.equal(handle.ok, true)
  runtime.emit('mode', { rootId: ROOT, enabled: true, epoch: 2 })
  runtime.emit('action', actionEvent({ epoch: 2 }))
  assert.equal(handle.status().counts.events, 1)
  assert.equal(records(handle).filter(line => line.type === 'action').length, 1)
  handle.stop('test-end')
})

test('已观察过 active 后 mode-off 停止本 run', () => {
  const { runtime, handle } = begin({ runtimeOptions: { modes: { [ROOT]: { enabled: true, epoch: 2 } } } })
  runtime.emit('action', actionEvent())
  runtime.emit('mode', { rootId: ROOT, enabled: false })
  assert.equal(handle.state, 'stopped')
  assert.equal(handle.reason, 'mode-off')
  assert.equal(runtime.allListeners(), 0)
  const lines = records(handle)
  assert.equal(lines.at(-1).type, 'stop')
  assert.equal(lines.at(-1).reason, 'mode-off')
})

test('epoch 改变停止本 run，新 epoch 的事件不落盘', () => {
  const { runtime, handle } = begin({ runtimeOptions: { modes: { [ROOT]: { enabled: true, epoch: 2 } } } })
  runtime.emit('action', actionEvent({ epoch: 2 }))
  runtime.emit('action', actionEvent({ epoch: 5, requestId: 'call-2:1' }))
  assert.equal(handle.reason, 'epoch-changed')
  const lines = records(handle)
  assert.equal(lines.filter(line => line.type === 'action').length, 1)
  assert.deepEqual(lines.at(-1).detail, { expectedEpoch: 2, observedEpoch: 5 })
})

test('冷态里的 epoch 变化只重定基线并留 note', () => {
  const { runtime, handle } = begin({ runtimeOptions: { modes: { [ROOT]: { enabled: false, epoch: 1 } } } })
  runtime.emit('action', actionEvent({ epoch: 3 }))
  assert.equal(handle.ok, true)
  const lines = records(handle)
  const note = lines.find(line => line.type === 'note')
  assert.equal(note.note, 'epoch-rebased')
  assert.deepEqual(note.detail, { from: 1, to: 3 })
  assert.equal(lines.filter(line => line.type === 'action').length, 1)
  handle.stop('test-end')
})

test('reset 停止本 run；其它 root 的 reset 被忽略', () => {
  const { runtime, handle } = begin({ runtimeOptions: { modes: { [ROOT]: { enabled: true, epoch: 2 } } } })
  runtime.emit('reset', { rootId: 'session-other', epoch: 3 })
  assert.equal(handle.ok, true)
  runtime.emit('reset', { rootId: ROOT, epoch: 4 })
  assert.equal(handle.reason, 'reset')
  assert.equal(handle.status().counts.events, 0)
  assert.equal(runtime.allListeners(), 0)
})

test('runtime 释放（reset 带 reason: dispose）单独命名', () => {
  const { runtime, handle } = begin({ runtimeOptions: { modes: { [ROOT]: { enabled: true, epoch: 2 } } } })
  runtime.emit('action', actionEvent())
  runtime.emit('reset', { rootId: ROOT, epoch: 5, enabled: false, reason: 'dispose' })
  assert.equal(handle.reason, 'runtime-disposed')
  assert.deepEqual(records(handle).at(-1).detail, { epoch: 5 })
  assert.equal(runtime.allListeners(), 0)
})

test('事件数上限后停止', () => {
  const { runtime, handle } = begin({ config: { maxEvents: 2 } })
  for (let index = 0; index < 3; index += 1) runtime.emit('action', actionEvent({ seq: index }))
  assert.equal(handle.reason, 'max-events')
  assert.equal(handle.status().counts.events, 2)
  assert.equal(records(handle).filter(line => line.type === 'action').length, 2)
})

test('字节上限后停止，事件行不超预算', () => {
  const { runtime, handle } = begin({ config: { maxBytes: 1200 } })
  for (let index = 0; index < 20; index += 1) runtime.emit('action', actionEvent({ seq: index }))
  assert.equal(handle.reason, 'max-bytes')
  const events = records(handle).filter(line => line.type === 'action')
  const bytes = events.reduce((sum, line) => sum + Buffer.byteLength(JSON.stringify(line) + '\n'), 0)
  assert.ok(bytes <= 1200, 'events must fit the budget, got ' + bytes)
  assert.ok(events.length >= 1, 'at least one event should fit')
  assert.ok(events.length < 20, 'the budget must cut the run short')
})

test('显式 stop 幂等：只有一条结束行，退订且不再写', () => {
  const { runtime, handle } = begin({ runtimeOptions: { modes: { [ROOT]: { enabled: true, epoch: 2 } } } })
  runtime.emit('action', actionEvent())
  handle.stop('stop-requested')
  const once = readFileSync(handle.file, 'utf8')
  handle.stop('stop-requested')
  handle.stop('again')
  assert.equal(readFileSync(handle.file, 'utf8'), once)
  assert.equal(runtime.allListeners(), 0)
  const stops = records(handle).filter(line => line.type === 'stop')
  assert.equal(stops.length, 1)
  assert.equal(stops[0].reason, 'stop-requested')
})

test('退出后零订阅零写入', () => {
  const { runtime, handle } = begin({ runtimeOptions: { modes: { [ROOT]: { enabled: true, epoch: 2 } } } })
  handle.stop('test-end')
  const before = readFileSync(handle.file, 'utf8')
  runtime.emit('action', actionEvent())
  runtime.emit('mode', { rootId: ROOT, enabled: false })
  runtime.emit('reset', { rootId: ROOT })
  assert.equal(readFileSync(handle.file, 'utf8'), before)
  assert.equal(runtime.allListeners(), 0)
})

test('定时到点自停并清 timer', () => {
  const timers = fakeTimers()
  const { handle } = begin({ timers, config: { durationMs: 5000 } })
  assert.equal(timers.pending.size, 1)
  assert.equal([...timers.pending.values()][0].ms, 5000)
  timers.fireAll()
  assert.equal(handle.reason, 'duration')
  assert.equal(timers.pending.size, 0)
  assert.equal(records(handle).at(-1).reason, 'duration')
})

test('订阅部分失败：回滚已订阅的监听、不外抛、留可读结束行', () => {
  const runtime = fakeRuntime({ subscribeThrows: { reset: true } })
  const { handle } = begin({ runtime })
  assert.equal(handle.ok, false)
  assert.equal(handle.state, 'stopped')
  assert.equal(handle.reason, 'attach-failed')
  assert.equal(runtime.allListeners(), 0)
  assert.deepEqual(runtime.calls.filter(call => call[0] === 'subscribe').map(call => call[1]), ['action', 'reset'])
  assert.deepEqual(records(handle).map(line => line.type), ['start', 'stop'])
  assert.equal(records(handle).at(-1).reason, 'attach-failed')
})

test('开始行写不进去：直接拒绝，零订阅', () => {
  const io = {
    open: (file) => openSync(file, 'wx'),
    write: () => { throw new Error('disk full') },
    close: (fd) => closeSync(fd),
  }
  const { runtime, handle } = begin({ io })
  assert.equal(handle.state, 'rejected')
  assert.equal(handle.reason, 'io-error')
  assert.equal(runtime.allListeners(), 0)
  assert.deepEqual(runtime.forbidden, [])
})

test('事件写不进去：停止但不影响 emit 的调用方', () => {
  let writes = 0
  const io = {
    open: (file) => openSync(file, 'wx'),
    write: (fd, text) => { writes += 1; if (writes > 1) throw new Error('disk full'); writeSync(fd, text) },
    close: (fd) => closeSync(fd),
  }
  const { runtime, handle } = begin({ io })
  assert.equal(handle.ok, true)
  assert.doesNotThrow(() => runtime.emit('action', actionEvent()))
  assert.equal(handle.reason, 'io-error')
  assert.equal(runtime.allListeners(), 0)
})

test('挂载缝：清理时退订、清 timer、闭文件，之后零写入', async () => {
  const runtime = fakeRuntime({ modes: { [ROOT]: { enabled: true, epoch: 2 } } })
  const timers = fakeTimers()
  const effects = []
  const ctx = { effect(execute) { const disposer = execute(); effects.push(disposer); return disposer } }
  const handle = await mountActionEvidence(
    ctx,
    { enabled: true, rootId: ROOT, durationMs: 60000 },
    { loadRuntime: async () => runtime, evidenceRoot: temp(), timers, log() {} },
  )
  assert.equal(handle.ok, true)
  assert.equal(effects.length, 1)
  assert.equal(runtime.listeners('action'), 1)
  assert.equal(timers.pending.size, 1)
  runtime.emit('action', actionEvent())
  effects[0]()
  const afterUnmount = readFileSync(handle.file, 'utf8')
  assert.equal(runtime.allListeners(), 0)
  assert.equal(timers.pending.size, 0)
  runtime.emit('action', actionEvent())
  assert.equal(readFileSync(handle.file, 'utf8'), afterUnmount)
  assert.equal(records(handle).at(-1).reason, 'unmounted')
})

test('挂载缝：加载失败不外抛、不建文件；未启用时完全不加载', async () => {
  const base = temp()
  const failed = await mountActionEvidence(
    { effect() {} },
    { enabled: true, rootId: ROOT },
    { loadRuntime: async () => { throw new Error('boom') }, evidenceRoot: base, log() {} },
  )
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'no-runtime')
  assert.equal(existsSync(join(base, 'artifacts')), false)

  let loads = 0
  let effects = 0
  const disabled = await mountActionEvidence(
    { effect() { effects += 1 } },
    { enabled: false },
    { loadRuntime: async () => { loads += 1; return fakeRuntime() }, log() {} },
  )
  assert.equal(disabled.reason, 'disabled')
  assert.equal(loads, 0)
  assert.equal(effects, 0)
})

test('不覆盖既有记录：runId 已存在时拒绝', () => {
  const base = temp()
  const dir = join(base, 'artifacts', 'desktop-action-evidence', 'run-fixed-0001')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'action-events.jsonl')
  writeFileSync(file, 'PRE-EXISTING\n')
  const runtime = fakeRuntime()
  const handle = createActionEvidence({
    runtime,
    config: { enabled: true, rootId: ROOT },
    evidenceRoot: base,
    runId: 'run-fixed-0001',
    timers: fakeTimers(),
    log() {},
  })
  assert.equal(handle.state, 'rejected')
  assert.equal(handle.reason, 'run-exists')
  assert.equal(readFileSync(file, 'utf8'), 'PRE-EXISTING\n')
  assert.equal(runtime.allListeners(), 0)
})

test('每次运行都是新目录，不覆盖上一次', () => {
  const base = temp()
  const runtime = fakeRuntime({ modes: { [ROOT]: { enabled: true, epoch: 2 } } })
  const first = createActionEvidence({ runtime, config: { enabled: true, rootId: ROOT }, evidenceRoot: base, timers: fakeTimers(), now: clock().now, log() {} })
  first.stop('test-end')
  const second = createActionEvidence({ runtime, config: { enabled: true, rootId: ROOT }, evidenceRoot: base, timers: fakeTimers(), now: clock().now, log() {} })
  second.stop('test-end')
  assert.notEqual(first.runId, second.runId)
  assert.notEqual(first.file, second.file)
  assert.equal(existsSync(first.file), true)
  assert.equal(existsSync(second.file), true)
})

test('证据根归属：拒绝逃逸的 runId，也不跟随不是目录的 artifacts', () => {
  const base = temp()
  const runtime = fakeRuntime()
  const escaped = createActionEvidence({
    runtime,
    config: { enabled: true, rootId: ROOT },
    evidenceRoot: base,
    runId: '../escape',
    timers: fakeTimers(),
    log() {},
  })
  assert.equal(escaped.state, 'rejected')
  assert.equal(escaped.reason, 'run-invalid')
  assert.equal(existsSync(join(base, 'escape')), false)

  const other = temp()
  writeFileSync(join(other, 'artifacts'), 'not a directory\n')
  const blocked = createActionEvidence({ runtime, config: { enabled: true, rootId: ROOT }, evidenceRoot: other, timers: fakeTimers(), log() {} })
  assert.equal(blocked.state, 'rejected')
  assert.equal(blocked.reason, 'evidence-root')
  assert.equal(runtime.allListeners(), 0)
})
