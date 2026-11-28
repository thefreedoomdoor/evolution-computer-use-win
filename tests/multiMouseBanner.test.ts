// tests/multiMouseBanner.test.ts
//
// A14: while a multi-mouse task runs, the operation banner says
// "DSH正在完成{task}" and the application name never reaches the words; with the
// mode off the banner is byte-for-byte the ordinary one again.
//
// The plugin writes <data dir>/companion-live.json; src/appearance.ts reads it on
// every bannerText() call, so these cases only need that file plus an appearance
// file for the ordinary wording.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bannerText, companionLiveFile, forgetAppearance, taskBannerText,
} from '../src/appearance.ts';

const dirs: string[] = [];
/** One data directory per case: appearance.json (ordinary words) + companion-live.json (task). */
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evocu-multimouse-banner-'));
  dirs.push(dir);
  process.env.EVOCU_DATA_DIR = dir;
  process.env.EVOCU_APPEARANCE_FILE = join(dir, 'appearance.json');
  forgetAppearance();
  return dir;
}
function live(value: unknown): void {
  writeFileSync(companionLiveFile(), typeof value === 'string' ? value : JSON.stringify(value));
}
test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  delete process.env.EVOCU_DATA_DIR;
  delete process.env.EVOCU_APPEARANCE_FILE;
  forgetAppearance();
});

test('with no live file the banner keeps the ordinary words', () => {
  temp();
  assert.equal(taskBannerText(), undefined);
  assert.equal(bannerText('微信'), 'DSH正在操作微信');
  assert.equal(bannerText(), 'DSH正在操作');
});

test('a disabled task mode leaves the ordinary banner byte for byte', () => {
  temp();
  live({ schema: 1, epoch: 0, rootId: null, enabled: false, task: '整理桌面', rows: [] });
  assert.equal(taskBannerText(), undefined);
  assert.equal(bannerText('微信'), 'DSH正在操作微信');
});

test('an enabled task replaces the words and never shows the application name (A14)', () => {
  temp();
  live({ schema: 1, epoch: 3, rootId: 'root-1', enabled: true, task: '整理桌面', rows: [] });
  const text = bannerText('微信');
  assert.equal(text, 'DSH正在完成整理桌面');
  assert.equal(text.includes('微信'), false, 'the application name must not reach the banner');
  assert.equal(taskBannerText(), 'DSH正在完成整理桌面');
});

test('an enabled task without a name still says what DSH is doing', () => {
  temp();
  live({ schema: 1, enabled: true, task: '   ', rows: [] });
  assert.equal(bannerText('微信'), 'DSH正在完成当前任务');
});

test('a broken or non-boolean live file falls back to the ordinary banner', () => {
  temp();
  live('{ not json');
  assert.equal(bannerText('微信'), 'DSH正在操作微信');
  live({ enabled: 'true', task: '整理桌面' });
  assert.equal(bannerText('微信'), 'DSH正在操作微信', 'only a real true enables the task words');
  live([]);
  assert.equal(bannerText('微信'), 'DSH正在操作微信');
});

test('turning the task off restores the ordinary banner on the very next call', () => {
  temp();
  live({ schema: 1, enabled: true, task: '整理桌面' });
  assert.equal(bannerText('微信'), 'DSH正在完成整理桌面');
  live({ schema: 1, enabled: false, task: '整理桌面' });
  assert.equal(bannerText('微信'), 'DSH正在操作微信', 'no cached task text survives the switch');
  live({ schema: 1, enabled: true, task: '整理桌面' });
  assert.equal(bannerText('微信'), 'DSH正在完成整理桌面', 'and it comes back at once');
});

test('the runtime task switch drives the real banner end to end (A14)', async () => {
  const dir = temp();
  // 插件是纯 .mjs，这里按 src/native-tools.ts:545 的写法用 URL specifier 动态载入：
  // 静态 import 会让 tsc 因为没有声明文件而报 TS7016。
  const specifier = new URL('../plugin/lib/multi-mouse-runtime.mjs', import.meta.url).href;
  const loaded = await import(specifier) as {
    createMultiMouseRuntime: (options: { dataDir: string }) => {
      publishMode: (rootId: string, patch: { enabled?: boolean; task?: string }) => unknown;
      dispose: () => void;
    };
  };
  const runtime = loaded.createMultiMouseRuntime({ dataDir: dir });
  try {
    assert.equal(bannerText('微信'), 'DSH正在操作微信', 'nothing is running yet');
    runtime.publishMode('root-1', { enabled: true, task: '整理桌面' });
    const on = bannerText('微信');
    assert.equal(on, 'DSH正在完成整理桌面');
    assert.equal(on.includes('微信'), false, 'the application name never reaches the banner');
    runtime.publishMode('root-1', { task: '写周报' });
    assert.equal(bannerText('微信'), 'DSH正在完成写周报', 'a new task rewords the same banner');
    runtime.publishMode('root-1', { enabled: false });
    assert.equal(bannerText('微信'), 'DSH正在操作微信', 'closing the mode restores the ordinary banner');
  } finally {
    runtime.dispose();
  }
  assert.equal(bannerText('微信'), 'DSH正在操作微信', 'a disposed runtime leaves nothing behind');
});

test('a task that literally contains {app} is kept as written', () => {
  temp();
  live({ schema: 1, enabled: true, task: '检查{app}窗口' });
  const text = bannerText('微信');
  assert.equal(text, 'DSH正在完成检查{app}窗口');
  assert.equal(text.includes('微信'), false, 'the placeholder is never substituted with a program name');
});
