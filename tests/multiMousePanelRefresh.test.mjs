/**
 * 行为回归：设置页「多鼠标」面板在异步读写下的真实行为。
 *
 * 背景：Agent 的原生 multi_mouse 工具不经过这个面板，随时可能改 runtime 的 enabled/task；
 * 面板自己也读写同一份状态。这里不复制面板的算法，而是把生产代码 plugin/lib/client.js
 * 原样装进一个最小宿主里跑起来：
 *   · window.__ModuleLoader__ + require('react')  —— 模块加载与 React 入口
 *   · 一份够用的 hooks 运行时（useState / useRef / useEffect + 同步 flush）
 *   · 可手动结算的 fetch（先发出、后返回，用来制造乱序响应）
 *   · 假的 document / window 事件目标（visibilitychange、focus）
 * 然后用用户真正做得到的动作（勾选、输入、点按钮、切回页面）驱动它，
 * 断言面板发出的请求与最终渲染结果。
 *
 * 只覆盖插件前端（纯 JS，无打包器）；不启动浏览器、不连真实宿主，
 * 也不证明真实 DSH 里的观感（那属于真机验收）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../plugin/lib/client.js', import.meta.url), 'utf8')

// --- 最小 React 运行时 ------------------------------------------------------

function createRenderer() {
  let currentNode = null
  let hookIndex = 0
  let pendingEffects = []
  let dirty = false
  let rootElement = null
  let rootNode = null

  function flatten(children, out) {
    const acc = out || []
    for (const child of children) {
      if (Array.isArray(child)) flatten(child, acc)
      else acc.push(child)
    }
    return acc
  }

  function createElement(type, props) {
    const children = flatten(Array.prototype.slice.call(arguments, 2))
    // 浅拷贝：client.js 会把 buttonStyle 这类共享常量当 props 传，不能往上挂 children。
    const resolved = props ? Object.assign({}, props) : {}
    // 与 React 一致：子节点同时挂在 props.children 上（CardTitle 这类组件读的是它）。
    if (children.length === 1) resolved.children = children[0]
    else if (children.length > 1) resolved.children = children
    return { type, props: resolved, children }
  }

  function useState(initial) {
    const node = currentNode
    const index = hookIndex
    hookIndex += 1
    if (!node.hooks[index]) node.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    const hook = node.hooks[index]
    const set = (next) => {
      const value = typeof next === 'function' ? next(hook.value) : next
      if (Object.is(value, hook.value)) return
      hook.value = value
      dirty = true
    }
    return [hook.value, set]
  }

  function useRef(initial) {
    const node = currentNode
    const index = hookIndex
    hookIndex += 1
    if (!node.hooks[index]) node.hooks[index] = { current: initial }
    return node.hooks[index]
  }

  function useEffect(fn, deps) {
    const node = currentNode
    const index = hookIndex
    hookIndex += 1
    const prev = node.hooks[index]
    const same = !!prev && !!prev.deps && !!deps && prev.deps.length === deps.length &&
      deps.every((value, at) => Object.is(value, prev.deps[at]))
    if (same) return
    node.hooks[index] = { deps: deps ? deps.slice() : null, cleanup: prev ? prev.cleanup : undefined }
    pendingEffects.push({ node, index, fn })
  }

  function runEffects() {
    const queue = pendingEffects
    pendingEffects = []
    for (const item of queue) {
      const slot = item.node.hooks[item.index]
      if (slot && typeof slot.cleanup === 'function') slot.cleanup()
      const cleanup = item.fn()
      if (slot) slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
  }

  function reconcileChildren(elements, oldNodes) {
    const next = []
    for (let at = 0; at < elements.length; at += 1) {
      next.push(reconcile(elements[at], oldNodes ? oldNodes[at] : null))
    }
    return next
  }

  function reconcile(element, oldNode) {
    if (element === null || element === undefined || typeof element === 'boolean') return null
    if (typeof element === 'string' || typeof element === 'number') {
      const text = String(element)
      if (oldNode && oldNode.kind === 'text') {
        oldNode.text = text
        return oldNode
      }
      return { kind: 'text', text }
    }
    if (typeof element.type === 'function') {
      const node = oldNode && oldNode.kind === 'component' && oldNode.type === element.type
        ? oldNode
        : { kind: 'component', type: element.type, props: {}, hooks: [], children: [] }
      node.props = element.props
      const outerNode = currentNode
      const outerIndex = hookIndex
      currentNode = node
      hookIndex = 0
      let output
      try {
        output = element.type(element.props)
      } finally {
        currentNode = outerNode
        hookIndex = outerIndex
      }
      node.children = reconcileChildren(flatten([output]), node.children)
      return node
    }
    const node = oldNode && oldNode.kind === 'host' && oldNode.tag === element.type
      ? oldNode
      : { kind: 'host', tag: element.type, props: {}, children: [] }
    node.props = element.props
    node.children = reconcileChildren(element.children, node.children)
    return node
  }

  function flush() {
    let guard = 0
    while (dirty && guard < 50) {
      guard += 1
      dirty = false
      rootNode = reconcile(rootElement, rootNode)
      runEffects()
    }
  }

  function render(element) {
    rootElement = element
    rootNode = null
    dirty = false
    rootNode = reconcile(element, null)
    runEffects()
    flush()
    return rootNode
  }

  function walk(node, visit) {
    if (!node) return
    visit(node)
    for (const child of node.children || []) walk(child, visit)
  }

  function unmount() {
    walk(rootNode, (node) => {
      if (node.kind !== 'component') return
      for (const slot of node.hooks) {
        if (slot && typeof slot.cleanup === 'function') slot.cleanup()
      }
    })
    rootNode = null
    rootElement = null
  }

  function textOf(node) {
    if (!node) return ''
    if (node.kind === 'text') return node.text
    return (node.children || []).map(textOf).join('')
  }

  function findAll(predicate) {
    const hits = []
    walk(rootNode, (node) => {
      if (predicate(node)) hits.push(node)
    })
    return hits
  }

  function findButtons(label) {
    return findAll((node) => node.kind === 'host' && node.tag === 'button' &&
      (label === undefined || textOf(node) === label))
  }

  function findInputs() {
    return findAll((node) => node.kind === 'host' && node.tag === 'input')
  }

  return {
    react: { createElement, useState, useRef, useEffect },
    render,
    flush,
    unmount,
    textOf,
    findAll,
    findButtons,
    findInputs,
    get root() {
      return rootNode
    },
  }
}

// --- 浏览器桩：window / document 事件目标 -----------------------------------

function createBrowser() {
  function target() {
    const listeners = new Map()
    return {
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type).add(fn)
      },
      removeEventListener(type, fn) {
        const set = listeners.get(type)
        if (set) set.delete(fn)
      },
      dispatch(type) {
        const set = listeners.get(type)
        if (!set) return
        for (const fn of Array.from(set)) fn({ type })
      },
      count(type) {
        const set = listeners.get(type)
        return set ? set.size : 0
      },
    }
  }
  const window = target()
  const document = target()
  document.visibilityState = 'visible'
  return { window, document }
}

// --- 可手动结算的 fetch -----------------------------------------------------

function createFetch() {
  const calls = []
  function fetchImpl(url, options) {
    const call = { url: String(url), method: (options && options.method) || 'GET', options: options || {} }
    call.promise = new Promise((resolve, reject) => {
      call.resolve = resolve
      call.reject = reject
    })
    calls.push(call)
    return call.promise
  }
  fetchImpl.calls = calls
  fetchImpl.gets = (needle) => calls.filter((call) => call.method === 'GET' && call.url.indexOf(needle) !== -1)
  fetchImpl.posts = () => calls.filter((call) => call.method === 'POST')
  fetchImpl.respond = (call, data, status) => {
    call.resolve({ status: status === undefined ? 200 : status, json: async () => data })
  }
  fetchImpl.fail = (call, error) => {
    call.reject(error)
  }
  return fetchImpl
}

/** 把 client.js 当成浏览器里的经典脚本装进 window.__ModuleLoader__。 */
function loadClient(env) {
  let exported = null
  env.window.__ModuleLoader__ = {
    load(spec) {
      exported = spec.factory((name) => {
        if (name === 'react') return env.react
        throw new Error('client.js 只应 require("react")，实际：' + name)
      })
    },
  }
  const evaluate = new Function('window', 'document', 'fetch', 'FileReader', SOURCE)
  evaluate(env.window, env.document, env.fetchImpl, class FileReaderStub {})
  assert.ok(exported, 'client.js 应通过 window.__ModuleLoader__ 注册模块')
  return exported
}

// --- 场景装置 ---------------------------------------------------------------

const NEEDS_SELECTION = {
  available: true,
  roots: [
    { rootId: 'root-aaaa1111', label: 'Agent A', enabled: false },
    { rootId: 'root-bbbb2222', label: 'Agent B', enabled: false },
  ],
  rootId: null,
  needsSelection: true,
  known: true,
  mode: null,
}

// 选中 root 之后服务端就会给出 rootId，needsSelection 随之变成 false（面板切回主视图）。
const SELECTED = {
  available: true,
  roots: [
    { rootId: 'root-aaaa1111', label: 'Agent A', enabled: false },
    { rootId: 'root-bbbb2222', label: 'Agent B', enabled: false },
  ],
  rootId: 'root-aaaa1111',
  needsSelection: false,
  known: true,
  mode: { enabled: false, epoch: 1, task: '' },
}

const ENABLED = {
  available: true,
  roots: [{ rootId: 'root-aaaa1111', label: 'Agent A', enabled: true }],
  rootId: 'root-aaaa1111',
  needsSelection: false,
  known: true,
  mode: { enabled: true, epoch: 7, task: '整理桌面' },
}

function setup() {
  const renderer = createRenderer()
  const browser = createBrowser()
  const fetchImpl = createFetch()
  const module = loadClient({
    react: renderer.react,
    window: browser.window,
    document: browser.document,
    fetchImpl,
  })
  // 只算 GET：POST 打的是同一个路径，混进来会让“读取次数”的断言失真。
  const multiMouse = () => fetchImpl.gets('/multi-mouse')
  // 走真实的 tab 分派：initialTab 决定 body 渲染哪一个面板。
  const mount = () => renderer.render(renderer.react.createElement(module.AppearanceSettings, { initialTab: 'multimouse' }))
  return { renderer, browser, fetchImpl, module, multiMouse, mount }
}

/** 排空微任务并刷新渲染，模拟浏览器里一次交互结束后的状态落地。 */
async function settle(renderer) {
  for (let round = 0; round < 8; round += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    renderer.flush()
  }
}

const checkboxOf = (renderer) => renderer.findInputs().find((node) => node.props.type === 'checkbox')
const taskInputOf = (renderer) => renderer.findInputs().find((node) => node.props.type === 'text')

// --- 用例 -------------------------------------------------------------------

test('the panel reads the runtime once on mount and renders what the server says', async () => {
  const { renderer, fetchImpl, multiMouse, mount } = setup()
  mount()
  assert.equal(multiMouse().length, 1, '挂载后只读一次多鼠标状态')
  assert.match(renderer.textOf(renderer.root), /正在读取多鼠标状态/)

  fetchImpl.respond(multiMouse()[0], { ok: true, value: ENABLED })
  await settle(renderer)
  assert.equal(multiMouse().length, 1, '读取成功之后不轮询')
  assert.doesNotMatch(renderer.textOf(renderer.root), /正在读取多鼠标状态/)

  const checkbox = checkboxOf(renderer)
  assert.ok(checkbox, '主视图要有“本任务”开关')
  assert.equal(checkbox.props.checked, true, '开关由服务端状态驱动')
  const task = taskInputOf(renderer)
  assert.ok(task, '主视图要有任务提示输入框')
  assert.equal(task.props.value, '整理桌面', '任务提示回填服务端任务')
  assert.equal(task.props.disabled, false)
})

test('an unavailable runtime is reported instead of pretending to be off', async () => {
  const { renderer, fetchImpl, multiMouse, mount } = setup()
  mount()
  fetchImpl.respond(multiMouse()[0], {
    ok: true,
    value: { available: false, roots: [], rootId: null, needsSelection: true, mode: null },
  })
  await settle(renderer)
  assert.match(renderer.textOf(renderer.root), /多鼠标 runtime 不可用/)
  assert.equal(renderer.findInputs().length, 0, 'runtime 不可用时不给开关，避免让人以为是自己关掉的')
})

test('coming back to the page or the window re-reads once each', async () => {
  const { renderer, browser, multiMouse, mount } = setup()
  mount()
  assert.equal(multiMouse().length, 1)

  browser.document.visibilityState = 'hidden'
  browser.document.dispatch('visibilitychange')
  assert.equal(multiMouse().length, 1, '页面隐藏时不发请求')

  browser.document.visibilityState = 'visible'
  browser.document.dispatch('visibilitychange')
  assert.equal(multiMouse().length, 2, '页面重新可见时读一次')

  browser.window.dispatch('focus')
  assert.equal(multiMouse().length, 3, '窗口重新聚焦时读一次')
})

test('a stale read cannot overwrite the newer one', async () => {
  const { renderer, browser, fetchImpl, multiMouse, mount } = setup()
  mount()
  browser.window.dispatch('focus')
  assert.equal(multiMouse().length, 2, '两次读取同时在途')

  // 后发的先回、先发的后回：旧响应必须被丢掉。
  fetchImpl.respond(multiMouse()[1], { ok: true, value: ENABLED })
  await settle(renderer)
  fetchImpl.respond(multiMouse()[0], { ok: true, value: NEEDS_SELECTION })
  await settle(renderer)

  const checkbox = checkboxOf(renderer)
  assert.ok(checkbox, '新读取的结果必须还在')
  assert.equal(checkbox.props.checked, true, '先发出、后返回的旧读取不得覆盖新状态')
})

test('a refresh does not overwrite the task text the user is typing', async () => {
  const { renderer, browser, fetchImpl, multiMouse, mount } = setup()
  mount()
  fetchImpl.respond(multiMouse()[0], { ok: true, value: ENABLED })
  await settle(renderer)

  taskInputOf(renderer).props.onChange({ target: { value: '我的草稿' } })
  renderer.flush()
  assert.equal(taskInputOf(renderer).props.value, '我的草稿')

  browser.window.dispatch('focus')
  fetchImpl.respond(multiMouse()[1], {
    ok: true,
    value: Object.assign({}, ENABLED, { mode: { enabled: false, epoch: 8, task: '服务端任务' } }),
  })
  await settle(renderer)

  assert.equal(taskInputOf(renderer).props.value, '我的草稿', '草稿没提交前不被后台刷新回写')
  assert.equal(checkboxOf(renderer).props.checked, false, '开关仍然跟随服务端')
})

test('a refresh during a save is deferred, never fired, so the save cannot be stranded', async () => {
  const { renderer, browser, fetchImpl, multiMouse, mount } = setup()
  mount()
  fetchImpl.respond(multiMouse()[0], { ok: true, value: NEEDS_SELECTION })
  await settle(renderer)

  const rootButton = renderer.findButtons().find((node) => renderer.textOf(node).indexOf('Agent A') === 0)
  assert.ok(rootButton, '多 root 时要能选中本任务对应的 root')
  rootButton.props.onClick()
  renderer.flush()

  const posts = fetchImpl.posts()
  assert.equal(posts.length, 1, '选中 root 走 POST')
  assert.deepEqual(JSON.parse(posts[0].options.body), { rootId: 'root-aaaa1111' })

  const refreshButtons = renderer.findButtons('重新读取')
  assert.equal(refreshButtons.length, 2, '设置容器一个“重新读取”，面板一个')
  const panelRefresh = refreshButtons[refreshButtons.length - 1]
  assert.equal(panelRefresh.props.disabled, true, '保存途中面板的“重新读取”不可点')

  // 即便点击仍被投递进来，也不得换代次：一旦换代，在途保存的响应会被判过期丢掉，
  // busy 就永远收不了尾，控件一直禁用、之后的刷新全被挡在 reloadAfterSave 里。
  panelRefresh.props.onClick()
  browser.window.dispatch('focus')
  renderer.flush()
  assert.equal(multiMouse().length, 1, '保存途中不读取，只记一笔')

  fetchImpl.respond(posts[0], { ok: true, value: SELECTED })
  await settle(renderer)
  assert.equal(multiMouse().length, 2, '保存收尾后补读一次，且只补一次')
  assert.match(renderer.textOf(renderer.root), /root：root-aaaa/, '保存结果已经落地，面板切回主视图')
  assert.equal(checkboxOf(renderer).props.disabled, false, 'busy 收尾后控件恢复可用')
  const mainRefresh = renderer.findButtons('刷新')
  assert.equal(mainRefresh.length, 1, '主视图的刷新按钮回来了')
  assert.equal(mainRefresh[0].props.disabled, false, '主视图刷新按钮也恢复可用')
})

test('a failed save still releases busy and re-reads once', async () => {
  const { renderer, browser, fetchImpl, multiMouse, mount } = setup()
  mount()
  fetchImpl.respond(multiMouse()[0], { ok: true, value: ENABLED })
  await settle(renderer)

  checkboxOf(renderer).props.onChange({ target: { checked: false } })
  renderer.flush()
  const posts = fetchImpl.posts()
  assert.equal(posts.length, 1)
  assert.deepEqual(JSON.parse(posts[0].options.body), { enabled: false, task: '整理桌面' })

  browser.window.dispatch('focus')
  renderer.flush()
  assert.equal(multiMouse().length, 1, '保存途中不读取')

  fetchImpl.fail(posts[0], new Error('本机接口断开了'))
  await settle(renderer)
  assert.equal(multiMouse().length, 2, '失败也要收尾并补读一次')
  assert.match(renderer.textOf(renderer.root), /本机接口断开了/)
  assert.equal(checkboxOf(renderer).props.disabled, false, '失败后控件恢复可用')
})

test('a late GET cannot overwrite the state a save already applied', async () => {
  const { renderer, browser, fetchImpl, multiMouse, mount } = setup()
  mount()
  fetchImpl.respond(multiMouse()[0], { ok: true, value: ENABLED })
  await settle(renderer)

  // 读取先发：切回窗口触发一次 GET，但先不结算。
  browser.window.dispatch('focus')
  assert.equal(multiMouse().length, 2, '读取已经在路上')

  // 保存后发：用户这时改了开关，POST 换代次。
  checkboxOf(renderer).props.onChange({ target: { checked: false } })
  renderer.flush()
  const posts = fetchImpl.posts()
  assert.equal(posts.length, 1)
  assert.deepEqual(JSON.parse(posts[0].options.body), { enabled: false, task: '整理桌面' })

  // 旧 GET 后返：它带的是保存前的视图（needsSelection），绝不能把保存结果顶掉。
  fetchImpl.respond(multiMouse()[1], { ok: true, value: NEEDS_SELECTION })
  await settle(renderer)
  fetchImpl.respond(posts[0], { ok: true, value: SELECTED })
  await settle(renderer)

  assert.match(renderer.textOf(renderer.root), /root：root-aaaa/, '保存结果生效，面板没有退回选 root 视图')
  const checkbox = checkboxOf(renderer)
  assert.ok(checkbox, '迟到的旧 GET 不得把面板打回 needsSelection')
  assert.equal(checkbox.props.checked, false, '开关是保存后的值')
})

test('a failed save keeps the task text and can be retried', async () => {
  const { renderer, browser, fetchImpl, multiMouse, mount } = setup()
  mount()
  fetchImpl.respond(multiMouse()[0], { ok: true, value: ENABLED })
  await settle(renderer)

  taskInputOf(renderer).props.onChange({ target: { value: '我的新任务' } })
  renderer.flush()
  taskInputOf(renderer).props.onBlur()
  renderer.flush()
  const posts = fetchImpl.posts()
  assert.equal(posts.length, 1, '失焦保存任务文字')
  assert.deepEqual(JSON.parse(posts[0].options.body), { enabled: true, task: '我的新任务' })

  // 保存途中切回窗口：这次读取被记下来，等保存收尾后补读。
  browser.window.dispatch('focus')
  renderer.flush()
  assert.equal(multiMouse().length, 1, '保存途中不读取')

  fetchImpl.fail(posts[0], new Error('本机接口断开了'))
  await settle(renderer)
  assert.equal(multiMouse().length, 2, '失败也收尾并补读一次')
  // 失败原因要看得见；补读成功后会清掉，所以在这之前断言。
  assert.match(renderer.textOf(renderer.root), /本机接口断开了/)

  // 补读回来的是服务端的旧任务（保存根本没成功）。草稿标记若在保存一开始就清掉，
  // 这里就会把用户刚打的字换成旧值，等于让他白改一遍。
  fetchImpl.respond(multiMouse()[1], { ok: true, value: ENABLED })
  await settle(renderer)
  assert.equal(taskInputOf(renderer).props.value, '我的新任务', '失败后草稿仍在输入框里')
  assert.equal(checkboxOf(renderer).props.disabled, false, '失败后可以再试')

  // 再试一次：同一次输入可以重新提交，不需要用户重打。
  checkboxOf(renderer).props.onChange({ target: { checked: false } })
  renderer.flush()
  const retries = fetchImpl.posts()
  assert.equal(retries.length, 2, '失败后能重试')
  assert.deepEqual(JSON.parse(retries[1].options.body), { enabled: false, task: '我的新任务' })
})

test('unmounting unbinds the listeners and ignores late responses', async () => {
  const { renderer, browser, fetchImpl, multiMouse, mount } = setup()
  mount()
  assert.equal(multiMouse().length, 1)
  assert.equal(browser.window.count('focus'), 1, '挂载时绑定 focus')
  assert.equal(browser.document.count('visibilitychange'), 1, '挂载时绑定 visibilitychange')

  renderer.unmount()
  assert.equal(browser.window.count('focus'), 0, '卸载时解绑 focus')
  assert.equal(browser.document.count('visibilitychange'), 0, '卸载时解绑 visibilitychange')

  browser.window.dispatch('focus')
  browser.document.dispatch('visibilitychange')
  assert.equal(multiMouse().length, 1, '卸载后不再发请求')

  fetchImpl.respond(multiMouse()[0], { ok: true, value: ENABLED })
  await settle(renderer)
  assert.equal(renderer.root, null, '卸载后不再渲染')
})
