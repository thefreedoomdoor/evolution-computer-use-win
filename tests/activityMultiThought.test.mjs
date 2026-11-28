import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installActivity } from '../plugin/lib/activity.mjs'

function createRuntime() {
  const modes = new Map()
  const listeners = new Set()
  let selected = null
  const rt = {
    disposed: 0,
    unsubs: 0,
    activeRootId() { return selected },
    getMode(rootId) {
      return modes.get(rootId) || { rootId, enabled: false, task: '', epoch: 1 }
    },
    publishMode(rootId, patch) {
      const before = modes.get(rootId) || { rootId, enabled: false, task: '', epoch: 1 }
      const next = Object.assign({}, before, patch)
      if (patch && patch.enabled === true) selected = rootId
      if (next.enabled !== before.enabled || next.task !== before.task) next.epoch = before.epoch + 1
      modes.set(rootId, next)
      for (const fn of Array.from(listeners)) { try { fn({ rootId, enabled: next.enabled, task: next.task, epoch: next.epoch }) } catch {} }
      return next
    },
    subscribe(type, fn) {
      if (type !== 'mode') return () => {}
      listeners.add(fn)
      return () => { listeners.delete(fn); rt.unsubs += 1 }
    },
    publishRootThinking(rootId, patch) {
      const mode = modes.get(rootId)
      if (!mode || !mode.enabled) return null
      mode.thinking = Object.assign({}, mode.thinking, patch)
      return mode.thinking
    },
    dispose() { rt.disposed += 1 },
  }
  return rt
}

function createHost(file, runtime) {
  const handlers = new Map()
  const ctx = {
    subagents: { rootOf(agent) { return { id: (agent && (agent.rootId || (agent.session && agent.session.id))) || 'root-1' } } },
    get(name) { return name === 'subagents' ? ctx.subagents : undefined },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return () => {}
    },
  }
  const activity = installActivity(ctx, file, {
    getSettings: () => ({ overlayEnabled: true }),
    getLocale: () => 'zh',
    getMultiMouse: () => runtime,
  })
  const emit = async (event, ...args) => {
    const out = []
    for (const fn of handlers.get(event) || []) out.push(await fn(...args))
    return out
  }
  return { ctx, emit, activity }
}

function readBody(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function flush(host) {
  host.activity.publish()
}

function rootAgent() { return { rootId: 'root-1', session: { id: 'root-1' } } }
function childAgent() { return { rootId: 'root-1', session: { id: 'child-a' } } }
function desktopExec(agent) {
  return { name: 'mcp__evolution-computer-use__desktop', arguments: '{}', agent: Object.assign({}, agent, { phase: { kind: 'running', turn: 1 } }) }
}
async function desktopCall(host, agent) {
  return host.emit('tools/execute', desktopExec(agent), async () => ({}))
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-activity-'))
  const file = join(dir, 'activity.json')
  const runtime = createRuntime()
  const host = createHost(file, runtime)
  t.after(async () => {
    try { await host.emit('dispose') } catch {}
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  return { dir, file, runtime, host }
}

test('opening multi-mouse hides a child owner immediately, then shows only root text', async (t) => {
  const { dir, file, runtime, host } = setup(t)
  await desktopCall(host, childAgent())
  let body = readBody(file)
  assert.equal(body.sessionId, 'child-a', '普通模式下子 Agent 先占浮窗')
  await host.emit('session/event', { id: 'child-a' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'done' } } })
  body = readBody(file)
  assert.equal(body.sessionId, 'child-a', '子 Agent 回合结束后处于 linger')
  assert.ok(body.lingerUntil > 0)
  runtime.publishMode('root-1', { enabled: true, task: '主任务' })
  body = readBody(file)
  assert.equal(body.active, false)
  assert.equal(body.sessionId, null, '开启多鼠标当下就清掉子 Agent owner')
  await host.emit('agent/assistant-stream', { agent: rootAgent(), frame: { type: 'start', turn: 1, step: 1, attemptId: 'r1' } })
  await host.emit('agent/assistant-stream', { agent: rootAgent(), frame: { type: 'chunk', attemptId: 'r1', chunk: { type: 'reasoning-delta', text: 'ROOT-THINK' } } })
  flush(host)
  body = readBody(file)
  assert.equal(body.sessionId, 'root-1')
  assert.ok(body.progress.reasoning.includes('ROOT-THINK'))
  await host.emit('dispose')
  rmSync(dir, { recursive: true, force: true })
})

test('root without desktop still shows main thought; child real action never becomes the owner', async (t) => {
  const { dir, file, runtime, host } = setup(t)
  runtime.publishMode('root-1', { enabled: true, task: '主任务' })
  await host.emit('agent/assistant-stream', { agent: rootAgent(), frame: { type: 'start', turn: 1, step: 1, attemptId: 'r1' } })
  await host.emit('agent/assistant-stream', { agent: rootAgent(), frame: { type: 'chunk', attemptId: 'r1', chunk: { type: 'reasoning-delta', text: 'ROOT-THINK' } } })
  flush(host)
  await desktopCall(host, childAgent())
  const body = readBody(file)
  assert.equal(body.sessionId, 'root-1')
  assert.ok(body.progress.reasoning.includes('ROOT-THINK'))
  assert.equal(body.progress.action, '', '子 Agent 的动作不能写进 root 主思考')
  await host.emit('dispose')
  rmSync(dir, { recursive: true, force: true })
})

test('root text is not polluted by child streams', async (t) => {
  const { dir, file, runtime, host } = setup(t)
  runtime.publishMode('root-1', { enabled: true, task: '主任务' })
  await host.emit('agent/assistant-stream', { agent: rootAgent(), frame: { type: 'start', turn: 1, step: 1, attemptId: 'r1' } })
  await host.emit('agent/assistant-stream', { agent: rootAgent(), frame: { type: 'chunk', attemptId: 'r1', chunk: { type: 'reasoning-delta', text: 'ROOT-THINK' } } })
  flush(host)
  await host.emit('agent/assistant-stream', { agent: childAgent(), frame: { type: 'start', turn: 1, step: 1, attemptId: 'c1' } })
  await host.emit('agent/assistant-stream', { agent: childAgent(), frame: { type: 'chunk', attemptId: 'c1', chunk: { type: 'reasoning-delta', text: 'CHILD-SECRET' } } })
  flush(host)
  const body = readBody(file)
  assert.ok(body.progress.reasoning.includes('ROOT-THINK'))
  assert.equal(body.progress.reasoning.includes('CHILD-SECRET'), false)
  await host.emit('dispose')
  rmSync(dir, { recursive: true, force: true })
})

test('turning multi-mouse off clears the root-only thought and restores normal owner behavior', async (t) => {
  const { dir, file, runtime, host } = setup(t)
  runtime.publishMode('root-1', { enabled: true, task: '主任务' })
  await host.emit('agent/assistant-stream', { agent: rootAgent(), frame: { type: 'start', turn: 1, step: 1, attemptId: 'r1' } })
  await host.emit('agent/assistant-stream', { agent: rootAgent(), frame: { type: 'chunk', attemptId: 'r1', chunk: { type: 'reasoning-delta', text: 'ROOT-THINK' } } })
  flush(host)
  runtime.publishMode('root-1', { enabled: false })
  let body = readBody(file)
  assert.equal(body.active, false)
  assert.equal(body.sessionId, null, '关闭后多鼠标专用的 root-only 浮窗立即收起')
  await desktopCall(host, childAgent())
  body = readBody(file)
  assert.equal(body.sessionId, 'child-a', 'off 模式恢复原有：真实桌面动作可以重新占浮窗')
  await host.emit('dispose')
  rmSync(dir, { recursive: true, force: true })
})

test('root turn/end keeps the main thought alive in multi mode, but not in normal mode', async (t) => {
  const { dir, file, runtime, host } = setup(t)
  // 普通模式：回合结束进入 20 秒 linger，随后 owner 清空。
  await desktopCall(host, childAgent())
  await host.emit('session/event', { id: 'child-a' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'done' } } })
  let body = readBody(file)
  assert.equal(body.active, false)
  assert.ok(body.lingerUntil > 0, '普通模式回合结束只 linger')
  // 多鼠标模式：主思考不因回合结束消失（任务还在继续）。
  runtime.publishMode('root-1', { enabled: true, task: '主任务' })
  await host.emit('agent/assistant-stream', { agent: rootAgent(), frame: { type: 'start', turn: 2, step: 1, attemptId: 'r2' } })
  await host.emit('agent/assistant-stream', { agent: rootAgent(), frame: { type: 'chunk', attemptId: 'r2', chunk: { type: 'reasoning-delta', text: 'ROOT-THINK-2' } } })
  flush(host)
  await host.emit('session/event', { id: 'root-1' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'done' } } })
  body = readBody(file)
  assert.equal(body.active, true, '多鼠标模式回合结束仍保留主思考')
  assert.equal(body.sessionId, 'root-1')
  assert.equal(body.progress.status, 'done')
  assert.equal(body.lingerUntil, undefined)
  await host.emit('dispose')
  rmSync(dir, { recursive: true, force: true })
})

test('switching task epoch drops the previous main thought text', async (t) => {
  const { dir, file, runtime, host } = setup(t)
  runtime.publishMode('root-1', { enabled: true, task: '任务一' })
  await host.emit('agent/assistant-stream', { agent: rootAgent(), frame: { type: 'start', turn: 1, step: 1, attemptId: 'r1' } })
  await host.emit('agent/assistant-stream', { agent: rootAgent(), frame: { type: 'chunk', attemptId: 'r1', chunk: { type: 'reasoning-delta', text: 'OLD-TASK-THINK' } } })
  flush(host)
  runtime.publishMode('root-1', { task: '任务二' })
  let body = readBody(file)
  assert.equal(body.active, false, '换任务时旧主思考立即清掉')
  assert.equal(body.progress, undefined)
  await host.emit('agent/assistant-stream', { agent: rootAgent(), frame: { type: 'start', turn: 3, step: 1, attemptId: 'r3' } })
  await host.emit('agent/assistant-stream', { agent: rootAgent(), frame: { type: 'chunk', attemptId: 'r3', chunk: { type: 'reasoning-delta', text: 'NEW-TASK-THINK' } } })
  flush(host)
  body = readBody(file)
  assert.ok(body.progress.reasoning.includes('NEW-TASK-THINK'))
  assert.equal(body.progress.reasoning.includes('OLD-TASK-THINK'), false)
  await host.emit('dispose')
  rmSync(dir, { recursive: true, force: true })
})

test('disposing activity only unsubscribes its mode listener and never disposes shared runtime', async (t) => {
  const { dir, runtime, host } = setup(t)
  await host.emit('dispose')
  assert.equal(runtime.disposed, 0)
  assert.equal(runtime.unsubs, 1)
  rmSync(dir, { recursive: true, force: true })
})
