import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanApps, loadIndex, indexFile } from './apps/index.ts';
import { runSelftest, type SelftestReport } from './selftest.ts';
import { createBrowser, type Browser } from './browser/browser.ts';
import { killBrowser } from './browser/edge.ts';
import { Faults } from './shared/faults.ts';
import type { Desktop } from './desktop/desktop.ts';

/** 第一次启动或用户主动 init 时做的事：扫软件、跑自测、留一份人看得懂的报告。 */
export interface InitOptions {
  dataDir: string;
  browser: Browser;
  /** 桌面控制没有打开时传 undefined；桌面自测会记 skipped。 */
  desktop?: Desktop;
  full?: boolean;
  /** 默认跑；false 只扫描。 */
  selftest?: boolean;
  allowNetwork?: boolean;
  /** init = 用户主动初始化；startup = 每次 DSH 启动的增量检查；none = 只返回结果不写报告。 */
  report?: 'init' | 'startup' | 'none';
  log?: (line: string) => void;
  /** 仅供测试注入：默认就是 scanApps / runSelftest。 */
  scan?: (options: { dataDir: string; full?: boolean; log?: (line: string) => void }) => Promise<import('./apps/index.ts').AppIndex>;
  selftestRun?: (options: { dataDir: string; browser: Browser; desktop?: Desktop; allowNetwork?: boolean; log?: (line: string) => void }) => Promise<SelftestReport>;
}

export interface InitReport {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  full: boolean;
  scan: {
    ok: boolean;
    mode: 'full' | 'incremental';
    apps: number;
    dirsScanned: number;
    exeFound: number;
    durationMs: number;
    indexFile: string;
    error?: string;
  };
  selftest?: SelftestReport;
  reportJson?: string;
  reportMarkdown?: string;
}

export const INIT_REPORT = 'init-report.json';
export const STARTUP_REPORT = 'startup-report.json';
export const initReportFile = (dataDir: string) => join(dataDir, INIT_REPORT);

function markdown(report: InitReport): string {
  const lines = [
    '# evolution-computer-use init report',
    '',
    `- 时间：${report.startedAt} → ${report.finishedAt}`,
    `- 结果：${report.ok ? '通过' : '有失败项'}`,
    '',
    '## 软件位置表',
    '',
    `- 扫描方式：${report.scan.mode === 'full' ? '完整扫描' : '增量扫描'}`,
    `- 软件条目：${report.scan.apps}`,
    `- 扫描目录：${report.scan.dirsScanned}`,
    `- 找到 exe：${report.scan.exeFound}`,
    `- 耗时：${(report.scan.durationMs / 1000).toFixed(1)} 秒`,
    `- 索引文件：\`${report.scan.indexFile}\``,
  ];
  if (report.scan.error) lines.push(`- 扫描错误：${report.scan.error}`);
  if (report.selftest) {
    lines.push('', '## 自测', '', '| 项目 | 结果 | 说明 | 耗时 |', '| --- | --- | --- | --- |');
    for (const item of report.selftest.items) {
      const status = item.status === 'passed' ? '通过' : item.status === 'failed' ? '失败' : '跳过';
      lines.push(`| ${item.name} | ${status} | ${item.detail.replace(/\|/g, '\\|')} | ${(item.ms / 1000).toFixed(1)}s |`);
    }
    const shots = report.selftest.items.flatMap(item => item.screenshots ?? []);
    if (shots.length) lines.push('', '截图：', '', ...shots.map(file => `- \`${file}\``));
  }
  lines.push('', '重新运行：`evolution-computer-use-win init`', '');
  return lines.join('\n');
}

function writeReport(dataDir: string, report: InitReport, name: string): string {
  const file = join(dataDir, name);
  writeFileSync(file, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
  return file;
}

/**
 * 一次初始化。扫描失败也继续跑自测：用户需要知道哪一部分坏了，而不是只看到一句“初始化失败”。
 * 报告只写数据目录，不碰用户的任何程序或配置。
 */
export async function runInit(options: InitOptions): Promise<InitReport> {
  const startedAt = new Date().toISOString();
  const log = options.log ?? (() => {});
  let scan: InitReport['scan'] = {
    ok: false, mode: options.full ? 'full' : 'incremental', apps: 0, dirsScanned: 0, exeFound: 0,
    durationMs: 0, indexFile: indexFile(options.dataDir), error: '扫描没有执行',
  };
  try {
    log(options.full ? '开始完整扫描软件位置…' : '开始增量扫描软件位置…');
    const index = await (options.scan ?? scanApps)({ dataDir: options.dataDir, full: options.full, log });
    scan = {
      ok: true, mode: index.scan.mode, apps: index.apps.length, dirsScanned: index.scan.dirsScanned,
      exeFound: index.scan.exeFound, durationMs: index.scan.durationMs, indexFile: indexFile(options.dataDir),
    };
    log(`软件位置表：${scan.apps} 个程序，${(scan.durationMs / 1000).toFixed(1)} 秒`);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    scan.error = text;
    log(`软件扫描失败：${text}`);
  }

  let selftest: SelftestReport | undefined;
  if (options.selftest !== false) {
    log(options.desktop ? '开始自测…' : '开始自测（桌面控制没打开，桌面项会跳过）…');
    // 自测用一次性浏览器 profile：主浏览器可能正被用户用着，而且 init 结束后不能留下一个看不见的窗口。
    // 目录按进程区分：两个 MCP 连接同时启动时，各自的 init 不能互相杀掉对方刚启动的浏览器。
    const profileDir = join(options.dataDir, 'selftest', `browser-${process.pid}`);
    let temp: Browser | undefined;
    if (!options.selftestRun) {
      try { killBrowser(profileDir); } catch { /* 尽力而为 */ }
      try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
      temp = createBrowser({ profileDir, faults: new Faults(() => {}) });
    }
    try {
      selftest = await (options.selftestRun ?? runSelftest)({
        dataDir: options.dataDir, browser: temp ?? options.browser, ...(options.desktop ? { desktop: options.desktop } : {}),
        allowNetwork: options.allowNetwork, log,
      });
      log(`自测完成：${selftest.ok ? '全部通过' : '有失败项'}`);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      selftest = {
        startedAt, finishedAt: new Date().toISOString(), ok: false,
        items: [{ id: 'selftest', name: '自测框架', status: 'failed', detail: text, ms: 0 }],
      };
      log(`自测失败：${text}`);
    } finally {
      if (temp) {
        try { temp.stop(); } catch { /* 尽力而为 */ }
        try { killBrowser(profileDir); } catch { /* 尽力而为 */ }
        try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
      }
    }
  }

  const report: InitReport = {
    startedAt, finishedAt: new Date().toISOString(), ok: scan.ok && (!selftest || selftest.ok),
    full: Boolean(options.full), scan, ...(selftest ? { selftest } : {}),
  };
  if (options.report !== 'none') {
    mkdirSync(options.dataDir, { recursive: true });
    const name = options.report === 'startup' ? STARTUP_REPORT : INIT_REPORT;
    report.reportJson = writeReport(options.dataDir, report, name);
    const md = join(options.dataDir, name.replace(/\.json$/, '.md'));
    writeFileSync(md, markdown(report), { encoding: 'utf8', mode: 0o600 });
    report.reportMarkdown = md;
  }
  return report;
}

/** 是否已经做过一次用户可见的 init（用于 DSH 每次启动时判断要不要补跑自测）。 */
export function hasInitReport(dataDir: string): boolean {
  return existsSync(initReportFile(dataDir));
}

/** 读索引只用于判断首次启动；坏文件按没有处理，交给扫描重写。 */
export function indexMissing(dataDir: string): boolean {
  return loadIndex(dataDir) === null;
}
