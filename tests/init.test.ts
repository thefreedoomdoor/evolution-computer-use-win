import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AppIndex } from '../src/apps/index.ts';
import { saveIndex } from '../src/apps/index.ts';
import { hasInitReport, indexMissing, runInit, INIT_REPORT, STARTUP_REPORT } from '../src/init.ts';

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ecu-init-'));
  return dir;
}
function index(apps: number, mode: 'full' | 'incremental' = 'full'): AppIndex {
  return {
    version: 1, updatedAt: new Date().toISOString(), machine: 'test',
    scan: { mode, startedAt: '', finishedAt: '', durationMs: 12, dirsScanned: 3, exeFound: apps, appEntries: apps },
    apps: Array.from({ length: apps }, (_, i) => ({ id: `a${i}`, name: `App${i}`, exe: `C:\\App${i}\\app${i}.exe`, source: 'program-files' as const, lastSeen: '', exists: true })),
    dirs: {},
  };
}
const passingSelftest = { startedAt: '', finishedAt: '', ok: true, items: [{ id: 'env', name: '环境', status: 'passed' as const, detail: 'ok', ms: 5 }] };
const failingSelftest = { startedAt: '', finishedAt: '', ok: false, items: [{ id: 'browser', name: '浏览器', status: 'failed' as const, detail: '打不开', ms: 5 }] };

test('init 成功：扫描与自测都跑，写 init-report.json 和 .md', async t => {
  const dataDir = temp(); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const lines: string[] = [];
  const report = await runInit({
    dataDir, browser: {} as never, report: 'init', log: line => lines.push(line),
    scan: async () => index(4), selftestRun: async () => passingSelftest,
  });
  assert.equal(report.ok, true);
  assert.equal(report.scan.ok, true);
  assert.equal(report.scan.apps, 4);
  assert.equal(report.scan.mode, 'full');
  assert.equal(report.selftest?.ok, true);
  assert.ok(existsSync(join(dataDir, INIT_REPORT)));
  assert.ok(report.reportMarkdown && existsSync(report.reportMarkdown));
  const md = readFileSync(report.reportMarkdown!, 'utf8');
  assert.match(md, /软件条目：4/);
  assert.match(md, /浏览器|环境/);
  assert.ok(lines.some(line => /软件位置表：4 个程序/.test(line)));
});

test('扫描失败也继续自测，报告里写明原因且 ok=false', async t => {
  const dataDir = temp(); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let tested = false;
  const report = await runInit({
    dataDir, browser: {} as never, report: 'init',
    scan: async () => { throw new Error('扫描炸了'); },
    selftestRun: async () => { tested = true; return passingSelftest; },
  });
  assert.equal(tested, true);
  assert.equal(report.ok, false);
  assert.equal(report.scan.ok, false);
  assert.match(report.scan.error ?? '', /扫描炸了/);
  assert.match(readFileSync(report.reportMarkdown!, 'utf8'), /扫描错误：扫描炸了/);
});

test('自测框架自己抛错也收敛成 failed 项，而不是让 init 抛出', async t => {
  const dataDir = temp(); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const report = await runInit({
    dataDir, browser: {} as never, report: 'init',
    scan: async () => index(1), selftestRun: async () => { throw new Error('框架坏了'); },
  });
  assert.equal(report.ok, false);
  assert.equal(report.selftest?.ok, false);
  assert.equal(report.selftest?.items[0]?.status, 'failed');
  assert.match(report.selftest!.items[0]!.detail, /框架坏了/);
});

test('startup 报告写到 startup-report.json，不动 init-report.json', async t => {
  const dataDir = temp(); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  await runInit({ dataDir, browser: {} as never, report: 'startup', scan: async () => index(2, 'incremental'), selftestRun: async () => passingSelftest });
  assert.equal(existsSync(join(dataDir, STARTUP_REPORT)), true);
  assert.equal(existsSync(join(dataDir, INIT_REPORT)), false);
  assert.equal(hasInitReport(dataDir), false);
});

test('report=none 不写文件，但结果照常返回', async t => {
  const dataDir = temp(); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const report = await runInit({ dataDir, browser: {} as never, report: 'none', scan: async () => index(3), selftestRun: async () => passingSelftest });
  assert.equal(report.ok, true);
  assert.equal(report.reportJson, undefined);
  assert.equal(existsSync(join(dataDir, INIT_REPORT)), false);
});

test('indexMissing 与 hasInitReport 按实际文件判断', async t => {
  const dataDir = temp(); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  assert.equal(indexMissing(dataDir), true);
  assert.equal(hasInitReport(dataDir), false);
  saveIndex(dataDir, index(1));
  assert.equal(indexMissing(dataDir), false);
  assert.equal(hasInitReport(dataDir), false);
  await runInit({ dataDir, browser: {} as never, report: 'init', scan: async () => index(1), selftestRun: async () => passingSelftest });
  assert.equal(hasInitReport(dataDir), true);
});
