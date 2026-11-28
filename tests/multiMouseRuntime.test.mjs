import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMultiMouseRuntime,
  getMultiMouseRuntime,
  resetMultiMouseRuntime,
  normalizeActionEvent,
  agentLabel,
} from '../plugin/lib/multi-mouse-runtime.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mm-rt-'))
}

function evt(over) {
  return Object.assign({
    kind: 'desktop-action',
    requestId: 'req-1', seq: 1, leaseId: 'lease-1', phase: 'executing',
    action: { kind: 'click', label: '点击 保存' }, space: 'physical',
    from: null, to: { x: 812, y: 430 }, path: [], sampleMs: 1, motionMs: 0,
    actor: { trust: 'trusted', agentId: 'child-a1b2c3', rootAgentId: 'root-1', depth: 1, lifetime: 1000 },
    at: 1000,
  }, over || {})
}

test('normalizeActionEvent accepts object and string action, rejects missing identity', () => {
  const a = normalizeActionEvent(evt())
  assert.equal(a.rootId, 'root-1')
  assert.equal(a.agentId, 'child-a1b2c3')
  assert.equal(a.kind, 'click')
  assert.equal(a.label, '点击 保存')
  assert.deepEqual(a.to, { x: 812, y: 430 })
  assert.equal(a.space, 'physical')

  const b = normalizeActionEvent(evt({ action: 'drag', actor: { trust: 'trusted', agentId: 'x', rootAgentId: 'r', depth: 0, lifetime: 5 } }))
  assert.equal(b.kind, 'drag')

  assert.equal(normalizeActionEvent({ action: 'click' }), null)
  assert.equal(normalizeActionEvent(null), null)
})

test('normalizeActionEvent clamps and drops unusable coordinates but keeps identity', () => {
  const a = normalizeActionEvent(evt({ to: { x: 'nope', y: 2 }, reason: 'x'.repeat(500) }))
  assert.equal(a.to, null)
  assert.ok(a.reason.length <= 200)
})

test('agentLabel matches the pointer worker convention', () => {
  assert.equal(agentLabel('abcdef123456', 2), 'Agent 2 - abcdef')
  assert.equal(agentLabel('', 3), 'Agent 3')
  assert.equal(agentLabel('ZZ', 1), 'Agent 1')
})

test('publishMode defaults off and bumps epoch on enable/disable or task switch', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 1000 })
  assert.deepEqual(rt.getMode('root-1'), { rootId: 'root-1', enabled: false, task: '', epoch: 1 })

  const on = rt.publishMode('root-1', { enabled: true, task: '整理桌面文件' })
  assert.equal(on.enabled, true)
  assert.equal(on.task, '整理桌面文件')
  assert.equal(on.epoch, 2)

  // 任务切换（enabled 不变、task 变了）也要 bump epoch，防旧任务迟到事件污染。
  const renamed = rt.publishMode('root-1', { task: '归档截图' })
  assert.equal(renamed.epoch, 3)
  assert.equal(renamed.enabled, true)

  // 冗余 enable（enabled/task 都不变）保持 epoch。
  const same = rt.publishMode('root-1', { enabled: true })
  assert.equal(same.epoch, 3)

  const off = rt.publishMode('root-1', { enabled: false })
  assert.equal(off.enabled, false)
  assert.equal(off.epoch, 4)
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('roots are independent maps with independent epochs', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 1 })
  const a = rt.publishMode('root-a', { enabled: true })
  const b = rt.publishMode('root-b', { enabled: true })
  assert.equal(a.epoch, 2)
  assert.equal(b.epoch, 2)
  rt.publishMode('root-a', { enabled: false })
  assert.equal(rt.getMode('root-a').epoch, 3)
  assert.equal(rt.getMode('root-b').epoch, 2)
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('disabled root records liveness but produces no companion rows', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 5 })
  rt.observeRoot({ rootId: 'root-1', label: '会话一' })
  rt.publishAction(evt())
  const body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.enabled, false)
  assert.equal(body.rows.length, 0)
  assert.equal(rt.listRoots()[0].rootId, 'root-1')
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('enabled root keeps one latest row per sub-agent, root excluded, banner drops app name', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 10 })
  rt.publishMode('root-1', { enabled: true, task: '整理桌面文件' })

  rt.publishAction(evt({ requestId: 'req-1', seq: 1 })) // child first click
  rt.publishAction(evt({ requestId: 'req-1', seq: 2, phase: 'executing', action: { kind: 'type', label: '输入 文件名' }, to: null, at: 2 }))
  rt.publishAction(evt({ requestId: 'req-2', seq: 1, actor: { trust: 'trusted', agentId: 'child-2', rootAgentId: 'root-1', depth: 1, lifetime: 2000 } }))
  rt.publishAction(evt({ requestId: 'req-3', seq: 1, actor: { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 1 }, action: { kind: 'move' } }))

  const body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.enabled, true)
  assert.equal(body.task, '整理桌面文件')
  assert.match(body.banner.text, /^DSH正在完成整理桌面文件$/)
  assert.doesNotMatch(body.banner.text, /记事本|微信/)
  assert.equal(body.rows.length, 2, 'two sub agents, root excluded')
  const byAgent = Object.fromEntries(body.rows.map((r) => [r.agentId, r]))
  assert.equal(byAgent['child-a1b2c3'].last.kind, 'type')
  assert.equal(byAgent['child-a1b2c3'].last.label, '输入 文件名')
  assert.equal(byAgent['child-a1b2c3'].last.x, null, 'a newer action without a trusted point must not inherit the previous x')
  assert.equal(byAgent['child-2'].ordinal, 2)
  assert.equal(body.thinking.sessionId, 'root-1')
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('stale epoch actions are dropped', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 10 })
  rt.publishMode('root-1', { enabled: true })
  const mode = rt.getMode('root-1') // epoch 2
  assert.equal(rt.publishAction(evt({ epoch: mode.epoch })) !== null, true)
  assert.equal(rt.publishAction(evt({ requestId: 'req-old', epoch: mode.epoch - 1, actor: { trust: 'trusted', agentId: 'old', rootAgentId: 'root-1', depth: 1, lifetime: 1000 } })), null)
  const body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.rows.some((r) => r.agentId === 'old'), false)
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('a throwing listener never breaks the others nor the call', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 10, onWarn: () => {} })
  const seen = []
  rt.subscribe('mode', () => { throw new Error('boom') })
  rt.subscribe('mode', (m) => seen.push(m.enabled))
  const snap = rt.publishMode('root-1', { enabled: true })
  assert.equal(snap.enabled, true)
  assert.deepEqual(seen, [true])
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('markAgent flips a row to done without reordering ordinals', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 10 })
  rt.publishMode('root-1', { enabled: true })
  rt.publishAction(evt())
  rt.markAgent('root-1', 'child-a1b2c3', 'done')
  const body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.rows[0].state, 'done')
  assert.equal(body.rows[0].ordinal, 1)
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('mode file records every seen root for cross-process polling', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 10 })
  rt.publishMode('root-1', { enabled: true, task: 't' })
  const file = JSON.parse(readFileSync(join(dir, 'multi-mouse-mode.json'), 'utf8'))
  assert.equal(file.schema, 1)
  assert.equal(file.roots['root-1'].enabled, true)
  assert.equal(file.roots['root-1'].task, 't')
  assert.equal(file.selectedRootId, 'root-1')
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})
test('switching task while enabled bumps epoch and drops stale rows', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 20 })
  const on = rt.publishMode('root-1', { enabled: true, task: 'A' }) // epoch 2
  rt.publishAction(evt({ epoch: on.epoch }))
  let body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.rows.length, 1)
  const next = rt.publishMode('root-1', { task: 'B' }) // enabled 不变、task 变 -> epoch 3 且清行
  assert.equal(next.epoch, on.epoch + 1)
  assert.equal(next.enabled, true)
  body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.rows.length, 0)
  // 上一 epoch 的迟到事件被丢弃
  assert.equal(rt.publishAction(evt({ epoch: on.epoch, seq: 2 })), null)
  assert.equal(JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8')).rows.length, 0)
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('selection is pinned and never stolen by background root activity', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 30 })
  rt.observeRoot({ rootId: 'root-a' })
  rt.observeRoot({ rootId: 'root-b' }) // 出现第二个 root 后不得自动选中
  assert.equal(rt.activeRootId(), null)
  assert.equal(rt.publishMode('root-b', { enabled: true }).rootId, 'root-b')
  assert.equal(rt.activeRootId(), 'root-b')
  // 后台 root-a 的登记更晚、活动更新，也不能把选中从 root-b 抢走
  rt.observeRoot({ rootId: 'root-a', at: 99999 })
  rt.publishAction(evt({ requestId: 'req-a', actor: { trust: 'trusted', agentId: 'x', rootAgentId: 'root-a', depth: 1, lifetime: 3000 }, at: 99999 }))
  assert.equal(rt.activeRootId(), 'root-b')
  const list = rt.listRoots()
  assert.equal(list.find((r) => r.rootId === 'root-b').selected, true)
  assert.equal(list.find((r) => r.rootId === 'root-a').selected, false)
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('single root auto-selects; selectRoot pins an explicit choice and rejects unknown', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 40 })
  rt.observeRoot({ rootId: 'root-1' })
  assert.equal(rt.activeRootId(), 'root-1')
  assert.equal(rt.selectRoot('missing'), null)
  assert.equal(rt.activeRootId(), 'root-1')
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('reload keeps task/epoch/selection but never auto-enables multi-mouse (A15)', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 50 })
  const on = rt.publishMode('root-1', { enabled: true, task: '任务' })
  assert.equal(on.epoch, 2)
  const file = JSON.parse(readFileSync(join(dir, 'multi-mouse-mode.json'), 'utf8'))
  assert.equal(file.selectedRootId, 'root-1')
  rt.dispose()
  // dispose 是终态：它把每个 root 置为 off、epoch++ 并落盘（同一合同在 :513-516 有专测）。
  // 所以“重启后该保留哪个 epoch”的基准是 dispose 之后的落盘快照，不是 dispose 之前的 on.epoch；
  // 用这份正确时点的快照做基准，断言重启原样延续、不额外推进，再断言显式开启只再前进一次。
  const savedAfterDispose = JSON.parse(readFileSync(join(dir, 'multi-mouse-mode.json'), 'utf8'))
  assert.equal(savedAfterDispose.roots['root-1'].enabled, false, 'dispose 落盘为 off')
  assert.equal(savedAfterDispose.roots['root-1'].epoch, on.epoch + 1, 'dispose 前进一次 epoch 并落盘')
  const restoredEpoch = savedAfterDispose.roots['root-1'].epoch
  const rt2 = createMultiMouseRuntime({ dataDir: dir, now: () => 60 })
  assert.equal(rt2.getMode('root-1').enabled, false, '重启不得恢复旧开启态')
  assert.equal(rt2.getMode('root-1').task, '任务')
  assert.equal(rt2.getMode('root-1').epoch, restoredEpoch, '重启原样延续落盘的 epoch，不额外推进')
  // 旧 epoch 事件拒绝：重启前的 epoch 已过期，只有重启后读到的当前 epoch 被接受。
  assert.equal(rt2.publishAction(evt({ requestId: 'reload-old', epoch: restoredEpoch - 1 })), null, '旧 epoch 事件仍被拒绝')
  assert.notEqual(rt2.publishAction(evt({ requestId: 'reload-new', epoch: restoredEpoch })), null, '当前 epoch 事件被接受')
  // 显式选中的任务保留（enabled 不恢复），设置页仍能显示这是哪个任务
  assert.equal(rt2.activeRootId(), 'root-1')
  const body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.enabled, false)
  assert.equal(body.rows.length, 0)
  const reOn = rt2.publishMode('root-1', { enabled: true })
  assert.equal(reOn.epoch, restoredEpoch + 1, '显式开启只再前进一次')
  assert.equal(rt2.activeRootId(), 'root-1')
  rt2.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('normalize rejects legacy trust, wrong kind, window coords and missing request identity', () => {
  assert.equal(normalizeActionEvent(evt({ kind: 'desktop-action-other' })), null)
  assert.equal(normalizeActionEvent(evt({ actor: { trust: 'legacy', agentId: 'a', rootAgentId: 'r', depth: 1, lifetime: 1 } })), null)
  assert.equal(normalizeActionEvent(evt({ requestId: '' })), null)
  assert.equal(normalizeActionEvent(evt({ seq: -1 })), null)
  assert.equal(normalizeActionEvent(evt({ actor: { trust: 'trusted', agentId: 'a', rootAgentId: 'r', depth: 1 } })), null, 'lifetime 缺失拒绝')
  // 非 physical 且带坐标：拒绝，绝不把窗口坐标改标成物理坐标
  assert.equal(normalizeActionEvent(evt({ space: 'window', to: { x: 10, y: 20 } })), null)
  // 非 physical 但无坐标（type/key）：保留声明，不重标
  const typed = normalizeActionEvent(evt({ space: 'window', to: null, from: null, path: [], action: { kind: 'type' } }))
  assert.equal(typed.space, 'window')
  // epoch 原样保留，供请求起点绑定
  assert.equal(normalizeActionEvent(evt({ epoch: 7 })).epoch, 7)
  assert.equal(normalizeActionEvent(evt()).epoch, null)
})

test('row keeps unknown ok as null; per-request epoch binding drops stale phases', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 70 })
  rt.publishMode('root-1', { enabled: true, task: 'A' }) // epoch 2
  assert.ok(rt.publishAction(evt({ seq: 1 })), 'queued 绑定 epoch 2')
  let body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.rows[0].last.ok, null, 'ok 未知不得冒充成功')
  assert.equal(rt.publishAction(evt({ seq: 1 })), null, '重复 seq 丢弃')
  assert.equal(rt.publishAction(evt({ seq: 0 })), null, '回退 seq 丢弃')
  rt.publishMode('root-1', { task: 'B' }) // epoch 3
  assert.equal(rt.publishAction(evt({ seq: 2, phase: 'succeeded' })), null, '旧请求不带 epoch 也拒')
  assert.equal(rt.publishAction(evt({ seq: 2, phase: 'succeeded', epoch: 2 })), null, '旧 epoch 拒')
  body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.rows.length, 0)
  assert.ok(rt.publishAction(evt({ requestId: 'req-b', seq: 1, epoch: 3, phase: 'executing' })))
  assert.equal(rt.publishAction(evt({ requestId: 'req-b', seq: 2, epoch: 3, phase: 'succeeded', ok: true })).phase, 'succeeded')
  body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.rows[0].last.ok, true)
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('same agentId with a new lifetime gets a fresh ordinal; old lifetime cannot overwrite', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 80 })
  rt.publishMode('root-1', { enabled: true })
  rt.publishAction(evt({ requestId: 'r1', seq: 1, at: 1 })) // lifetime 1000
  let body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.rows[0].ordinal, 1)
  rt.publishAction(evt({ requestId: 'r2', seq: 1, at: 2, actor: { trust: 'trusted', agentId: 'child-a1b2c3', rootAgentId: 'root-1', depth: 1, lifetime: 2000 }, action: { kind: 'move', label: '移动' } }))
  body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.rows.length, 1)
  assert.equal(body.rows[0].lifetime, 2000)
  assert.equal(body.rows[0].ordinal, 2, '新生命期独立 ordinal，不复用 1')
  assert.equal(rt.publishAction(evt({ requestId: 'r3', seq: 1, at: 3, actor: { trust: 'trusted', agentId: 'child-a1b2c3', rootAgentId: 'root-1', depth: 1, lifetime: 1000 }, action: { kind: 'click', label: '旧点击' } })), null)
  body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.rows.length, 1)
  assert.equal(body.rows[0].lifetime, 2000)
  assert.equal(body.rows[0].last.kind, 'move')
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('keeps every live sub-agent row, at least twelve at once (A10)', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 90 })
  rt.publishMode('root-1', { enabled: true, task: '多人任务' })
  for (let i = 1; i <= 12; i += 1) {
    rt.publishAction(evt({
      requestId: `live-${i}`, seq: 1,
      actor: { trust: 'trusted', agentId: `live-child-${i}`, rootAgentId: 'root-1', depth: 1, lifetime: 1000 + i },
      action: { kind: 'move', label: '移动' },
    }))
  }
  const body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.rows.length, 12, '十二个活着的子 Agent 行全部保留')
  assert.deepEqual(new Set(body.rows.map((r) => r.agentId)).size, 12)
  assert.deepEqual(body.rows.map((r) => r.ordinal), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('capacity eviction only recycles done rows, never a live agent', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 91 })
  rt.publishMode('root-1', { enabled: true, task: '容量' })
  for (let i = 1; i <= 33; i += 1) {
    rt.publishAction(evt({
      requestId: `cap-${i}`, seq: 1,
      actor: { trust: 'trusted', agentId: `cap-child-${i}`, rootAgentId: 'root-1', depth: 1, lifetime: 2000 + i },
    }))
    rt.markAgent('root-1', `cap-child-${i}`, 'done')
  }
  rt.publishAction(evt({
    requestId: 'cap-live', seq: 1,
    actor: { trust: 'trusted', agentId: 'cap-live-child', rootAgentId: 'root-1', depth: 1, lifetime: 9000 },
  }))
  const body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.rows.length, 32, '超出上限只回收 done 行')
  const live = body.rows.filter((r) => r.agentId === 'cap-live-child')
  assert.equal(live.length, 1, '活着的第 34 人不被淘汰')
  assert.equal(live[0].state, 'acting')
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('actions are only emitted to subscribers while multi-mouse is enabled', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 92 })
  const seen = []
  rt.subscribe('action', (evt) => seen.push(evt))
  rt.publishAction(evt({ requestId: 'off-1' })) // 未开启：只登记活跃度
  assert.equal(seen.length, 0, '关闭时不得给指针发动作')
  rt.publishMode('root-1', { enabled: true })
  rt.publishAction(evt({ requestId: 'on-1' }))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].epoch, 2, '转发事件带请求绑定的实际 epoch')
  rt.publishMode('root-1', { enabled: false })
  rt.publishAction(evt({ requestId: 'off-2' }))
  assert.equal(seen.length, 1, '关闭后不再发新动作')
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('publishActorDisposed removes that lifetime only and releases the pointer', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 93 })
  const written = []
  const released = []
  const detach = rt.attachPointerWriter({ dispose: (actor) => written.push(actor) })
  rt.subscribe('actor-disposed', (info) => released.push(info))
  rt.publishMode('root-1', { enabled: true, task: '释放' })
  const actorA = { trust: 'trusted', agentId: 'child-a', rootAgentId: 'root-1', depth: 1, lifetime: 1000 }
  const actorB = { trust: 'trusted', agentId: 'child-b', rootAgentId: 'root-1', depth: 1, lifetime: 2000 }
  rt.publishAction(evt({ requestId: 'a-1', actor: actorA }))
  rt.publishAction(evt({ requestId: 'b-1', actor: actorB }))
  assert.equal(rt.publishActorDisposed(actorA), true)
  assert.equal(written.length, 1)
  assert.equal(written[0].agentId, 'child-a')
  assert.equal(released.length, 1)
  assert.equal(released[0].lifetime, 1000)
  let body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.deepEqual(body.rows.map((r) => r.agentId), ['child-b'], '只删被释放生命期的行')
  // 已释放生命期的迟到事件不得复活
  assert.equal(rt.publishAction(evt({ requestId: 'a-late', seq: 1, actor: actorA })), null)
  body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.deepEqual(body.rows.map((r) => r.agentId), ['child-b'])
  // 新生命期（lifetime 更大）可以是同一 agent 的续命，拿新 ordinal
  const actorA2 = { trust: 'trusted', agentId: 'child-a', rootAgentId: 'root-1', depth: 1, lifetime: 1500 }
  rt.publishAction(evt({ requestId: 'a-2', actor: actorA2 }))
  body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.rows.length, 2)
  assert.equal(body.rows.find((r) => r.agentId === 'child-a').ordinal, 3)
  assert.equal(rt.publishActorDisposed({ trust: 'legacy', agentId: 'child-b', rootAgentId: 'root-1', lifetime: 2000 }), false)
  assert.equal(rt.publishActorDisposed({ trust: 'trusted', agentId: 'child-b', rootAgentId: 'no-such-root', lifetime: 2000 }), false)
  assert.equal(released.length, 1, '未知 root / legacy 不通知')
  detach()
  rt.publishActorDisposed(actorB)
  assert.equal(written.length, 1, '解绑后不再转发给旧 writer')
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('runtime exposes one process-scoped pointer state path for the probe writer and C# helper', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir })
  assert.ok(rt.pointerStatePath().endsWith('pointer-state-' + process.pid + '.json'))
  assert.equal(rt.sampleCursor, undefined, '不再承诺同步采样 API：真实锚点由 C# renderer 在 spawn/release 采')
  assert.equal(rt.setCursorSampler, undefined)
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('publishActorLive registers an active root without inventing a companion row', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 95 })
  const child = { trust: 'trusted', agentId: 'child-live', rootAgentId: 'root-1', depth: 1, lifetime: 1000 }
  const live = []
  rt.subscribe('actor-live', (info) => live.push(info))
  assert.equal(rt.publishActorLive(child), true)
  assert.equal(live.length, 1, 'probe 订阅可信 actor-live，不再自算身份')
  assert.deepEqual(live[0].actor, child)
  assert.equal(live[0].rootId, 'root-1')
  assert.equal(rt.publishActorLive(child), true)
  assert.equal(live.length, 1, '同一 agentId+lifetime 重复公告只发一次')
  const late = []
  rt.subscribe('actor-live', (info) => late.push(info))
  assert.equal(late.length, 1, 'probe 晚订阅时回放当前活 actor')
  assert.equal(rt.listRoots().length, 1, 'root 被登记供设置页选择')
  assert.equal(rt.activeRootId(), 'root-1', '唯一 root 自动选中')
  const body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.deepEqual(body.rows, [], '没有动作就没有行')
  assert.equal(body.enabled, false, '登记活人不等于开启多鼠标')
  assert.equal(rt.publishActorLive({ trust: 'legacy', agentId: 'x', rootAgentId: 'root-1', depth: 1, lifetime: 1 }), false)
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('publishActorDisposed releases through the single writer without inventing a cursor', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 96 })
  const calls = []
  const seen = []
  rt.attachPointerWriter({ dispose: (actor, cursor) => calls.push([actor, cursor]) })
  rt.subscribe('actor-disposed', (info) => seen.push(info))
  rt.publishMode('root-1', { enabled: true, task: '释放并淡出' })
  const actor = { trust: 'trusted', agentId: 'child-a', rootAgentId: 'root-1', depth: 1, lifetime: 1000 }
  rt.publishAction(evt({ requestId: 'dc-1', actor }))
  assert.equal(rt.publishActorDisposed(actor), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], undefined, 'release 不带坐标：淡出锚点由 renderer 实采')
  assert.equal(seen[0].cursor, undefined)
  assert.equal(seen[0].lifetime, 1000)
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})


test('settings teardown only drops its own subscriptions: gateway action still reaches the writer', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 97 })
  const written = []
  const seen = []
  const writer = { dispose: () => {}, ingest: (event) => written.push(event) }
  rt.attachPointerWriter(writer)
  // probe 的订阅是 runtime 的 action 消费者；设置插件卸载不能把它清掉。
  rt.subscribe('action', (event) => { seen.push(event); writer.ingest(event) })
  rt.publishMode('root-1', { enabled: true, task: '共享总线' })
  // 模拟设置插件卸载：只退订自己的 companion 监听，绝不 dispose 共享 runtime。
  const settingsUnsub = rt.subscribe('companion', () => {})
  settingsUnsub()
  assert.equal(rt.isClosed(), false, '设置插件卸载后 runtime 仍可用')
  const event = evt({ requestId: 'after-settings-dispose', seq: 1, actor: { trust: 'trusted', agentId: 'child-a1b2c3', rootAgentId: 'root-1', depth: 1, lifetime: 1000 } })
  assert.notEqual(rt.publishAction(event), null, 'gateway 的 ActionEvent 仍进入同一 bus')
  assert.equal(seen.length, 1)
  assert.equal(written.length, 1, 'probe 的 writer 仍消费同一实例')
  assert.equal(rt.getMode('root-1').enabled, true, '任务开关没有被设置插件卸载清掉')
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('explicit dispose is terminal: off is persisted, reset is delivered, get() rebuilds', () => {
  const dir = tempDir()
  resetMultiMouseRuntime()
  const rt = getMultiMouseRuntime({ dataDir: dir, now: () => 98 })
  const resets = []
  const modes = []
  rt.subscribe('reset', (info) => resets.push(info))
  rt.subscribe('mode', (info) => modes.push(info))
  rt.publishMode('root-1', { enabled: true, task: '终态任务' })
  const before = rt.getMode('root-1')
  rt.publishActorLive({ trust: 'trusted', agentId: 'child-a', rootAgentId: 'root-1', depth: 1, lifetime: 1000 })
  assert.equal(rt.isClosed(), false)
  rt.dispose()
  assert.equal(rt.isClosed(), true)
  assert.equal(rt.publishAction(evt({ requestId: 'closed-1' })), null, '关闭后旧引用不再接受动作')
  assert.equal(rt.publishMode('root-1', { enabled: true }), null, '关闭后旧引用不能再开任务')
  assert.ok(resets.some((info) => info.reason === 'dispose' && info.enabled === false), 'dispose 发 reset 清指针')
  assert.ok(modes.some((info) => info.enabled === false && info.epoch > before.epoch), 'dispose 发 mode off 且 epoch++')
  const saved = JSON.parse(readFileSync(join(dir, 'multi-mouse-mode.json'), 'utf8'))
  assert.equal(saved.roots['root-1'].enabled, false, 'mode 文件落盘为 off')
  assert.ok(saved.roots['root-1'].epoch > before.epoch)
  const companion = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(companion.enabled, false)
  assert.deepEqual(companion.rows, [], '没有残留 Companion 行')
  const next = getMultiMouseRuntime({ dataDir: dir, now: () => 99 })
  assert.notEqual(next, rt, 'get 不再返回 closed 单例')
  assert.equal(next.isClosed(), false)
  assert.equal(next.getMode('root-1').enabled, false, '新实例延续 off，不自动常驻')
  next.dispose()
  resetMultiMouseRuntime()
  rmSync(dir, { recursive: true, force: true })
})

test('mode changes emit reset with the new epoch and reason', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 94 })
  const resets = []
  rt.subscribe('reset', (info) => resets.push(info))
  rt.publishMode('root-1', { enabled: true, task: '任务一' })
  rt.publishMode('root-1', { task: '任务二' })
  rt.publishMode('root-1', { enabled: false })
  assert.deepEqual(resets.map((r) => [r.epoch, r.reason, r.enabled]), [[2, 'enabled', true], [3, 'task', true], [4, 'disabled', false]])
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('publishRootThinking fills companion reasoning only for the enabled root', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 96 })
  assert.equal(rt.publishRootThinking('root-1', { reasoning: '关闭时不应该写入' }), null, 'off 状态不接收主思考文本')
  rt.publishMode('root-1', { enabled: true, task: '主思考' })
  const result = rt.publishRootThinking('root-1', {
    reasoning: '先读文件再操作',
    reply: '准备开始',
    status: 'thinking',
    action: '读文件',
    step: 2,
    intent: '检查配置',
  })
  assert.equal(result.reasoning, '先读文件再操作')
  assert.equal(result.sessionId, 'root-1')
  const companion = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(companion.thinking.reasoning, '先读文件再操作', 'Companion.thinking.reasoning 不再为空')
  assert.equal(companion.thinking.reply, '准备开始')
  assert.equal(companion.thinking.step, 2)
  assert.equal(companion.thinking.action, '读文件')
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('a late disposal from an older root lifetime keeps the newer root thinking', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 97 })
  const written = []
  const released = []
  const companions = []
  rt.attachPointerWriter({ dispose: (actor) => written.push(actor) })
  rt.subscribe('actor-disposed', (info) => released.push(info))
  rt.subscribe('companion', (info) => companions.push(info))
  rt.publishMode('root-1', { enabled: true, task: '重启后继续' })
  const rootOld = { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 1000 }
  const rootNew = { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 2000 }
  // 旧根生命期：先公告，再写一段真实思考。
  assert.equal(rt.publishActorLive(rootOld), true)
  assert.equal(rt.publishRootThinking('root-1', { reasoning: '旧根的思考' }).visible, true)
  // 冷恢复/重启后同一 session id 拿到新 lifetime，新根开始写自己的思考。
  assert.equal(rt.publishActorLive(rootNew), true)
  const fresh = rt.publishRootThinking('root-1', { reasoning: '新根的思考', status: 'thinking', action: '读文件' })
  assert.equal(fresh.visible, true)
  assert.equal(fresh.reasoning, '新根的思考')
  const before = companions.length
  // 旧生命期的 disposal 迟到：不得隐藏新框，也不得推一条误导性的空状态。
  assert.equal(rt.publishActorDisposed(rootOld), true)
  let body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.thinking.visible, true, '旧生命期销毁不得隐藏新主思考框')
  assert.equal(body.thinking.reasoning, '新根的思考', '新框正文保持不变')
  assert.equal(body.thinking.action, '读文件')
  assert.equal(companions.length, before, '旧生命期销毁不发 companion 更新')
  assert.equal(released.length, 1, 'actor-disposed 仍然照实上报')
  assert.equal(released[0].lifetime, 1000)
  assert.equal(written.length, 1, '旧生命期的指针照常释放')
  assert.equal(written[0].lifetime, 1000)
  // 新根的生命期依然可用：动作照常刷新主思考。
  const live = rt.publishAction(evt({
    requestId: 'root-new-1', seq: 1, actor: { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 2000 },
  }))
  assert.notEqual(live, null, '新生命期的动作不被旧 disposal 打死')
  body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.thinking.visible, true)
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('disposing the current root lifetime still hides the main thinking box', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 98 })
  const companions = []
  rt.subscribe('companion', (info) => companions.push(info))
  rt.publishMode('root-1', { enabled: true, task: '正常收尾' })
  const rootOld = { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 1000 }
  const rootNew = { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 2000 }
  rt.publishActorLive(rootOld)
  rt.publishActorLive(rootNew)
  rt.publishRootThinking('root-1', { reasoning: '当前根的思考' })
  const before = companions.length
  assert.equal(rt.publishActorDisposed(rootNew), true)
  const body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.thinking.visible, false, '当前生命期销毁照旧隐藏')
  assert.equal(body.thinking.status, 'idle')
  assert.equal(companions.length, before + 1, '当前生命期销毁要通知 Companion')
  assert.equal(companions[companions.length - 1].thinking.visible, false)
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('a repeated disposal of the retired root lifetime is idempotent', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 99 })
  const companions = []
  rt.subscribe('companion', (info) => companions.push(info))
  rt.publishMode('root-1', { enabled: true, task: '重复销毁' })
  const rootOld = { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 1000 }
  const rootNew = { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 2000 }
  rt.publishActorLive(rootOld)
  rt.publishActorLive(rootNew)
  rt.publishRootThinking('root-1', { reasoning: '只写一次' })
  rt.publishActorDisposed(rootOld)
  const before = companions.length
  assert.equal(rt.publishActorDisposed(rootOld), true)
  const body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.thinking.visible, true, '重复的旧销毁仍不影响新框')
  assert.equal(body.thinking.reasoning, '只写一次')
  assert.equal(companions.length, before, '重复的旧销毁不再发 companion')
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('a stale root disposal cannot hide thinking after an epoch switch', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 100 })
  const companions = []
  rt.subscribe('companion', (info) => companions.push(info))
  rt.publishMode('root-1', { enabled: true, task: '第一个任务' })
  const rootOld = { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 1000 }
  rt.publishActorLive(rootOld)
  rt.publishRootThinking('root-1', { reasoning: '第一个任务的思考' })
  // 换任务：epoch++ 清空 life/actors/disposed，旧生命期的记录不再存在。
  rt.publishMode('root-1', { enabled: true, task: '第二个任务' })
  const rootNew = { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 2000 }
  rt.publishActorLive(rootNew)
  rt.publishRootThinking('root-1', { reasoning: '第二个任务的思考' })
  assert.equal(rt.getMode('root-1').epoch, 3)
  const before = companions.length
  assert.equal(rt.publishActorDisposed(rootOld), true)
  const body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.thinking.visible, true, '跨 epoch 的旧生命期销毁不得抹掉新思考')
  assert.equal(body.thinking.reasoning, '第二个任务的思考')
  assert.equal(body.task, '第二个任务')
  assert.equal(companions.length, before)
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('a root lifetime change while the mode is off is remembered across re-enable', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 101 })
  const companions = []
  rt.subscribe('companion', (info) => companions.push(info))
  rt.publishMode('root-1', { enabled: true, task: '关闭窗口' })
  const rootOld = { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 1000 }
  rt.publishActorLive(rootOld)
  rt.publishRootThinking('root-1', { reasoning: '第一段的思考' })
  // 关闭：epoch++ 清空 life/actors，thinking 重置为隐藏。
  rt.publishMode('root-1', { enabled: false })
  assert.equal(rt.getMode('root-1').enabled, false)
  // 关闭期间换生命期：root 动作只登记活跃度，但生命周期水位要记住，否则重新开启后旧销毁会抹掉新框。
  const off = rt.publishAction(evt({
    requestId: 'root-off-1', seq: 1, actor: { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 2000 },
  }))
  assert.notEqual(off, null, '关闭时仍登记活跃度')
  // 重新开启并写入新思考。
  rt.publishMode('root-1', { enabled: true, task: '重新开启' })
  rt.publishRootThinking('root-1', { reasoning: '重新开启后的思考' })
  const before = companions.length
  assert.equal(rt.publishActorDisposed(rootOld), true)
  const body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.thinking.visible, true, '关闭期间换过的生命期让旧销毁失效')
  assert.equal(body.thinking.reasoning, '重新开启后的思考')
  assert.equal(companions.length, before)
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('a late action from the retired root lifetime cannot relight the thinking box', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 102 })
  const actions = []
  rt.subscribe('action', (info) => actions.push(info))
  rt.publishMode('root-1', { enabled: true, task: '旧动作不得复活' })
  const rootOld = { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 1000 }
  const rootNew = { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 2000 }
  rt.publishActorLive(rootOld)
  rt.publishActorLive(rootNew)
  rt.publishRootThinking('root-1', { reasoning: '新根的思考' })
  // 当前生命期正常收尾：框已隐藏，正文留着。
  assert.equal(rt.publishActorDisposed(rootNew), true)
  let body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.thinking.visible, false)
  assert.equal(body.thinking.reasoning, '新根的思考')
  const before = actions.length
  // 旧生命期的动作迟到：既不得重新点亮框，也不得作为动作广播出去。
  assert.equal(rt.publishAction(evt({ requestId: 'root-old-late', seq: 1, actor: rootOld })), null)
  body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.thinking.visible, false, '旧生命期的迟到动作不得重新点亮主思考框')
  assert.equal(body.thinking.reasoning, '新根的思考')
  assert.equal(actions.length, before, '旧生命期的动作不再广播')
  // 已销毁的生命期同样被墓碑挡住；真正更新的生命期（更大 lifetime）照旧可用。
  assert.equal(rt.publishAction(evt({ requestId: 'root-retired-1', seq: 1, actor: rootNew })), null, '已销毁生命期的动作不得复活')
  const rootNewer = { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 3000 }
  assert.notEqual(rt.publishAction(evt({ requestId: 'root-newer-1', seq: 1, actor: rootNewer })), null, '更新的生命期照旧可用')
  body = JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  assert.equal(body.thinking.visible, true, '新生命期的动作重新点亮主思考框')
  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('a newer action without a trusted point does not inherit the previous coordinates', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 41 })
  rt.publishMode('root-1', { enabled: true, task: '坐标' })
  const read = () => JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  const rowOf = (body) => body.rows.find((r) => r.agentId === 'child-a1b2c3')

  // 1) 真实物理点：写入本笔自己的坐标。
  assert.notEqual(rt.publishAction(evt({ requestId: 'phys-1', seq: 1, at: 1 })), null)
  let row = rowOf(read())
  assert.equal(row.last.x, 812)
  assert.equal(row.last.y, 430)

  // 2) 新的 request，网页 window 空间事件没有可信 to：坐标必须是 null，不能沿用上一笔。
  assert.notEqual(rt.publishAction(evt({
    requestId: 'web-1', seq: 1, phase: 'executing', space: 'window',
    from: null, to: null, path: [], action: { kind: 'click', label: '点击 链接' }, at: 2,
  })), null)
  row = rowOf(read())
  assert.equal(row.last.seq, 1)
  assert.equal(row.last.phase, 'executing')
  assert.equal(row.last.label, '点击 链接')
  assert.equal(row.last.x, null, 'no trusted point on this event, so x is unknown')
  assert.equal(row.last.y, null)
  assert.equal('to' in row.last, false, 'the row never fabricates a physical point')
  assert.equal('path' in row.last, false)

  // 3) 0 与负坐标是真实可信点，不能用 truthiness 丢掉。
  assert.notEqual(rt.publishAction(evt({ requestId: 'phys-0', seq: 1, to: { x: 0, y: -40 }, at: 3 })), null)
  row = rowOf(read())
  assert.equal(row.last.x, 0)
  assert.equal(row.last.y, -40)

  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('a depth-0 event whose agentId is not the root cannot write thinking, rows or bindings', () => {
  const dir = tempDir()
  const rt = createMultiMouseRuntime({ dataDir: dir, now: () => 51 })
  rt.publishMode('root-1', { enabled: true, task: '身份' })
  const read = () => JSON.parse(readFileSync(join(dir, 'companion-live.json'), 'utf8'))
  const actions = []
  rt.subscribe('action', (info) => actions.push(info))
  const before = rt.listRoots()[0]
  const beforeBody = read()

  const mixed = { trust: 'trusted', agentId: 'mixed-a', rootAgentId: 'root-1', depth: 0, lifetime: 1000 }
  assert.equal(rt.publishAction(evt({ requestId: 'mix-1', seq: 1, actor: mixed, at: 5 })), null, 'depth 0 with a non-root agentId is a contradiction')

  const after = rt.listRoots()[0]
  assert.equal(after.lastActivityAt, before.lastActivityAt, 'a rejected event must not record activity')
  assert.equal(after.rows, 0)
  const afterBody = read()
  assert.equal(afterBody.rows.length, 0, 'no sub-agent row')
  assert.equal(afterBody.thinking.sessionId, beforeBody.thinking.sessionId, 'the main thinking line is not overwritten')
  assert.notEqual(afterBody.thinking.sessionId, 'mixed-a')
  assert.equal(actions.length, 0, 'a rejected event is not broadcast as an action')

  // 请求绑定与生命期水位都没被占用：同一 requestId、更小 lifetime 的合法子事件照常生效。
  const okChild = { trust: 'trusted', agentId: 'mixed-a', rootAgentId: 'root-1', depth: 1, lifetime: 900 }
  assert.notEqual(rt.publishAction(evt({ requestId: 'mix-1', seq: 1, actor: okChild, at: 6 })), null, 'the rejected event must not have bound the requestId or raised a lifetime watermark')
  let row = read().rows.find((r) => r.agentId === 'mixed-a')
  assert.equal(row.lifetime, 900)

  // 合法 root 自己的事件仍然生效，主思考与子行都不回退。
  const okRoot = { trust: 'trusted', agentId: 'root-1', rootAgentId: 'root-1', depth: 0, lifetime: 1 }
  assert.notEqual(rt.publishAction(evt({ requestId: 'root-ok', seq: 1, actor: okRoot, action: { kind: 'move', label: '移动到 保存' }, space: 'window', from: null, to: null, path: [], at: 7 })), null, 'the real root still drives the thinking line')
  const body = read()
  assert.equal(body.thinking.sessionId, 'root-1')
  assert.equal(body.thinking.action, '移动到 保存')
  assert.equal(body.rows.length, 1, 'the legitimate child row is still there')

  rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})
