#!/usr/bin/env node
/**
 * Isolated browser surface probe —— task-77 / C16 窗口位移校准试验（只写脚本，不运行）
 *
 * 目的
 * ----
 * 在一个由本脚本自己启动、全新 profile、独有调试端口的隔离浏览器实例里，用真实 CDP 的
 * Browser.getWindowForTarget -> windowId -> Browser.setWindowBounds 制造一次**可观察、可复现、可恢复**的
 * 窗口位移，并要求同一次 helper(content) 的原生窗口/renderer 物理矩形出现**唯一的因果变化**，
 * 以此建立 “CDP windowId ↔ 原生 HWND” 的行为因果绑定，并逐轴量出该局部段的 DIP→物理像素因子。
 *
 * 这个脚本刻意不做的事
 * --------------------
 * - 不运行于生产链路；不写 multi-pointer-state / 生产 mode / companion；不驱动任何指针；不输出物理坐标。
 * - 不改 src/ 任何文件；只 import 已 build 的 lib/。
 * - 不 activateTarget / bringToFront；不导航用户已打开的标签页（这里只有本实例自己那一个 tab）。
 * - 不对任何未经核实的 windowId 调 setWindowBounds；不按 profile 路径 like 匹配去杀进程。
 * - 不删除 profile 目录（R12 待用户确认）。
 * - 不声称 same-surface 已证，不声称 A16 / Q5 通过。
 *
 * 视觉证据之外的门禁（见 task-77 回执 A–F）
 * ----------------------------------------
 * A. 只在该 browser socket 上发 Browser.close，且只在 端口/profile/PID 三方核实之后；关不掉就明确记
 *    cleanup 未确认并留证据，绝不按路径模糊匹配杀进程。
 * B. helper(browserProfile) 的分类必须与传入 PID 集合完整、互不重叠、无外来；unknown 必须为空、complete 必须为真；
 *    多个 matched 一律 unknown（不靠唯一性凑结论）。
 * C. 不用 “DIP delta × 最终 dpi/96” 推跨屏变换：只在 before/after 同一台显示器、dpi 不变、可确认的局部段做位移，
 *    并两次复现；测得的每轴因子只与 GetDpiForWindow 交叉核验，不充绝对坐标转换证明。
 * D. 只比较本 profile 枚举到的窗口，不声称其他用户窗口未被动过。
 * E. verdict 只叫 windowIdHwndCausalOnly；单页/单 renderer 只是**实验不变量**，不写成 proven。
 * F. 每笔 CDP 有超时、总时限有界；恢复与清理写在 finally 里，最终以**回读**判定，不做 false success。
 *
 * 用法
 * ----
 *   node scripts/browser-surface-probe.mjs
 * 前置：npm run typecheck && npm run build（lib/ 必须含本脚本用到的导出，preflight 会检查）。
 * 输出：artifacts/browser-surface-probe-<ts>/report.json + stdout 一行摘要；退出码
 *   0 = 得到 windowIdHwndCausalOnly，且 cleanup.ok && cleanup.browserClosed && (restore 不存在或 ok)
 *   2 = unknown / stopped / cleanup 未确认（证据齐全但没能证明或没确认收尾）
 *   3 = stale build（lib 缺导出，未启动浏览器）
 *   4 = 未预期异常（已尽力恢复与清理）
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 测试页：自含、无网络、无凭据、无第三方的普通渲染文档。 */
const TEST_HTML = [
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>surface probe</title>',
  '<style>html,body{margin:0;padding:0;height:100%}body{background:#fff;color:#111;',
  'font:16px/1.5 "Segoe UI",system-ui,sans-serif}h1{margin:24px;font-size:20px}</style></head>',
  '<body><h1>surface probe</h1><p>isolated window-displacement calibration</p></body></html>',
].join('');
const TEST_DATA_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(TEST_HTML);

/** 两次位移：互质、足够大而不易被窗口最小步进吃掉，方向相反以识别串扰。 */
const MOVE_A = { dx: 211, dy: -97 };
const MOVE_B = { dx: -137, dy: 83 };

const CDP_TIMEOUT_MS = 5_000;      // 每笔 CDP
const LAUNCH_TIMEOUT_MS = 20_000;  // 浏览器启动
const HELPER_CALL_MS = 30_000;     // helper 单次（driver 默认）
const TOTAL_BUDGET_MS = 90_000;    // 全流程硬上限
const CLOSE_CONFIRM_MS = 10_000;   // 等 Browser.close 生效
const SETTLE_MS = 350;             // 改窗口 bounds 后等合成器/枚举稳定

const PHYSICAL_UNITS = 'physical-screen-pixels';
const RENDER_WIDGET_CLASS = 'Chrome_RenderWidgetHostHWND';
const PIXEL_TOLERANCE = 2;         // 窗口矩形位移 vs 期望位移
const CHILD_TOLERANCE = 1;         // 子窗口相对父窗口 / 回读比较
const FACTOR_RELATIVE_TOLERANCE = 0.02; // 两次位移因子复现 / 与 dpi/96 交叉核验
const ALIGN_TOLERANCE = 0.005;     // 内容区比例与 dpiScale 的交叉核验（仅证据）

// 清理阶段预算：保留给 reverify / close / driver.stop，restore 耗尽也要尝试 stop。
// settle3 + restore25 + reverify12 + close10 + stop8 = 58s，总界 60s。
const CLEANUP_SETTLE_MS = 3_000;
const CLEANUP_RESTORE_MS = 25_000;
const CLEANUP_REVERIFY_MS = 12_000;
const CLEANUP_CLOSE_MS = 10_000;
const CLEANUP_STOP_MS = 8_000;
const CLEANUP_TOTAL_MS = 60_000;
const CLOSE_STREAK = 2;         // 连续多少次严格 closed 才判关闭
const CLOSE_POLL_MS = 500;      // 关闭轮询间隔
const CLOSE_OBSERVE_MS = 1_200; // 单次 TCP/HTTP 观测超时

class Stopped extends Error {
  constructor(code, detail) { super(code); this.name = 'Stopped'; this.code = code; this.detail = detail; }
}
class StaleBuild extends Error {
  constructor(missing) { super('stale build'); this.name = 'StaleBuild'; this.missing = missing; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPosInt = value => Number.isInteger(value) && value > 0;
const isNum = value => typeof value === 'number' && Number.isFinite(value);
const isRect = value => isRecord(value) && isNum(value.x) && isNum(value.y) && isNum(value.width) && isNum(value.height) && value.width > 0 && value.height > 0;
// helper 的原始可测矩形：有限 x/y/w/h，宽高允许合法 0；null/缺字段/NaN/负宽高都不是可测矩形，不能补 0。
const isRawRect = value => isRecord(value) && isNum(value.x) && isNum(value.y) && isNum(value.width) && isNum(value.height) && value.width >= 0 && value.height >= 0;
const near = (a, b, tolerance) => isNum(a) && isNum(b) && Math.abs(a - b) <= tolerance;
const round = value => (isNum(value) ? Math.round(value * 1000) / 1000 : value);

function requireExport(modules, specifier, names) {
  const module = modules[specifier];
  const missing = names.filter(name => module === undefined || module[name] === undefined);
  if (missing.length) throw new StaleBuild(missing.map(name => specifier + ' -> ' + name));
}

/** helper(content) 的回包：单位必须是物理像素、布尔必须是布尔、矩形必须真实。任何一项不对就整包不可用。 */
function readContent(answer, where) {
  if (!isRecord(answer)) throw new Stopped('content-not-object', { where });
  const { units, dpiAwareness, windows, renderer, rendererTruncated } = answer;
  if (units !== PHYSICAL_UNITS) throw new Stopped('content-units', { where, units });
  if (dpiAwareness !== 2) throw new Stopped('content-dpi-awareness', { where, dpiAwareness });
  if (!Array.isArray(windows) || !Array.isArray(renderer)) throw new Stopped('content-shape', { where });
  if (typeof rendererTruncated !== 'boolean') throw new Stopped('content-truncated-flag', { where });
  if (rendererTruncated) throw new Stopped('content-renderer-truncated', { where });

  const parsedWindows = windows.map(value => {
    if (!isRecord(value)) throw new Stopped('content-window-not-object', { where });
    const { hwnd, pid, className, title, visible, minimized, cloaked, dpi, windowRect, frameRect, clientRect } = value;
    if (!isPosInt(hwnd) || !isPosInt(pid)) throw new Stopped('content-window-ids', { where, hwnd, pid });
    if (typeof className !== 'string' || typeof title !== 'string') throw new Stopped('content-window-text', { where, hwnd });
    if (typeof visible !== 'boolean' || typeof minimized !== 'boolean' || typeof cloaked !== 'boolean') {
      throw new Stopped('content-window-flags', { where, hwnd });
    }
    const eligible = visible && !minimized && !cloaked;
    if (!isRawRect(windowRect) || !isRawRect(clientRect)) {
      throw new Stopped('content-window-rect', { where, hwnd, visible, minimized, cloaked, eligible, windowRect, frameRect, clientRect });
    }
    if (dpi !== null && !(isNum(dpi) && dpi > 0)) throw new Stopped('content-window-dpi', { where, hwnd, dpi });
    if (frameRect !== null && !isRawRect(frameRect)) {
      throw new Stopped('content-window-frame-rect', { where, hwnd, visible, minimized, cloaked, eligible, windowRect, frameRect, clientRect });
    }
    if (eligible && frameRect !== null && !isRect(frameRect)) {
      throw new Stopped('content-window-frame-rect', { where, hwnd, visible, minimized, cloaked, eligible, windowRect, frameRect, clientRect });
    }
    // 隐藏/非候选窗口的 0 面积是合法原始测量，必须保留供全 profile diff；可见可绘候选必须正面积。
    if (eligible && (!isRect(windowRect) || !isRect(clientRect))) {
      throw new Stopped('content-window-not-drawable', { where, hwnd, visible, minimized, cloaked, eligible, windowRect, frameRect, clientRect });
    }
    return { hwnd, pid, className, title, visible, minimized, cloaked, dpi, windowRect, frameRect, clientRect, eligible };
  });

  const parsedRenderers = renderer.map(value => {
    if (!isRecord(value)) throw new Stopped('content-renderer-not-object', { where });
    const { hwnd, parent, className, pid, visible, clientRect } = value;
    if (!isPosInt(hwnd) || !isPosInt(parent) || !isPosInt(pid)) throw new Stopped('content-renderer-ids', { where, hwnd, parent, pid });
    if (typeof className !== 'string') throw new Stopped('content-renderer-class', { where, hwnd });
    if (typeof visible !== 'boolean') throw new Stopped('content-renderer-visible', { where, hwnd });
    if (!isRawRect(clientRect)) throw new Stopped('content-renderer-rect', { where, hwnd, parent, visible, clientRect });
    // 隐藏 renderer 的 0 面积保留；可见 renderer 是绘制候选，必须正面积。
    if (visible && !isRect(clientRect)) throw new Stopped('content-renderer-not-drawable', { where, hwnd, parent, visible, clientRect });
    return { hwnd, parent, className, pid, visible, clientRect };
  });

  return { units, dpiAwareness, windows: parsedWindows, renderer: parsedRenderers, rendererTruncated };
}

/** helper(browserProfile) 的回包：分类必须与传入 PID 集合完整、互不重叠、无外来。 */
function readProfileCheck(answer, expectedPids) {
  if (!isRecord(answer)) throw new Stopped('profile-not-object');
  const { status, complete, incompleteReason, expected, candidates, matched, unmatched, unknown } = answer;
  const listOk = value => Array.isArray(value) && value.every(entry => isPosInt(entry));
  if (typeof status !== 'string' || !['matched', 'mismatch', 'unknown'].includes(status)) throw new Stopped('profile-status', { status });
  if (typeof complete !== 'boolean') throw new Stopped('profile-complete', { complete });
  if (incompleteReason !== null && typeof incompleteReason !== 'string') throw new Stopped('profile-incomplete-reason', { incompleteReason });
  if (complete === true && incompleteReason !== null) throw new Stopped('profile-incomplete-reason', { incompleteReason });
  if (typeof expected !== 'string') throw new Stopped('profile-expected', { expected });
  if (!isPosInt(candidates)) throw new Stopped('profile-candidates', { candidates });
  if (!listOk(matched) || !listOk(unmatched)) throw new Stopped('profile-lists');
  if (!Array.isArray(unknown) || !unknown.every(entry => isRecord(entry) && isPosInt(entry.pid) && typeof entry.reason === 'string')) {
    throw new Stopped('profile-unknown-list');
  }
  const unknownPids = unknown.map(entry => entry.pid);
  const seen = new Set();
  for (const pid of [...matched, ...unmatched, ...unknownPids]) {
    if (seen.has(pid)) throw new Stopped('profile-partition-overlap', { pid });
    seen.add(pid);
  }
  const wanted = new Set(expectedPids);
  const foreign = [...seen].filter(pid => !wanted.has(pid));
  const absent = [...wanted].filter(pid => !seen.has(pid));
  if (foreign.length) throw new Stopped('profile-partition-foreign', { foreign });
  if (absent.length) throw new Stopped('profile-partition-absent', { absent });
  return { status, complete, incompleteReason, expected, candidates, matched, unmatched, unknown, unknownPids };
}

/**
 * Browser.getWindowBounds 的回包只有 bounds。CDP 规定 minimized/maximized/fullscreen 不能带
 * left/top/width/height，所以这里允许"只有 windowState"的回包（交由调用方归一化后再取数值矩形）；
 * 但只要出现数值，就必须四个都齐且为正——缺值仍算失败，绝不补 0。
 */
function readBoundsOnly(answer) {
  const bounds = isRecord(answer) && isRecord(answer.bounds) ? answer.bounds : null;
  if (!bounds) return null;
  const { left, top, width, height, windowState } = bounds;
  if (windowState !== undefined && typeof windowState !== 'string') return null;
  const anyNumber = [left, top, width, height].some(value => value !== undefined);
  if (!anyNumber) {
    return typeof windowState === 'string' ? { windowState } : null;
  }
  if (!isNum(left) || !isNum(top) || !isNum(width) || !isNum(height) || width <= 0 || height <= 0) return null;
  return { left, top, width, height, windowState };
}

/**
 * Browser.getWindowForTarget 的回包同时有 windowId 与 bounds；窗口为 maximized/fullscreen 时
 * bounds 只带 windowState，因此这里只强制要求 windowId，bounds 交给 readBoundsOnly 宽容解析。
 */
function readWindowForTarget(answer) {
  if (!isRecord(answer)) return null;
  const windowId = answer.windowId;
  if (!Number.isInteger(windowId) || windowId < 0) return null;
  return { windowId, bounds: readBoundsOnly(answer) };
}

function rectDelta(before, after) {
  return { dx: after.x - before.x, dy: after.y - before.y, dw: after.width - before.width, dh: after.height - before.height };
}

/**
 * 同一实例内两帧原生测量的差：只回答“哪些窗口/子窗口动了，动了多少”，不做任何身份推断。
 * 只枚举本 profile 的窗口，因此结论只覆盖本 profile。
 */
function diffFrames(before, after, intendedHwnd) {
  const beforeByHwnd = new Map(before.windows.map(win => [win.hwnd, win]));
  const afterByHwnd = new Map(after.windows.map(win => [win.hwnd, win]));
  const added = [...afterByHwnd.keys()].filter(hwnd => !beforeByHwnd.has(hwnd));
  const removed = [...beforeByHwnd.keys()].filter(hwnd => !afterByHwnd.has(hwnd));
  if (added.length || removed.length) throw new Stopped('window-set-changed', { added, removed });

  const rows = after.windows.map(win => {
    const prior = beforeByHwnd.get(win.hwnd);
    const children = after.renderer.filter(entry => entry.parent === win.hwnd && entry.className === RENDER_WIDGET_CLASS);
    const priorChildren = new Map(before.renderer
      .filter(entry => entry.parent === win.hwnd && entry.className === RENDER_WIDGET_CLASS)
      .map(entry => [entry.hwnd, entry]));
    const childRows = children.map(entry => {
      const older = priorChildren.get(entry.hwnd);
      return {
        hwnd: entry.hwnd,
        visible: entry.visible,
        clientRect: entry.clientRect,
        delta: older ? rectDelta(older.clientRect, entry.clientRect) : null,
        appeared: !older,
      };
    });
    return {
      hwnd: win.hwnd,
      intended: win.hwnd === intendedHwnd,
      visible: win.visible,
      minimized: win.minimized,
      cloaked: win.cloaked,
      dpi: win.dpi,
      windowRect: win.windowRect,
      clientRect: win.clientRect,
      windowDelta: rectDelta(prior.windowRect, win.windowRect),
      clientDelta: rectDelta(prior.clientRect, win.clientRect),
      children: childRows,
    };
  });
  return { rows, added, removed };
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Stopped('cdp-timeout', { label, ms })), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function fetchJson(url, timeoutMs = 3_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
  return await response.json();
}

function portOfUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch { return null; }
}

/** connectCdp 返回 Promise；必须先 await 再保存，避免把 Promise 当 Cdp 调 send。 */
async function openCdp(connectCdpFn, url, timeoutMs, label) {
  if (typeof connectCdpFn !== 'function') throw new Stopped('cdp-connect-missing', { label });
  const cdp = await connectCdpFn(url, { timeoutMs });
  if (!cdp || typeof cdp.send !== 'function' || typeof cdp.close !== 'function') {
    throw new Stopped('cdp-shape', { label, got: cdp === null ? 'null' : typeof cdp });
  }
  return cdp;
}

function closeCdpQuietly(cdp, label, evidence) {
  if (!cdp) return false;
  try {
    cdp.close();
    return true;
  } catch (error) {
    if (Array.isArray(evidence)) evidence.push(label + ' 关闭失败: ' + errorText(error));
    return false;
  }
}

function disposeArbiterQuietly(arbiter, evidence) {
  if (!arbiter) return false;
  try {
    arbiter.dispose();
    return true;
  } catch (error) {
    if (Array.isArray(evidence)) evidence.push('arbiter.dispose 失败: ' + errorText(error));
    return false;
  }
}

/**
 * 一次位移的判定：只允许“预期窗口按 dpi 因子移动、其客户区与 renderer 同步、其他窗口与其他 renderer 一律不动”。
 * 任一不成立就 ok:false，并逐条写下原因（不吞成一句 unknown）。
 */
function assessMove(diff, dip, beforeContent) {
  const reasons = [];
  const intended = diff.rows.find(row => row.intended);
  if (!intended) return { ok: false, reasons: ['intended-window-missing'], intended: null, othersMoved: [], expected: null, factors: {}, scale: null };

  const beforeWin = beforeContent.windows.find(win => win.hwnd === intended.hwnd) || null;
  const dpi = intended.dpi;
  const dpiBefore = beforeWin ? beforeWin.dpi : null;
  if (!beforeWin) reasons.push('intended-missing-before');
  if (!isNum(dpi) || dpi <= 0) reasons.push('intended-dpi-unknown');
  if (beforeWin && dpiBefore !== dpi) reasons.push('intended-dpi-changed');

  const othersMoved = diff.rows.filter(row => !row.intended && (
    Math.abs(row.windowDelta.dx) > CHILD_TOLERANCE || Math.abs(row.windowDelta.dy) > CHILD_TOLERANCE ||
    Math.abs(row.windowDelta.dw) > CHILD_TOLERANCE || Math.abs(row.windowDelta.dh) > CHILD_TOLERANCE ||
    Math.abs(row.clientDelta.dx) > CHILD_TOLERANCE || Math.abs(row.clientDelta.dy) > CHILD_TOLERANCE ||
    Math.abs(row.clientDelta.dw) > CHILD_TOLERANCE || Math.abs(row.clientDelta.dh) > CHILD_TOLERANCE));
  if (othersMoved.length) reasons.push('other-windows-moved');

  if (!intended.visible || intended.minimized || intended.cloaked) reasons.push('intended-not-visible');

  const scale = isNum(dpi) && dpi > 0 ? dpi / 96 : null;
  const expected = scale === null ? null : { dx: dip.dx * scale, dy: dip.dy * scale };
  if (expected) {
    if (!near(intended.windowDelta.dx, expected.dx, PIXEL_TOLERANCE)) reasons.push('window-dx-mismatch');
    if (!near(intended.windowDelta.dy, expected.dy, PIXEL_TOLERANCE)) reasons.push('window-dy-mismatch');
  }

  // 客户区是窗口外框的子矩形：窗口整体移动时它必须同量移动，且尺寸不变。
  if (Math.abs(intended.clientDelta.dx - intended.windowDelta.dx) > CHILD_TOLERANCE) reasons.push('client-dx-desync');
  if (Math.abs(intended.clientDelta.dy - intended.windowDelta.dy) > CHILD_TOLERANCE) reasons.push('client-dy-desync');
  if (Math.abs(intended.clientDelta.dw) > CHILD_TOLERANCE || Math.abs(intended.clientDelta.dh) > CHILD_TOLERANCE) reasons.push('client-resized');

  const children = intended.children || [];
  if (!children.length) reasons.push('intended-has-no-renderer');
  for (const child of children) {
    if (!child.delta) { reasons.push('renderer-appeared'); continue; }
    if (Math.abs(child.delta.dx - intended.clientDelta.dx) > CHILD_TOLERANCE) reasons.push('renderer-dx-desync');
    if (Math.abs(child.delta.dy - intended.clientDelta.dy) > CHILD_TOLERANCE) reasons.push('renderer-dy-desync');
    if (Math.abs(child.delta.dw) > CHILD_TOLERANCE || Math.abs(child.delta.dh) > CHILD_TOLERANCE) reasons.push('renderer-resized');
  }
  for (const row of diff.rows) {
    if (row.intended) continue;
    for (const child of row.children || []) {
      if (!child.delta) { reasons.push('foreign-renderer-appeared'); continue; }
      if (Math.abs(child.delta.dx) > CHILD_TOLERANCE || Math.abs(child.delta.dy) > CHILD_TOLERANCE) reasons.push('foreign-renderer-moved');
    }
  }

  const factors = {};
  if (dip.dx !== 0 && isNum(intended.windowDelta.dx)) factors.x = intended.windowDelta.dx / dip.dx;
  if (dip.dy !== 0 && isNum(intended.windowDelta.dy)) factors.y = intended.windowDelta.dy / dip.dy;
  if (isNum(factors.x) && scale !== null && Math.abs(factors.x - scale) > FACTOR_RELATIVE_TOLERANCE * scale) reasons.push('factor-x-vs-dpi');
  if (isNum(factors.y) && scale !== null && Math.abs(factors.y - scale) > FACTOR_RELATIVE_TOLERANCE * scale) reasons.push('factor-y-vs-dpi');

  return {
    ok: reasons.length === 0,
    reasons,
    intended: {
      hwnd: intended.hwnd,
      windowRect: intended.windowRect,
      clientRect: intended.clientRect,
      windowDelta: intended.windowDelta,
      clientDelta: intended.clientDelta,
      children: children.map(child => ({ hwnd: child.hwnd, visible: child.visible, delta: child.delta })),
      dpi,
      dpiBefore,
    },
    othersMoved: othersMoved.map(row => ({ hwnd: row.hwnd, windowDelta: row.windowDelta, clientDelta: row.clientDelta })),
    expected,
    factors,
    scale,
  };
}

/** 严格关闭判定：只有 TCP ECONNREFUSED + 原 PID 已不存在 + HTTP 无应答才算 closed。
 *  HTTP 任意应答或 TCP open 一律 alive；ENOTFOUND/RESET/hangup/timeout 不能单独判关闭。 */
function classifyClosureObservation(obs) {
  if (!isRecord(obs)) throw new Stopped('closure-observation-shape');
  const { http, tcp, pidAlive } = obs;
  if (!['response', 'no-response', 'timeout'].includes(http)) throw new Stopped('closure-http-kind', { http });
  if (!['open', 'refused', 'error', 'timeout'].includes(tcp)) throw new Stopped('closure-tcp-kind', { tcp });
  if (pidAlive !== true && pidAlive !== false && pidAlive !== null) throw new Stopped('closure-pid-kind', { pidAlive });
  if (http === 'response' || tcp === 'open') return 'alive';
  if (tcp === 'refused' && pidAlive === false && http !== 'response') return 'closed';
  return 'unknown';
}

/** 只做存活探测：process.kill(pid, 0) 不发信号；ESRCH 表示进程已不存在。 */
function pidAliveOf(pid) {
  if (!isPosInt(pid)) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    return true; // EPERM 等：保守按仍存活处理
  }
}

function observeTcp(port, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = value => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (error) { void error; }
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('open'));
    socket.once('timeout', () => finish('timeout'));
    socket.once('error', error => finish(error && error.code === 'ECONNREFUSED' ? 'refused' : 'error'));
  });
}

async function observeHttp(port, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch('http://127.0.0.1:' + port + '/json/version', { signal: controller.signal });
    return 'response';
  } catch (error) {
    if (error && error.name === 'AbortError') return 'timeout';
    return 'no-response';
  } finally {
    clearTimeout(timer);
  }
}

async function observeClosure(port, pid, options = {}) {
  const timeoutMs = options.timeoutMs || CLOSE_OBSERVE_MS;
  const [http, tcp] = await Promise.all([observeHttp(port, timeoutMs), observeTcp(port, timeoutMs)]);
  return { port, http, tcp, pidAlive: pidAliveOf(pid), atMs: Date.now() };
}

/** 有界阶段执行器：超时后不取消协程，但 generation/closed 守卫会拒绝任何后续发送。 */
class StageRunner {
  constructor(options) {
    this.label = options.label;
    this.now = options.now || Date.now;
    this.endAt = options.endAt;
    this.closed = false;
    this.closedReason = null;
    this.generation = 0;
    this.issues = [];
  }

  remaining() {
    return this.endAt - this.now();
  }

  assertOpen(name) {
    if (this.closed) throw new Stopped('stage-closed', { label: this.label, name, reason: this.closedReason });
    if (this.remaining() <= 0) throw new Stopped('stage-budget', { label: this.label, name, remainingMs: this.remaining() });
  }

  close(reason) {
    if (!this.closed) {
      this.closed = true;
      this.closedReason = reason || 'closed';
    }
    this.generation += 1;
  }

  async run(name, fn) {
    this.assertOpen(name);
    this.issues.push({ name, atMs: this.now() });
    const token = ++this.generation;
    const budgetMs = Math.max(1, this.remaining());
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Stopped('stage-timeout', { label: this.label, name, budgetMs }));
      }, budgetMs);
    });
    try {
      const value = await Promise.race([Promise.resolve().then(fn), timeout]);
      if (this.closed) throw new Stopped('stage-closed', { label: this.label, name });
      if (token !== this.generation) throw new Stopped('stage-superseded', { label: this.label, name });
      return value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** 连续 CLOSE_STREAK 次判 closed 才算关闭；alive/unknown 都重置连击。 */
async function waitForBrowserClosed(options) {
  const { port, pid, stage } = options;
  const observer = options.observe || (target => observeClosure(target, pid));
  const pause = options.sleepFn || sleep;
  const clock = options.now || Date.now;
  const endAt = isNum(options.totalMs) ? clock() + options.totalMs : stage.endAt;
  const evidence = options.evidence || null;
  const observations = [];
  let streak = 0;
  while (clock() < endAt) {
    stage.assertOpen('close-poll');
    let observation;
    try {
      observation = await observer(port);
    } catch (error) {
      observation = { error: errorText(error) };
    }
    let verdict = 'unknown';
    if (observation && !observation.error) {
      try { verdict = classifyClosureObservation(observation); } catch (error) { void error; verdict = 'unknown'; }
    }
    observations.push({ verdict, observation });
    if (evidence) evidence.push({ name: 'closure-observation', verdict, observation });
    if (verdict === 'closed') {
      streak += 1;
      if (streak >= CLOSE_STREAK) return { closed: true, streak, observations };
    } else {
      streak = 0;
    }
    const left = endAt - clock();
    if (left <= 0) break;
    await pause(Math.min(CLOSE_POLL_MS, left));
  }
  return { closed: false, streak, observations };
}

/** 恢复：bounds 回读 → 原 state 回读 → 原生矩形。每步独立容错，绝不抛穿（helper 失败也记步骤）。 */
async function restoreWindow(ctx) {
  const stage = ctx.stage;
  const steps = [];
  const record = async (name, expectedFn, fn) => {
    let observed = null;
    let ok = false;
    let error = null;
    try {
      observed = await fn();
      ok = Boolean(expectedFn(observed));
      if (!ok) error = 'unexpected-observation';
    } catch (caught) {
      error = errorText(caught);
    }
    steps.push({ name, ok, observed, error });
    return ok;
  };

  const base = isRecord(ctx.base) ? ctx.base : {};
  const wantedBounds = {};
  if (isNum(base.left)) wantedBounds.left = base.left;
  if (isNum(base.top)) wantedBounds.top = base.top;
  if (isNum(base.width)) wantedBounds.width = base.width;
  if (isNum(base.height)) wantedBounds.height = base.height;
  if (Object.keys(wantedBounds).length) {
    await record('restore-bounds', () => true, () => stage.run('setWindowBounds', () => ctx.setBounds(wantedBounds)));
    await record('restore-bounds-readback', observed => isRecord(observed) &&
      near(observed.left, base.left, PIXEL_TOLERANCE) && near(observed.top, base.top, PIXEL_TOLERANCE) &&
      (!isNum(base.width) || near(observed.width, base.width, PIXEL_TOLERANCE)) &&
      (!isNum(base.height) || near(observed.height, base.height, PIXEL_TOLERANCE)),
    () => stage.run('getWindowBounds', () => ctx.readBounds()));
  } else {
    steps.push({ name: 'restore-bounds', ok: false, observed: null, error: 'no-reported-bounds' });
  }

  if (ctx.normalizedFrom) {
    await record('restore-state', () => true, () => stage.run('setWindowState', () => ctx.setBounds({ windowState: ctx.normalizedFrom })));
    await record('restore-state-readback', observed => isRecord(observed) && observed.windowState === ctx.normalizedFrom,
      () => stage.run('getWindowState', () => ctx.readBounds()));
  }

  if (ctx.contentBefore && isPosInt(ctx.intendedHwnd)) {
    const beforeWindow = ctx.contentBefore.windows.find(entry => entry.hwnd === ctx.intendedHwnd) || null;
    await record('restore-native-rect', observed => Boolean(observed && beforeWindow && isRect(beforeWindow.windowRect) && isRect(observed.windowRect) &&
      near(observed.windowRect.x, beforeWindow.windowRect.x, PIXEL_TOLERANCE) &&
      near(observed.windowRect.y, beforeWindow.windowRect.y, PIXEL_TOLERANCE) &&
      near(observed.windowRect.width, beforeWindow.windowRect.width, PIXEL_TOLERANCE) &&
      near(observed.windowRect.height, beforeWindow.windowRect.height, PIXEL_TOLERANCE)),
    async () => {
      const answer = await stage.run('helper-content', () => ctx.helperCall('content', { pid: ctx.matchedPid }));
      const parsed = readContent(answer, 'after-restore');
      return parsed.windows.find(entry => entry.hwnd === ctx.intendedHwnd) || null;
    });
  }

  const ok = steps.length > 0 && steps.every(entry => entry.ok);
  const stateRestored = !ctx.normalizedFrom || steps.some(entry => entry.name === 'restore-state-readback' && entry.ok);
  return { ok, stateRestored, confidence: ok ? 'confirmed' : 'unknown', steps };
}

/** 纯预算编排：显式 0 也保留（?? 而非 ||），且任何阶段都不得越过总预算。 */
function cleanupSchedule(startedAtMs, options = {}) {
  const totalMs = options.totalMs ?? CLEANUP_TOTAL_MS;
  const hardEnd = startedAtMs + totalMs;
  const restoreEnd = Math.min(startedAtMs + CLEANUP_SETTLE_MS + (options.restoreMs ?? CLEANUP_RESTORE_MS), hardEnd);
  const reverifyEnd = Math.min(restoreEnd + (options.reverifyMs ?? CLEANUP_REVERIFY_MS), hardEnd);
  const closeEnd = Math.min(reverifyEnd + (options.closeMs ?? CLEANUP_CLOSE_MS), hardEnd);
  const stopEnd = Math.min(closeEnd + (options.stopMs ?? CLEANUP_STOP_MS), hardEnd);
  return { startedAtMs, totalMs, hardEnd, restoreEnd, reverifyEnd, closeEnd, stopEnd };
}

/**
 * 主报告消费层：把 runCleanup 的 restore outcome 映射成 report.restore。
 * moved=false 且 runCleanup 报 skipped/not-needed 时必须是明确的 notNeeded，不能生成 ok:false 的 NOT-CONFIRMED。
 */
function restoreReportFromOutcome(outcome, moved) {
  if (outcome && outcome.skipped === true) {
    // not-needed 只在确实没做位移时成立；moved=true 却报 not-needed 属自相矛盾，按未确认处理。
    if (outcome.reason === 'not-needed' && moved !== true) return { notNeeded: true, reason: 'not-needed' };
    return { ok: false, confidence: 'unknown', skipped: true, reason: outcome.reason || 'skipped', steps: [] };
  }
  if (outcome && outcome.ok === true && outcome.value) return outcome.value;
  if (outcome && outcome.ok === false) {
    return { ok: false, confidence: 'unknown', steps: [{ name: 'restore', ok: false, error: outcome.error || outcome.reason || 'restore-not-confirmed' }] };
  }
  return moved ? { ok: false, confidence: 'unknown', steps: [] } : null;
}

/** 报告展示用：not-needed 与真失败必须区分。 */
function restoreSummary(report) {
  const value = report && report.restore;
  if (!value) return 'not-needed';
  if (value.notNeeded === true) return 'not-needed';
  return value.ok === true ? 'confirmed' : 'NOT-CONFIRMED';
}

/** 成功退出的唯一判据：因果结论成立、cleanup 已确认、浏览器已确认关闭、restore 不存在或已确认/明确不需要。 */
function isProbeSuccess(report) {
  if (!isRecord(report)) return false;
  const cleanup = report.cleanup;
  if (!isRecord(cleanup)) return false;
  if (report.verdict !== 'windowIdHwndCausalOnly') return false;
  if (cleanup.ok !== true) return false;
  if (cleanup.browserClosed !== true) return false;
  if (report.restore && report.restore.notNeeded !== true && report.restore.ok !== true) return false;
  return true;
}

/** import-safe：把报告映射为退出码；cleanup 不确定时绝不返回 0。 */
function probeExitCode(report) {
  if (!isRecord(report)) return 4;
  if (report.stopReason && report.stopReason.code === 'stale-build') return 3;
  if (report.stopReason && report.stopReason.code === 'unexpected') return 4;
  return isProbeSuccess(report) ? 0 : 2;
}

/** 清理编排：restore → reverify → close → stop，各自独立预算；失败不阻断后续阶段（close 需要 reverify 确认）。 */
async function runCleanup(options) {
  const clock = options.now || Date.now;
  const startedAtMs = clock();
  const { restoreEnd, reverifyEnd, closeEnd, stopEnd } = cleanupSchedule(startedAtMs, options);
  const result = { startedAtMs, elapsedMs: 0, restore: null, reverify: null, close: null, stop: null, evidence: [] };
  const evidence = result.evidence;

  // 阶段体直接执行（不再套一层 stage.run），由独立 watchdog 到点关闭阶段：
  // 关闭后阶段内任何迟到的 stage.run 都会被 stage-closed/stage-budget 拒绝，不会续发 setWindowBounds。
  const runStage = async (name, endAt, fn) => {
    if (typeof fn !== 'function') return { name, skipped: true, reason: 'not-needed', ok: false };
    const stage = new StageRunner({ label: name, now: clock, endAt });
    if (stage.remaining() <= 0) return { name, skipped: true, reason: 'no-budget', ok: false };
    let timer = null;
    const watchdog = new Promise((resolve, reject) => {
      void resolve;
      timer = setTimeout(() => {
        stage.close('stage-timeout');
        reject(new Stopped('stage-timeout', { label: name, name, budgetMs: stage.remaining() }));
      }, Math.max(1, stage.remaining()));
    });
    try {
      const value = await Promise.race([Promise.resolve().then(() => fn(stage)), watchdog]);
      if (stage.closed) throw new Stopped('stage-closed', { label: name, name });
      return { name, skipped: false, ok: true, value };
    } catch (error) {
      return { name, skipped: false, ok: false, code: error instanceof Stopped ? error.code : 'error', error: errorText(error) };
    } finally {
      if (timer) clearTimeout(timer);
      stage.close('stage-exit');
    }
  };

  result.restore = await runStage('restore', restoreEnd, options.restore);
  result.reverify = await runStage('reverify', reverifyEnd, options.reverify);
  const reverifyOk = Boolean(result.reverify && result.reverify.ok === true &&
    (!result.reverify.value || result.reverify.value.ok !== false));
  if (typeof options.close === 'function' && reverifyOk) {
    result.close = await runStage('close', closeEnd, options.close);
  } else {
    result.close = { name: 'close', skipped: true, ok: false, reason: typeof options.close === 'function' ? 'reverify-not-confirmed' : 'not-needed' };
    evidence.push({ name: 'close-skipped', reason: result.close.reason });
  }
  result.stop = await runStage('stop', stopEnd, options.stop);
  result.elapsedMs = clock() - startedAtMs;
  const restoreOk = !result.restore
    ? options.requireRestore !== true
    : result.restore.skipped === true
      ? options.requireRestore !== true
      : result.restore.ok === true && (!result.restore.value || result.restore.value.ok !== false);
  const reverifyConfirmed = !result.reverify
    ? options.requireReverify !== true
    : result.reverify.skipped === true
      ? options.requireReverify !== true
      : result.reverify.ok === true && (!result.reverify.value || result.reverify.value.ok !== false);
  const okClose = !result.close
    ? options.requireClose !== true
    : result.close.skipped === true
      ? false
      : result.close.ok === true;
  result.reverifyConfirmed = Boolean(reverifyConfirmed);
  result.ok = Boolean(result.stop && result.stop.ok === true && restoreOk && reverifyConfirmed && okClose);
  return result;
}

async function main() {
  const startedAt = Date.now();
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const artifactsDir = path.join(ROOT, 'artifacts', 'browser-surface-probe-' + stamp);
  const report = {
    schema: 'browser-surface-probe/1',
    startedAt: new Date(startedAt).toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version },
    scope: 'isolated-only',
    sameSurface: 'experiment-scoped-not-proven',
    pointerOutput: 'none',
    productionGeometryChanged: false,
    verdict: null,
    stopReason: null,
    steps: [],
    helperCalls: 0,
    contentRawBefore: null,
  };
  const step = (name, data) => { report.steps.push(Object.assign({ name, atMs: Date.now() - startedAt }, data || {})); };
  const budgetDeadline = startedAt + TOTAL_BUDGET_MS;
  const guardBudget = () => { if (Date.now() > budgetDeadline) throw new Stopped('total-budget', { ms: TOTAL_BUDGET_MS }); };

  let driver;
  let arbiter;
  let browserCdp;
  let tabCdp;
  let send;
  let port = 0;
  let browserWsUrl = '';
  let profileDir = '';
  let verified = false;
  let intendedHwnd = 0;
  let matchedPid = 0;
  let windowId = 0;
  let contentBefore = null;
  let baselineContent = null;
  let base = null;
  let normalizedFrom = null;
  let moved = false;
  let windowWritesAllowed = true;
  let readBounds = null;
  let setBounds = null;
  let helperCall = async () => { throw new Stopped('helper-not-ready'); };

  try {
    if (process.platform !== 'win32') throw new Stopped('not-windows', { platform: process.platform });

    // ---- preflight：lib 必须是当前构建，缺导出立即停（不启动浏览器） ----
    const modules = {};
    for (const specifier of ['lib/browser/cdp.js', 'lib/browser/edge.js', 'lib/desktop/driver.js', 'lib/desktop/arbiter.js', 'lib/shared/faults.js']) {
      modules[specifier] = await import(pathToFileURL(path.join(ROOT, specifier)).href);
    }
    requireExport(modules, 'lib/browser/cdp.js', ['connectCdp', 'pageTargets', 'pageLayout', 'readWindowBounds', 'readTabViewport', 'browserEndpoint']);
    requireExport(modules, 'lib/browser/edge.js', ['findBrowser', 'launchBrowser', 'launchArgs', 'browserCandidates']);
    requireExport(modules, 'lib/desktop/driver.js', ['createDesktopDriver']);
    requireExport(modules, 'lib/desktop/arbiter.js', ['createArbiter']);
    requireExport(modules, 'lib/shared/faults.js', ['Faults']);
    const cdpLib = modules['lib/browser/cdp.js'];
    const edgeLib = modules['lib/browser/edge.js'];
    const driverLib = modules['lib/desktop/driver.js'];
    const arbiterLib = modules['lib/desktop/arbiter.js'];
    const faultsLib = modules['lib/shared/faults.js'];
    step('preflight', { ok: true, libs: Object.keys(modules) });

    fs.mkdirSync(artifactsDir, { recursive: true });
    profileDir = path.join(artifactsDir, 'profile');
    if (fs.existsSync(profileDir)) throw new Stopped('profile-exists', { profileDir });
    step('profile', { dir: profileDir, fresh: true });

    // ---- helper：正式 driver + 独立 arbiter（真实 broker，使用 lead 指定的专用命名管道） ----
    if (typeof process.env.EVOLUTION_CU_BROKER_PIPE !== 'string' || process.env.EVOLUTION_CU_BROKER_PIPE.trim() === '') {
      throw new Stopped('arbiter-pipe-missing', { variable: 'EVOLUTION_CU_BROKER_PIPE' });
    }
    try {
      arbiter = arbiterLib.createArbiter();
    } catch (error) {
      throw new Stopped('arbiter-create', { message: errorText(error) });
    }
    driver = driverLib.createDesktopDriver({ faults: new faultsLib.Faults(), callMs: HELPER_CALL_MS, arbiter });
    helperCall = async (op, args) => { report.helperCalls += 1; return await driver.call(op, args); };
    const cursor = await helperCall('cursor', {});
    step('helper', { alive: true, cursor: isRecord(cursor) && Array.isArray(cursor.cursor) ? cursor.cursor : null });

    guardBudget();
    // ---- S2 启动隔离浏览器 ----
    const binary = edgeLib.findBrowser();
    if (!binary) throw new Stopped('no-browser', { candidates: edgeLib.browserCandidates() });
    report.launch = { binary, profileDir, command: [binary].concat(edgeLib.launchArgs(profileDir)) };
    port = await edgeLib.launchBrowser(binary, profileDir, LAUNCH_TIMEOUT_MS);
    if (!isPosInt(port)) throw new Stopped('launch-no-port', { port });
    const activePortFile = path.join(profileDir, 'DevToolsActivePort');
    const activeLines = fs.existsSync(activePortFile) ? fs.readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/) : [];
    step('launch', { port, devToolsActivePort: activeLines });

    // ---- S3a 端口 ↔ socket 一致 ----
    const endpoint = cdpLib.browserEndpoint(port);
    const version = await fetchJson(endpoint + '/json/version');
    const wsUrl = isRecord(version) && typeof version.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : '';
    if (portOfUrl(wsUrl) !== port) throw new Stopped('port-mismatch', { port, wsPort: portOfUrl(wsUrl) });
    browserWsUrl = wsUrl;
    step('port-check', { ok: true, port, product: isRecord(version) ? version.Browser : null, wsUrl });

    // ---- S3b browser 进程集合：坏记录一律整体失败（不跳过） ----
    browserCdp = await openCdp(cdpLib.connectCdp, wsUrl, CDP_TIMEOUT_MS, 'browser');
    send = (socket, method, params) => withTimeout(socket.send(method, params), CDP_TIMEOUT_MS, method);
    const info = await send(browserCdp, 'SystemInfo.getProcessInfo', {});
    if (!isRecord(info) || !Array.isArray(info.processInfo)) throw new Stopped('sysinfo-shape');
    const browserPids = [];
    let malformed = 0;
    for (const entry of info.processInfo) {
      if (!isRecord(entry) || typeof entry.type !== 'string' || !Number.isInteger(entry.id) || entry.id <= 0) { malformed += 1; continue; }
      if (entry.type === 'browser' && !browserPids.includes(entry.id)) browserPids.push(entry.id);
    }
    if (malformed) throw new Stopped('sysinfo-malformed', { malformed, total: info.processInfo.length });
    if (!browserPids.length) throw new Stopped('no-browser-pid');
    if (browserPids.length > 8) throw new Stopped('too-many-browser-pids', { browserPids });
    step('system-info', { browserPids, totalProcesses: info.processInfo.length });

    // ---- S3c 精确 profile 核实 ----
    const profileCheck = readProfileCheck(await helperCall('browserProfile', { expected: profileDir, pids: browserPids }), browserPids);
    report.profileCheck = profileCheck;
    if (profileCheck.expected !== profileDir) throw new Stopped('profile-expected-mismatch', { expected: profileCheck.expected });
    if (profileCheck.complete !== true) throw new Stopped('profile-incomplete', { incompleteReason: profileCheck.incompleteReason });
    if (profileCheck.status === 'unknown') throw new Stopped('profile-unknown');
    if (profileCheck.status !== 'matched') throw new Stopped('profile-mismatch');
    if (profileCheck.unknownPids.length) throw new Stopped('profile-unknown-pids', { unknownPids: profileCheck.unknownPids });
    if (profileCheck.matched.length !== 1) throw new Stopped('profile-multiple-matched', { matched: profileCheck.matched });
    matchedPid = profileCheck.matched[0];
    verified = true;
    step('profile-check', { ok: true, matchedPid });

    // ---- S3d 原生快照 ----
    let rawContentBefore;
    try {
      rawContentBefore = await helperCall('content', { pid: matchedPid });
    } catch (error) {
      report.contentRawBefore = { where: 'before', pid: matchedPid, error: errorText(error) };
      throw error;
    }
    // 本 profile 的 exact pid 才可能进入这里；不记录命令行/凭据，只保留 helper 的原始几何与窗口元数据。
    report.contentRawBefore = {
      where: 'before',
      pid: matchedPid,
      note: 'exact-profile browser pid only; no other user windows; window metadata and raw geometry only',
      answer: rawContentBefore,
    };
    contentBefore = readContent(rawContentBefore, 'before');
    const visibleWindows = contentBefore.windows.filter(win => win.visible && !win.minimized && !win.cloaked);
    if (visibleWindows.length !== 1) throw new Stopped('window-not-unique', { visible: visibleWindows.map(win => win.hwnd) });
    const host = visibleWindows[0];
    if (host.pid !== matchedPid) throw new Stopped('window-pid-mismatch', { hwnd: host.hwnd, pid: host.pid });
    if (!isNum(host.dpi) || host.dpi <= 0) throw new Stopped('window-dpi-unknown', { hwnd: host.hwnd, dpi: host.dpi });
    const widgets = contentBefore.renderer.filter(entry => entry.parent === host.hwnd && entry.className === RENDER_WIDGET_CLASS && entry.visible);
    if (widgets.length !== 1) throw new Stopped('renderer-not-unique', { hwnd: host.hwnd, count: widgets.length });
    intendedHwnd = host.hwnd;
    step('native', {
      hwnd: host.hwnd, dpi: host.dpi, windowRect: host.windowRect, frameRect: host.frameRect, clientRect: host.clientRect,
      renderer: { hwnd: widgets[0].hwnd, clientRect: widgets[0].clientRect },
      windowCount: contentBefore.windows.length, rendererCount: contentBefore.renderer.length,
    });

    // ---- S4 唯一 page target → windowId ----
    const rawTargets = await fetchJson(endpoint + '/json/list');
    const pageLike = Array.isArray(rawTargets) ? rawTargets.filter(entry => isRecord(entry) && entry.type === 'page') : [];
    const targets = await cdpLib.pageTargets(port);
    if (pageLike.length !== 1 || targets.length !== 1) throw new Stopped('page-target-count', { pageLike: pageLike.length, pageTargets: targets.length });
    const target = targets[0];
    step('target', { id: target.id, url: target.url, title: target.title, allTypes: Array.isArray(rawTargets) ? rawTargets.map(entry => entry && entry.type) : null });

    tabCdp = await openCdp(cdpLib.connectCdp, target.webSocketDebuggerUrl, CDP_TIMEOUT_MS, 'tab');
    await send(tabCdp, 'Page.enable', {});

    // 自含测试页：先试 data: 导航；浏览器拒绝时退回 Page.setDocumentContent（都由浏览器侧写入，无网络）。
    const waitReady = async () => {
      const limit = Date.now() + 5_000;
      while (Date.now() < limit) {
        guardBudget();
        try {
          const answer = await send(tabCdp, 'Runtime.evaluate', { expression: '[document.readyState, document.title]', returnByValue: true });
          const value = isRecord(answer) && isRecord(answer.result) ? answer.result.value : null;
          if (Array.isArray(value) && value[0] === 'complete' && value[1] === 'surface probe') return true;
        } catch { /* 文档还在换，下一次再问 */ }
        await sleep(100);
      }
      return false;
    };
    let pageSource = 'data-url';
    let ready = false;
    try {
      await send(tabCdp, 'Page.navigate', { url: TEST_DATA_URL });
      ready = await waitReady();
    } catch (error) {
      step('page-navigate-failed', { error: errorText(error) });
    }
    if (!ready) {
      const tree = await send(tabCdp, 'Page.getFrameTree', {});
      const frameId = isRecord(tree) && isRecord(tree.frameTree) && isRecord(tree.frameTree.frame) ? tree.frameTree.frame.id : null;
      if (typeof frameId !== 'string' || !frameId) throw new Stopped('frame-tree-unreadable');
      await send(tabCdp, 'Page.setDocumentContent', { frameId, html: TEST_HTML });
      pageSource = 'set-document-content';
      ready = await waitReady();
    }
    if (!ready) throw new Stopped('page-not-ready');
    step('page', { source: pageSource, bytes: TEST_HTML.length });

    const windowAnswer = await send(browserCdp, 'Browser.getWindowForTarget', { targetId: target.id });
    const windowInfo = readWindowForTarget(windowAnswer);
    if (!windowInfo) throw new Stopped('window-for-target-unreadable');
    windowId = windowInfo.windowId;
    step('window-for-target', { windowId, boundsDip: windowInfo.bounds });

    // ---- S4b bounds；maximized/fullscreen 只在本隔离窗口上归一化为 normal ----
    // 只认 getWindowBounds 的 original reported bounds；不推断 maximized 时的 normal 矩形。
    readBounds = async () => readBoundsOnly(await send(browserCdp, 'Browser.getWindowBounds', { windowId }));
    setBounds = async bounds => {
      if (!windowWritesAllowed) throw new Stopped('window-writes-closed', { bounds });
      moved = true;
      await send(browserCdp, 'Browser.setWindowBounds', { windowId, bounds });
    };

    const first = await readBounds();
    if (!first) throw new Stopped('window-bounds-unreadable');
    const originalState = first.windowState || 'normal';
    if (originalState === 'minimized') throw new Stopped('window-minimized');
    const crossCheckable = isNum(first.left) && isNum(first.top) && isNum(windowInfo.bounds && windowInfo.bounds.left) && isNum(windowInfo.bounds && windowInfo.bounds.top);
    if (crossCheckable && (!near(first.left, windowInfo.bounds.left, PIXEL_TOLERANCE) || !near(first.top, windowInfo.bounds.top, PIXEL_TOLERANCE))) {
      step('bounds-cross-check', { warn: 'getWindowForTarget 与 getWindowBounds 不一致', forTarget: windowInfo.bounds, getBounds: first });
    }
    base = first;
    if (originalState !== 'normal') {
      normalizedFrom = originalState; // 首次 normal 写入前就记录原 state，中途失败仍可尝试恢复
      await setBounds({ windowState: 'normal' });
      await sleep(SETTLE_MS);
      const normalized = await readBounds();
      if (!normalized || (normalized.windowState && normalized.windowState !== 'normal')) throw new Stopped('normalize-failed', { observed: normalized });
      base = normalized;
    }
    if (!isNum(base.left) || !isNum(base.top) || !isNum(base.width) || !isNum(base.height)) {
      throw new Stopped('base-bounds-unreadable', { base });
    }
    step('bounds', { windowId, originalReportedBounds: first, originalState, normalizedFrom, normalizedBounds: normalizedFrom ? base : null });

    baselineContent = readContent(await helperCall('content', { pid: matchedPid }), 'baseline');
    const baselineWin = baselineContent.windows.find(win => win.hwnd === intendedHwnd);
    if (!baselineWin) throw new Stopped('intended-missing-after-normalize');
    if (baselineWin.dpi !== host.dpi) throw new Stopped('dpi-changed-on-normalize', { before: host.dpi, after: baselineWin.dpi });

    // 视口与布局必须在归一化之后读，否则窗口从最大化改回 normal 会让 CSS 尺寸前后不一致。
    const layout = await cdpLib.pageLayout(tabCdp);
    if (!layout) throw new Stopped('layout-unreadable');
    const tabPids = () => Promise.resolve(browserPids);
    const viewport = await cdpLib.readTabViewport(tabCdp, { targetId: target.id, pid: matchedPid, layout }, { browserPids: tabPids });
    report.viewport = viewport;
    step('viewport', { ok: isRecord(viewport) ? viewport.ok : null, layout });
    const baselineWidget = baselineContent.renderer.find(entry => entry.parent === intendedHwnd && entry.className === RENDER_WIDGET_CLASS && entry.visible) || null;

    // ---- S5 两次可恢复的因果位移 ----
    const applyMove = async (label, dip, from, fromContent) => {
      guardBudget();
      const wanted = { left: from.left + dip.dx, top: from.top + dip.dy };
      if (isNum(from.width) && isNum(from.height)) { wanted.width = from.width; wanted.height = from.height; }
      await setBounds(wanted);
      await sleep(SETTLE_MS);
      const observed = await readBounds();
      if (!observed || !near(observed.left, wanted.left, PIXEL_TOLERANCE) || !near(observed.top, wanted.top, PIXEL_TOLERANCE)) {
        throw new Stopped('move-not-applied', { label, wanted, observed });
      }
      const after = readContent(await helperCall('content', { pid: matchedPid }), label);
      return { observed, after, diff: diffFrames(fromContent, after, intendedHwnd) };
    };

    const firstMove = await applyMove('move-a', MOVE_A, base, baselineContent);
    const firstAssess = assessMove(firstMove.diff, MOVE_A, baselineContent);
    step('move-a', { dip: MOVE_A, observed: firstMove.observed, assess: firstAssess, diff: firstMove.diff });
    report.moveA = firstAssess;
    if (!firstAssess.ok) throw new Stopped('move-a-not-causal', { reasons: firstAssess.reasons });

    const secondMove = await applyMove('move-b', MOVE_B, firstMove.observed, firstMove.after);
    const secondAssess = assessMove(secondMove.diff, MOVE_B, firstMove.after);
    step('move-b', { dip: MOVE_B, observed: secondMove.observed, assess: secondAssess, diff: secondMove.diff });
    report.moveB = secondAssess;
    if (!secondAssess.ok) throw new Stopped('move-b-not-causal', { reasons: secondAssess.reasons });

    const factorChecks = ['x', 'y'].map(axis => {
      const a = firstAssess.factors[axis];
      const b = secondAssess.factors[axis];
      const reference = Math.max(Math.abs(isNum(a) ? a : 0), Math.abs(isNum(b) ? b : 0));
      const ok = isNum(a) && isNum(b) && reference > 0 && Math.abs(a - b) <= FACTOR_RELATIVE_TOLERANCE * reference;
      return { axis, first: a, second: b, ok };
    });
    report.factorChecks = factorChecks;
    if (!factorChecks.every(check => check.ok)) throw new Stopped('factor-not-reproduced', { factorChecks });

    // ---- S7 内容区 / CSS 对齐：只记数值，不解释成“支持 pageZoom” ----
    if (!baselineWidget) throw new Stopped('baseline-renderer-missing');
    const widgetRect = baselineWidget.clientRect;
    const alignment = {
      rendererClientPhysicalWidth: widgetRect.width,
      rendererClientPhysicalHeight: widgetRect.height,
      ratioX: null, ratioY: null, dpiScale: host.dpi / 96,
      visualScale: null, offsetX: null, offsetY: null, verdict: 'unavailable', note: null,
    };
    if (isRecord(viewport) && viewport.ok === true && isRecord(viewport.viewport)) {
      const css = viewport.viewport;
      alignment.visualScale = css.cdpVisualScale;
      alignment.offsetX = css.cdpVisualOffsetX;
      alignment.offsetY = css.cdpVisualOffsetY;
      alignment.innerWidthCss = css.innerWidthCss;
      alignment.innerHeightCss = css.innerHeightCss;
      if (isNum(css.innerWidthCss) && css.innerWidthCss > 0 && isNum(css.innerHeightCss) && css.innerHeightCss > 0) {
        alignment.ratioX = widgetRect.width / css.innerWidthCss;
        alignment.ratioY = widgetRect.height / css.innerHeightCss;
      }
      const ratiosPresent = isNum(alignment.ratioX) && isNum(alignment.ratioY);
      const ratiosAgree = ratiosPresent && Math.abs(alignment.ratioX - alignment.ratioY) <= ALIGN_TOLERANCE * Math.max(alignment.ratioX, alignment.ratioY);
      const matchesDpi = ratiosPresent && Math.abs(alignment.ratioX / alignment.dpiScale - 1) <= ALIGN_TOLERANCE && Math.abs(alignment.ratioY / alignment.dpiScale - 1) <= ALIGN_TOLERANCE;
      const noVisualTransform = alignment.visualScale === 1 && near(alignment.offsetX, 0, 1) && near(alignment.offsetY, 0, 1);
      alignment.verdict = ratiosAgree && matchesDpi && noVisualTransform ? 'consistent-with-dpi' : 'not-explained';
      if (alignment.verdict !== 'consistent-with-dpi') {
        alignment.note = '原始数值已记录；内容区比例与 dpiScale 不一致或存在视觉视口变换，本试验不解释，也不作为支持 pageZoom 的证据';
      }
    } else {
      alignment.note = 'tab 视口读数不可用，只保留原生候选矩形';
    }
    report.alignment = alignment;
    step('alignment', alignment);

    report.verdict = 'windowIdHwndCausalOnly';
    step('verdict', { verdict: report.verdict, hwnd: intendedHwnd, windowId, factors: firstAssess.factors });

  } catch (error) {
    if (error instanceof Stopped) {
      report.stopReason = { code: error.code, detail: error.detail || null };
      report.verdict = 'unknown';
    } else if (error instanceof StaleBuild) {
      report.stopReason = { code: 'stale-build', missing: error.missing };
      report.verdict = 'stopped';
    } else {
      report.stopReason = { code: 'unexpected', message: errorText(error) };
      report.verdict = 'unknown';
    }
    step('stopped', report.stopReason);
  } finally {
    // F：restore / reverify / close / stop 分阶段、各有预算；任一失败都不跳过后续与报告。
    // A：只在再次核实（完整 ws URL + browser PID + profile）后，用同一自有 socket 发 Browser.close；绝不按路径杀进程。
    const cleanup = { startedAt: new Date().toISOString(), evidence: [], browserClosed: false, killedByPath: false };
    const browserVerified = Boolean(verified && send && browserCdp && !browserCdp.closed);
    const identityUsable = browserVerified && Boolean(windowId && base);
    const restorePayload = moved && identityUsable
      ? { stage: null, base, normalizedFrom, windowId, setBounds, readBounds, helperCall, matchedPid, intendedHwnd, contentBefore }
      : null;
    let reverifyOutcome = null;
    let stopAttempted = false;
    let stopSettled = false;
    if (port && !browserVerified) {
      cleanup.evidence.push('已取得调试端口 ' + port + ' 但未建立自有 browser socket，无法确认关闭；不按路径杀进程');
    }
    try {
      const outcome = await runCleanup({
        now: Date.now,
        totalMs: CLEANUP_TOTAL_MS,
        requireRestore: moved,
        requireReverify: browserVerified,
        requireClose: browserVerified,
        restore: restorePayload
          ? async stage => { restorePayload.stage = stage; return await restoreWindow(restorePayload); }
          : (moved ? async () => ({ ok: false, stateRestored: false, confidence: 'unknown', steps: [{ name: 'restore', ok: false, error: '身份未核实，按规则不向未知 windowId 写入 bounds' }] }) : null),
        reverify: browserVerified ? async stage => {
          const fresh = await stage.run('json-version', () => fetchJson(endpointOfPort(port), CDP_TIMEOUT_MS));
          const freshWs = isRecord(fresh) && typeof fresh.webSocketDebuggerUrl === 'string' ? fresh.webSocketDebuggerUrl : '';
          if (freshWs !== browserWsUrl) throw new Stopped('reverify-ws-mismatch', { expected: browserWsUrl, observed: freshWs });
          const info = await stage.run('sysinfo', () => send(browserCdp, 'SystemInfo.getProcessInfo', {}));
          if (!isRecord(info) || !Array.isArray(info.processInfo)) throw new Stopped('reverify-sysinfo-shape');
          const pids = [];
          for (const entry of info.processInfo) {
            if (!isRecord(entry) || !Number.isInteger(entry.id) || entry.id <= 0) throw new Stopped('reverify-sysinfo-malformed');
            if (entry.type === 'browser' && !pids.includes(entry.id)) pids.push(entry.id);
          }
          if (!pids.length || !pids.includes(matchedPid)) throw new Stopped('reverify-pid-gone', { pids, matchedPid });
          const check = readProfileCheck(await stage.run('browser-profile', () => helperCall('browserProfile', { expected: profileDir, pids })), pids);
          if (check.expected !== profileDir || check.complete !== true || check.status !== 'matched' || check.unknownPids.length || check.matched.length !== 1 || check.matched[0] !== matchedPid) {
            throw new Stopped('reverify-profile', { status: check.status, complete: check.complete, matched: check.matched });
          }
          reverifyOutcome = { wsUrl: freshWs, browserPids: pids, matchedPid };
          step('reverify', reverifyOutcome);
          return { ok: true, wsUrl: freshWs, browserPids: pids, matchedPid };
        } : null,
        close: browserVerified ? async stage => {
          await stage.run('Browser.close', () => send(browserCdp, 'Browser.close', {}));
          cleanup.evidence.push('Browser.close 已发送（同一自有 socket）');
          const wait = await waitForBrowserClosed({ port, pid: matchedPid, stage, evidence: cleanup.evidence });
          if (wait.closed !== true) {
            cleanup.evidence.push('调试端口在预算内未连续 ' + CLOSE_STREAK + ' 次证实关闭；未确认，不按路径杀进程');
            throw new Stopped('close-unconfirmed', { observations: wait.observations.length });
          }
          cleanup.browserClosed = true;
          return { closed: true };
        } : null,
        stop: driver ? async () => { stopAttempted = true; await driver.stop(); stopSettled = true; } : null,
      });
      cleanup.phases = outcome;
      cleanup.restore = outcome.restore || null;
      cleanup.reverify = outcome.reverify || null;
      cleanup.closePhase = outcome.close || null;
      cleanup.stop = outcome.stop || null;
      cleanup.stopAttempted = stopAttempted;
      cleanup.stopSettled = stopSettled;
      cleanup.ok = outcome.ok === true && (!driver || (stopAttempted && stopSettled));
      cleanup.reverified = Boolean(reverifyOutcome && outcome.reverify && outcome.reverify.ok === true);
      const restoreReport = restoreReportFromOutcome(outcome.restore, moved);
      if (restoreReport) report.restore = restoreReport;
    } catch (error) {
      cleanup.error = errorText(error);
      cleanup.evidence.push('清理编排异常: ' + errorText(error));
      cleanup.ok = false;
    } finally {
      // driver.stop 已发出但未 settle 时不重复并发；只有完全没发出时才在预算内兜底一次。
      if (driver && !stopAttempted) {
        stopAttempted = true;
        try {
          await withTimeout(driver.stop(), CLEANUP_STOP_MS, 'driver-stop-fallback');
          stopSettled = true;
          cleanup.evidence.push('driver.stop 兜底已 settle');
        } catch (error) {
          cleanup.evidence.push('driver.stop 兜底未确认: ' + errorText(error));
        }
      }
      cleanup.stopAttempted = stopAttempted;
      cleanup.stopSettled = stopSettled;
      if (driver && !stopSettled) {
        cleanup.ok = false;
        cleanup.evidence.push('driver.stop 未确认 settle；cleanup 不得报成功');
      }
    }

    // 先置写禁旗再关闭 socket：此后任何迟到的 restore 协程都会被 stage-closed / window-writes-closed 拒绝。
    windowWritesAllowed = false;
    cleanup.arbiterDisposed = disposeArbiterQuietly(arbiter, cleanup.evidence);
    if (arbiter && !cleanup.arbiterDisposed) {
      cleanup.ok = false;
      cleanup.evidence.push('arbiter 未确认 dispose；cleanup 不得报成功');
    }
    cleanup.tabCdpClosed = closeCdpQuietly(tabCdp, 'tabCdp', cleanup.evidence);
    cleanup.browserCdpClosed = closeCdpQuietly(browserCdp, 'browserCdp', cleanup.evidence);
    if ((tabCdp && !cleanup.tabCdpClosed) || (browserCdp && !cleanup.browserCdpClosed)) {
      cleanup.ok = false;
      cleanup.evidence.push('自有 CDP socket 未确认关闭；cleanup 不得报成功');
    }
    cleanup.profileKept = profileDir;
    cleanup.note = '不删除 profile 目录（R12 待用户确认）';
    report.cleanup = cleanup;

    report.finishedAt = new Date().toISOString();
    report.totalMs = Date.now() - startedAt;
    try {
      fs.mkdirSync(artifactsDir, { recursive: true });
      const reportPath = path.join(artifactsDir, 'report.json');
      const tmpPath = reportPath + '.tmp-' + process.pid;
      fs.writeFileSync(tmpPath, JSON.stringify(report, null, 2), 'utf8');
      fs.renameSync(tmpPath, reportPath);
      report.reportPath = reportPath;
    } catch (error) {
      report.reportPath = null;
      console.error('report 写入失败: ' + errorText(error));
    }
  }
  return report;
}

const endpointOfPort = port => 'http://127.0.0.1:' + port + '/json/version';

const invokedDirectly = Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    const report = await main();
    const factors = report.moveA ? report.moveA.factors : {};
    const cleanup = report.cleanup || {};
    console.log([
      'PROBE', report.verdict,
      'windowId=' + (report.steps.find(entry => entry.name === 'window-for-target') || {}).windowId,
      'hwnd=' + (report.steps.find(entry => entry.name === 'native') || {}).hwnd,
      'factors=' + JSON.stringify(factors),
      'restore=' + restoreSummary(report),
      'cleanup=' + (cleanup.browserClosed ? 'closed' : 'unconfirmed'),
      'report=' + report.reportPath,
    ].join(' '));
    // 退出码与文件头一致：只有因果结论 + cleanup 全部确认才为 0；2 unknown/stopped/cleanup 未确认；3 stale build；4 未预期异常
    process.exitCode = probeExitCode(report);
  } catch (error) {
    console.error('PROBE unexpected: ' + errorText(error));
    process.exitCode = 4;
  }
}

export {
  openCdp,
  closeCdpQuietly,
  disposeArbiterQuietly,
  classifyClosureObservation,
  observeClosure,
  waitForBrowserClosed,
  StageRunner,
  restoreWindow,
  readContent,
  restoreReportFromOutcome,
  restoreSummary,
  cleanupSchedule,
  isProbeSuccess,
  probeExitCode,
  runCleanup,
  main,
};
