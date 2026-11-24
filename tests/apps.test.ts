// tests/apps.test.ts
// 离线测试：不跑真实全盘扫描、不访问网络、不依赖第三方库。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  candidateId,
  decrypt,
  dedupeCandidates,
  encrypt,
  indexFile,
  loadIndex,
  parseScanOutput,
  resolveApp,
  saveIndex,
  scanApps,
} from '../src/apps/index.ts';
import type { AppEntry, AppIndex, RawScanOutput } from '../src/apps/index.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'evo-apps-'));
}

function makeEntry(patch: Partial<AppEntry> & { name: string; id: string; source: AppEntry['source'] }): AppEntry {
  return { lastSeen: '2026-01-01T00:00:00.000Z', exists: true, ...patch };
}

function makeIndex(apps: AppEntry[] = []): AppIndex {
  return {
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    machine: 'test',
    scan: {
      mode: 'incremental',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 0,
      dirsScanned: 0,
      exeFound: 0,
      appEntries: apps.length,
    },
    apps,
    dirs: {},
  };
}

/** 用 mkdtemp 建的临时目录跑一段并在结束后清理。 */
function withTempDir<T>(run: (dir: string) => T): T {
  const dir = tempDir();
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('encrypt/decrypt 往返，文件头是魔数 + 版本', () => {
  const payload = '{"hello":"世界","n":1}';
  const buffer = encrypt(payload);
  assert.equal(buffer.subarray(0, 8).toString('ascii'), 'EVAPPIDX');
  assert.equal(buffer[8], 1);
  assert.equal(decrypt(buffer), payload);
  assert.throws(() => decrypt(Buffer.from('not an index')));
});

test('saveIndex/loadIndex 加解密往返', () => {
  withTempDir((dir) => {
    const index = makeIndex([
      makeEntry({ id: 'abc', name: '记事本', exe: 'C:\\Windows\\notepad.exe', source: 'start-menu' }),
    ]);
    saveIndex(dir, index);
    const raw = readFileSync(indexFile(dir));
    assert.equal(raw.subarray(0, 8).toString('ascii'), 'EVAPPIDX');
    assert.deepEqual(loadIndex(dir), index);
  });
});

test('缺失索引返回 null', () => {
  withTempDir((dir) => assert.equal(loadIndex(dir), null));
});

test('篡改密文后 loadIndex 返回 null、不抛、坏文件改名为 .corrupt-*', () => {
  withTempDir((dir) => {
    saveIndex(dir, makeIndex([makeEntry({ id: 'x', name: 'A', exe: 'C:\\A\\a.exe', source: 'program-files' })]));
    const file = indexFile(dir);
    const raw = readFileSync(file);
    raw[raw.length - 1] ^= 0xff; // 翻掉最后一个密文字节
    writeFileSync(file, raw);

    let loaded: AppIndex | null = makeIndex(); // 非 null 占位
    assert.doesNotThrow(() => { loaded = loadIndex(dir); });
    assert.equal(loaded, null);

    const names = readdirSync(dir);
    assert.ok(names.some((name) => name.includes('.corrupt-')), '坏文件应被改名保留');
    assert.ok(!names.includes('apps-index.enc'), '原文件应已挪走');
  });
});

test('parseScanOutput 归一化各来源字段', () => {
  const raw: RawScanOutput = {
    startApps: [{ name: ' 计算器 ', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }],
    startMenu: [{ name: 'B', target: '"C:\\b\\b.exe"', arguments: '--flag' }],
    appPaths: [{ name: '', exe: 'C:\\c\\c.exe' }],
    uninstall: [{ name: 'D', displayIcon: 'C:\\d\\d.exe,0', installLocation: 'C:\\d' }],
  };
  const candidates = parseScanOutput(raw);
  assert.equal(candidates[0]!.name, '计算器');
  assert.equal(candidates[0]!.source, 'start-apps');
  assert.equal(candidates[0]!.appId, 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App');
  assert.equal(candidates[1]!.exe, 'C:\\b\\b.exe');
  assert.equal(candidates[1]!.args, '--flag');
  assert.equal(candidates[2]!.name, 'c', 'App Paths 没名字时用 exe 文件名');
  assert.equal(candidates[3]!.exe, 'C:\\d\\d.exe', 'displayIcon 的 ,0 应去掉');
  assert.equal(candidates[3]!.installDir, 'C:\\d');
});

test('dedupeCandidates 同 exe 合并、高优先来源胜出、名称进 aliases', () => {
  const merged = dedupeCandidates([
    { name: 'Tool', source: 'program-files', exe: 'C:\\x\\tool.exe', installDir: 'C:\\x' },
    { name: 'Tool Pro', source: 'start-menu', exe: 'C:\\x\\tool.exe', args: '-p' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.source, 'start-menu');
  assert.equal(merged[0]!.args, '-p');
  assert.deepEqual(merged[0]!.aliases, ['Tool']);
});

test('scanApps 合并去重：L1 名称优先、displayIcon 解析、统计正确', async () => {
  const dir = tempDir();
  try {
    const raw: RawScanOutput = {
      startApps: [{ name: '计算器', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }],
      startMenu: [{ name: '记事本', target: 'C:\\Windows\\System32\\notepad.exe', arguments: '' }],
      appPaths: [{ name: 'Notepad 副本', exe: 'C:\\Windows\\System32\\notepad.exe' }],
      uninstall: [
        { name: '某软件', displayIcon: 'C:\\Program Files\\某软件\\app.exe,0', installLocation: 'C:\\Program Files\\某软件' },
      ],
    };
    const index = await scanApps({ dataDir: dir, powershell: () => JSON.stringify(raw), programRoots: [] });

    const notepads = index.apps.filter(
      (entry) => entry.exe && entry.exe.toLowerCase() === 'c:\\windows\\system32\\notepad.exe',
    );
    assert.equal(notepads.length, 1, '同 exe 应去重成一条');
    assert.equal(notepads[0]!.name, '记事本', 'start-menu 名称优先于 app-paths');
    assert.equal(notepads[0]!.source, 'start-menu');
    assert.equal(
      notepads[0]!.id,
      candidateId({ name: '记事本', source: 'start-menu', exe: 'C:\\Windows\\System32\\notepad.exe' }),
      'id 应稳定可复算',
    );

    assert.ok(index.apps.some((entry) => entry.name === '计算器' && entry.appId), 'appId 条目应存在');
    const uninstalled = index.apps.find((entry) => entry.name === '某软件')!;
    assert.equal(uninstalled.exe, 'C:\\Program Files\\某软件\\app.exe');
    assert.equal(uninstalled.source, 'uninstall');

    assert.equal(index.scan.mode, 'incremental');
    assert.equal(index.scan.appEntries, index.apps.length);
    assert.ok(index.updatedAt.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanApps 中 Program Files 与 L1 同 exe 时 L1 名称优先', async () => {
  const dir = tempDir();
  const root = mkdtempSync(join(tmpdir(), 'evo-pf-'));
  try {
    const vendor = join(root, 'Vendor');
    mkdirSync(vendor);
    const exe = join(vendor, 'tool.exe');
    writeFileSync(exe, '');
    const raw: RawScanOutput = { appPaths: [{ name: '工具甲', exe }] };
    const index = await scanApps({ dataDir: dir, powershell: () => JSON.stringify(raw), programRoots: [root] });
    const matches = index.apps.filter((entry) => entry.exe && entry.exe.toLowerCase() === exe.toLowerCase());
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.name, '工具甲');
    assert.equal(matches[0]!.source, 'app-paths');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveApp：大小写/空格/连字符/下划线/中文/别名/包含/exists 优先', () => {
  const index = makeIndex([
    makeEntry({ id: '1', name: 'Google Chrome', exe: 'C:\\Program Files\\Google\\Chrome\\chrome.exe', source: 'program-files' }),
    makeEntry({ id: '2', name: '微信', exe: 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe', source: 'program-files', aliases: ['Weixin'] }),
    makeEntry({ id: '3', name: 'Notepad', exe: 'C:\\Windows\\notepad.exe', source: 'start-menu', exists: false }),
    makeEntry({ id: '4', name: 'Notepad', exe: 'C:\\Other\\notepad.exe', source: 'program-files', exists: true }),
    makeEntry({ id: '5', name: '计算器', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', source: 'start-apps' }),
  ]);
  assert.equal(resolveApp('google chrome', index)?.id, '1');
  assert.equal(resolveApp('GOOGLE-CHROME', index)?.id, '1');
  assert.equal(resolveApp('google_chrome', index)?.id, '1');
  assert.equal(resolveApp('  googlechrome  ', index)?.id, '1');
  assert.equal(resolveApp('chrome', index)?.id, '1', 'exe 文件名');
  assert.equal(resolveApp('微信', index)?.id, '2', '中文原样');
  assert.equal(resolveApp('weixin', index)?.id, '2', '别名');
  assert.equal(resolveApp('notepad', index)?.id, '4', '优先 exists 的条目');
  assert.equal(resolveApp('计算器', index)?.id, '5');
  assert.equal(resolveApp('windowscalculator', index)?.id, '5', 'appId 片段');
  assert.equal(resolveApp('chrom', index)?.id, '1', '包含匹配');
  assert.equal(resolveApp('不存在的软件', index), undefined);
});

test('增量扫描：目录 mtime 未变则跳过，full=true 强制重扫', async () => {
  const dir = tempDir();
  const root = mkdtempSync(join(tmpdir(), 'evo-pf2-'));
  try {
    const sub = join(root, 'App');
    mkdirSync(sub);
    writeFileSync(join(sub, 'app.exe'), '');

    const first = await scanApps({ dataDir: dir, powershell: () => '{}', programRoots: [root] });
    assert.ok(first.scan.dirsScanned >= 1);
    assert.ok(first.apps.some((entry) => entry.name === 'app'));
    assert.ok(first.dirs[root], '应记录根目录 mtime');

    const second = await scanApps({ dataDir: dir, powershell: () => '{}', programRoots: [root] });
    assert.equal(second.scan.mode, 'incremental');
    assert.equal(second.scan.dirsScanned, 0, 'mtime 未变应跳过扫描');
    assert.ok(second.apps.some((entry) => entry.name === 'app'), '缓存条目应保留');

    const forced = await scanApps({ dataDir: dir, powershell: () => '{}', programRoots: [root], full: true });
    assert.equal(forced.scan.mode, 'full');
    assert.ok(forced.scan.dirsScanned >= 1, 'full=true 应强制重扫');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('目录 mtime 变化触发重扫并收编新 exe', async () => {
  const dir = tempDir();
  const root = mkdtempSync(join(tmpdir(), 'evo-pf3-'));
  try {
    const a = join(root, 'A');
    mkdirSync(a);
    writeFileSync(join(a, 'one.exe'), '');
    const first = await scanApps({ dataDir: dir, powershell: () => '{}', programRoots: [root] });
    assert.ok(first.apps.some((entry) => entry.name === 'one'));

    const b = join(root, 'B');
    mkdirSync(b);
    writeFileSync(join(b, 'two.exe'), '');
    const future = new Date(Date.now() + 5000);
    utimesSync(root, future, future); // 明确改动 root mtime

    const second = await scanApps({ dataDir: dir, powershell: () => '{}', programRoots: [root] });
    assert.ok(second.scan.dirsScanned >= 1, 'mtime 变化应重扫');
    assert.ok(second.apps.some((entry) => entry.name === 'two'), '应发现新 exe');
    assert.ok(second.apps.some((entry) => entry.name === 'one'), '旧条目应保留（L0 兜底）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
