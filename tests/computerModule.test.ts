import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Faults } from '../src/shared/faults.ts';
import { createComputerUse, type ComputerUseOptions } from '../src/index.ts';
import type { Page } from '../src/browser/page.ts';
import { UncertainError } from '../src/desktop/arbiter.ts';

// Everything below runs on fakes; the in-process gate keeps a step and the stop that meets it lined up
// deterministically without the shared broker. The poison and cancel paths exercised here are the same code either way.
process.env.EVOLUTION_CU_ARBITER = 'inproc';

const browser = () => ({ run: async () => '', scratch: async () => '', show: async () => {}, status: () => ({ state: 'stopped' as const, binary: 'msedge.exe' }), stop() {} });
function setup(t: test.TestContext, options: Partial<ComputerUseOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'computer-module-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const computer = createComputerUse({ dataDir, browser: browser() as never, ...options });
  t.after(async () => computer.stop());
  return { dataDir, computer };
}
const names = (computer: ReturnType<typeof createComputerUse>) => computer.tools().map(tool => tool.name);

test('the plugin offers its tools, keeps its tool list as the agent learns, and reports its state', async t => {
  const { dataDir, computer } = setup(t);
  const before = computer.tools();
  assert.ok(names(computer).includes('computer_use'));
  assert.equal(await computer.routines(), undefined);
  await computer.call('procedure_save', { json: JSON.stringify({ name: '看看', category: 'web', description: '看看', params: {}, steps: [{ open: 'https://example.com/' }] }) });
  assert.equal(computer.tools(), before, 'learning something new does not change the tool list');
  assert.deepEqual(computer.status(), {
    browser: { state: 'stopped', binary: 'msedge.exe' }, dir: join(dataDir, 'procedures'),
    categories: [{ name: 'web', guide: false, operations: [{ name: '看看', description: '看看', onAlarm: false, last: null }] }],
    desktop: null, inbox: null, faults: [],
  });
  await assert.rejects(computer.call('nothing', {}), /没有 nothing 这个工具/);
  await assert.rejects(computer.call('desktop', { action: 'shot' }), /桌面控制没有打开/);
});

test('procedures and the browser profile can live elsewhere, so agents share what they learned', async t => {
  const shared = mkdtempSync(join(tmpdir(), 'computer-shared-')); t.after(() => rmSync(shared, { recursive: true, force: true }));
  const one = setup(t, { proceduresDir: shared }).computer, two = setup(t, { proceduresDir: shared }).computer;
  await one.call('procedure_save', { json: JSON.stringify({ name: '看看', category: 'web', description: '看看', params: {}, steps: [{ open: 'https://example.com/' }] }) });
  assert.match((await two.call('computer_use', { target: 'web' })).text, /操作：看看/);
});

test('what a procedure reads is filed once in messages.jsonl, unless filing is off', async t => {
  const page = { open: async () => {}, extract: async () => [{ id: 'm1', text: '你好' }], brief: async () => '' } as unknown as Page;
  const reading = { ...browser(), run: <T>(work: (p: Page, signal: AbortSignal) => Promise<T>) => work(page, new AbortController().signal) };
  const json = JSON.stringify({ name: '读', category: 'web', description: '读', params: {}, steps: [{ open: 'https://example.com/' }, { extract: { list: { css: '.m' }, fields: { id: { attr: 'data-id' }, text: { css: '.t' } } } }],
    messages: { channel: 'web', accountId: 'me', conversationType: 'private', conversationId: 'c', messageId: '{{id}}', speakerId: 'u', content: '{{text}}' } });
  const { dataDir, computer } = setup(t, { browser: reading as never });
  await computer.call('procedure_save', { json });
  assert.match((await computer.call('procedure_run', { path: 'web/读' })).text, /新记进消息记录 1 条/);
  assert.match((await computer.call('procedure_run', { path: 'web/读' })).text, /新记进消息记录 0 条/, 'reading it again files nothing new');
  const lines = readFileSync(join(dataDir, 'messages.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(lines.map(line => (JSON.parse(line) as { content: string }).content), ['你好']);
  const off = setup(t, { browser: reading as never, messages: false }).computer;
  await off.call('procedure_save', { json });
  assert.equal((await off.call('procedure_run', { path: 'web/读' })).text, '{"rows":[{"id":"m1","text":"你好"}]}');
});

test('stopping clears the browser fault and the faults of broken procedure files', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'computer-module-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, 'procedures'));
  writeFileSync(join(dataDir, 'procedures', 'broken.json'), '{not json');
  const faults = new Faults();
  const computer = createComputerUse({ dataDir, faults, browser: browser() as never });
  computer.status();
  faults.set('computer', '专用浏览器没能打开：x');
  assert.ok(faults.list().some(line => line.includes('broken.json')));
  assert.match((await computer.call('computer_use', {})).text, /现在有问题的：[\s\S]*broken\.json/);
  await computer.stop();
  assert.deepEqual(faults.list(), []);
});

test('the desktop switch adds and removes the desktop tool and tells the host; on another system it is a fault, not a tool', async t => {
  let stopped = 0, changed = 0;
  const driver = { call: async () => ({}), running: () => false, stop: () => { stopped++; } };
  const faults = new Faults();
  const { computer } = setup(t, { faults, platform: 'win32', desktopDriver: () => driver, inbox: false, onToolsChanged: () => { changed++; } });
  assert.equal(names(computer).includes('desktop'), false, 'off by default');
  assert.equal(await computer.setDesktop(true), undefined);
  assert.equal(changed, 1);
  assert.equal(names(computer).filter(name => name === 'desktop').length, 1);
  assert.deepEqual(computer.status().desktop, { running: false, mode: 'background', foreground: false, halted: false, recent: [] });
  await computer.setDesktop(true);
  assert.equal(changed, 1, 'turning on what is on changes nothing');
  await computer.setDesktop(false);
  assert.deepEqual([stopped, changed], [1, 2]);
  assert.equal(computer.status().desktop, null);
  const elsewhere = setup(t, { faults, platform: 'linux' }).computer;
  assert.equal(await elsewhere.setDesktop(true), '桌面控制目前只支持 Windows');
  assert.equal(names(elsewhere).includes('desktop'), false);
  assert.deepEqual(faults.list(), ['桌面控制目前只支持 Windows']);
  await elsewhere.stop();
  assert.deepEqual(faults.list(), []);
});

test('the inbox goes on and off with desktop control, with a helper of its own; what it gathers waits for the agent', async t => {
  const calls: string[] = [];
  let helpers = 0, stopped = 0, flashes = [{ app: '钉钉', exe: 'DingTalk', at: new Date().toISOString() }];
  const helper = { call: async (op: string) => { calls.push(op); if (op === 'flashes') { const out = { flashes }; flashes = []; return out; } return { notifications: [] }; }, running: () => false, stop: () => { stopped++; } };
  const { computer } = setup(t, { platform: 'win32', desktopDriver: () => ({ call: async () => ({}), running: () => false, stop() {} }),
    inbox: { timeZone: 'Asia/Shanghai', pollMs: 10 }, inboxHelper: () => { helpers++; return helper; } });
  assert.equal(computer.status().inbox, null, 'desktop control is off: nothing is watched');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual([helpers, calls.length], [0, 0]);
  await computer.setDesktop(true);
  assert.ok(names(computer).includes('inbox_read'));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual([calls.includes('notifications'), calls.includes('flashes')], [true, true]);
  await computer.setDesktop(false);
  assert.deepEqual([computer.status().inbox, stopped], [null, 1], 'turning desktop control off stops the inbox and its helper');
  assert.equal(names(computer).includes('inbox_read'), false);
});

test('inbox words wait in the mailbox: the next result carries a one-line hint, inbox_read the words', async t => {
  const helper = (posted: unknown[]) => ({ call: async (op: string) => op === 'flashes' ? { flashes: posted.splice(0) } : { notifications: [] }, running: () => false, stop() {} });
  const flashes = [{ app: '钉钉', exe: 'DingTalk', at: new Date().toISOString() }];
  const { computer } = setup(t, { platform: 'win32', desktopDriver: () => ({ call: async () => ({}), running: () => false, stop() {} }),
    inbox: { timeZone: 'Asia/Shanghai', pollMs: 5, quietMs: 20 }, inboxHelper: () => helper(flashes) });
  await computer.setDesktop(true);
  for (let tries = 0; tries < 100 && !computer.status().inbox?.unread; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(computer.status().inbox?.unread, 1);
  const first = await computer.call('computer_use', { target: 'x' });
  assert.match(first.text, /（信箱有新动静，手头的事做完了用 inbox_read 看。）$/);
  assert.doesNotMatch(first.text, /钉钉/, 'the words themselves wait until the agent reads them');
  assert.doesNotMatch((await computer.call('computer_use', { target: 'x' })).text, /信箱有新动静/, 'hinted once');
  const read = await computer.call('inbox_read', {});
  assert.match(read.text, /^外面有动静（任务栏上看到的）[\s\S]*- 钉钉：任务栏在闪/);
  assert.equal((await computer.call('inbox_read', {})).text, '信箱里没有新的动静。');
});

test('a stop pressed between steps reaches the agent with its next result; release lets it act again', async t => {
  let events!: (name: string) => void, halts = 0;
  const driver = { call: async (op: string) => op === 'windows' ? { windows: [] } : {}, running: () => true, stop() {} };
  const { computer } = setup(t, { platform: 'win32', inbox: false, desktopDriver: on => { events = on; return driver; }, onHalt: () => { halts++; } });
  await computer.setDesktop(true);
  events('stop');
  assert.deepEqual([computer.halted(), halts], [true, 1]);
  const next = await computer.call('computer_use', {});
  assert.match(next.text, /（用户刚才按了停下：在用户解除之前，不能再操作用户的电脑。先问问用户。）$/);
  assert.doesNotMatch((await computer.call('computer_use', {})).text, /按了停下/, 'said once');
  await assert.rejects(computer.call('desktop', { action: 'open' }), /用户按了停下/);
  computer.release();
  assert.equal(computer.halted(), false);
  assert.match((await computer.call('desktop', { action: 'open' })).text, /开着的窗口/);
});

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('a stop refuses new input before it waits for the browser, and puts the helper away only after', async t => {
  let finishBrowser: () => void = () => {};
  const browserHeld = new Promise<void>(resolve => { finishBrowser = resolve; });
  const calls: string[] = [];
  let stopCalls = 0;
  const driver = { call: async (op: string) => { calls.push(op); return op === 'windows' ? { windows: [], foreground: 0 } : {}; }, running: () => true, stop: () => { stopCalls += 1; } };
  const faults = new Faults();
  const { computer } = setup(t, { platform: 'win32', faults, inbox: false, desktopDriver: () => driver as never,
    browser: { ...browser(), stop: () => browserHeld } as never });
  await computer.setDesktop(true);
  faults.set('computer', '专用浏览器没能打开：崩过一次');
  const stopping = computer.stop();
  await assert.rejects(computer.call('desktop', { action: 'open', path: 'C:\\Windows\\notepad.exe' }), /正在关闭/, 'a step that arrives after the stop never starts');
  assert.deepEqual(calls, [], 'the step never reached the helper');
  assert.equal(stopCalls, 0, 'the desktop helper is put away only after the browser has finished');
  finishBrowser();
  await stopping;
  assert.equal(stopCalls, 1);
  assert.deepEqual(faults.list(), []);
});

test('a stop cancels the step in flight and never lets a waiting step open anything', async t => {
  let finishLaunch: () => void = () => {};
  const launchHeld = new Promise<void>(resolve => { finishLaunch = resolve; });
  let finishBrowser: () => void = () => {};
  const browserHeld = new Promise<void>(resolve => { finishBrowser = resolve; });
  let finishHelper: () => void = () => {};
  const helperHeld = new Promise<void>(resolve => { finishHelper = resolve; });
  let launched = false;
  const calls: string[] = [];
  let stopCalls = 0;
  const driver = {
    call: async (op: string) => {
      calls.push(op);
      if (op === 'windows') return launched ? { windows: [{ hwnd: 7, pid: 9, title: '新窗口', minimized: false }], foreground: 0 } : { windows: [], foreground: 0 };
      if (op === 'launch') { await launchHeld; launched = true; return { launched: 7 }; }
      if (op === 'shot') return { print: 'P', path: 'C:\\p.png', width: 10, height: 10 };
      return {};
    },
    running: () => true,
    stop: () => { stopCalls += 1; return helperHeld; },
  };
  const { computer } = setup(t, { platform: 'win32', inbox: false, desktopDriver: () => driver as never,
    browser: { ...browser(), stop: () => browserHeld } as never });
  await computer.setDesktop(true);
  const first = computer.call('desktop', { action: 'open', path: 'C:\\a.exe' }).catch(error => error);
  const second = computer.call('desktop', { action: 'open', path: 'C:\\b.exe' }).catch(error => error);
  for (let i = 0; i < 50 && calls.length < 2; i++) await tick();
  assert.deepEqual(calls.slice(0, 2), ['windows', 'launch'], 'the first step is in the helper when the stop arrives');
  const stopping = computer.stop();
  finishLaunch();
  const after: unknown = await second;
  if (!(after instanceof Error)) assert.fail('the step that was only waiting should have failed, not run');
  assert.match(after.message, /正在关闭/, 'the waiting step never started');
  assert.equal(calls.filter(op => op === 'launch').length, 1, 'nothing was opened for the waiting step');
  assert.equal(stopCalls, 0, 'nothing was put away while the browser was still stopping');
  finishBrowser();
  for (let i = 0; i < 50 && stopCalls < 1; i++) await tick();
  assert.equal(stopCalls, 1, 'the desktop helper is stopped once the browser is done');
  finishHelper();
  await stopping;
  void first;
});

test('a stop keeps the reason an earlier uncertain step gave instead of saying it is merely closing', async t => {
  let finishBrowser: () => void = () => {};
  const browserHeld = new Promise<void>(resolve => { finishBrowser = resolve; });
  let stopCalls = 0;
  const driver = { call: async () => { throw new UncertainError('上一笔点按结果不明（哨兵）'); }, running: () => true, stop: () => { stopCalls += 1; } };
  const { computer } = setup(t, { platform: 'win32', inbox: false, desktopDriver: () => driver as never,
    browser: { ...browser(), stop: () => browserHeld } as never });
  await computer.setDesktop(true);
  await assert.rejects(computer.call('desktop', { action: 'open', path: 'C:\\x.exe' }), /哨兵/);
  const stopping = computer.stop();
  const again: unknown = await computer.call('desktop', { action: 'open', path: 'C:\\y.exe' }).catch(error => error);
  if (!(again instanceof Error)) assert.fail('the step after the stop should have failed');
  assert.match(again.message, /哨兵/, 'the earlier, more specific reason is kept');
  assert.doesNotMatch(again.message, /正在关闭/);
  finishBrowser();
  await stopping;
  assert.equal(stopCalls, 1);
});
