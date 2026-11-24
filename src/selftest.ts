/**
 * computer-use 自测：把关键链路真实跑一遍，产出一份结构化报告。
 *
 * 原则：默认完全离线（只碰 127.0.0.1）；真实网站流程只有显式 allowNetwork 才跑。
 * 每项都有超时，任何异常都收敛成 failed/skipped 项，绝不把整个自测挂死。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from './browser/browser.ts';
import type { Desktop, Listed } from './desktop/desktop.ts';
import { errorText } from './shared/faults.ts';

export type SelftestStatus = 'passed' | 'failed' | 'skipped';

export interface SelftestItem {
  id: string;
  name: string;
  status: SelftestStatus;
  detail: string;
  ms: number;
  screenshots?: string[];
}

export interface SelftestReport {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  items: SelftestItem[];
}

/** 每一项的预算；测试里可以传小值，避免真的等几十秒。 */
export interface SelftestTimeouts {
  environment: number;
  browserLocal: number;
  desktopWindow: number;
  webDemo: number;
  cleanup: number;
}

export interface SelftestDeps {
  dataDir: string;
  browser: Browser;
  desktop?: Desktop;
  allowNetwork?: boolean;
  log?: (line: string) => void;
  /** 仅供测试缩短等待；正常调用不用传。 */
  timeouts?: Partial<SelftestTimeouts>;
}

const DEFAULT_TIMEOUTS: SelftestTimeouts = {
  environment: 15_000,
  browserLocal: 60_000,
  desktopWindow: 60_000,
  webDemo: 90_000,
  cleanup: 15_000,
};

interface Context {
  deps: SelftestDeps;
  /** <dataDir>/selftest 的绝对路径。 */
  dir: string;
  /** yyyyMMdd-HHmmss，一次运行内所有截图共用。 */
  stamp: string;
  log: (line: string) => void;
  timeouts: SelftestTimeouts;
  server?: Server;
  windowProc?: ChildProcess;
  /** 需要清理的临时文件。 */
  tempFiles: string[];
}

interface Outcome {
  status: SelftestStatus;
  detail: string;
  screenshots?: string[];
}

/** 用于把“环境打不开”与“页面打开后步骤失败”区分开。 */
class SkipError extends Error {}

function formatStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 超时就 reject；race 本身会处理落败 promise 的 rejection。 */
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 超时（超过 ${ms}ms）`)), ms);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

function saveShot(ctx: Context, id: string, data: Buffer): string {
  mkdirSync(ctx.dir, { recursive: true });
  const file = join(ctx.dir, `${ctx.stamp}-${id}.png`);
  writeFileSync(file, data);
  return file;
}

async function closeServer(ctx: Context): Promise<void> {
  const server = ctx.server;
  if (!server) return;
  ctx.server = undefined;
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function stopProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    proc.kill();
  } catch {
    /* 进程可能已经退出 */
  }
  if (await waitUntil(() => proc.exitCode !== null || proc.signalCode !== null, 3_000)) return;
  // Windows 上 PowerShell 可能还带着子进程：按 pid 树强杀一次。
  if (proc.pid) {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* 尽力而为 */
    }
    await waitUntil(() => proc.exitCode !== null || proc.signalCode !== null, 3_000);
  }
}

function readTextFile(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  } catch {
    return undefined;
  }
}

/** 轮询结果文件，最多等 ms；返回最后一次读到的内容（没有文件时 undefined）。 */
async function pollFile(file: string, ms: number): Promise<string | undefined> {
  const end = Date.now() + ms;
  let last: string | undefined;
  while (Date.now() < end) {
    last = readTextFile(file);
    if (last !== undefined && last !== '') return last;
    await sleep(200);
  }
  return last;
}

async function waitForWindow(desktop: Desktop, title: string, ms: number): Promise<Listed | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const windows = await desktop.windows();
      const hit = windows.find(entry => entry.title.includes(title));
      if (hit) return hit;
    } catch {
      /* 桌面接口暂时不可用：继续等一会儿 */
    }
    await sleep(300);
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 自测项                                                             */
/* ------------------------------------------------------------------ */

async function checkEnvironment(ctx: Context): Promise<Outcome> {
  const problems: string[] = [];
  if (process.platform !== 'win32') problems.push(`平台是 ${process.platform}，本自测只支持 Windows`);
  try {
    mkdirSync(ctx.dir, { recursive: true });
    const probe = join(ctx.dir, `.write-probe-${process.pid}`);
    writeFileSync(probe, 'ok', 'utf8');
    const back = readFileSync(probe, 'utf8');
    rmSync(probe, { force: true });
    if (back !== 'ok') problems.push('dataDir 写入后读回内容不一致');
  } catch (error) {
    problems.push(`dataDir 不可写：${errorText(error)}`);
  }
  if (problems.length) return { status: 'failed', detail: problems.join('；') };
  return {
    status: 'passed',
    detail: `Node ${process.version} · ${process.platform}/${process.arch} · dataDir 可写 · 自测目录 ${ctx.dir}`,
  };
}

const LOCAL_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Evolution CU Selftest</title></head>
<body>
<h1>computer-use selftest</h1>
<input id="q" />
<button id="go" onclick="document.getElementById('out').textContent = document.getElementById('q').value.toUpperCase()">go</button>
<div id="out"></div>
</body></html>`;

async function checkBrowserLocal(ctx: Context): Promise<Outcome> {
  let browserState = 'running';
  try {
    browserState = ctx.deps.browser.status().state;
  } catch {
    /* status 不可用就继续尝试 */
  }
  if (browserState === 'missing') {
    return { status: 'skipped', detail: '本机没有可用的 Edge/Chrome（browser.status() 为 missing），跳过本地浏览器流程。' };
  }

  const server = createServer((request, response) => {
    if (request.url === '/' || request.url?.startsWith('/?')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(LOCAL_PAGE);
    } else {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  ctx.server = server;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('临时 HTTP server 没有拿到端口');
  const url = `http://127.0.0.1:${address.port}/`;
  const typed = 'hello selftest 42';
  const expected = typed.toUpperCase();
  const screenshots: string[] = [];

  try {
    const result = await ctx.deps.browser.scratch(async page => {
      await page.open(url);
      await page.wait({ anchor: { css: 'input#q' } }, 10_000);
      await page.type({ anchor: { css: 'input#q' } }, typed);
      await page.click({ anchor: { css: 'button#go' } });
      await page.wait({ text: expected }, 10_000);
      const shot = await page.shot();
      screenshots.push(saveShot(ctx, 'browser-local', shot));
      const out = await page.evaluate('return document.querySelector("#out") ? document.querySelector("#out").textContent : ""', {});
      if (String(out) !== expected) {
        throw new Error(`#out 读回的文本是 ${JSON.stringify(out)}，期望 ${JSON.stringify(expected)}`);
      }
      return String(out);
    });
    return {
      status: 'passed',
      detail: `本地页面 ${url} 打开、输入、点击、回读均正确（#out = ${JSON.stringify(result)}）。`,
      screenshots,
    };
  } finally {
    await closeServer(ctx);
  }
}

const WINDOW_SCRIPT = fileURLToPath(new URL('../scripts/selftest-window.ps1', import.meta.url));

async function checkDesktopWindow(ctx: Context): Promise<Outcome> {
  const desktop = ctx.deps.desktop;
  if (!desktop) {
    return { status: 'skipped', detail: '没有传入 desktop（Desktop 未启用），跳过桌面窗口自测。' };
  }
  if (process.platform !== 'win32') {
    return { status: 'skipped', detail: `平台是 ${process.platform}，桌面窗口自测只在 win32 可用。` };
  }
  if (!existsSync(WINDOW_SCRIPT)) {
    return { status: 'skipped', detail: `找不到窗口脚本 ${WINDOW_SCRIPT}` };
  }

  const title = `Evolution CU Selftest ${process.pid}`;
  const resultFile = join(tmpdir(), `evolution-cu-selftest-${process.pid}-${Date.now()}.txt`);
  ctx.tempFiles.push(resultFile);
  rmSync(resultFile, { force: true });

  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = [
    // -WindowStyle Hidden hides PowerShell's own console; windowsHide must stay false,
    // because Node's windowsHide sets STARTUPINFO.wShowWindow=SW_HIDE, which also hides
    // the WinForms window the script creates (verified: the window never appears).
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', WINDOW_SCRIPT,
    '-Title', title,
    '-ResultFile', resultFile,
    '-LifeSeconds', '20',
  ];
  const proc = spawn(powershell, args, { windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'] });
  ctx.windowProc = proc;
  let stderr = '';
  proc.stderr?.on('data', chunk => {
    stderr = (stderr + String(chunk)).slice(-2_000);
  });
  const spawned = await new Promise<{ ok: boolean; error?: string }>(resolve => {
    proc.once('spawn', () => resolve({ ok: true }));
    proc.once('error', error => resolve({ ok: false, error: errorText(error) }));
  });
  if (!spawned.ok) {
    ctx.windowProc = undefined;
    return { status: 'skipped', detail: `无法启动 PowerShell 窗口脚本：${spawned.error ?? '未知错误'}` };
  }

  try {
    const found = await waitForWindow(desktop, title, Math.min(15_000, ctx.timeouts.desktopWindow - 10_000));
    if (!found) {
      const exited = await waitUntil(() => proc.exitCode !== null || proc.signalCode !== null, 1_500);
      if (exited && proc.exitCode !== null && proc.exitCode !== 0) {
        return {
          status: 'failed',
          detail: `窗口脚本异常退出（exit code ${proc.exitCode}）${stderr ? `：${stderr.trim()}` : ''}`,
        };
      }
      return {
        status: 'skipped',
        detail: `窗口「${title}」在等待时间内没有出现（桌面控制可能没有启用）${stderr ? `；脚本输出：${stderr.trim()}` : ''}`,
      };
    }

    const typed = 'selftest 回读 42';
    const screenshots: string[] = [];
    try {
      const opened = await desktop.act({ action: 'open', app: title });
      ctx.log(`[selftest] desktop open: ${opened.text}`);
      const shot = await desktop.act({ action: 'shot' });
      if (!shot.image) throw new Error('desktop shot 没有返回截图');
      screenshots.push(saveShot(ctx, 'desktop-window', shot.image.data));
      // 先点一下输入框再输入：窗口不是前台时键盘焦点可能还在窗口本身，直接 type 会落到窗体而不是输入框。
      await desktop.act({ action: 'click', x: 200, y: 50 });
      await desktop.act({ action: 'type', text: typed });
      // 输入框内容一变就写结果文件；WinForms 按钮在后台模式下收不到鼠标消息，不靠按钮判定。
      const got = await pollFile(resultFile, 15_000);
      if (got === undefined) throw new Error('输入后结果文件没有出现');
      if (got !== typed) throw new Error(`回读结果文件内容是 ${JSON.stringify(got)}，期望 ${JSON.stringify(typed)}`);
      return { status: 'passed', detail: `窗口「${title}」已找到并打开，点击输入框、输入文字并回读一致：${JSON.stringify(got)}。`, screenshots };
    } catch (error) {
      return { status: 'failed', detail: `桌面窗口流程失败：${errorText(error)}`, screenshots };
    }
  } finally {
    await stopProcess(proc);
    ctx.windowProc = undefined;
  }
}

async function checkWebDemo(ctx: Context): Promise<Outcome> {
  if (ctx.deps.allowNetwork !== true) {
    return { status: 'skipped', detail: '未开启 allowNetwork（默认离线），跳过真实网站流程。' };
  }
  const screenshots: string[] = [];
  try {
    await ctx.deps.browser.scratch(async page => {
      try {
        await page.open('https://www.baidu.com/');
      } catch (error) {
        throw new SkipError(`百度打不开（网络/DNS 失败）：${errorText(error)}`);
      }
      await page.wait({ anchor: { css: 'input#kw' } }, 15_000);
      await page.type({ anchor: { css: 'input#kw' } }, '周杰伦');
      await page.click({ anchor: { css: '#su' } });
      await page.wait({ anchor: { css: '#content_left h3 a' } }, 15_000);
      await page.click({ anchor: { css: '#content_left h3 a', nth: 0 } });
      await page.wait({ text: '周杰伦' }, 15_000);
      const shot = await page.shot();
      screenshots.push(saveShot(ctx, 'web-demo', shot));
    });
    return { status: 'passed', detail: '百度搜索“周杰伦”并打开第一个结果成功。', screenshots };
  } catch (error) {
    if (error instanceof SkipError) return { status: 'skipped', detail: error.message };
    return { status: 'failed', detail: `页面已打开，但关键步骤失败：${errorText(error)}`, screenshots };
  }
}

async function checkCleanup(ctx: Context): Promise<Outcome> {
  const notes: string[] = [];
  let ok = true;

  if (ctx.server) {
    try {
      await closeServer(ctx);
      notes.push('临时 HTTP server 已关闭');
    } catch (error) {
      ok = false;
      notes.push(`关闭临时 HTTP server 失败：${errorText(error)}`);
    }
  } else {
    notes.push('临时 HTTP server 已关闭');
  }

  if (ctx.windowProc) {
    try {
      await stopProcess(ctx.windowProc);
      ctx.windowProc = undefined;
      notes.push('临时窗口进程已结束');
    } catch (error) {
      ok = false;
      notes.push(`结束临时窗口进程失败：${errorText(error)}`);
    }
  } else {
    notes.push('没有残留的临时窗口进程');
  }

  for (const file of ctx.tempFiles.splice(0)) {
    try {
      rmSync(file, { force: true });
      notes.push('临时结果文件已删除');
    } catch (error) {
      ok = false;
      notes.push(`删除临时文件失败 ${file}：${errorText(error)}`);
    }
  }
  if (!existsSync(ctx.dir)) {
    ok = false;
    notes.push(`自测目录不见了：${ctx.dir}`);
  }
  return { status: ok ? 'passed' : 'failed', detail: notes.join('；') };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                             */
/* ------------------------------------------------------------------ */

type Check = (ctx: Context) => Promise<Outcome>;

const CHECKS: [string, string, Check, keyof SelftestTimeouts][] = [
  ['environment', '环境检查', checkEnvironment, 'environment'],
  ['browser-local', '本地浏览器流程', checkBrowserLocal, 'browserLocal'],
  ['desktop-window', '桌面窗口流程', checkDesktopWindow, 'desktopWindow'],
  ['web-demo', '真实网站流程（可选）', checkWebDemo, 'webDemo'],
  ['cleanup', '清理', checkCleanup, 'cleanup'],
];

async function runItem(ctx: Context, id: string, name: string, check: Check, budget: number): Promise<SelftestItem> {
  const started = Date.now();
  let outcome: Outcome;
  try {
    outcome = await withTimeout(check(ctx), budget, name);
  } catch (error) {
    outcome = { status: 'failed', detail: errorText(error) };
  }
  const item: SelftestItem = {
    id,
    name,
    status: outcome.status,
    detail: outcome.detail,
    ms: Date.now() - started,
  };
  if (outcome.screenshots?.length) item.screenshots = outcome.screenshots;
  try {
    ctx.log(`[selftest] ${id}: ${item.status} (${item.ms}ms) ${item.detail}`);
  } catch {
    /* 日志坏了不能弄坏报告 */
  }
  return item;
}

/**
 * 跑完整自测。始终 resolve：任何单项失败/异常都记录在报告里。
 */
export async function runSelftest(deps: SelftestDeps): Promise<SelftestReport> {
  const startedAt = new Date();
  const stamp = formatStamp(startedAt);
  const ctx: Context = {
    deps,
    dir: resolve(deps.dataDir, 'selftest'),
    stamp,
    log: deps.log ?? (() => {}),
    timeouts: { ...DEFAULT_TIMEOUTS, ...deps.timeouts },
    tempFiles: [],
  };

  const items: SelftestItem[] = [];
  for (const [id, name, check, budgetKey] of CHECKS) {
    items.push(await runItem(ctx, id, name, check, ctx.timeouts[budgetKey]));
  }

  const finishedAt = new Date();
  const ok = items.length > 0 && items.every(item => item.status !== 'failed') && items.some(item => item.status === 'passed');
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    ok,
    items,
  };
}
