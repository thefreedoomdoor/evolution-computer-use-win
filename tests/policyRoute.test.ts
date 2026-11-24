// Per-app policies choose the mode of one step: a foreground policy borrows the administrator helper, a background
// policy stays with the window helper, a refused UAC prompt fails that step, and the user's global switch never moves.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createComputerUse } from '../src/index.ts';
import { forgetPolicies, matchAppPolicy, parsePolicies, policyMode } from '../src/policies.ts';

const WINDOW = { hwnd: 67996, pid: 14568, exe: 'Weixin', title: '微信', minimized: false, width: 1750, height: 1400 };
const NOTE = { hwnd: 500, pid: 9, exe: 'notepad', title: '记事本', minimized: false, width: 1200, height: 800 };

const browser = () => ({
  run: async () => '', scratch: async () => '', show: async () => {},
  status: () => ({ state: 'stopped' as const, binary: 'msedge.exe' }), stop() {},
});

/** The Windows helper: just enough of its answers for opening a window and taking a picture. */
function helper(log: string[], counters?: { started: number; stopped: number }, refuse?: string) {
  return {
    call: async (op: string, args: Record<string, unknown> = {}) => {
      log.push(op);
      switch (op) {
        case 'windows': return { windows: [WINDOW, NOTE], foreground: WINDOW.hwnd };
        case 'shot': case 'screen': {
          writeFileSync(String(args.file), 'png');
          return { width: 1280, height: 1024, clientWidth: 1600, clientHeight: 1280, left: 0, top: 0 };
        }
        case 'refocus': return { refocused: true };
        default: return {};
      }
    },
    running: () => true,
    stop: () => { if (counters) counters.stopped++; },
    ...(counters ? { start: async () => { counters.started++; if (refuse) throw new Error(refuse); } } : {}),
  };
}

function harness(t: test.TestContext, options: { policies?: unknown; refuseForeground?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'computer-policy-'));
  const policyFile = join(dataDir, 'app-policies.json');
  if (options.policies) writeFileSync(policyFile, JSON.stringify(options.policies));
  process.env.EVOCU_POLICIES_FILE = policyFile;
  process.env.EVOCU_AUDIT_DIR = join(dataDir, 'audit');
  forgetPolicies();
  const backgroundLog: string[] = [], foregroundLog: string[] = [];
  const counters = { started: 0, stopped: 0 };
  const computer = createComputerUse({
    dataDir, browser: browser() as never, platform: 'win32', inbox: false,
    desktopDriver: () => helper(backgroundLog),
    foregroundDriver: () => helper(foregroundLog, counters, options.refuseForeground),
  });
  t.after(() => {
    computer.stop();
    delete process.env.EVOCU_POLICIES_FILE;
    delete process.env.EVOCU_AUDIT_DIR;
    forgetPolicies();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { computer, backgroundLog, foregroundLog, counters };
}

const policy = (mode: string, match = 'app:微信') => ({ apps: [{ match, label: '微信', mode }] });

test('a foreground policy borrows the administrator helper while the global switch stays background', async t => {
  const { computer, backgroundLog, foregroundLog, counters } = harness(t, { policies: policy('foreground') });
  assert.equal(await computer.setDesktopMode('background'), undefined);
  const opened = await computer.call('desktop', { action: 'open', app: '微信' });
  assert.match(opened.text, /整个屏幕的截图/);
  assert.equal(computer.desktopMode(), 'background', 'the global switch is still what the user chose');
  assert.equal(computer.foregroundOn(), false, 'the borrowed helper is not the user switching to foreground');
  assert.equal(counters.started, 1);
  assert.ok(foregroundLog.includes('screen'), 'the action itself ran over the whole screen');
  // The same program's next step, without naming it again, stays in the borrowed mode.
  await computer.call('desktop', { action: 'click', x: 10, y: 10 });
  assert.equal(counters.started, 1, 'the helper is not started again');
});

test('opening another program without a policy goes back to the global mode', async t => {
  const { computer, backgroundLog, foregroundLog, counters } = harness(t, { policies: policy('foreground') });
  await computer.setDesktopMode('background');
  await computer.call('desktop', { action: 'open', app: '微信' });
  foregroundLog.length = 0;
  await computer.call('desktop', { action: 'open', app: '记事本' });
  assert.ok(backgroundLog.includes('shot'), 'the other program went to the window helper');
  assert.ok(!foregroundLog.includes('shot') && !foregroundLog.includes('screen'), 'the borrowed mode did not follow');
  assert.ok(counters.stopped >= 1, 'leaving the program stops the borrowed administrator helper');
});

test('a refused UAC prompt fails the step instead of quietly staying in background', async t => {
  const { computer, backgroundLog } = harness(t, { policies: policy('foreground'), refuseForeground: '用户拒绝了管理员权限' });
  await computer.setDesktopMode('background');
  await assert.rejects(computer.call('desktop', { action: 'open', app: '微信' }), /这个程序按你的设置要用前台模式，但没能启动管理员助手：用户拒绝了管理员权限/);
  assert.equal(computer.desktopMode(), 'background');
  assert.ok(!backgroundLog.includes('shot'), 'the action was not run in the wrong mode');
});

test('a background policy keeps one program in the window helper while the global switch is foreground', async t => {
  const { computer, backgroundLog, foregroundLog, counters } = harness(t, { policies: policy('background') });
  assert.equal(await computer.setDesktopMode('foreground'), undefined);
  await computer.call('desktop', { action: 'open', app: '微信' });
  assert.equal(computer.desktopMode(), 'foreground');
  assert.equal(counters.started, 1, 'only the switch the user chose started the helper');
  assert.ok(backgroundLog.includes('shot'), 'the background helper did the opening');
  assert.ok(!foregroundLog.includes('shot') && !foregroundLog.includes('screen'), 'the whole-screen helper was not used');
});

test('without a policy the global mode the user chose is what acts', async t => {
  const { computer, backgroundLog, foregroundLog } = harness(t);
  await computer.setDesktopMode('background');
  await computer.call('desktop', { action: 'open', app: '微信' });
  assert.ok(backgroundLog.includes('shot'));
  assert.ok(!foregroundLog.includes('screen'));
});

test('exe: and title: policies match the window list, case-insensitively', () => {
  const policies = parsePolicies({ apps: [
    { match: 'exe:WEIXIN.EXE', label: '微信', mode: 'foreground' },
    { match: 'title:微信', label: '微信标题', mode: 'background' },
  ] });
  assert.equal(matchAppPolicy(policies, { exe: 'weixin' })?.mode, 'foreground');
  assert.equal(matchAppPolicy(policies, { title: '微信' })?.mode, 'background');
  assert.equal(matchAppPolicy(policies, { app: '别的' }), undefined);
});
