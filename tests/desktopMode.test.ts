// The three states the user's computer can be in, and the switch between them, without ever starting a real helper.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createComputerUse, type ComputerUseOptions } from '../src/index.ts';

const browser = () => ({
  run: async () => '', scratch: async () => '', show: async () => {},
  status: () => ({ state: 'stopped' as const, binary: 'msedge.exe' }), stop() {},
});

interface Counters { created: { background: number; foreground: number }; started: number; stopped: { background: number; foreground: number } }

/** A plugin whose helpers are counters: what got created, started and stopped, and how often the host was told. */
function harness(t: test.TestContext, options: { refuseForeground?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'computer-mode-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const counters: Counters = { created: { background: 0, foreground: 0 }, started: 0, stopped: { background: 0, foreground: 0 } };
  let changes = 0;
  const computer = createComputerUse({
    dataDir, browser: browser() as never, platform: 'win32', inbox: false, onToolsChanged: () => { changes++; },
    desktopDriver: () => {
      counters.created.background++;
      return { call: async () => ({}), running: () => true, stop: () => { counters.stopped.background++; } };
    },
    foregroundDriver: () => {
      counters.created.foreground++;
      return {
        call: async () => ({}), running: () => true, stop: () => { counters.stopped.foreground++; },
        start: async () => { counters.started++; if (options.refuseForeground) throw new Error(options.refuseForeground); },
      };
    },
  });
  t.after(() => computer.stop());
  return { computer, counters, changes: () => changes };
}

const tool = (computer: ReturnType<typeof createComputerUse>, name: string) => computer.tools().find(entry => entry.name === name);

test('off is where it starts: no helper, the switch offered, nothing to act with', async t => {
  const { computer, counters } = harness(t);
  assert.equal(computer.desktopMode(), 'off');
  assert.equal(computer.status().desktop, null);
  assert.ok(tool(computer, 'desktop_mode'), 'the switch itself is there even while the kitchen is closed');
  assert.equal(tool(computer, 'desktop'), undefined);
  assert.deepEqual(counters.created, { background: 0, foreground: 0 });
  assert.equal(counters.started, 0);
  await assert.rejects(computer.call('desktop', { action: 'shot' }), /桌面控制没有打开/);
});

test('background creates the window helper alone, and saying it twice creates nothing new', async t => {
  const { computer, counters, changes } = harness(t);
  assert.equal(await computer.setDesktopMode('background'), undefined);
  assert.equal(computer.desktopMode(), 'background');
  assert.equal(computer.foregroundOn(), false);
  assert.deepEqual(counters.created, { background: 1, foreground: 0 });
  assert.equal(counters.started, 0);
  assert.match(tool(computer, 'desktop')!.description, /后台模式/);
  const desktopParams = tool(computer, 'desktop')!.inputSchema.properties;
  assert.ok('url' in desktopParams, 'open 可以带 url 打开网页');
  assert.equal(computer.status().desktop?.mode, 'background');
  assert.equal(changes(), 1);
  assert.equal(await computer.setDesktopMode('background'), undefined);
  assert.deepEqual(counters.created, { background: 1, foreground: 0 });
  assert.equal(changes(), 1, 'nothing changed, so the host is not told to list again');
});

test('foreground keeps the window helper, starts the elevated one, and says so in the tool', async t => {
  const { computer, counters } = harness(t);
  await assert.doesNotReject(computer.setDesktopMode('background'));
  assert.equal(await computer.setDesktopMode('foreground'), undefined);
  assert.equal(computer.desktopMode(), 'foreground');
  assert.equal(computer.foregroundOn(), true);
  assert.deepEqual(counters.created, { background: 1, foreground: 1 });
  assert.equal(counters.started, 1);
  assert.equal(counters.stopped.foreground, 0);
  assert.match(tool(computer, 'desktop')!.description, /前台模式/);
  assert.equal(computer.status().desktop?.mode, 'foreground');
});

test('back to background stops the elevated helper and changes nothing else', async t => {
  const { computer, counters } = harness(t);
  await computer.setDesktopMode('foreground');
  assert.equal(await computer.setDesktopMode('background'), undefined);
  assert.equal(computer.desktopMode(), 'background');
  assert.equal(counters.stopped.foreground, 1);
  assert.equal(counters.stopped.background, 0, 'the window helper stays up');
  assert.deepEqual(counters.created, { background: 1, foreground: 1 });
  assert.equal(counters.started, 1);
  assert.match(tool(computer, 'desktop')!.description, /后台模式/);
});

test('off stops both helpers, hides the acting tool, and still offers the switch', async t => {
  const { computer, counters } = harness(t);
  await computer.setDesktopMode('foreground');
  assert.equal(await computer.setDesktopMode('off'), undefined);
  assert.equal(computer.desktopMode(), 'off');
  assert.equal(computer.status().desktop, null);
  assert.deepEqual(counters.stopped, { background: 1, foreground: 1 });
  assert.ok(tool(computer, 'desktop_mode'));
  assert.equal(tool(computer, 'desktop'), undefined);
});

test('a refused UAC prompt leaves the window helper in place and says why', async t => {
  const { computer, counters } = harness(t, { refuseForeground: '用户拒绝了管理员权限' });
  await computer.setDesktopMode('background');
  assert.equal(await computer.setDesktopMode('foreground'), '用户拒绝了管理员权限');
  assert.equal(computer.desktopMode(), 'background');
  assert.equal(computer.foregroundOn(), false);
  assert.equal(counters.stopped.foreground, 1, 'the helper that failed to start is not left running');
  assert.match(tool(computer, 'desktop')!.description, /后台模式/);
  assert.ok(computer.status().faults.some(line => line.includes('用户拒绝了管理员权限')), 'the refusal is visible as a fault');
});

test('through the tool, foreground needs the user: no confirm, no UAC prompt', async t => {
  const { computer, counters } = harness(t);
  await computer.setDesktopMode('background');
  const blocked = await computer.call('desktop_mode', { mode: 'foreground' });
  assert.match(blocked.text, /还没有切换/);
  assert.equal(computer.desktopMode(), 'background');
  assert.equal(counters.created.foreground, 0, 'asking the user costs no UAC prompt');
  const done = await computer.call('desktop_mode', { mode: 'foreground', confirm: true });
  assert.match(done.text, /已切换到前台模式/);
  assert.equal(computer.desktopMode(), 'foreground');
  assert.equal(counters.created.foreground, 1);
  const off = await computer.call('desktop_mode', { mode: 'off' });
  assert.match(off.text, /已关闭桌面控制/);
  assert.equal(computer.desktopMode(), 'off');
});

test('through the tool, an unknown mode is refused and changes nothing', async t => {
  const { computer } = harness(t);
  await computer.setDesktopMode('background');
  await assert.rejects(computer.call('desktop_mode', { mode: 'screen' }), /mode 只能是 off、background、foreground/);
  assert.equal(computer.desktopMode(), 'background');
});