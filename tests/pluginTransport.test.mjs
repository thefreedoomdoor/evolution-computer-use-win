/**
 * 网关传输接口（/transport）的单元测试。
 *
 * 守住三件事：
 *  1. 只改 id 为 evolution-computer-use、且 name 指向本包网关的那一行，其它行与字段一概不动；
 *  2. 只有 next 是 mcp / native，且 expected 与刚读到的值一致才写（乐观并发，避免覆盖别人的改动）；
 *  3. 宿主 configEditor 缺失或拒绝时如实报错，绝不谎报成功。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createSettingsApi } from '../plugin/lib/routes.js';

const ENTRY_ID = 'evolution-computer-use';
const ENTRY_NAME = 'evolution-computer-use-win';

function row(config = {}, overrides = {}) {
  return { options: Object.assign({ id: ENTRY_ID, name: ENTRY_NAME, config }, overrides) };
}

/** 假 configEditor：entries() 给行，edit() 用回调返回值整体替换该行 config（与宿主一致）。 */
function fakeEditor(rows, options = {}) {
  const edits = [];
  return {
    edits,
    entries() {
      if (options.entriesThrows) throw new Error('loader 不可用');
      return rows;
    },
    async edit(entry, change) {
      edits.push(entry.options.id);
      if (options.editThrows) throw new Error(options.editThrows);
      // drift：模拟“别人在读到和写回之间先改了”—— 宿主里这份文件由 configEditor 重读，这里照实改在回调之前。
      if (options.drift) entry.options.config = Object.assign({}, entry.options.config || {}, { toolTransport: options.drift });
      const next = change(entry.options.config || {}, {});
      assert.equal(typeof next, 'object');
      // 宿主是 config 整体替换：回调没写的字段会真的消失，所以这里如实照做。
      if (!options.discard) entry.options.config = next;
    },
  };
}

function apiWith(editor) {
  return createSettingsApi({ dataDir: 'C:\\gateway-transport-test', getConfigEditor: () => editor });
}

function request(method, body) {
  const req = new EventEmitter();
  req.method = method;
  if (method === 'POST') {
    const text = typeof body === 'string' ? body : JSON.stringify(body === undefined ? {} : body);
    setImmediate(() => {
      req.emit('data', Buffer.from(text, 'utf8'));
      req.emit('end');
    });
  } else {
    setImmediate(() => req.emit('end'));
  }
  return req;
}

function response() {
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    done,
    setHeader(name, value) { res.headers[name] = value; },
    end(text) { res.body = JSON.parse(text); finish(); },
  };
  return res;
}

async function call(api, method, body) {
  const route = api.routes.find((item) => item.path === '/transport');
  assert.ok(route, '/transport 路由必须注册');
  const res = response();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('接口没有在 2 秒内回包')), 2000);
    timer.unref?.();
  });
  route.handler(request(method, body), res);
  try {
    await Promise.race([res.done, timeout]);
  } finally {
    clearTimeout(timer);
  }
  return res;
}

test('GET 读当前传输：没写 toolTransport 就是历史默认 mcp，并给出 expected 令牌', async () => {
  const editor = fakeEditor([row({ desktopMode: 'background' })]);
  const res = await call(apiWith(editor), 'GET');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  const value = res.body.value;
  assert.equal(value.entryId, ENTRY_ID);
  assert.deepEqual(value.options, ['mcp', 'native']);
  assert.equal(value.available, true);
  assert.equal(value.current, 'mcp');
  assert.equal(value.explicit, false, '没写配置要能区分出来，才敢说“按历史默认”');
  assert.equal(value.expected, 'mcp');
});

test('POST native 只改这一行的 toolTransport，其它字段与其它行都原样保留', async () => {
  const gateway = row({ desktopMode: 'background', multiMouse: true });
  const other = { options: { id: 'mcp-dsh-computer-use-win', name: 'dsh-computer-use-win', config: { mode: 'full' } } };
  const editor = fakeEditor([other, gateway]);
  const res = await call(apiWith(editor), 'POST', { next: 'native', expected: 'mcp' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.value.current, 'native');
  assert.equal(res.body.value.explicit, true);
  assert.deepEqual(editor.edits, [ENTRY_ID], '只允许编辑网关那一行');
  assert.deepEqual(gateway.options.config, { desktopMode: 'background', multiMouse: true, toolTransport: 'native' });
  assert.deepEqual(other.options.config, { mode: 'full' }, '别的插件的行不能被顺手改掉');
});

test('expected 与当前值不一致时回 409，且不写配置', async () => {
  const gateway = row({ desktopMode: 'background' });
  const editor = fakeEditor([gateway]);
  const res = await call(apiWith(editor), 'POST', { next: 'native', expected: 'native' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.conflict, true);
  assert.match(res.body.message, /请刷新后再改/);
  assert.equal(editor.edits.length, 0, '冲突时一次 edit 都不能发生');
  assert.deepEqual(gateway.options.config, { desktopMode: 'background' });
});

test('缺 expected 同样按冲突处理，不做无令牌的写入', async () => {
  const gateway = row({});
  const editor = fakeEditor([gateway]);
  const res = await call(apiWith(editor), 'POST', { next: 'native' });
  assert.equal(res.statusCode, 409);
  assert.equal(editor.edits.length, 0);
});

test('next 只接受 mcp 或 native，native-probe 不给界面开', async () => {
  const editor = fakeEditor([row({})]);
  for (const next of ['native-probe', '', 'nativ', 42]) {
    const res = await call(apiWith(editor), 'POST', { next, expected: 'mcp' });
    assert.equal(res.statusCode, 400, 'next=' + JSON.stringify(next) + ' 必须被拒绝');
    assert.equal(res.body.ok, false);
  }
  assert.equal(editor.edits.length, 0);
});

test('默认是 mcp 时改成 mcp 也算一次显式写入（不再依赖历史默认）', async () => {
  const gateway = row({ desktopMode: 'background' });
  const editor = fakeEditor([gateway]);
  const res = await call(apiWith(editor), 'POST', { next: 'mcp', expected: 'mcp' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.value.explicit, true);
  assert.deepEqual(gateway.options.config, { desktopMode: 'background', toolTransport: 'mcp' });
});

test('id 命中但 name 指向别的插件时拒绝，一个字段都不改', async () => {
  const foreign = row({ mode: 'full' }, { name: 'dsh-computer-use-win' });
  const editor = fakeEditor([foreign]);
  const view = await call(apiWith(editor), 'GET');
  assert.equal(view.statusCode, 200);
  assert.equal(view.body.value.available, false);
  assert.match(view.body.value.reason, /不是本插件的网关/);
  const res = await call(apiWith(editor), 'POST', { next: 'native', expected: 'mcp' });
  assert.equal(res.statusCode, 409);
  assert.equal(editor.edits.length, 0);
  assert.deepEqual(foreign.options.config, { mode: 'full' });
});

test('当前 profile 里没有网关那一行时明确说找不到，不就近改别的行', async () => {
  const editor = fakeEditor([{ options: { id: 'some-other-row', name: 'other', config: {} } }]);
  const res = await call(apiWith(editor), 'POST', { next: 'native', expected: 'mcp' });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /没有可编辑的/);
  assert.equal(editor.edits.length, 0);
});

test('没有 configEditor 服务时：GET 说明原因，POST 回 503，其它接口不受影响', async () => {
  const api = createSettingsApi({ dataDir: 'C:\\gateway-transport-test', getConfigEditor: () => undefined });
  const view = await call(api, 'GET');
  assert.equal(view.statusCode, 200);
  assert.equal(view.body.value.available, false);
  assert.match(view.body.value.reason, /configEditor/);
  const res = await call(api, 'POST', { next: 'native', expected: 'mcp' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
  // 同一套 api 仍要提供其它路由（不能因为缺 configEditor 就整体不可用）
  assert.ok(api.routes.some((item) => item.path === '/read'));
  assert.ok(api.routes.some((item) => item.path === '/multi-mouse'));
});

test('getter 抛错也算服务不可用，接口不往外抛', async () => {
  const api = createSettingsApi({
    dataDir: 'C:\\gateway-transport-test',
    getConfigEditor: () => { throw new Error('服务还没起来'); },
  });
  const view = await call(api, 'GET');
  assert.equal(view.statusCode, 200);
  assert.equal(view.body.value.available, false);
  assert.match(view.body.value.reason, /读取 configEditor 失败/);
});

test('宿主说这一行被更高优先级覆盖时回 409，配置保持原样', async () => {
  const gateway = row({ desktopMode: 'background' });
  const editor = fakeEditor([gateway], {
    editThrows: 'Configuration for "evolution-computer-use" is overridden by a home patch or command-line overlay',
  });
  const res = await call(apiWith(editor), 'POST', { next: 'native', expected: 'mcp' });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /覆盖/);
  assert.deepEqual(gateway.options.config, { desktopMode: 'background' });
});

test('写完复核没变就回 500，不把“写了但没生效”当成成功', async () => {
  const editor = fakeEditor([row({})], { discard: true });
  const res = await call(apiWith(editor), 'POST', { next: 'native', expected: 'mcp' });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.match(res.body.message, /没有改成/);
});

test('entries() 抛错时 GET 仍是安全的（available false），不会 500 炸整个设置页', async () => {
  const editor = fakeEditor([], { entriesThrows: true });
  const res = await call(apiWith(editor), 'GET');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.value.available, false);
  assert.match(res.body.value.reason, /读取可编辑配置失败/);
});

test('不认识的请求方法回 405', async () => {
  const res = await call(apiWith(fakeEditor([row({})])), 'DELETE');
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.ok, false);
});

test('当前是 native（显式）时如实回传，explicit 为 true', async () => {
  const editor = fakeEditor([row({ toolTransport: 'native' })]);
  const res = await call(apiWith(editor), 'GET');
  assert.equal(res.body.value.current, 'native');
  assert.equal(res.body.value.explicit, true);
  assert.equal(res.body.value.expected, 'native');
});

test('entries() 里有两行同名 id 时拒绝猜：GET available false，POST 409 且不写', async () => {
  const first = row({ desktopMode: 'background' });
  const second = row({ desktopMode: 'background' });
  const editor = fakeEditor([first, second]);
  const view = await call(apiWith(editor), 'GET');
  assert.equal(view.statusCode, 200);
  assert.equal(view.body.value.available, false);
  assert.match(view.body.value.reason, /无法确定改哪一行/);
  const res = await call(apiWith(editor), 'POST', { next: 'native', expected: 'mcp' });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(editor.edits, []);
  assert.deepEqual(first.options.config, { desktopMode: 'background' });
  assert.deepEqual(second.options.config, { desktopMode: 'background' });
});

test('不认识的传输值如实展示（native-probe / 手写值），并允许按它自己的 expected 改回 native', async () => {
  const probe = row({ desktopMode: 'background', toolTransport: 'native-probe' });
  const editor = fakeEditor([probe]);
  const view = await call(apiWith(editor), 'GET');
  assert.equal(view.body.value.available, true);
  assert.equal(view.body.value.current, 'native-probe');
  assert.equal(view.body.value.explicit, true);
  assert.equal(view.body.value.expected, 'native-probe');

  const weird = row({ toolTransport: 'weird' });
  const other = fakeEditor([weird]);
  const seen = await call(apiWith(other), 'GET');
  assert.equal(seen.body.value.current, 'weird');
  const res = await call(apiWith(other), 'POST', { next: 'native', expected: 'weird' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.value.current, 'native');
  assert.equal(weird.options.config.toolTransport, 'native');
});

test('expected 在 edit 回调里再查一次：读完之后被别人改成 native 就 409，不覆盖别人的值', async () => {
  const gateway = row({ desktopMode: 'background' });
  const editor = fakeEditor([gateway], { drift: 'native' });
  const res = await call(apiWith(editor), 'POST', { next: 'mcp', expected: 'mcp' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.conflict, true);
  assert.match(res.body.message, /请刷新后再改/);
  assert.equal(res.body.value.current, 'native');
  // 别人写的 native 保留，我们的 mcp 没落盘。
  assert.deepEqual(gateway.options.config, { desktopMode: 'background', toolTransport: 'native' });
});
