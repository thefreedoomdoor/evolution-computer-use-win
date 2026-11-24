import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computerTools, type ToolsDeps } from '../src/tools.ts';
import { createProcedureLibrary } from '../src/procedures/library.ts';
import type { MessageRecord } from '../src/procedures/messages.ts';
import type { ToolSpec } from '../src/tool.ts';
import type { Page } from '../src/browser/page.ts';

function setup(t: test.TestContext, options: { record?: () => Promise<never>; failRun?: Error; page?: object; extra?: Partial<ToolsDeps> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'computer-tools-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls: string[] = [];
  const page = {
    open: async (url: string) => { calls.push(`open ${url}`); }, read: async () => '页 · u\n[1] button 发送', brief: async () => '页 · u',
    click: async (target: unknown) => { calls.push(`click ${JSON.stringify(target)}`); }, type: async () => {}, press: async () => {}, scroll: async () => {},
    wait: async () => {}, has: async () => true, extract: async () => [{ uid: '42', id: 'm1', text: '你好' }], evaluate: async () => 2, shot: async () => Buffer.from('png'), bringToFront: async () => {},
    ...options.page,
  } as unknown as Page;
  let runs = 0;
  const browser = { run: <T>(work: (p: Page, signal: AbortSignal) => Promise<T>) => { runs++; return options.failRun ? Promise.reject(options.failRun) : work(page, new AbortController().signal); } };
  const library = createProcedureLibrary(dir);
  const recorded: MessageRecord[] = [];
  const messages = { record: async (records: MessageRecord[]) => { if (options.record) return options.record(); recorded.push(...records); return { written: records.length }; } };
  const tools = () => computerTools({ browser, library, messages, routines: async () => undefined, health: () => [], ...options.extra });
  const result = (list: ToolSpec[], name: string, args: object = {}) => list.find(tool => tool.name === name)!.execute(args as never, { signal: new AbortController().signal });
  const run = async (list: ToolSpec[], name: string, args: object = {}) => (await result(list, name, args)).text;
  return { calls, library, tools, run, result, recorded, runs: () => runs };
}

test('page tools act on its page and answer briefly; a page shot comes back as an image', async t => {
  const s = setup(t);
  const tools = s.tools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['computer_use', 'page_click', 'page_eval', 'page_open', 'page_press', 'page_read', 'page_scroll', 'page_shot', 'page_type', 'page_wait', 'procedure_note', 'procedure_routines', 'procedure_run', 'procedure_save']);
  assert.match(await s.run(tools, 'page_open', { url: 'https://www.bilibili.com/' }), /\[1\] button 发送/);
  assert.match(await s.run(tools, 'page_click', { ref: 1 }), /已点击 \[1\]/);
  assert.deepEqual(s.calls, ['open https://www.bilibili.com/', 'click {"ref":1}']);
  await assert.rejects(s.run(tools, 'page_scroll', { direction: 'left' }), /up 或 down/);
  const shot = await s.result(tools, 'page_shot');
  assert.deepEqual(shot.images?.map(image => [image.data.toString(), image.mediaType]), [['png', 'image/png']]);
});

test('every input schema says what is required and refuses what it does not know', async t => {
  const s = setup(t);
  const tools = s.tools();
  const open = tools.find(tool => tool.name === 'page_open')!;
  // reason 每一步都能给：这句话原样进审计，用户看得见 agent 的打算。
  assert.deepEqual(open.inputSchema, { type: 'object', properties: { url: { type: 'string' }, reason: { type: 'string', description: '为什么做这一步，写进审计记录' } }, required: ['url'], additionalProperties: false });
  await assert.rejects(s.run(tools, 'page_open', {}), /page_open 缺少参数 url/);
  await assert.rejects(s.run(tools, 'page_open', { url: 'https://a.com/', urll: 'x' }), /page_open 不认识参数 urll/);
  await assert.rejects(s.run(tools, 'page_click', { ref: '1' }), /page_click 的参数 ref 应该是 integer/);
  assert.match(await s.run(tools, 'page_read', { page: null }), /发送/, 'null stands for absent');
  assert.equal(s.runs(), 1);
});

test('a refused save explains itself, and asking without json gives the format', async t => {
  const s = setup(t);
  await assert.rejects(s.run(s.tools(), 'procedure_save', { json: '{"name":"a/b"}' }), /没有保存：name：/);
  assert.match(await s.run(s.tools(), 'procedure_save', {}), /^操作文件的格式：\n格式不对时保存会被拒绝/);
});

test('a bad number is refused before the browser is touched', async t => {
  const s = setup(t);
  const tools = s.tools();
  await assert.rejects(s.run(tools, 'page_click', { ref: 0 }), /编号/);
  await assert.rejects(s.run(tools, 'page_read', { page: 0 }), /page/);
  await assert.rejects(s.run(tools, 'page_read', { ref: -1 }), /编号/);
  await assert.rejects(s.run(tools, 'page_wait', { text: '' }), /text/);
  await assert.rejects(s.run(tools, 'page_wait', { text: 'x', seconds: 61 }), /seconds/);
  assert.equal(s.runs(), 0);
});

test('page_open refuses anything but web addresses before the browser is touched', async t => {
  const s = setup(t);
  for (const url of ['file:///C:/', 'javascript:alert(1)', 'data:text/html,x', 'edge://settings']) await assert.rejects(s.run(s.tools(), 'page_open', { url }), /只能打开 http 或 https 地址/);
  assert.equal(s.runs(), 0);
  assert.deepEqual(s.calls, []);
});

test('page_type says the box content is replaced', t => {
  assert.match(setup(t).tools().find(tool => tool.name === 'page_type')!.description, /替换/);
});

const dm = (extra: object = {}) => JSON.stringify({
  name: '读私信', category: 'bilibili', description: '读阿明的私信', params: { uid: { type: 'string', required: true } },
  steps: [{ open: 'https://message.bilibili.com/#/whisper/mid{{uid}}' }, { extract: { list: { css: '.msg' }, fields: { id: { css: '.msg', attr: 'data-id' }, text: { css: '.text' } } } }],
  messages: { channel: 'bilibili', accountId: 'me', conversationType: 'private', conversationId: '{{uid}}', messageId: '{{id}}', speakerId: '{{uid}}', content: '{{text}}' }, ...extra,
});

test('a saved operation is found with computer_use and run with procedure_run, without the model', async t => {
  const s = setup(t);
  assert.match(await s.run(s.tools(), 'procedure_save', { json: dm() }), /^已保存 bilibili\/读私信（第 1 版）/);
  assert.match(await s.run(s.tools(), 'procedure_note', { category: 'bilibili', text: '网站：bilibili.com（B站）' }), /^已写好 bilibili 的说明（第 1 版）/);
  assert.equal(s.tools().length, 14, 'saving never adds a tool');
  assert.match(await s.run(s.tools(), 'computer_use', { target: 'B站' }), /^bilibili\n网站：bilibili\.com（B站）\n操作：读私信\n/);
  assert.match(await s.run(s.tools(), 'computer_use', {}), /^现在能用：page_\*（专用浏览器）、procedure_\*（学会的操作）。\n学会的操作：bilibili（1 个）/, 'asked without a target, the modules come first');
  const out = await s.run(s.tools(), 'procedure_run', { path: 'bilibili/读私信', args: { uid: '42' } });
  assert.match(out, /"rows":\[\{"uid":"42","id":"m1","text":"你好"\}\]/);
  assert.match(out, /新记进消息记录 1 条/);
  assert.deepEqual(s.recorded.map(({ procedure, channel, conversationId, messageId, speakerId, content, outgoing }) => ({ procedure, channel, conversationId, messageId, speakerId, content, outgoing })),
    [{ procedure: 'bilibili/读私信', channel: 'bilibili', conversationId: '42', messageId: 'm1', speakerId: '42', content: '你好', outgoing: false }]);
  await assert.rejects(s.run(s.tools(), 'procedure_run', { path: 'bilibili/读私信', args: {} }), /缺少参数 uid/);
  await assert.rejects(s.run(s.tools(), 'procedure_run', { path: 'bilibili/没有' }), /没有 bilibili\/没有 这个操作/);
});

test('computer_use without a target says what is broken', async t => {
  const s = setup(t, { extra: { health: () => ['专用浏览器没能打开：x'] } });
  assert.match(await s.run(s.tools(), 'computer_use', {}), /现在有问题的：\n- 专用浏览器没能打开：x$/);
});

test('a failing message write is told after the result, never in its place', async t => {
  const s = setup(t, { record: async () => { throw new Error('磁盘满了'); } });
  s.library.save(dm());
  const out = await s.run(s.tools(), 'procedure_run', { path: 'bilibili/读私信', args: { uid: '42' } });
  assert.match(out, /"rows":\[/);
  assert.match(out, /（没能记进消息记录：磁盘满了）/);
});

test('without a message sink the rows are only returned', async t => {
  const s = setup(t, { extra: { messages: undefined } as Partial<ToolsDeps> });
  s.library.save(dm());
  const out = await s.run(s.tools(), 'procedure_run', { path: 'bilibili/读私信', args: { uid: '42' } });
  assert.equal(out, '{"rows":[{"uid":"42","id":"m1","text":"你好"}]}');
});

test('a run that is cut off is noted as failed before the error goes on', async t => {
  const s = setup(t, { failRun: new Error('操作等得太久') });
  s.library.save(dm());
  await assert.rejects(s.run(s.tools(), 'procedure_run', { path: 'bilibili/读私信', args: { uid: '1' } }), /操作等得太久/);
  assert.match(s.library.lastRun('bilibili/读私信')?.detail ?? '', /操作等得太久/);
});

test('a broken newest version falls back to a kept one, and the agent is told its newest failed', async t => {
  const s = setup(t, { page: { extract: async (spec: { list: { css: string } }) => spec.list.css === '.new' ? [] : [{ uid: '42', id: 'm1', text: '你好' }] } });
  const version = (css: string) => JSON.stringify({ name: '读私信', category: 'bilibili', description: '读私信', params: {}, steps: [{ open: 'https://example.com/' }, { extract: { list: { css }, fields: { id: { css, attr: 'data-id' } } } }] });
  s.library.save(version('.msg'));
  s.library.save(version('.new'));
  const out = await s.run(s.tools(), 'procedure_run', { path: 'bilibili/读私信' });
  assert.match(out, /^\{"rows":\[\{"uid":"42","id":"m1","text":"你好"\}\]\}\n（最新版第 2 步（提取 选择器 \.new）没跑通：一条都没有提取到.*这次退回第 1 版跑通了。/);
});

test('procedure_routines runs the routine, or says there is none', async t => {
  assert.match(await setup(t).run(setup(t).tools(), 'procedure_routines'), /^没有例行操作/);
  const s = setup(t, { extra: { routines: async () => 'bilibili/看未读：私信 2' } });
  assert.equal(await s.run(s.tools(), 'procedure_routines'), 'bilibili/看未读：私信 2');
});

test('the desktop tool is there only when its switch is on; its screenshot comes back with a caption', async t => {
  const s = setup(t);
  assert.equal(s.tools().some(tool => tool.name === 'desktop'), false);
  const desktop = { act: async (input: { action: string }) => input.action === 'shot' ? { text: '微信 的截图附在结果里', image: { data: Buffer.from('png'), mediaType: 'image/png' as const } } : { text: '已按 tab。' } };
  const on = setup(t, { extra: { desktop } });
  const shot = await on.result(on.tools(), 'desktop', { action: 'shot' });
  assert.equal(shot.text, '微信 的截图附在结果里');
  assert.deepEqual(shot.images?.map(image => image.caption), ['这是用户电脑上当前窗口的截图。']);
  assert.deepEqual(await on.result(on.tools(), 'desktop', { action: 'press', key: 'tab' }), { text: '已按 tab。' });
  assert.match(on.tools().find(tool => tool.name === 'desktop')!.description, /后台模式/);
  const front = setup(t, { extra: { desktop, screen: desktop } });
  assert.match(front.tools().find(tool => tool.name === 'desktop')!.description, /前台模式/);
});

test('inbox_read is there only with the inbox, and empties it', async t => {
  assert.equal(setup(t).tools().some(tool => tool.name === 'inbox_read'), false);
  const words = ['外面有动静'];
  const s = setup(t, { extra: { inbox: () => words.splice(0).join('\n') || undefined } });
  assert.equal(await s.run(s.tools(), 'inbox_read'), '外面有动静');
  assert.equal(await s.run(s.tools(), 'inbox_read'), '信箱里没有新的动静。');
  assert.match(await s.run(s.tools(), 'computer_use'), /inbox_read（信箱）/);
});
