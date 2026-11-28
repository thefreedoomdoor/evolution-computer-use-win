/**
 * 设置页客户端插件：网关传输控件必须真的挂到“网关那一行”的配置槽上。
 *
 * 这里不渲染 React：client.js 是给 Web UI 的模块工厂（window.__ModuleLoader__），
 * 测试只把工厂取出来跑 apply()，核对槽位 key / order / 组件身份，再对源码做几条静态断言，
 * 防止以后有人把控件挂错行或把 expected 令牌丢掉。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const CLIENT_FILE = fileURLToPath(new URL('../plugin/lib/client.js', import.meta.url));
const SOURCE = readFileSync(CLIENT_FILE, 'utf8');

/**
 * 宿主契约（与真实 Web UI 一致，见 client.js 结尾）：
 *   window.__ModuleLoader__.load({ id, factory })
 * 单个对象参数，工厂挂在 factory 上。静态装载与行为装载都走这一份捕获，
 * 避免两处签名再次分叉（上一版把 load 写成 load(id, definition)，启动即 TypeError）。
 */
function captureModules(target) {
  const registrations = [];
  target.__ModuleLoader__ = {
    load(...args) {
      assert.equal(args.length, 1, 'load 只接受一个 { id, factory } 对象');
      const specification = args[0];
      assert.ok(specification && typeof specification === 'object', 'load 的参数必须是对象');
      assert.equal(typeof specification.factory, 'function', 'load 的参数必须带 factory');
      registrations.push(specification);
      return undefined;
    },
  };
  return registrations;
}

globalThis.window = {};
const staticModules = captureModules(globalThis.window);

await import('../plugin/lib/client.js');
delete globalThis.window;

assert.equal(staticModules.length, 1, 'client.js 应当只注册一个模块');
assert.equal(staticModules[0].id, 'evolution-computer-use-win', '模块 id 必须是包名');
const moduleDefinition = staticModules[0];

const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect() {},
  useRef(value) {
    return { current: value };
  },
};

const api = moduleDefinition.factory((specifier) => {
  if (specifier === 'react') return fakeReact;
  throw new Error('client.js 不应该 require 别的模块：' + specifier);
});

function fakeContext() {
  const injections = [];
  const registrations = [];
  return {
    injections,
    registrations,
    ctx: {
      slots: {
        inject(name, callback) {
          injections.push(name);
          callback();
          return () => {};
        },
        register(options, render) {
          registrations.push({ options, render });
          return () => {};
        },
      },
    },
  };
}

test('网关传输控件挂在网关那一行的配置槽上（包名#entry id）', () => {
  const host = fakeContext();
  api.apply(host.ctx);

  assert.deepEqual(host.injections, ['plugins.row.config', 'plugins.row.config', 'plugins.bundle.config']);

  const modeRow = host.registrations[0];
  assert.equal(modeRow.options.name, 'plugins.row.config');
  assert.equal(modeRow.options.key, 'evolution-computer-use-win#evolution-desktop-mode');
  assert.equal(modeRow.options.order, 10);
  assert.equal(modeRow.render({ view: 'summary' }).type, api.DesktopModeControl);

  const transportRow = host.registrations[1];
  assert.equal(transportRow.options.name, 'plugins.row.config');
  assert.equal(transportRow.options.key, 'evolution-computer-use-win#evolution-computer-use');
  assert.equal(transportRow.options.order, 20);
  assert.equal(transportRow.render({ view: 'summary' }).type, api.GatewayTransportControl);
  assert.equal(transportRow.render({ view: 'page' }).type, api.GatewayTransportControl);

  const bundlePage = host.registrations[2];
  assert.equal(bundlePage.options.name, 'plugins.bundle.config');
  assert.equal(bundlePage.options.key, 'evolution-computer-use-win', 'bundle 页的 key 仍是包名，行为不变');
  assert.equal(bundlePage.render({ view: 'page' }).type, api.DesktopModeControl);

  const keys = host.registrations.map((item) => item.options.name + '|' + item.options.key);
  assert.equal(new Set(keys).size, keys.length, '槽位 key 不能重复');
});

test('view 原样传给控件（summary 是列表行，page 是详情页）', () => {
  const host = fakeContext();
  api.apply(host.ctx);
  for (const { render } of host.registrations) {
    assert.equal(render({ view: 'summary' }).props.view, 'summary');
    assert.equal(render({ view: 'page' }).props.view, 'page');
    assert.equal(render(undefined).props.view, undefined, '没有 slotProps 时不能崩');
  }
});

test('插槽服务出错时只记录，不让整个设置页挂掉', () => {
  const broken = {
    slots: {
      inject() {
        throw new Error('slots 服务不可用');
      },
      register() {
        throw new Error('不该走到这里');
      },
    },
  };
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    assert.doesNotThrow(() => api.apply(broken));
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((line) => line.includes('注册插槽失败')));
});

test('网关控件走宿主接口：GET 读、POST 带 expected 令牌、卸载后不再更新状态', () => {
  // 静态断言（client.js 没有构建步骤，这几条就是它的行为契约）。
  assert.ok(SOURCE.includes("fetch(API + '/transport'"), '必须直接请求 /transport');
  assert.ok(SOURCE.includes('expected: state.expected'), 'POST 必须带 expected，避免覆盖别人的改动');
  assert.ok(SOURCE.includes('next === state.current'), '当前值不该被重复提交');
  assert.ok(SOURCE.includes('disabled: busy || !available || state === null'), '加载中或不可用时要禁用按钮');
  assert.ok(SOURCE.includes('alive.current = false'), '卸载后要停止 setState');
  assert.ok(SOURCE.includes("role: 'radiogroup'"), '两个选项要是单选组');
  assert.ok(SOURCE.includes("role: 'status'"), '保存/错误状态要有可读的状态区');
  // 主题色：当前深色主题下 brand-primary 接近白色，文字必须换成 onBrandText。
  assert.ok(SOURCE.includes('var(--dsw-alias-brand-primary'), '选中态用主题的 brand-primary');
  assert.ok(SOURCE.includes('onBrandText'));
});

test('两个选项的文案说清真实差别，也不宣称未完成的验收', () => {
  assert.ok(SOURCE.includes('历史默认'), 'MCP 要标明是历史默认，不能让人以为是新选择');
  assert.ok(SOURCE.includes('未知身份一律拒绝'), 'native 要说明未知身份会被拒绝');
  assert.ok(!/已通过验收|fully verified/i.test(SOURCE), '界面不能宣称未完成的验收');
});

// ---------------------------------------------------------------------------
// 行为测试：真的把控件跑起来（极简 hooks 渲染器 + 手动结算的 fetch）。
// client.js 没有构建步骤，这里用 new Function 把 window/document/fetch 传进去，
// 每个用例都重新加载一次模块，拿到独立实例，互不串状态。
// ---------------------------------------------------------------------------

function createHooks() {
  const hooks = [];
  const effects = new Map();
  let pending = [];
  let index = 0;
  let dirty = false;
  let tree = null;

  const react = {
    createElement(type, attrs) {
      const children = Array.prototype.slice.call(arguments, 2);
      const next = {};
      if (attrs) for (const key of Object.keys(attrs)) next[key] = attrs[key];
      // 真 React 把子节点放在 props.children 上：Card / CardTitle 这类纯函数组件就是读它。
      if (children.length === 1) next.children = children[0];
      else if (children.length > 1) next.children = children;
      return { type, props: next, children };
    },
    useState(initial) {
      const at = index;
      index += 1;
      if (!(at in hooks)) hooks[at] = typeof initial === 'function' ? initial() : initial;
      const set = (value) => {
        const next = typeof value === 'function' ? value(hooks[at]) : value;
        if (Object.is(next, hooks[at])) return;
        hooks[at] = next;
        dirty = true;
      };
      return [hooks[at], set];
    },
    useRef(initial) {
      const at = index;
      index += 1;
      if (!(at in hooks)) hooks[at] = { current: initial };
      return hooks[at];
    },
    useEffect(fn, deps) {
      const at = index;
      index += 1;
      const previous = effects.get(at);
      const same =
        !!previous &&
        Array.isArray(previous.deps) &&
        Array.isArray(deps) &&
        previous.deps.length === deps.length &&
        deps.every((value, position) => Object.is(value, previous.deps[position]));
      if (same) return;
      pending.push({ at, fn, deps: Array.isArray(deps) ? deps.slice() : null });
    },
  };

  function draw(component, props) {
    dirty = false;
    index = 0;
    pending = [];
    tree = component(props);
    const queue = pending;
    pending = [];
    for (const item of queue) {
      const previous = effects.get(item.at);
      if (previous && typeof previous.cleanup === 'function') previous.cleanup();
      const cleanup = item.fn();
      effects.set(item.at, { deps: item.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined });
    }
  }

  return {
    react,
    render(component, props) {
      // 挂载后立刻把挂载副作用（首个 GET 的 setBusy 等）重绘出来，用例可以直接断言首帧。
      draw(component, props || { view: 'page' });
      this.flush(component, props);
    },
    flush(component, props) {
      let guard = 0;
      while (dirty && guard < 100) {
        guard += 1;
        draw(component, props || { view: 'page' });
      }
    },
    text() {
      return textOf(tree).join(' ');
    },
    buttons() {
      return nodesOf(tree).filter((node) => node.type === 'button');
    },
    unmount() {
      for (const value of effects.values()) if (typeof value.cleanup === 'function') value.cleanup();
      effects.clear();
    },
  };
}

function nodesOf(node, out = []) {
  if (node === null || node === undefined || node === true || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) nodesOf(child, out);
    return out;
  }
  if (typeof node === 'string' || typeof node === 'number') return out;
  if (typeof node.type === 'function') {
    nodesOf(node.type(node.props), out);
    return out;
  }
  out.push(node);
  for (const child of node.children || []) nodesOf(child, out);
  return out;
}

function textOf(node, out = []) {
  if (node === null || node === undefined || node === true || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    const text = String(node);
    if (text.trim()) out.push(text);
    return out;
  }
  if (typeof node.type === 'function') {
    textOf(node.type(node.props), out);
    return out;
  }
  for (const child of node.children || []) textOf(child, out);
  return out;
}

function createFetch() {
  const calls = [];
  const impl = (url, options) => {
    const call = {
      url: String(url),
      method: (options && options.method) || 'GET',
      body: options && typeof options.body === 'string' ? JSON.parse(options.body) : null,
    };
    call.promise = new Promise((resolve, reject) => {
      call.resolve = resolve;
      call.reject = reject;
    });
    calls.push(call);
    return call.promise;
  };
  impl.calls = calls;
  impl.gets = () => calls.filter((call) => call.method === 'GET');
  impl.posts = () => calls.filter((call) => call.method === 'POST');
  impl.respond = (call, data, status = 200) => call.resolve({ status, ok: status >= 200 && status < 300, json: async () => data });
  impl.fail = (call, error) => call.reject(error);
  return impl;
}

function loadClient(environment) {
  // 与静态装载同一条捕获路径：load({ id, factory }) 单参数。
  const modules = captureModules(environment.window);
  const run = new Function('window', 'document', 'fetch', 'FileReader', SOURCE);
  run(environment.window, environment.document, environment.fetch, class FileReaderStub {});
  assert.equal(modules.length, 1, 'client.js 应当只注册一个模块');
  assert.equal(modules[0].id, 'evolution-computer-use-win', '模块 id 必须是包名');
  const exported = modules[0].factory((name) => {
    if (name === 'react') return environment.react;
    throw new Error('client.js 不应该 require 别的模块：' + name);
  });
  assert.ok(exported, 'client.js 应当注册模块');
  return exported;
}

/** 每个用例一套独立的 hooks + fetch + 模块实例。 */
function harness() {
  const hooks = createHooks();
  const fetchImpl = createFetch();
  const target = {
    addEventListener() {},
    removeEventListener() {},
  };
  const apiUnderTest = loadClient({
    window: Object.assign({}, target),
    document: Object.assign({ visibilityState: 'visible' }, target),
    fetch: fetchImpl,
    react: hooks.react,
  });
  const component = apiUnderTest.GatewayTransportControl;
  return { hooks, fetchImpl, api: apiUnderTest, component };
}

const settle = async () => {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

function buttonByText(hooks, label) {
  const found = hooks.buttons().filter((node) => textOf({ type: 'x', props: {}, children: node.children }).join('') === label);
  assert.equal(found.length, 1, '应当只有一个「' + label + '」按钮');
  return found[0];
}

function view(overrides = {}) {
  return Object.assign(
    { entryId: 'evolution-computer-use', options: ['mcp', 'native'], available: true, current: 'mcp', explicit: false, expected: 'mcp' },
    overrides
  );
}

test('加载中禁用两个选项；拿到宿主状态后才显示当前值', async () => {
  const { hooks, fetchImpl, component } = harness();
  hooks.render(component);
  assert.equal(fetchImpl.gets().length, 1, '挂上就应该 GET 一次');
  assert.equal(fetchImpl.gets()[0].url, '/api/dsh-evolution-desktop-mode/transport');
  assert.equal(fetchImpl.gets()[0].body, null, 'GET 不带 body');
  assert.ok(hooks.text().includes('加载中'), '加载中要如实显示');
  assert.equal(hooks.buttons().length, 2);
  for (const button of hooks.buttons()) assert.equal(button.props.disabled, true, '加载中两个选项都要禁用');

  fetchImpl.respond(fetchImpl.gets()[0], { ok: true, value: view() });
  await settle();
  hooks.flush(component);
  assert.ok(hooks.text().includes('当前：mcp'));
  assert.ok(hooks.text().includes('未写配置，按历史默认'), '没写过 toolTransport 要说明按历史默认');
  for (const button of hooks.buttons()) assert.equal(button.props.disabled, false);
});

test('保存中先显示草稿、重复点击不再发请求；成功后以宿主回传为准', async () => {
  const { hooks, fetchImpl, component } = harness();
  hooks.render(component);
  fetchImpl.respond(fetchImpl.gets()[0], { ok: true, value: view() });
  await settle();
  hooks.flush(component);

  buttonByText(hooks, 'native').props.onClick({ stopPropagation() {} });
  hooks.flush(component);
  assert.equal(fetchImpl.posts().length, 1, '提交一次');
  assert.deepEqual(fetchImpl.posts()[0].body, { next: 'native', expected: 'mcp' }, 'POST 只带 next 与 expected');
  assert.ok(hooks.text().includes('保存中'), '保存中要如实显示');
  assert.equal(buttonByText(hooks, 'native').props['aria-checked'], 'true', '保存中先显示草稿');

  buttonByText(hooks, 'native').props.onClick({ stopPropagation() {} });
  hooks.flush(component);
  assert.equal(fetchImpl.posts().length, 1, '保存中重复点击不得再发请求');

  fetchImpl.respond(fetchImpl.posts()[0], { ok: true, value: view({ current: 'native', explicit: true, expected: 'native' }) });
  await settle();
  hooks.flush(component);
  assert.ok(hooks.text().includes('当前：native'));
  assert.ok(!hooks.text().includes('保存中'));
  assert.equal(buttonByText(hooks, 'MCP').props['aria-checked'], 'false');
});

test('保存失败回到原来的选择、照实显示错误，并给重试', async () => {
  const { hooks, fetchImpl, component } = harness();
  hooks.render(component);
  fetchImpl.respond(fetchImpl.gets()[0], { ok: true, value: view() });
  await settle();
  hooks.flush(component);

  buttonByText(hooks, 'native').props.onClick({ stopPropagation() {} });
  hooks.flush(component);
  fetchImpl.respond(fetchImpl.posts()[0], { ok: false, message: '修改网关传输失败：宿主拒绝了这次修改' }, 500);
  await settle();
  hooks.flush(component);

  assert.equal(buttonByText(hooks, 'MCP').props['aria-checked'], 'true', '失败后回到原来的选择');
  assert.equal(buttonByText(hooks, 'native').props['aria-checked'], 'false');
  assert.ok(hooks.text().includes('修改网关传输失败'), '错误要照实显示');
  assert.ok(!hooks.text().includes('保存中'));

  buttonByText(hooks, '重试').props.onClick({ stopPropagation() {} });
  hooks.flush(component);
  assert.equal(fetchImpl.gets().length, 2, '重试要重新读宿主状态');
});

test('冲突时以宿主真实值为准，并提示刷新', async () => {
  const { hooks, fetchImpl, component } = harness();
  hooks.render(component);
  fetchImpl.respond(fetchImpl.gets()[0], { ok: true, value: view() });
  await settle();
  hooks.flush(component);

  buttonByText(hooks, 'native').props.onClick({ stopPropagation() {} });
  hooks.flush(component);
  fetchImpl.respond(
    fetchImpl.posts()[0],
    {
      ok: false,
      conflict: true,
      message: '网关传输已经被别处改成 native，请刷新后再改',
      value: view({ current: 'native', explicit: true, expected: 'native' }),
    },
    409
  );
  await settle();
  hooks.flush(component);
  assert.ok(hooks.text().includes('请刷新后再改'));
  assert.ok(hooks.text().includes('当前：native'), '冲突后显示宿主的新值，而不是自己的草稿');
});

test('迟到的 POST 响应不得覆盖更新的状态', async () => {
  const { hooks, fetchImpl, component } = harness();
  hooks.render(component);
  fetchImpl.respond(fetchImpl.gets()[0], { ok: true, value: view() });
  await settle();
  hooks.flush(component);

  // 第一次保存网络失败 → 出现重试
  buttonByText(hooks, 'native').props.onClick({ stopPropagation() {} });
  hooks.flush(component);
  const firstPost = fetchImpl.posts()[0];
  fetchImpl.fail(firstPost, new Error('socket hang up'));
  await settle();
  hooks.flush(component);
  assert.ok(hooks.text().includes('本机接口没有响应'));

  // 重试读到宿主其实已经被别人改成了 native
  buttonByText(hooks, '重试').props.onClick({ stopPropagation() {} });
  hooks.flush(component);
  const secondGet = fetchImpl.gets()[1];
  assert.ok(secondGet, '重试要发新的 GET');
  fetchImpl.respond(secondGet, { ok: true, value: view({ current: 'native', explicit: true, expected: 'native' }) });
  await settle();
  hooks.flush(component);
  assert.ok(hooks.text().includes('当前：native'));

  // 那条迟到的 POST 现在才回：必须被丢掉，界面不能倒回旧值。
  fetchImpl.respond(firstPost, { ok: true, value: view() });
  await settle();
  hooks.flush(component);
  assert.ok(!hooks.text().includes('当前：mcp'), '迟到响应不得把状态改回旧值');
  assert.ok(hooks.text().includes('当前：native'));
});

test('不可用时只说明原因、选项禁用，点击不发 POST', async () => {
  const { hooks, fetchImpl, component } = harness();
  hooks.render(component);
  fetchImpl.respond(
    fetchImpl.gets()[0],
    {
      ok: true,
      value: view({ available: false, reason: '当前 profile 里没有可编辑的 evolution-computer-use 行（可能被更高优先级的配置覆盖）' }),
    }
  );
  await settle();
  hooks.flush(component);

  assert.ok(hooks.text().includes('没有可编辑的'), '原因要照实显示');
  for (const button of hooks.buttons()) assert.equal(button.props.disabled, true);
  buttonByText(hooks, 'native').props.onClick({ stopPropagation() {} });
  hooks.flush(component);
  assert.equal(fetchImpl.posts().length, 0, '不可用时绝不能提交');
});

test('native-probe 这类特殊值如实展示，且没有额外的 probe 按钮', async () => {
  const { hooks, fetchImpl, component } = harness();
  hooks.render(component);
  fetchImpl.respond(fetchImpl.gets()[0], { ok: true, value: view({ current: 'native-probe', explicit: true, expected: 'native-probe' }) });
  await settle();
  hooks.flush(component);

  assert.ok(hooks.text().includes('当前：native-probe'), '不认识的传输值要照实显示，不能假装是 mcp');
  assert.ok(hooks.text().includes('探针传输'), '要说明这是验收用的探针传输');
  const labels = hooks.buttons().map((node) => textOf({ type: 'x', props: {}, children: node.children }).join(''));
  assert.deepEqual(labels, ['MCP', 'native'], '只有两个选项，没有额外的 probe 按钮');
});

test('卸载后迟到的响应不再改状态', async () => {
  const { hooks, fetchImpl, component } = harness();
  hooks.render(component);
  const pendingRead = fetchImpl.gets()[0];
  hooks.unmount();
  fetchImpl.respond(pendingRead, { ok: true, value: view({ current: 'native', explicit: true }) });
  await settle();
  assert.ok(!hooks.text().includes('当前：native'), '卸载后不得再渲染出状态');
});
