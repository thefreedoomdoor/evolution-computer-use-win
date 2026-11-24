import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAudit, detailOf, type AuditEntry } from '../src/audit.ts';
import { DEFAULT_APPEARANCE, forgetAppearance, type AuditLogAppearance } from '../src/appearance.ts';

const made: string[] = [];
function temp(name: string): string { const dir = mkdtempSync(join(tmpdir(), name)); made.push(dir); return dir; }
test.after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  delete process.env.EVOCU_AUDIT_DIR;
  delete process.env.EVOCU_ACTIVITY_FILE;
  delete process.env.EVOCU_APPEARANCE_FILE;
  forgetAppearance();
});

/** 一个和真实 ~/.evolution-computer-use 隔开的审计环境：临时审计目录、临时 appearance.json、临时 activity.json。 */
function setup(options: { auditLog?: Partial<AuditLogAppearance>; activity?: unknown } = {}) {
  const root = temp('evocu-audit-');
  const home = temp('evocu-audit-settings-');
  const appearanceFile = join(home, 'appearance.json');
  writeFileSync(appearanceFile, JSON.stringify({ auditLog: { ...DEFAULT_APPEARANCE.auditLog, ...(options.auditLog ?? {}) } }), 'utf8');
  const activityFile = join(home, 'activity.json');
  if (options.activity !== undefined) writeFileSync(activityFile, JSON.stringify(options.activity), 'utf8');
  process.env.EVOCU_AUDIT_DIR = root;
  process.env.EVOCU_ACTIVITY_FILE = activityFile;
  process.env.EVOCU_APPEARANCE_FILE = appearanceFile;
  forgetAppearance();
  return { root, home, appearanceFile, activityFile };
}

const two = (value: number) => String(value).padStart(2, '0');
const dayName = (at: Date) => `audit-${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}.jsonl`;
const lines = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim());
const rows = (file: string) => lines(file).map(line => JSON.parse(line) as Record<string, unknown>);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const NOON = new Date(2026, 10, 24, 13, 2, 11, 482);

function entry(patch: Partial<AuditEntry> = {}): AuditEntry {
  return { at: NOON, tool: 'desktop', action: 'click', app: '微信', x: 412, y: 238, ok: true, result: '点了 (412,238)', ...patch };
}

test('one step is one JSON line: every contract field, local time with its offset, empty fields at their defaults', () => {
  const s = setup({ activity: { sessionId: 'abcdef12-3456-7890-abcd-ef1234567890', turn: 4, progress: { reasoning: '先点开设置' } } });
  const audit = createAudit();
  audit.record(entry({ exe: 'Weixin.exe', title: '微信', reason: '点开设置' }));
  const file = join(s.root, dayName(NOON));
  const [row] = rows(file);
  assert.deepEqual(Object.keys(row), ['at', 'session', 'turn', 'tool', 'action', 'app', 'exe', 'title', 'x', 'y', 'x2', 'y2', 'double', 'right', 'key', 'modifiers', 'text', 'direction', 'seconds', 'ok', 'result', 'reason', 'shot'], 'the contract fields, in contract order');
  assert.match(String(row.at), /^2026-11-24T13:02:11\.482[+-]\d{2}:\d{2}$/, 'local time with an offset, not Z');
  assert.equal(row.session, 'abcdef12-3456-7890-abcd-ef1234567890');
  assert.equal(row.turn, 4, 'the turn from activity.json');
  assert.deepEqual([row.tool, row.action, row.app, row.exe, row.title], ['desktop', 'click', '微信', 'Weixin.exe', '微信']);
  assert.deepEqual([row.x, row.y, row.x2, row.y2], [412, 238, null, null]);
  assert.deepEqual([row.double, row.right], [false, false]);
  assert.deepEqual([row.key, row.text, row.direction, row.seconds, row.shot], ['', '', '', 0, '']);
  assert.deepEqual([row.ok, row.result, row.reason], [true, '点了 (412,238)', '点开设置']);
  assert.deepEqual(row.modifiers, []);
  audit.close();
});

test('the reason: what the agent said, else the last thought in activity.json, flattened and cut at 500 characters', async () => {
  const s = setup({ activity: { sessionId: 's', turn: 2, progress: { reasoning: '先  看一眼\n设置，再点开' } } });
  const audit = createAudit();
  const file = join(s.root, dayName(NOON));
  audit.record(entry({ reason: '  agent 自己写的 理由 ' }));
  audit.record(entry());
  const [given, fallback] = rows(file);
  assert.equal(given.reason, 'agent 自己写的 理由', 'the agent reason wins, whitespace folded');
  assert.equal(fallback.reason, '先 看一眼 设置，再点开', 'else the last thought from activity.json');

  // 一秒之内不重读 activity.json。
  writeFileSync(s.activityFile, JSON.stringify({ progress: { reasoning: '换了一段想法' } }), 'utf8');
  audit.record(entry());
  assert.equal(rows(file).at(-1)!.reason, '先 看一眼 设置，再点开', 'read at most once a second');
  await pause(1050);
  audit.record(entry());
  assert.equal(rows(file).at(-1)!.reason, '换了一段想法', 'a second later it is read again');

  writeFileSync(s.activityFile, JSON.stringify({ progress: { reasoning: '长'.repeat(600) } }), 'utf8');
  await pause(1050);
  audit.record(entry());
  assert.equal(String(rows(file).at(-1)!.reason).length, 500, 'cut at 500 characters');
  audit.close();
});

test('the audit window reads audit-live.tsv: 40 rows, 7 columns, no tab or newline inside a field, no .tmp left behind', () => {
  const s = setup();
  const audit = createAudit();
  for (let i = 0; i < 45; i += 1) {
    audit.record(entry({ at: new Date(2026, 10, 24, 13, 2, i), action: 'press', key: 'ctrl+s', reason: `第${i}步\t原因\n第二行` }));
  }
  audit.record(entry({ at: new Date(2026, 10, 24, 13, 2, 59), ok: false, result: '没做成：窗口不见了' }));
  const file = join(s.root, 'audit-live.tsv');
  const shown = lines(file);
  assert.equal(shown.length, 40, 'only the latest 40');
  for (const row of shown) {
    assert.equal(row.split('\t').length, 7, 'tab only ever separates columns');
    assert.ok(!/[\r\n]/.test(row));
  }
  const [at, ok, action, app, detail, reason, shot] = shown.at(-2)!.split('\t');
  assert.match(at, /^\d{2}:\d{2}:\d{2}$/, 'HH:mm:ss');
  assert.equal(ok, '1');
  assert.equal(action, 'press');
  assert.equal(app, '微信');
  assert.equal(detail, '按键 Ctrl+S');
  assert.equal(reason, '第44步 原因 第二行', 'tab and newline become a space');
  assert.equal(shot, '');
  assert.ok(!readdirSync(s.root).some(name => name.includes('.tmp')), 'written aside and renamed, never left half');
  const failed = shown.at(-1)!.split('\t');
  assert.equal(failed[1], '0', 'a step that failed says so');
  assert.equal(failed[2], 'click');
  assert.equal(failed[4], '点击 (412,238)');

  // 下一次启动接上这一屏，不从头开始。
  const again = createAudit();
  again.record(entry({ at: new Date(2026, 10, 24, 13, 3, 0), action: 'open', app: '微信' }));
  const after = lines(file);
  assert.equal(after.length, 40);
  assert.equal(after.at(-1)!.split('\t')[4], '打开 微信', 'a new audit carries on from the rows already there');
  again.close();
  audit.close();
});

test('one Chinese phrase per step for the audit window: click, double, right, drag, keys, text, scroll, tools', () => {
  const say = (patch: Partial<AuditEntry>) => detailOf(entry(patch));
  assert.equal(say({ action: 'click' }), '点击 (412,238)');
  assert.equal(say({ action: 'click', double: true }), '双击 (412,238)');
  assert.equal(say({ action: 'click', right: true }), '右键 (412,238)');
  assert.equal(say({ action: 'drag', x: 1, y: 2, x2: 3, y2: 4 }), '拖动 (1,2)→(3,4)');
  assert.equal(say({ action: 'press', key: 'ctrl+s' }), '按键 Ctrl+S');
  assert.equal(say({ action: 'press', key: 'escape' }), '按键 escape');
  assert.equal(say({ action: 'type', text: '你好' }), '输入 2 个字');
  assert.equal(say({ action: 'scroll', direction: 'down' }), '滚动 ↓');
  assert.equal(say({ action: 'scroll', direction: 'left' }), '滚动 ←');
  assert.equal(say({ action: 'open', app: '微信' }), '打开 微信');
  assert.equal(say({ action: 'shot' }), '截图');
  assert.equal(say({ action: 'page_open https://example.com' }), '打开网址 https://example.com');
  assert.equal(say({ action: 'procedure_run 分类/操作' }), '运行操作 分类/操作');
  assert.equal(say({ action: 'inbox_read' }), '看信箱');
});

test('a screenshot is kept in shots/ while the policy allows it, and only the words are kept when it does not', () => {
  const s = setup();
  const audit = createAudit();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  audit.record(entry({ action: 'shot', image: png }));
  const [row] = rows(join(s.root, dayName(NOON)));
  assert.match(String(row.shot), /^shots\/\d{8}-\d{6}-\d{3}-\d+\.png$/, 'a path relative to the audit folder');
  assert.deepEqual(readFileSync(join(s.root, String(row.shot))), png);
  assert.equal(lines(join(s.root, 'audit-live.tsv')).at(-1)!.split('\t')[6], row.shot, 'the window opens the same file');
  audit.close();

  const off = setup({ auditLog: { screenshots: false } });
  const quiet = createAudit();
  quiet.record(entry({ action: 'shot', image: png }));
  assert.equal(rows(join(off.root, dayName(NOON)))[0].shot, '', 'no path when screenshots are off');
  assert.ok(!existsSync(join(off.root, 'shots')), 'and no folder either');
  quiet.close();
});

test('retentionDays: day files and their screenshots that are too old are gone when the audit starts', () => {
  const s = setup({ auditLog: { retentionDays: 1 } });
  mkdirSync(join(s.root, 'shots'), { recursive: true });
  const oldDay = join(s.root, 'audit-2020-01-01.jsonl');
  writeFileSync(oldDay, '{}\n', 'utf8');
  const oldShot = join(s.root, 'shots', '20200101-000000-000-1.png');
  writeFileSync(oldShot, 'old', 'utf8');
  const keptShot = join(s.root, 'shots', '20990101-000000-000-9.png');
  writeFileSync(keptShot, 'new', 'utf8');
  const audit = createAudit();
  assert.ok(!existsSync(oldDay), 'the old day file is deleted');
  assert.ok(!existsSync(oldShot), 'and the screenshot of that day');
  assert.ok(existsSync(keptShot), 'a screenshot that is not old stays');
  audit.close();
});

test('maxScreenshotsMB: the oldest screenshots go first once the folder is too big', () => {
  const s = setup({ auditLog: { maxScreenshotsMB: 20 } });
  const dir = join(s.root, 'shots');
  mkdirSync(dir, { recursive: true });
  // 名字里的日期决定新旧：三天前、两天前、一天前。
  const stamped = (back: number) => { const at = new Date(); at.setDate(at.getDate() - back); return `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-000000-000-${back}.png`; };
  const names = [stamped(3), stamped(2), stamped(1)];
  for (const name of names) writeFileSync(join(dir, name), Buffer.alloc(11 * 1024 * 1024));
  const audit = createAudit();
  const left = readdirSync(dir).sort();
  assert.deepEqual(left, [names[2]], '20MB holds one 11MB screenshot: the two oldest are gone');
  audit.close();
});

test('maxEntries: a day that grew too long is cut down to its latest rows', () => {
  const s = setup({ auditLog: { maxEntries: 100 } });
  const today = new Date();
  const file = join(s.root, dayName(today));
  const written = Array.from({ length: 130 }, (_, i) => JSON.stringify({ at: `x-${i}`, ok: true }));
  writeFileSync(file, `${written.join('\n')}\n`, 'utf8');
  const audit = createAudit();
  const left = rows(file);
  assert.equal(left.length, 100, 'kept at most 100');
  assert.equal(left[0].at, 'x-30', 'the oldest 30 rows are the ones dropped');
  assert.equal(left.at(-1)!.at, 'x-129');
  audit.close();
});

test('an audit that cannot write only logs: a step of the agent never fails because of it', () => {
  const home = temp('evocu-audit-broken-');
  const blocker = join(home, 'not-a-directory');
  writeFileSync(blocker, 'a plain file, not a folder', 'utf8');
  process.env.EVOCU_AUDIT_DIR = blocker;
  process.env.EVOCU_ACTIVITY_FILE = join(home, 'activity.json');
  process.env.EVOCU_APPEARANCE_FILE = join(home, 'appearance.json');
  writeFileSync(process.env.EVOCU_APPEARANCE_FILE, '{}', 'utf8');
  forgetAppearance();
  const notes: string[] = [];
  const audit = createAudit({ log: text => notes.push(text) });
  assert.doesNotThrow(() => audit.record(entry({ action: 'shot', image: Buffer.from('png') })));
  assert.ok(notes.some(text => text.includes('审计目录建不出来')), notes.join(' / '));
  audit.close();
});

test('an audit that is turned off, or already closed, writes nothing and breaks nothing', () => {
  const off = setup({ auditLog: { enabled: false } });
  const quiet = createAudit();
  quiet.record(entry());
  assert.deepEqual(readdirSync(off.root), [], 'nothing on disk');
  quiet.close();

  const on = setup();
  const audit = createAudit();
  audit.record(entry());
  audit.close();
  audit.record(entry({ action: 'open', app: '微信' }));
  assert.equal(rows(join(on.root, dayName(NOON))).length, 1, 'closed audits keep quiet');
});