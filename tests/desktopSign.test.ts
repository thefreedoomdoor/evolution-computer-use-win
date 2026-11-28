import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createDesktop, STOPPED } from '../src/desktop/desktop.ts';
import { DEFAULT_APPEARANCE, forgetAppearance } from '../src/appearance.ts';
import { createComputerUse } from '../src/index.ts';

// 真机上的仲裁走跨进程 broker；这些假助手单测只要一个进程内的本地闸门，也不会拉起任何子进程。
process.env.EVOLUTION_CU_ARBITER = 'inproc';

type Args = Record<string, unknown>;
const WECHAT = { hwnd: 67996, owner: 0, pid: 14568, exe: 'Weixin', title: '微信', minimized: false, width: 1750, height: 1400 };

/** 横幅的字和样式来自 appearance.json：指到一个空文件，测试只看默认值。 */
const settings = mkdtempSync(join(tmpdir(), 'computer-sign-appearance-'));
process.env.EVOCU_APPEARANCE_FILE = join(settings, 'appearance.json');
forgetAppearance();
test.after(() => { rmSync(settings, { recursive: true, force: true }); delete process.env.EVOCU_APPEARANCE_FILE; forgetAppearance(); });

/** The helper: every call is kept; a click can be held open, so the partner can press stop while it is under way. */
function helper(options: { signFails?: boolean } = {}) {
  const calls: [string, Args][] = [];
  let release: (() => void) | undefined, picture = 0;
  const call = async (op: string, args: Args = {}) => {
    calls.push([op, args]);
    if (op === 'windows') return { windows: [WECHAT], foreground: 1 };
    if (op === 'sign' && options.signFails) throw new Error('the sign could not be drawn');
    if (op === 'click' && args.hold) await new Promise<void>(resolve => { release = resolve; });
    if (op === 'sheet') { writeFileSync(String(args.file), 'sheet'); return { width: 1, height: 1 }; }
    if (op === 'shot') { writeFileSync(String(args.file), 'png'); picture += 9; return { width: 1280, height: 1024, clientWidth: 1600, clientHeight: 1280, print: (picture % 250).toString(16).padStart(2, '0').repeat(256) }; }
    return {};
  };
  return { calls, call, signs: () => calls.filter(([op]) => op === 'sign').map(([, args]) => args), keys: () => calls.filter(([op]) => op === 'key').length, letGo: () => release?.() };
}
function setup(options: { signFails?: boolean; secondMs?: number } = {}) {
  const h = helper(options), faults: (string | undefined)[] = [];
  let holdNext = false;
  const driver = { call: (op: string, args: Args = {}) => h.call(op, op === 'click' && holdNext ? { ...args, hold: (holdNext = false, true) } : args) };
  const desktop = createDesktop({ driver, running: async () => false, settleMs: 0, appearMs: 50, secondMs: options.secondMs ?? 2, lingerMs: 30, companion: () => '鲸鲸', signFault: text => faults.push(text) });
  return { ...h, desktop, faults, hold: () => { holdNext = true; } };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('while she acts the partner sees the program\'s own words over the window she is on, gone a moment after she stops', async () => {
  const s = setup();
  await s.desktop.act({ action: 'open', app: '一个她随便写的名字 微信' }).catch(() => {});
  await s.desktop.act({ action: 'open', app: '微信' });
  await s.desktop.act({ action: 'click', x: 10, y: 10 });
  const shown = s.signs().filter(args => args.show);
  assert.ok(shown.length >= 2);
  for (const args of shown) {
    assert.equal(args.show, true);
    assert.equal(args.hwnd, WECHAT.hwnd);
    assert.equal(args.text, 'DSH正在操作微信', 'her words never reach the banner: the banner names the program');
    assert.equal(args.hint, DEFAULT_APPEARANCE.banner.hint);
    assert.equal(args.stop, DEFAULT_APPEARANCE.banner.stop);
    assert.equal(args.stopped, DEFAULT_APPEARANCE.banner.stopped);
    // 整份横幅样式原样交给 PowerShell 助手去画。
    assert.equal((args.style as typeof DEFAULT_APPEARANCE.banner).text, DEFAULT_APPEARANCE.banner.text);
  }
  await pause(60);
  assert.deepEqual(s.signs().at(-1), { show: false });
  const before = s.signs().length;
  await s.desktop.act({ action: 'record', seconds: 3 });
  await s.desktop.act({ action: 'review' });
  assert.ok(s.signs().slice(before).every(args => args.show), 'looking at what was recorded is not acting');
});

test('a banner that cannot be drawn is a fault for the console, never a failed action of hers', async () => {
  const s = setup({ signFails: true });
  await s.desktop.act({ action: 'open', app: '微信' });
  assert.equal((await s.desktop.act({ action: 'shot' })).image?.mediaType, 'image/png');
  assert.match(String(s.faults.at(-1)), /^操作提示没能显示：the sign could not be drawn$/);
});

test('the partner\'s stop cuts off the step under way and every later one until they speak to her; what was recorded can still be looked at', async () => {
  const s = setup();
  await s.desktop.act({ action: 'open', app: '微信' });
  await s.desktop.act({ action: 'record', seconds: 2 });
  s.hold();
  const step = s.desktop.act({ action: 'click', x: 10, y: 10 });
  await pause(10);
  assert.deepEqual(s.desktop.halt(), { cut: true, recording: false });
  s.letGo();
  await assert.rejects(step, new Error(STOPPED));
  await assert.rejects(s.desktop.act({ action: 'shot' }), new Error(STOPPED));
  await assert.rejects(s.desktop.act({ action: 'open', app: '微信' }), new Error(STOPPED));
  assert.match((await s.desktop.act({ action: 'review' })).text, /录了 2s/);
  s.desktop.release();
  assert.equal((await s.desktop.act({ action: 'shot' })).image?.mediaType, 'image/png');
});

test('a recording the partner stops ends there, and nothing more is sent to the window, not even the pause', async () => {
  // Long enough (a minute of fake seconds) that a busy machine cannot let it end before the stop.
  const s = setup({ secondMs: 200 });
  await s.desktop.act({ action: 'open', app: '微信' });
  await s.desktop.act({ action: 'record', seconds: 300 });
  await pause(20);
  assert.deepEqual(s.desktop.halt(), { cut: false, recording: true });
  await pause(30);
  assert.equal(s.keys(), 0, 'no space bar after the partner said stop');
  assert.match((await s.desktop.act({ action: 'review' })).text, /录了 \d+s、\d+ 帧/);
});

test('the plugin tells the agent of a stop that cut off no step, and lets it go on once the user releases it', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'computer-sign-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const browser = { run: async () => '', scratch: async () => '', show: async () => {}, status: () => ({ state: 'stopped' as const, binary: null }), stop() {} };
  const h = helper();
  let events: ((name: string) => void) | undefined, halts = 0;
  const computer = createComputerUse({ dataDir, browser: browser as never, platform: 'win32', inbox: false, name: '鲸鲸', onHalt: () => { halts++; },
    desktopDriver: listen => { events = listen; return { call: h.call, running: () => false, stop() {} }; } });
  await computer.setDesktop(true);
  const act = (input: object) => computer.call('desktop', input);
  await act({ action: 'open', app: '微信' });
  events!('stop');
  assert.equal(halts, 1);
  // The step that hears of it is refused, and carries the word about the stop after its reason.
  await assert.rejects(act({ action: 'shot' }), (error: Error) => error.message.startsWith(STOPPED) && error.message.endsWith('（用户刚才按了停下：在用户解除之前，不能再操作用户的电脑。先问问用户。）'));
  await assert.rejects(act({ action: 'shot' }), new Error(STOPPED), 'the word is said once');
  computer.release();
  assert.match((await act({ action: 'shot' })).text, /截图/);
  events!('something else');
  assert.equal(halts, 1);
  await computer.stop();
});

// The sign is its own Add-Type unit: it cannot name Desk's Aborting field. Production binds Sign.Abort to a compiled
// static method, and Halt calls that delegate synchronously before any drawing. This compiles the two real production
// blocks with Windows PowerShell 5.1, binds them the same way, and proves the stop flag is set without a script-block
// delegate or a PowerShell runspace. The fixture opens no window, synthesizes no input, and touches no marker/profile.
test('the sign compiles on its own and its Halt stops the desktop through the bound CLR delegate', {
  skip: process.platform !== 'win32' && 'requires Windows PowerShell to compile the helper',
}, () => {
  const source = fileURLToPath(new URL('../src/desktop/win32.ps1', import.meta.url));
  const fixture = fileURLToPath(new URL('./fixtures/desktop-sign-compile.ps1', import.meta.url));
  const root = process.env.SystemRoot;
  assert.ok(root, 'Windows SystemRoot is needed to locate PowerShell');
  const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fixture, '-Source', source,
  ], { windowsHide: true, encoding: 'utf8', timeout: 120_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'offline sign assertions failed\n' + (result.stdout ?? '') + (result.stderr ?? ''));
  assert.equal((result.stdout ?? '').trim(), 'DESKTOP_SIGN_COMPILE_OK 5');
});
