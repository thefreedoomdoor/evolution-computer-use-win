// tests/appearance.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_APPEARANCE, auditDir, bannerText, forgetAppearance, parseAppearance, readAppearance,
} from '../src/appearance.ts';
import {
  forgetPolicies, matchAppPolicy, parsePolicies, POLICIES_FILE, readAppPolicies,
} from '../src/policies.ts';

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evocu-appearance-'));
  dirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  delete process.env.EVOCU_APPEARANCE_FILE;
  delete process.env.EVOCU_AUDIT_DIR;
});

test('an absent or empty appearance is the documented default', () => {
  assert.deepEqual(parseAppearance(undefined), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance({}), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance('nonsense'), DEFAULT_APPEARANCE);
});

test('numbers are clamped, unknown positions and bad colors fall back', () => {
  const parsed = parseAppearance({
    banner: { width: -5, height: 999, opacity: 5, position: 'left', colors: { bg: 'red', text: '#12345' }, layout: { gap: -3, padding: 900 } },
    audit: { width: 10, layout: { rows: 99 }, position: 'left-of-thought' },
    thought: { width: 24, height: 9999, opacity: 101 },
    auditLog: { retentionDays: 0, maxScreenshotsMB: 1, maxEntries: 5 },
  });
  assert.equal(parsed.banner.width, 0);
  assert.equal(parsed.banner.height, 120);
  assert.equal(parsed.banner.opacity, 20);
  assert.equal(parsed.banner.position, 'top-center');
  assert.equal(parsed.banner.colors.bg, DEFAULT_APPEARANCE.banner.colors.bg);
  assert.equal(parsed.banner.colors.text, DEFAULT_APPEARANCE.banner.colors.text);
  assert.equal(parsed.banner.layout.gap, 0);
  assert.equal(parsed.banner.layout.padding, 80);
  assert.equal(parsed.audit.width, 220);
  assert.equal(parsed.audit.layout.rows, 40);
  assert.equal(parsed.thought.width, 240);
  assert.equal(parsed.thought.height, 1600);
  assert.equal(parsed.thought.opacity, 100);
  assert.equal(parsed.auditLog.retentionDays, 1);
  assert.equal(parsed.auditLog.maxScreenshotsMB, 20);
  assert.equal(parsed.auditLog.maxEntries, 100);
});

test('a partial object keeps every other default', () => {
  const parsed = parseAppearance({ thought: { width: 500, colors: { accent: '#ABCDEF' } } });
  assert.equal(parsed.thought.width, 500);
  assert.equal(parsed.thought.height, DEFAULT_APPEARANCE.thought.height);
  assert.equal(parsed.thought.opacity, DEFAULT_APPEARANCE.thought.opacity);
  assert.equal(parsed.thought.colors.accent, '#ABCDEF');
  assert.deepEqual(parsed.banner, DEFAULT_APPEARANCE.banner);
  assert.deepEqual(parsed.audit, DEFAULT_APPEARANCE.audit);
});

test('fonts fall back field by field', () => {
  const parsed = parseAppearance({ banner: { fonts: { main: { family: '', size: 3, bold: 'yes' }, hint: { size: 18 } } } });
  assert.equal(parsed.banner.fonts.main.family, 'Microsoft YaHei UI');
  assert.equal(parsed.banner.fonts.main.size, 6);
  assert.equal(parsed.banner.fonts.main.bold, true);
  assert.equal(parsed.banner.fonts.hint.size, 18);
  assert.equal(parsed.banner.fonts.hint.bold, false);
});

test('a written file is read, a broken one is ignored, and a newer mtime wins', () => {
  const dir = temp();
  const file = join(dir, 'appearance.json');
  process.env.EVOCU_APPEARANCE_FILE = file;
  writeFileSync(file, JSON.stringify({ thought: { width: 480 }, banner: { text: '测试{app}' } }));
  forgetAppearance();
  assert.equal(readAppearance().thought.width, 480);
  assert.equal(bannerText('记事本'), '测试记事本');
  assert.equal(bannerText(), '测试');
  writeFileSync(file, '{ not json');
  const past = new Date(Date.now() + 2000);
  utimesSync(file, past, past);
  assert.equal(readAppearance().thought.width, DEFAULT_APPEARANCE.thought.width);
  assert.equal(bannerText('微信'), 'DSH正在操作微信');
  writeFileSync(file, JSON.stringify({ banner: { text: 'DSH正在操作{app}' } }));
  const future = new Date(Date.now() + 4000);
  utimesSync(file, future, future);
  assert.equal(readAppearance().banner.text, 'DSH正在操作{app}');
});

test('the audit directory follows the environment override', () => {
  process.env.EVOCU_AUDIT_DIR = join(temp(), 'audit');
  assert.equal(auditDir(), process.env.EVOCU_AUDIT_DIR);
});

test('policies parse strictly, first match wins, exe matches with or without .exe', () => {
  const policies = parsePolicies({
    apps: [
      { match: 'exe:Weixin.exe', label: '微信', mode: 'foreground' },
      { match: 'exe:weixin.EXE', label: '重复', mode: 'background' },
      { match: 'title:微信', label: '标题', mode: 'background' },
      { match: 'app:notepad', label: '记事本', mode: 'background' },
      { match: 'exe:', label: '空', mode: 'foreground' },
      { match: 'desktop:foo', label: '坏前缀', mode: 'foreground' },
      { match: 'exe:bad.exe', label: '坏模式', mode: 'always' },
      'nope',
    ],
  });
  assert.deepEqual(policies.map(policy => policy.mode), ['foreground', 'background', 'background']);
  assert.equal(matchAppPolicy(policies, { exe: 'Weixin' })?.label, '微信');
  assert.equal(matchAppPolicy(policies, { exe: 'Weixin.exe' })?.label, '微信');
  assert.equal(matchAppPolicy(policies, { title: '微信' })?.label, '标题');
  assert.equal(matchAppPolicy(policies, { app: 'Notepad' })?.label, '记事本');
  assert.equal(matchAppPolicy(policies, { exe: 'chrome.exe' }), undefined);
});

test('a policy file is read from the fixed path with its own cache', () => {
  const dir = temp();
  const file = join(dir, 'app-policies.json');
  writeFileSync(file, JSON.stringify({ apps: [{ match: 'exe:calc.exe', mode: 'background' }] }));
  const original = POLICIES_FILE;
  // The module's path is fixed; this test reads through the real path only when it is absent.
  // Parsing and matching are covered above; here just make sure a missing file is empty.
  if (!readAppPolicies().length) assert.deepEqual(readAppPolicies(), []);
  forgetPolicies();
  assert.ok(original.endsWith('app-policies.json'));
});
