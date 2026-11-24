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
import type { Desktop, DesktopResult, Listed } from './desktop/desktop.ts';
import { errorText } from './shared/faults.ts';

export type SelftestStatus = 'passed' | 'failed' | 'skipped';

export interface SelftestSubcheck {
  id: string;
  name: string;
  status: SelftestStatus;
  detail: string;
}

export interface SelftestItem {
  id: string;
  name: string;
  status: SelftestStatus;
  detail: string;
  ms: number;
  screenshots?: string[];
  subchecks?: SelftestSubcheck[];
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
  desktopWindow: 120_000,
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
  subchecks?: SelftestSubcheck[];
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

const HOLO_SCRIPT = fileURLToPath(new URL('../scripts/selftest-holo.ps1', import.meta.url));

interface HoloBox { x: number; y: number; w: number; h: number }
interface HoloReady {
  pid: number;
  hwnd: number;
  width: number;
  height: number;
  zones: Record<string, HoloBox>;
  boxes: Record<string, HoloBox>;
}
interface HoloEvent { t: number; type: string; [key: string]: unknown }

function readHoloEvents(file: string): HoloEvent[] {
  const events: HoloEvent[] = [];
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as HoloEvent;
        if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') events.push(parsed);
      } catch {
        /* 半行写入时下一轮再读 */
      }
    }
  } catch {
    /* 文件还没出现 */
  }
  return events;
}

async function waitForHoloEvents(file: string, done: (events: HoloEvent[]) => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (done(readHoloEvents(file))) return;
    await sleep(100);
  }
}

async function readHoloReady(file: string, ms: number): Promise<HoloReady> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(file)) {
      try {
        const ready = JSON.parse(readFileSync(file, 'utf8')) as HoloReady;
        if (ready && ready.zones && ready.boxes) return ready;
      } catch {
        /* 还在写 */
      }
    }
    await sleep(100);
  }
  throw new Error('HUD 的 ready 文件没有出现：' + file);
}

function centerOf(box: HoloBox): { x: number; y: number } {
  return { x: box.x + Math.round(box.w / 2), y: box.y + Math.round(box.h / 2) };
}

async function checkDesktopWindow(ctx: Context): Promise<Outcome> {
  const desktop = ctx.deps.desktop;
  if (!desktop) {
    return { status: 'skipped', detail: '没有传入 desktop（Desktop 未启用），跳过桌面窗口自测。' };
  }
  if (process.platform !== 'win32') {
    return { status: 'skipped', detail: '平台是 ' + process.platform + '，桌面窗口自测只在 win32 可用。' };
  }
  if (!existsSync(HOLO_SCRIPT)) {
    return { status: 'skipped', detail: '找不到 HUD 窗口脚本 ' + HOLO_SCRIPT };
  }

  const title = 'Evolution CU Holo ' + process.pid;
  const eventFile = join(ctx.dir, ctx.stamp + '-desktop-events.jsonl');
  const readyFile = join(ctx.dir, ctx.stamp + '-desktop-ready.json');
  const docFile = join(ctx.dir, ctx.stamp + '-document.txt');
  ctx.tempFiles.push(eventFile, readyFile, docFile);
  for (const file of [eventFile, readyFile, docFile]) rmSync(file, { force: true });

  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = [
    // -WindowStyle Hidden hides PowerShell's own console; windowsHide must stay false,
    // because Node's windowsHide sets STARTUPINFO.wShowWindow=SW_HIDE, which also hides
    // the WinForms window the script creates (verified: the window never appears).
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', HOLO_SCRIPT,
    '-Title', title,
    '-EventFile', eventFile,
    '-ReadyFile', readyFile,
    '-LifeSeconds', '90',
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
    return { status: 'failed', detail: 'HUD 窗口进程启动失败：' + (spawned.error ?? '未知错误') };
  }

  const screenshots: string[] = [];
  const subchecks: SelftestSubcheck[] = [];
  const add = (id: string, name: string, status: SelftestStatus, detail: string) => {
    subchecks.push({ id, name, status, detail });
  };
  const runCheck = async (id: string, name: string, work: () => string | Promise<string>): Promise<void> => {
    try {
      add(id, name, 'passed', await work());
    } catch (error) {
      add(id, name, 'failed', errorText(error));
    }
  };
  const save = (id: string, result: DesktopResult) => {
    if (result.image) screenshots.push(saveShot(ctx, id, result.image.data));
  };

  try {
    const ready = await readHoloReady(readyFile, 20_000);
    const zone = (name: string): HoloBox => {
      const box = ready.zones[name];
      if (!box) throw new Error('HUD 没有报告 ' + name + ' 区域');
      return box;
    };
    const box = (name: string): HoloBox => {
      const found = ready.boxes[name];
      if (!found) throw new Error('HUD 没有报告 ' + name + ' 输入框');
      return found;
    };

    let actionError = '';
    try {
      const opened = await desktop.act({ action: 'open', app: title });
      save('desktop-holo', opened);
      await desktop.act({ action: 'click', x: centerOf(zone('LMB')).x, y: centerOf(zone('LMB')).y });
      await desktop.act({ action: 'click', x: centerOf(zone('DBL')).x, y: centerOf(zone('DBL')).y, double: true });
      await desktop.act({ action: 'click', x: centerOf(zone('RMB')).x, y: centerOf(zone('RMB')).y, right: true });
      await desktop.act({ action: 'scroll', x: centerOf(zone('SCROLL')).x, y: centerOf(zone('SCROLL')).y, direction: 'down' });
      await desktop.act({ action: 'drag', x: zone('DRAG').x + 25, y: zone('DRAG').y + 30, x2: zone('DRAG').x + 215, y2: zone('DRAG').y + 65 });
      await desktop.act({ action: 'move', x: centerOf(zone('MOVE')).x, y: centerOf(zone('MOVE')).y });
      await desktop.act({ action: 'click', x: centerOf(box('stream')).x, y: centerOf(box('stream')).y });
      await desktop.act({ action: 'type', text: 'FLOW-9X', stream: true });
      await desktop.act({ action: 'click', x: centerOf(box('plain')).x, y: centerOf(box('plain')).y });
      await desktop.act({ action: 'type', text: 'BURST-7Z' });
      await desktop.act({ action: 'click', x: centerOf(box('stream')).x, y: centerOf(box('stream')).y });
      await desktop.act({ action: 'press', key: 'ctrl+s' });
    } catch (error) {
      actionError = errorText(error);
    }

    await waitForHoloEvents(eventFile, events => {
      const stream = events.some(event => event.type === 'text' && event.source === 'stream' && event.text === 'FLOW-9X');
      const plain = events.some(event => event.type === 'text' && event.source === 'plain' && event.text === 'BURST-7Z');
      const key = events.some(event => event.type === 'key' && event.key === 'S' && event.control === true);
      return stream && plain && key;
    }, actionError ? 3_000 : 8_000);

    const events = readHoloEvents(eventFile);
    const trouble = (what: string) => actionError ? what + '（动作序列失败：' + actionError + '）' : what;

    await runCheck('left-click', '左键单击', () => {
      const event = events.find(item => item.type === 'click' && item.zone === 'LMB');
      if (!event) throw new Error(trouble('没收到 LMB 单击事件'));
      return '已捕获 LMB 单击 (' + String(event.x) + ',' + String(event.y) + ')。';
    });
    await runCheck('double-click', '双击', () => {
      const event = events.find(item => item.type === 'double' && item.zone === 'DBL');
      if (!event) throw new Error(trouble('没收到 DBL 双击事件'));
      return '已捕获 DBL 双击 (' + String(event.x) + ',' + String(event.y) + ')。';
    });
    await runCheck('right-click', '右键单击', () => {
      const event = events.find(item => item.type === 'right' && item.zone === 'RMB');
      if (!event) throw new Error(trouble('没收到 RMB 右键事件'));
      return '已捕获 RMB 右键 (' + String(event.x) + ',' + String(event.y) + ')。';
    });
    await runCheck('scroll', '滚动', () => {
      const event = events.find(item => item.type === 'scroll' && Number(item.delta) !== 0);
      if (!event) throw new Error(trouble('没收到滚动事件'));
      return '已捕获滚轮 delta=' + String(event.delta) + '。';
    });
    await runCheck('drag', '拖动', () => {
      const event = events.find(item => item.type === 'drag' && Number(item.distance) >= 100);
      if (!event) throw new Error(trouble('没收到拖动事件，或拖动距离太小'));
      return '已捕获拖动 (' + String(event.x1) + ',' + String(event.y1) + ')→(' + String(event.x2) + ',' + String(event.y2) + ')，距离 ' + String(event.distance) + 'px。';
    });
    await runCheck('move', '无点击移动鼠标', () => {
      const event = events.find(item => item.type === 'move' && item.zone === 'MOVE');
      if (!event) throw new Error(trouble('没收到 MOVE 悬停事件'));
      return '已捕获悬停移动 (' + String(event.x) + ',' + String(event.y) + ')，没有点击。';
    });
    const streamTexts = events.filter(item => item.type === 'text' && item.source === 'stream');
    const plainTexts = events.filter(item => item.type === 'text' && item.source === 'plain');
    const streamSpan = streamTexts.length > 1 ? Number(streamTexts[streamTexts.length - 1].t) - Number(streamTexts[0].t) : 0;
    const plainSpan = plainTexts.length > 1 ? Number(plainTexts[plainTexts.length - 1].t) - Number(plainTexts[0].t) : 0;
    await runCheck('stream-input', '流式键盘输入', () => {
      const final = streamTexts.length ? String(streamTexts[streamTexts.length - 1].text) : '';
      if (final !== 'FLOW-9X') throw new Error(trouble('流式输入框最终内容是 ' + JSON.stringify(final)));
      if (streamSpan < 150) throw new Error('流式输入只用 ' + streamSpan + 'ms，没有形成逐字流');
      return '流式输入 ' + JSON.stringify(final) + '，用时 ' + streamSpan + 'ms。';
    });
    await runCheck('plain-input', '非流式键盘输入', () => {
      const final = plainTexts.length ? String(plainTexts[plainTexts.length - 1].text) : '';
      if (final !== 'BURST-7Z') throw new Error(trouble('非流式输入框最终内容是 ' + JSON.stringify(final)));
      if (!(plainSpan < streamSpan)) throw new Error('非流式输入用时 ' + plainSpan + 'ms，没有快于流式 ' + streamSpan + 'ms');
      return '非流式输入 ' + JSON.stringify(final) + '，用时 ' + plainSpan + 'ms。';
    });
    await runCheck('shortcut', '键盘快捷键输入', () => {
      const event = events.find(item => item.type === 'key' && item.key === 'S' && item.control === true);
      if (!event) throw new Error(trouble('没收到 Ctrl+S 快捷键事件'));
      return '已捕获 CTRL+S（key=' + String(event.key) + '，control=true）。';
    });

    let appOpened = false;
    await runCheck('open-app', '打开应用', async () => {
      const notepad = join(systemRoot, 'System32', 'notepad.exe');
      if (!existsSync(notepad)) throw new Error('找不到记事本 ' + notepad);
      const result = await desktop.act({ action: 'open', path: notepad });
      if (!result.text.includes('已启动')) throw new Error('打开应用返回：' + result.text.slice(0, 160));
      appOpened = true;
      save('desktop-app-open', result);
      return '已启动记事本，窗口出现。';
    });
    await runCheck('close-app', '关闭应用', async () => {
      if (!appOpened) throw new Error('应用没有打开，无法验证关闭');
      const result = await desktop.act({ action: 'close' });
      if (!result.text.includes('已关闭')) throw new Error('关闭应用返回：' + result.text.slice(0, 160));
      return result.text.trim();
    });

    let docOpened = false;
    await runCheck('open-doc', '打开文档', async () => {
      writeFileSync(docFile, 'Evolution computer-use diagnostic document.\nGenerated by init selftest.\n', 'utf8');
      const result = await desktop.act({ action: 'open', file: docFile });
      if (!result.text.includes('已')) throw new Error('打开文档返回：' + result.text.slice(0, 160));
      docOpened = true;
      save('desktop-doc-open', result);
      return '已用默认程序打开文档 ' + docFile + '，窗口出现。';
    });
    await runCheck('close-doc', '关闭文档', async () => {
      if (!docOpened) throw new Error('文档没有打开，无法验证关闭');
      const result = await desktop.act({ action: 'close' });
      if (!result.text.includes('已关闭')) throw new Error('关闭文档返回：' + result.text.slice(0, 160));
      return result.text.trim();
    });

    try {
      const back = await desktop.act({ action: 'open', app: title });
      save('desktop-holo-final', back);
    } catch {
      /* HUD 可能已经到寿命；截图不是判定条件 */
    }

    const failed = subchecks.filter(item => item.status === 'failed');
    const passed = subchecks.length - failed.length;
    if (!subchecks.length) return { status: 'failed', detail: '桌面诊断没有产生任何子项。', screenshots };
    if (failed.length) {
      return {
        status: 'failed',
        detail: '桌面诊断 ' + passed + '/' + subchecks.length + ' 项通过；失败：' + failed.map(item => item.name).join('、') + '。',
        screenshots,
        subchecks,
      };
    }
    return {
      status: 'passed',
      detail: '桌面诊断 ' + subchecks.length + ' 项全部通过：左键、双击、右键、滚动、拖动、无点击移动、流式输入、非流式输入、快捷键、打开/关闭应用、打开/关闭文档。',
      screenshots,
      subchecks,
    };
  } catch (error) {
    const tail = stderr ? '（PowerShell：' + stderr.slice(-300) + '）' : '';
    return { status: 'failed', detail: '桌面诊断失败：' + errorText(error) + tail, screenshots, ...(subchecks.length ? { subchecks } : {}) };
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
  if (outcome.subchecks?.length) item.subchecks = outcome.subchecks;
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
