#!/usr/bin/env node
/**
 * browser-overlay-probe —— task-106：私有 Overlay 高亮能不能被两条截图通道看见（只写脚本，不运行）
 *
 * 要回答的问题
 * ------------
 * CDP 的 Overlay.highlightRect 是"私有绘制"：协议明说它**不处理 device pixel ratio**（crbug.com/437807128）。
 * 但它到底能不能进原生窗口内容、能不能进 Page.captureScreenshot，仓库里从来没有实测过。
 * 这个脚本在**自己启动、全新 profile、独有调试端口**的隔离浏览器里，逐像素回答三件事：
 *   1. 高亮画出来的东西，native（helper shot = PrintWindow）看得见吗？
 *   2. 同一次高亮，surface（Page.captureScreenshot fromSurface:true）看得见吗？
 *   3. 看见的东西是不是落在**预测的**位置上（几何一致），以及 hideHighlight 之后能不能逐像素回到基线？
 *
 * 这个脚本刻意不做的事
 * --------------------
 * - 不运行于生产链路；不改 src/、lib/、plugin/；不改冻结的 scripts/browser-surface-probe.mjs 与其测试。
 * - 不驱动任何指针、不输出物理坐标、不启用生产校准、不写 multi-pointer-state / 生产 mode。
 * - 不抢用户窗口/tab/焦点：只操作本实例自己那一个窗口（Browser.setWindowBounds，且只作用于本次取到的 windowId）。
 * - 不按 profile 路径模糊杀进程；不删 profile 目录。
 * - 不声称 same-surface 已证，不声称 A16 / Q5 通过。像素结论与身份结论**分两个字段**，互不代替。
 *
 * 为什么这样分工
 * --------------
 * Node 侧没有 PNG 解码能力，helper 的 shot 已经把 PNG 存盘（src/desktop/win32.ps1:384）。
 * 所以：native 测量与截图全部走**正式** driver（createDesktopDriver + Faults，同一套 helper op），
 * 只有"把两张已经存好的 PNG 逐区域比一下"这一步交给离线 PowerShell（scripts/browser-overlay-pixels.ps1），
 * 它不碰窗口、不碰输入、不含任何 PInvoke。
 *
 * 身份必须每次现场重证
 * --------------------
 * 不复用任何旧 report：本进程自己做
 *   SystemInfo.getProcessInfo 的完整 PID 分区 → helper(browserProfile) 精确 profile 证明（唯一 matched）
 *   → helper(content) 里唯一可见窗口 pid===matchedPid、唯一 renderer(parent===hwnd, Chrome_RenderWidgetHostHWND)
 *   → Browser.getWindowForTarget / getWindowBounds 的 windowId，两次真实位移的因果与因子复现。
 * 任一步不成立就立即停，不进入像素阶段。
 *
 * 序列（最多 18 次截图）
 * ---------------------
 *   B0  空页双路基线           native+surface            2
 *   P1  加一个已知纯色 div      native+surface            2   ← 正控：两条通道都必须看见它
 *   移除 div → B1 重取          native+surface            2   ← 必须与 B0 逐像素相同
 *   3 轮 × (highlight 两路 + hide 两路)                    12
 *   合计 18。
 *
 * 预设判据（先定，不看数据后改）
 * ----------------------------
 *   矩形内改动 ≥ 90%，矩形外 ≤ 0.5%，变化 bbox 与预测框四边相差 ≤ 2px；
 *   hide 之后必须与 B1 逐像素相同；三轮必须同向。位置不符记 geometry-mismatch，不反推校准掩盖。
 *
 * 结论词表（overlayCapture，只描述"窗口层像素能不能看见"）
 * ------------------------------------------------------
 *   native-only | both | neither | geometry-mismatch | inconclusive
 *
 * 退出码
 * ------
 *   0 = 预设像素门槛全过（native-only 或 both）且清理确认
 *   2 = 负结果 / 未定 / 清理未确认（清理未确认永远非 0）
 *   3 = stale build（lib/ 缺导出或离线像素脚本缺失，未启动浏览器）
 *   4 = 未预期异常（已尽力恢复与清理）
 *
 * 用法
 * ----
 *   npm run typecheck && npm run build      # lib/ 必须是当前构建
 *   node scripts/browser-overlay-probe.mjs
 * 输出：artifacts/browser-overlay-probe-<ts>/report.json + 一行 stdout 摘要。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 冻结探针（task-77）已导出的可复用件：阶段预算、内容校验、恢复、清理编排、连接生命周期。
import {
  StageRunner,
  readContent,
  restoreWindow,
  runCleanup,
  cleanupSchedule,
  openCdp,
  closeCdpQuietly,
  disposeArbiterQuietly,
  waitForBrowserClosed,
} from './browser-surface-probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIXELS_SCRIPT = path.join(ROOT, 'scripts', 'browser-overlay-pixels.ps1');
const POWERSHELL = ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];

// ---- 时间预算：主体 90s（含抓图与离线像素分析），清理独立 60s（含 Overlay 卫生） ----
const CDP_TIMEOUT_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 20_000;
const HELPER_CALL_MS = 30_000;
const PIXELS_CALL_MS = 20_000;
const TOTAL_BUDGET_MS = 90_000;
const CLEANUP_TOTAL_MS = 60_000;
const CLEANUP_HYGIENE_MS = 2_000;
const CLEANUP_HYGIENE_STEP_MS = 700;
const SETTLE_MS = 350;
// 启动门槛（A+B）：发起 launch 之前主体必须还完整剩下这 20s，不够就零投递；失败也不按路径杀进程。
const LAUNCH_BUDGET_MS = 20_000;

// ---- 预设阈值（先定后测） ----
const PIXEL_TOLERANCE = 2;
const CHILD_TOLERANCE = 1;
const FACTOR_RELATIVE_TOLERANCE = 0.02;
const INSIDE_MIN_RATIO = 0.9;
const OUTSIDE_MAX_RATIO = 0.005;
const DPR_EXACT_TOLERANCE = 1e-6;
const ROUNDS = 3;
const MAX_SHOTS = 18;

const PIXEL_SCHEMA = 'browser-overlay-pixels/1';
const PIXEL_FORMATS = ['Format32bppArgb', 'Format32bppRgb', 'Format24bppRgb'];
const PHYSICAL_UNITS = 'physical-screen-pixels';
const RENDER_WIDGET_CLASS = 'Chrome_RenderWidgetHostHWND';
const SAME_SURFACE = 'experiment-scoped-not-proven';

// 只在自有 data: 页面上画一个已知纯色块；坐标是 CSS px。
const BOX_CSS = { x: 120, y: 100, width: 240, height: 160 };
const OVERLAY_COLOR = { r: 255, g: 0, b: 255, a: 1 };
const OVERLAY_OUTLINE = { r: 0, g: 255, b: 0, a: 1 };
const MOVE_A = { dx: 211, dy: -97 };
const MOVE_B = { dx: -137, dy: 83 };

const TEST_HTML = [
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>overlay probe</title>',
  '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden}',
  'body{background:#fff;color:#111;font:16px/1.5 "Segoe UI",system-ui,sans-serif}',
  'h1{margin:24px;font-size:20px}</style></head><body>',
  '<h1>overlay probe</h1><p>isolated private-overlay pixel experiment</p>',
  '</body></html>',
].join('');
const TEST_DATA_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(TEST_HTML);
const TEST_TITLE = 'overlay probe';

const METRICS_EXPRESSION = [
  '(() => {',
  '  const vv = window.visualViewport;',
  '  return {',
  '    dpr: window.devicePixelRatio,',
  '    innerWidth: window.innerWidth,',
  '    innerHeight: window.innerHeight,',
  '    scrollX: window.scrollX,',
  '    scrollY: window.scrollY,',
  '    visualScale: vv ? vv.scale : 1,',
  '    visualWidth: vv ? vv.width : window.innerWidth,',
  '    visualHeight: vv ? vv.height : window.innerHeight,',
  '    visualOffsetX: vv ? vv.offsetLeft : 0,',
  '    visualOffsetY: vv ? vv.offsetTop : 0,',
  '    readyState: document.readyState,',
  '    title: document.title,',
  '  };',
  '})()',
].join('\n');

const BOX_ADD = [
  '(() => {',
  '  const box = document.createElement("div");',
  '  box.id = "cu-overlay-probe-box";',
  '  box.style.cssText = "position:fixed;left:' + BOX_CSS.x + 'px;top:' + BOX_CSS.y + 'px;width:'
    + BOX_CSS.width + 'px;height:' + BOX_CSS.height + 'px;background:#ff00ff;";',
  '  document.body.appendChild(box);',
  '  return true;',
  '})()',
].join('\n');

const BOX_REMOVE = [
  '(() => {',
  '  const box = document.getElementById("cu-overlay-probe-box");',
  '  if (box) { box.remove(); }',
  '  return document.getElementById("cu-overlay-probe-box") === null;',
  '})()',
].join('\n');

// DOM 负控：只证明"发 Overlay 指令前后主世界 DOM 没有变化"，不冒充私有性/同 surface 证明。
const DOM_INSTALL = [
  '(() => {',
  '  if (window.__cuOverlayProbeObserver) { window.__cuOverlayProbeObserver.disconnect(); }',
  '  const text = document.documentElement ? document.documentElement.outerHTML : "";',
  '  let hash = 0;',
  '  for (let i = 0; i < text.length; i += 1) { hash = (hash * 31 + text.charCodeAt(i)) | 0; }',
  '  window.__cuOverlayProbe = { mutations: 0, hash: hash, length: text.length };',
  '  window.__cuOverlayProbeObserver = new MutationObserver(list => { window.__cuOverlayProbe.mutations += list.length; });',
  '  window.__cuOverlayProbeObserver.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });',
  '  return { mutations: 0, hash: hash, length: text.length };',
  '})()',
].join('\n');

const DOM_READ = '(() => { const state = window.__cuOverlayProbe; return { mutations: state.mutations, hash: state.hash, length: state.length }; })()';
const DOM_DISCONNECT = '(() => { if (window.__cuOverlayProbeObserver) { window.__cuOverlayProbeObserver.disconnect(); window.__cuOverlayProbeObserver = null; } return true; })()';

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

class Stopped extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'Stopped';
    this.code = code;
    this.detail = detail;
  }
}

class StaleBuild extends Error {
  constructor(missing) {
    super('stale build: ' + missing.join(', '));
    this.name = 'StaleBuild';
    this.missing = missing;
  }
}

// ---------------------------------------------------------------------------
// 小工具（纯函数）
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPosInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isWhole(value) {
  return isNum(value) && Math.trunc(value) === value;
}

function isRect(value) {
  return isRecord(value) && isNum(value.x) && isNum(value.y) && isPosInt(value.width) && isPosInt(value.height);
}

function fitsInside(rect, image) {
  return isRecord(rect) && isRect(image)
    && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0
    && rect.x + rect.width <= image.width && rect.y + rect.height <= image.height;
}

function near(a, b, tolerance) {
  return isNum(a) && isNum(b) && Math.abs(a - b) <= tolerance;
}

function errorText(error) {
  if (!error) return 'unknown error';
  if (!(error instanceof Error)) return String(error);
  return error.message || error.name;
}

function asStopped(error) {
  if (error instanceof Stopped) return error;
  if (error instanceof StaleBuild) return error;
  if (error && error.name === 'Stopped' && typeof error.code === 'string') {
    return new Stopped(error.code, error.detail === undefined ? undefined : error.detail);
  }
  return error;
}

async function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((resolve, reject) => {
    void resolve;
    timer = setTimeout(() => reject(new Stopped('timeout', { label, ms })), Math.max(1, ms));
  });
  try {
    return await Promise.race([Promise.resolve(promise), guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function portOfUrl(url) {
  try { return Number(new URL(String(url)).port) || 0; } catch { return 0; }
}

function endpointOfPort(port) {
  return 'http://127.0.0.1:' + port;
}

function readBrowserPids(answer) {
  if (!isRecord(answer) || !Array.isArray(answer.processInfo)) throw new Stopped('sysinfo-shape');
  const ids = new Set();
  for (const entry of answer.processInfo) {
    if (!isRecord(entry)) throw new Stopped('sysinfo-malformed');
    const type = entry.type;
    if (typeof type !== 'string' || type === '') throw new Stopped('sysinfo-malformed');
    if (type !== 'browser') continue;
    const id = entry.id;
    if (!isPosInt(id)) throw new Stopped('sysinfo-malformed');
    ids.add(id);
  }
  return [...ids];
}

/**
 * 只读 PNG 头（前 33 字节）：签名 + IHDR。这不是解码器，只用来核对尺寸/色型/隔行，避免隐式缩放。
 * 不合法返回 null。
 */
export function readPngHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) return null;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let index = 0; index < 8; index += 1) if (buffer[index] !== signature[index]) return null;
  if (buffer[12] !== 73 || buffer[13] !== 72 || buffer[14] !== 68 || buffer[15] !== 82) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const interlace = buffer[28];
  if (!isPosInt(width) || !isPosInt(height)) return null;
  return { width, height, bitDepth, colorType, interlace };
}

// ---------------------------------------------------------------------------
// 几何换算：native PNG 的原点是窗口客户区左上角，不是屏幕绝对坐标
// ---------------------------------------------------------------------------

/** native 截图的原点（屏幕物理像素）= renderer 客户区左上 − 顶层窗口客户区左上。 */
export function nativePngOrigin(windowClientRect, rendererClientRect) {
  if (!isRect(windowClientRect) || !isRect(rendererClientRect)) return null;
  return { x: rendererClientRect.x - windowClientRect.x, y: rendererClientRect.y - windowClientRect.y };
}

/** CSS 矩形 → 图片像素矩形。origin 缺省 {0,0}（surface 截图）；native 传 nativePngOrigin 的结果。 */
export function boxFromCss(cssRect, dpr, origin) {
  if (!isRect(cssRect)) return null;
  if (!isNum(dpr) || dpr <= 0) return null;
  const base = isRecord(origin) && isNum(origin.x) && isNum(origin.y) ? origin : { x: 0, y: 0 };
  const box = {
    x: Math.round(base.x + cssRect.x * dpr),
    y: Math.round(base.y + cssRect.y * dpr),
    width: Math.round(cssRect.width * dpr),
    height: Math.round(cssRect.height * dpr),
  };
  if (!Number.isInteger(box.x) || !Number.isInteger(box.y)) return null;
  if (box.width <= 0 || box.height <= 0) return null;
  return box;
}

/**
 * 区域内/外区域规划：inside 必须完整落在图内；outside 从固定候选里按顺序选前 2 个能放下的。
 * 放不下就返回 null（由调用方记 inconclusive），绝不裁剪成"差不多"的区域。
 */
export function buildRegions(prefix, box, image) {
  if (!isRect(box) || !isRect(image)) return null;
  if (!fitsInside(box, image)) return null;
  const inside = { name: prefix + '-inside', x: box.x, y: box.y, width: box.width, height: box.height };
  const candidates = [
    { name: prefix + '-outside-right', x: box.x + box.width + 40, y: box.y, width: 200, height: box.height },
    { name: prefix + '-outside-left', x: box.x - 40 - 200, y: box.y, width: 200, height: box.height },
    { name: prefix + '-outside-below', x: box.x, y: box.y + box.height + 40, width: box.width, height: 120 },
    { name: prefix + '-outside-above', x: box.x, y: box.y - 40 - 120, width: box.width, height: 120 },
  ];
  const outside = [];
  for (const candidate of candidates) {
    if (outside.length >= 2) break;
    if (!fitsInside(candidate, image)) continue;
    outside.push(candidate);
  }
  if (!outside.length) return null;
  return { inside, outside };
}

// ---------------------------------------------------------------------------
// 页面测量与前提条件
// ---------------------------------------------------------------------------

export function readPageMetrics(value) {
  if (!isRecord(value)) return null;
  const keys = ['dpr', 'innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'visualScale', 'visualWidth', 'visualHeight', 'visualOffsetX', 'visualOffsetY'];
  const metrics = {};
  for (const key of keys) {
    const number = value[key];
    if (!isNum(number)) return null;
    metrics[key] = number;
  }
  if (metrics.dpr <= 0 || metrics.visualScale <= 0) return null;
  if (metrics.innerWidth <= 0 || metrics.innerHeight <= 0) return null;
  if (typeof value.readyState !== 'string') return null;
  metrics.readyState = value.readyState;
  metrics.title = typeof value.title === 'string' ? value.title : '';
  return metrics;
}

export function readDomState(value) {
  if (!isRecord(value)) return null;
  const mutations = value.mutations;
  const hash = value.hash;
  const length = value.length;
  if (!isWhole(mutations) || mutations < 0) return null;
  if (!isWhole(hash)) return null;
  if (!isWhole(length) || length <= 0) return null;
  return { mutations, hash, length };
}

export function readShotMeta(value) {
  if (!isRecord(value)) return null;
  const width = value.width;
  const height = value.height;
  const clientWidth = value.clientWidth;
  const clientHeight = value.clientHeight;
  if (!isPosInt(width) || !isPosInt(height) || !isPosInt(clientWidth) || !isPosInt(clientHeight)) return null;
  return { width, height, clientWidth, clientHeight };
}

/** 未缩放 = 图片像素数正好等于客户区像素数（Shot 的 Render 没插值）。 */
export function shotIsUnscaled(meta) {
  return isRecord(meta) && meta.width === meta.clientWidth && meta.height === meta.clientHeight;
}

/**
 * 前提条件：DPR 必须实测为 1、页面没滚、没有缩放、图片尺寸与窗口/视口一致。
 * 任何一条不成立都必须 inconclusive（Phase A 只在 DPR=1 上有意义）。
 */
export function checkPreconditions(input) {
  const reasons = [];
  const metrics = input.metrics;
  const layout = input.layout;
  const nativeSize = input.nativeSize;
  const surfaceSize = input.surfaceSize;
  const windowClientRect = input.windowClientRect;
  const rendererClientRect = input.rendererClientRect;

  if (!metrics) {
    return { ok: false, reasons: ['page-metrics-invalid'], dpr: null, expectedSurface: null };
  }
  if (!near(metrics.dpr, 1, DPR_EXACT_TOLERANCE)) reasons.push('dpr-not-1');
  if (!near(metrics.visualScale, 1, DPR_EXACT_TOLERANCE)) reasons.push('visual-scale-not-1');
  if (metrics.scrollX !== 0 || metrics.scrollY !== 0) reasons.push('page-scrolled');
  if (metrics.visualOffsetX !== 0 || metrics.visualOffsetY !== 0) reasons.push('visual-viewport-offset');
  if (!isRecord(layout) || !isNum(layout.cssWidth) || !isNum(layout.cssHeight) || layout.cssWidth <= 0 || layout.cssHeight <= 0) {
    reasons.push('layout-invalid');
    return { ok: false, reasons, dpr: metrics.dpr, expectedSurface: null };
  }
  if (!near(layout.pageZoom, 1, DPR_EXACT_TOLERANCE)) reasons.push('page-zoom-not-1');

  const expectedSurface = {
    width: Math.round(layout.cssWidth * metrics.dpr),
    height: Math.round(layout.cssHeight * metrics.dpr),
  };
  if (!isRecord(nativeSize) || !isRecord(surfaceSize)) {
    reasons.push('image-size-unknown');
    return { ok: false, reasons, dpr: metrics.dpr, expectedSurface };
  }
  if (!near(surfaceSize.width, expectedSurface.width, PIXEL_TOLERANCE)) reasons.push('surface-size-mismatch');
  if (!near(surfaceSize.height, expectedSurface.height, PIXEL_TOLERANCE)) reasons.push('surface-size-mismatch');
  if (isRect(windowClientRect)) {
    if (nativeSize.width !== windowClientRect.width || nativeSize.height !== windowClientRect.height) reasons.push('native-size-mismatch');
  } else {
    reasons.push('window-client-rect-invalid');
  }
  if (isRect(rendererClientRect)) {
    if (!near(rendererClientRect.width, expectedSurface.width, PIXEL_TOLERANCE)) reasons.push('renderer-css-mismatch');
    if (!near(rendererClientRect.height, expectedSurface.height, PIXEL_TOLERANCE)) reasons.push('renderer-css-mismatch');
  } else {
    reasons.push('renderer-client-rect-invalid');
  }
  if (!near(metrics.innerWidth, layout.cssWidth, PIXEL_TOLERANCE)) reasons.push('inner-width-mismatch');

  return { ok: reasons.length === 0, reasons, dpr: metrics.dpr, expectedSurface };
}

// ---------------------------------------------------------------------------
// 离线像素答案的严格解析（只信 manifest 里声明过的东西）
// ---------------------------------------------------------------------------

function failReading(code, detail) {
  return { ok: false, code, detail };
}

export function readPixelsReport(value, expected) {
  if (!isRecord(value)) return failReading('shape', 'pixel answer is not an object');
  if (value.ok !== true) {
    const error = isRecord(value.error) ? value.error : null;
    const code = error && typeof error.code === 'string' ? error.code : 'not-ok';
    const detail = error && typeof error.detail === 'string' ? error.detail : 'pixel script refused';
    return failReading(code, detail);
  }
  if (value.schema !== PIXEL_SCHEMA) return failReading('schema', String(value.schema));
  if (!isRecord(expected) || !Array.isArray(expected.images) || !Array.isArray(expected.jobs)) {
    return failReading('expected', 'expected spec invalid');
  }

  const images = Array.isArray(value.images) ? value.images : null;
  if (!images || images.length !== expected.images.length) return failReading('images', 'image list length');
  const imageById = new Map();
  for (const image of images) {
    if (!isRecord(image)) return failReading('images', 'image is not an object');
    const id = image.id;
    if (typeof id !== 'string' || id === '') return failReading('images', 'image id');
    if (imageById.has(id)) return failReading('images', 'duplicate image id ' + id);
    const want = expected.images.find(entry => entry.id === id);
    if (!want) return failReading('images', 'unexpected image ' + id);
    if (!isPosInt(image.width) || !isPosInt(image.height)) return failReading('images', 'image size ' + id);
    if (image.width !== want.width || image.height !== want.height) return failReading('dimensions', 'image size mismatch ' + id);
    if (!isPosInt(image.bytes)) return failReading('images', 'image bytes ' + id);
    if (typeof image.pixelFormat !== 'string' || !PIXEL_FORMATS.includes(image.pixelFormat)) {
      return failReading('format', 'unsupported pixel format ' + id + ' ' + String(image.pixelFormat));
    }
    imageById.set(id, { id, width: image.width, height: image.height, bytes: image.bytes, pixelFormat: image.pixelFormat });
  }
  if (imageById.size !== expected.images.length) return failReading('images', 'missing images');

  const results = Array.isArray(value.results) ? value.results : null;
  if (!results || results.length !== expected.jobs.length) return failReading('results', 'result list length');

  const normalized = [];
  for (let index = 0; index < expected.jobs.length; index += 1) {
    const result = results[index];
    const job = expected.jobs[index];
    if (!isRecord(result)) return failReading('results', 'result is not an object at ' + index);
    if (result.job !== index) return failReading('results', 'job index ' + index);
    if (result.kind !== job.kind) return failReading('results', 'job kind ' + index);
    if (result.a !== job.a || result.b !== job.b) return failReading('results', 'job images ' + index);
    const rows = Array.isArray(result.regions) ? result.regions : null;
    // 一个 equal job 不声明区域时，像素脚本比较整幅图，并把这一行叫 full；这里补出同样的期望行。
    const declared = Array.isArray(job.regions) ? job.regions : [];
    let wantRows = declared;
    if (declared.length === 0) {
      const whole = imageById.get(job.a);
      if (!whole) return failReading('results', 'job images at ' + index);
      wantRows = [{ name: 'full', x: 0, y: 0, width: whole.width, height: whole.height }];
    }
    if (!rows || rows.length !== wantRows.length) return failReading('results', 'region list length at ' + index);

    const regions = [];
    for (let cursor = 0; cursor < wantRows.length; cursor += 1) {
      const row = rows[cursor];
      const want = wantRows[cursor];
      if (!isRecord(row)) return failReading('results', 'region is not an object ' + index + '/' + cursor);
      if (row.name !== want.name) return failReading('results', 'region name ' + want.name);
      if (row.width !== want.width || row.height !== want.height) return failReading('dimensions', 'region size ' + want.name);
      if (!isWhole(row.x) || !isWhole(row.y) || row.x < 0 || row.y < 0) return failReading('results', 'region origin ' + want.name);
      // 原点必须与声明的一模一样：只比尺寸的话，脚本把区域挪到图里别的位置也能"对上"。
      if (!isWhole(want.x) || !isWhole(want.y)) return failReading('expected', 'declared origin ' + want.name);
      if (row.x !== want.x || row.y !== want.y) return failReading('results', 'region origin mismatch ' + want.name);
      const total = row.total;
      const changed = row.changed;
      const alphaChanged = row.alphaChanged;
      if (!isWhole(total) || total !== want.width * want.height) return failReading('results', 'region total ' + want.name);
      if (!isWhole(changed) || changed < 0 || changed > total) return failReading('results', 'region changed ' + want.name);
      if (!isWhole(alphaChanged) || alphaChanged < 0 || alphaChanged > total) return failReading('results', 'region alpha ' + want.name);

      let bbox = null;
      if (changed > 0) {
        const raw = row.bbox;
        if (!isRecord(raw)) return failReading('results', 'region bbox missing ' + want.name);
        if (!isWhole(raw.x) || !isWhole(raw.y) || !isPosInt(raw.width) || !isPosInt(raw.height)) {
          return failReading('results', 'region bbox shape ' + want.name);
        }
        if (raw.x < row.x || raw.y < row.y) return failReading('results', 'region bbox origin ' + want.name);
        if (raw.x + raw.width > row.x + want.width || raw.y + raw.height > row.y + want.height) {
          return failReading('results', 'region bbox outside ' + want.name);
        }
        bbox = { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
      } else if (row.bbox !== null && row.bbox !== undefined) {
        return failReading('results', 'region bbox but no changes ' + want.name);
      }

      for (const key of ['meanA', 'meanB']) {
        const mean = row[key];
        if (!isRecord(mean)) return failReading('results', 'region ' + key + ' ' + want.name);
        for (const channel of ['r', 'g', 'b']) {
          if (!isNum(mean[channel]) || mean[channel] < 0 || mean[channel] > 255) {
            return failReading('results', 'region ' + key + '.' + channel + ' ' + want.name);
          }
        }
      }

      regions.push({
        name: want.name,
        x: row.x,
        y: row.y,
        width: want.width,
        height: want.height,
        changed,
        alphaChanged,
        total,
        ratio: changed / total,
        alphaRatio: alphaChanged / total,
        bbox,
        meanA: { r: row.meanA.r, g: row.meanA.g, b: row.meanA.b },
        meanB: { r: row.meanB.r, g: row.meanB.g, b: row.meanB.b },
      });
    }
    normalized.push({ job: index, kind: job.kind, a: job.a, b: job.b, regions });
  }

  return { ok: true, images: [...imageById.values()], results: normalized };
}

// ---------------------------------------------------------------------------
// 判据（纯函数：喂数据、出结论，阈值是常量）
// ---------------------------------------------------------------------------

export function judgeHighlight(input) {
  const inside = input.inside;
  const outside = Array.isArray(input.outside) ? input.outside.filter(entry => entry !== null && entry !== undefined) : [];
  if (!inside) {
    return { shown: false, visible: false, geometryOk: false, ratio: null, outsideMax: null, bbox: null, offset: null, reasons: ['inside-region-missing'] };
  }
  const minInside = isNum(input.minInsideRatio) ? input.minInsideRatio : INSIDE_MIN_RATIO;
  const maxOutside = isNum(input.maxOutsideRatio) ? input.maxOutsideRatio : OUTSIDE_MAX_RATIO;
  const tolerance = isNum(input.tolerance) ? input.tolerance : PIXEL_TOLERANCE;
  const ratio = inside.changed / inside.total;
  const outsideMax = outside.length ? Math.max(...outside.map(entry => entry.changed / entry.total)) : 0;
  const bbox = inside.changed > 0 ? inside.bbox : null;
  const offset = bbox && isRect(input.expected)
    ? { dx: bbox.x - input.expected.x, dy: bbox.y - input.expected.y, dw: bbox.width - input.expected.width, dh: bbox.height - input.expected.height }
    : null;
  const geometryOk = Boolean(offset)
    && Math.abs(offset.dx) <= tolerance
    && Math.abs(offset.dy) <= tolerance
    && Math.abs(offset.dw) <= tolerance
    && Math.abs(offset.dh) <= tolerance;
  const reasons = [];
  if (ratio < minInside) reasons.push('inside-unchanged');
  if (outsideMax > maxOutside) reasons.push('outside-changed');
  if (bbox && !geometryOk) reasons.push('geometry-offset');
  const shown = ratio >= minInside && outsideMax <= maxOutside;
  return { shown, visible: shown && geometryOk, geometryOk, ratio, outsideMax, bbox, offset, reasons };
}

/** 单条路径三轮汇总：可见性、几何、hide 回基线、一致性。 */
export function judgeRounds(evidences) {
  const list = Array.isArray(evidences) ? evidences : [];
  const rounds = list.length;
  const shown = list.filter(entry => entry && entry.highlight && entry.highlight.shown === true);
  const visible = list.filter(entry => entry && entry.highlight && entry.highlight.visible === true);
  const mismatched = shown.filter(entry => entry.highlight.visible !== true);
  const hiddenOk = list.filter(entry => entry && entry.hidden && entry.hidden.identical === true);
  const domOk = list.filter(entry => entry && entry.dom && entry.dom.ok === true);
  const allShown = rounds > 0 && shown.length === rounds;
  const allVisible = rounds > 0 && visible.length === rounds;
  const hiddenAll = rounds > 0 && hiddenOk.length === rounds;
  const domAll = rounds > 0 && domOk.length === rounds;
  const geometryMismatch = mismatched.length >= 2;   // 至少两轮同向偏移才算几何问题
  const consistent = rounds > 0 && hiddenAll && domAll
    && (shown.length === 0 || (allVisible && shown.length === rounds))
    && !geometryMismatch;
  return {
    rounds,
    shownRounds: shown.length,
    visibleRounds: visible.length,
    mismatchRounds: mismatched.length,
    hiddenRounds: hiddenOk.length,
    domRounds: domOk.length,
    visible: allVisible,
    hiddenAll,
    domAll,
    geometryMismatch,
    consistent,
    offsets: shown.map(entry => entry.highlight.offset),
    ratios: shown.map(entry => entry.highlight.ratio),
  };
}

/**
 * 总裁决。身份与像素分开：这里只看像素证据，identity 字段由 composeReport 另外装配。
 */
export function overlayVerdict(input) {
  const preconditions = input.preconditions;
  const controls = input.controls;
  const baseline = input.baseline;
  const paths = input.paths;
  if (!isRecord(preconditions) || preconditions.ok !== true) {
    return { overlayCapture: 'inconclusive', reason: 'preconditions' };
  }
  if (!isRecord(controls) || !isRecord(controls.native) || !isRecord(controls.surface)
    || controls.native.ok !== true || controls.surface.ok !== true) {
    return { overlayCapture: 'inconclusive', reason: 'positive-control' };
  }
  if (!isRecord(baseline) || baseline.native !== true || baseline.surface !== true) {
    return { overlayCapture: 'inconclusive', reason: 'baseline-drift' };
  }
  if (!isRecord(paths) || !isRecord(paths.native) || !isRecord(paths.surface)) {
    return { overlayCapture: 'inconclusive', reason: 'path-evidence-missing' };
  }
  if (paths.native.geometryMismatch === true || paths.surface.geometryMismatch === true) {
    return { overlayCapture: 'geometry-mismatch', reason: 'highlight-not-where-predicted' };
  }
  if (paths.native.consistent !== true || paths.surface.consistent !== true) {
    return { overlayCapture: 'inconclusive', reason: 'rounds-disagree' };
  }
  if (paths.native.visible === true && paths.surface.visible === true) {
    return { overlayCapture: 'both', reason: 'both-capture-paths-see-it' };
  }
  if (paths.native.visible === true) return { overlayCapture: 'native-only', reason: 'window-content-only' };
  if (paths.surface.visible === true) return { overlayCapture: 'inconclusive', reason: 'surface-only' };
  return { overlayCapture: 'neither', reason: 'no-capture-path-sees-it' };
}

/**
 * 阈值是否全过（与 overlayCapture 分开，便于单独断言）。
 * "看见"只在裁决说该看见的那条路径上要求；两条路径都必须 hide 回基线、DOM 未变、三轮一致、无几何偏移。
 * 这样 native-only 也能是成功（window content 看得见、surface 看不见），而不会因为 surface 应该看不见就判负。
 */
export function thresholdsMet(report) {
  if (!isRecord(report)) return false;
  const capture = report.overlayCapture;
  if (capture !== 'native-only' && capture !== 'both') return false;
  const paths = isRecord(report.paths) ? report.paths : null;
  if (!paths) return false;
  for (const pathId of ['native', 'surface']) {
    const path = paths[pathId];
    if (!isRecord(path)) return false;
    if (path.hiddenAll !== true || path.domAll !== true) return false;
    if (path.geometryMismatch === true || path.consistent !== true) return false;
  }
  if (paths.native.visible !== true) return false;
  if (capture === 'both' && paths.surface.visible !== true) return false;
  return true;
}

/** 退出码：清理未确认永远非 0；像素成功必须是预设门槛全过，不看 C16 的 isProbeSuccess。 */
export function overlayExitCode(report) {
  if (!isRecord(report)) return 4;
  if (report.stopReason && report.stopReason.code === 'stale-build') return 3;
  if (report.stopReason && report.stopReason.code === 'unexpected') return 4;
  const cleanup = report.cleanup;
  const cleanupOk = isRecord(cleanup) && cleanup.ok === true && cleanup.browserClosed === true;
  const restore = report.restore;
  const restoreOk = !isRecord(restore) || restore.notNeeded === true || restore.ok === true;
  return cleanupOk && restoreOk && thresholdsMet(report) ? 0 : 2;
}

/**
 * 清理只有**一个绝对的 deadline**：从 finally 入口算 60s，Overlay 卫生与 restore→reverify→close→stop 全在里面。
 * 卫生先花掉的真实毫秒从后面扣掉；扣到 0 就是 0，绝不再补一个"最少 1s"的预算（那会让清理越过自己的上限）。
 */
export function cleanupDeadline(startMs) {
  const start = isNum(startMs) ? Math.round(startMs) : 0;
  return { startMs: start, hardEnd: start + CLEANUP_TOTAL_MS, capMs: CLEANUP_TOTAL_MS };
}

/** 同一个绝对 deadline 上还剩多少预算；用完了就是 0（调用方据此跳过，不再硬撑）。 */
export function cleanupRemaining(deadline, nowMs) {
  if (!isRecord(deadline) || !isNum(deadline.hardEnd)) return 0;
  const at = isNum(nowMs) ? nowMs : Date.now();
  return Math.max(0, deadline.hardEnd - at);
}

/** 卫生的下一步能拿多少：单步 ≤700ms、卫生合计 ≤2s，并且都得落在同一个清理 deadline 里。 */
export function hygieneStepMs(deadline, usedMs, nowMs, stepCapMs) {
  const cap = isPosInt(stepCapMs) ? stepCapMs : CLEANUP_HYGIENE_STEP_MS;
  const used = isNum(usedMs) && usedMs > 0 ? usedMs : 0;
  const hygieneLeft = Math.max(0, CLEANUP_HYGIENE_MS - used);
  return Math.max(0, Math.min(cap, hygieneLeft, cleanupRemaining(deadline, nowMs)));
}
/** 一个预算域：主体这条、清理那条各一个，互不继承。endAt 非法时 left() 恒 0（fail closed，什么都不发）。 */
export function makeBudgetDomain(label, endAtMs) {
  const known = isNum(endAtMs);
  const endAt = known ? endAtMs : 0;
  return {
    label: typeof label === 'string' && label !== '' ? label : 'body',
    endAt,
    ms: known ? Math.max(0, endAt - Date.now()) : 0,
    left(nowMs) {
      const at = isNum(nowMs) ? nowMs : Date.now();
      return known ? Math.max(0, endAt - at) : 0;
    },
  };
}

/** 启动门槛：剩余不够完整的上限就一次都不发起（不 spawn、不留半开的浏览器）。 */
export function launchGate(remainingMs, needMs) {
  const need = isPosInt(needMs) ? needMs : LAUNCH_BUDGET_MS;
  const left = isNum(remainingMs) && remainingMs > 0 ? remainingMs : 0;
  if (left >= need) return { ok: true, needMs: need, remainingMs: left };
  return { ok: false, code: 'launch-budget', needMs: need, remainingMs: left };
}

export async function boundedSleep(domain, ms, sleepFn) {
  const sleeper = typeof sleepFn === 'function' ? sleepFn : sleep;
  const left = isRecord(domain) && typeof domain.left === 'function' ? domain.left() : 0;
  const wanted = Math.max(0, Math.min(isNum(ms) && ms > 0 ? ms : 0, left));
  if (wanted <= 0) return 0;
  await sleeper(wanted);
  return wanted;
}

/**
 * 命令账本：每条真正发出去的命令都先查域剩余，再以 min(cap, 剩余) 投递，并登记**原始** promise。
 * 等待超时只结束“等”这件事，账本里那条仍记 pending —— 报告不能因为它超时就说它停了。
 */
export function createDispatchLedger(options) {
  const clock = isRecord(options) && typeof options.now === 'function' ? options.now : () => Date.now();
  const raws = new Map();
  const entries = [];
  const totals = { sent: 0, settled: 0, lateAdopted: 0, seq: 0 };

  const pending = () => raws.size;

  const note = (entry, ok, value, onLate) => {
    entry.settled = true;
    entry.ok = ok === true;
    entry.outcome = ok === true ? 'settled' : 'rejected';
    entry.error = ok === true ? null : errorText(value);
    totals.settled += 1;
    raws.delete(entry.id);
    if (entry.timedOut === true && typeof onLate === 'function') {
      totals.lateAdopted += 1;
      entry.lateAdopted = true;
      // 回调契约只有一个对象：{entry, ok, value, domain, label}。
      // 首参不是"结果"本身——把账目对象当连接去 close 的写法（账目上没有 close）会静默丢掉晚到的连接。
      const late = { entry, ok: ok === true, value, domain: entry.domain, label: entry.label };
      try { onLate(late); } catch { /* 晚到的处置失败也不能改账 */ }
    }
  };

  const begin = (domain, label, capMs, thunk, extra) => {
    const name = typeof label === 'string' && label !== '' ? label : 'dispatch';
    const domainLabel = isRecord(domain) && typeof domain.label === 'string' ? domain.label : 'body';
    const left = isRecord(domain) && typeof domain.left === 'function' ? domain.left(clock()) : 0;
    if (!(left > 0)) {
      throw new Stopped('budget-exhausted', { domain: domainLabel, label: name, capMs: isNum(capMs) ? capMs : null, remainingMs: left });
    }
    if (typeof thunk !== 'function') throw new Stopped('dispatch-without-work', { domain: domainLabel, label: name });
    const cap = Math.max(1, Math.min(isNum(capMs) && capMs > 0 ? capMs : 1, left));
    totals.seq += 1;
    const entry = {
      id: totals.seq, domain: domainLabel, label: name,
      capMs: isNum(capMs) ? capMs : null, cap, startedAt: clock(),
      settled: false, ok: null, outcome: 'pending', error: null, timedOut: false, lateAdopted: false,
    };
    const raw = Promise.resolve(thunk());
    entry.promise = raw;
    raws.set(entry.id, raw);
    totals.sent += 1;
    entries.push(entry);
    raw.then(value => note(entry, true, value, extra && extra.onLate), error => note(entry, false, error, extra && extra.onLate));
    return entry;
  };

  const wait = async entry => {
    const promise = isRecord(entry) ? entry.promise : null;
    if (!promise || typeof promise.then !== 'function') throw new Stopped('dispatch-unknown', {});
    let timer = null;
    const expiry = new Promise((_, reject) => {
      timer = setTimeout(() => {
        entry.timedOut = true;
        reject(new Stopped('wait-timeout', { domain: entry.domain, label: entry.label, ms: entry.cap, pending: pending() }));
      }, entry.cap);
    });
    try {
      return await Promise.race([promise, expiry]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const run = async (domain, label, capMs, thunk, extra) => wait(begin(domain, label, capMs, thunk, extra));

  const waitSettled = async (ms, domainLabel) => {
    const label = typeof domainLabel === 'string' ? domainLabel : null;
    if (pending() === 0) return { settled: true, pending: 0 };
    const budget = isNum(ms) && ms > 0 ? ms : 0;
    if (budget <= 0) return { settled: false, reason: 'no-budget', pending: pending(), domain: label };
    const waits = Array.from(raws.values());
    let timer = null;
    const outcome = await new Promise(resolve => {
      const finish = () => resolve('settled');
      Promise.all(waits.map(one => one.then(() => undefined, () => undefined))).then(finish, finish);
      timer = setTimeout(() => resolve('wait-timeout'), Math.min(budget, 2 ** 31 - 1));
    });
    if (timer) clearTimeout(timer);
    if (outcome === 'settled' && pending() === 0) return { settled: true, pending: 0 };
    return { settled: false, reason: outcome === 'settled' ? 'new-dispatch-appeared' : 'wait-timeout', pending: pending(), domain: label };
  };

  const snapshot = () => ({
    sent: totals.sent,
    settled: totals.settled,
    pending: pending(),
    lateAdopted: totals.lateAdopted,
    // 恒 false：只报账本事实，绝不声称“已经停下”。
    terminated: false,
    entries: entries.map(entry => ({
      id: entry.id, domain: entry.domain, label: entry.label,
      capMs: entry.capMs, cap: entry.cap, startedAt: entry.startedAt,
      settled: entry.settled === true, outcome: entry.outcome,
      timedOut: entry.timedOut === true, lateAdopted: entry.lateAdopted === true,
      ok: entry.ok === true, error: entry.error,
    })),
  });

  return { begin, run, wait, waitSettled, snapshot };
}

/**
 * 晚到结果的统一口径：只有成功的 value 才可能是连接。
 * main 与离线测试都调这一个函数，免得两处各自把"账目"当成连接去 close。
 */
export function closeLateConnection(result, evidence, label) {
  const name = typeof label === 'string' && label !== '' ? label : 'cdp';
  const room = Array.isArray(evidence) ? evidence : [];
  const late = isRecord(result) ? result : {};
  if (late.ok !== true) {
    room.push('cdp:' + name + ': 晚到的连接请求失败了（' + (late.value === undefined ? 'unknown' : errorText(late.value)) + '），没有连接可关');
    return { closed: false, reason: 'late-attempt-failed' };
  }
  const cdp = late.value;
  if (!isRecord(cdp) || typeof cdp.close !== 'function') {
    room.push('cdp:' + name + ': 晚到的连接没有 close 可用，只能留作未关闭事实');
    return { closed: false, reason: 'no-close' };
  }
  try {
    cdp.close();
    room.push('cdp:' + name + ': 晚到的连接已经关掉，没有交给主体');
    return { closed: true, reason: null };
  } catch (error) {
    room.push('cdp:' + name + ': 晚到的连接关不掉（' + errorText(error) + '），只能留作未关闭事实');
    return { closed: false, reason: 'close-failed' };
  }
}

/**
 * 连一个 CDP target：预算先查、命令后发；晚到的连接由 closeLateConnection 关掉。
 * main 的 openCdpAs 与离线测试走同一个函数——行为回归不另写一份。
 */
export function openConnection(options) {
  const settings = isRecord(options) ? options : {};
  const ledger = settings.ledger;
  const domain = settings.domain;
  const label = typeof settings.label === 'string' && settings.label !== '' ? settings.label : 'cdp';
  const connectFn = settings.connectFn;
  const evidence = Array.isArray(settings.evidence) ? settings.evidence : [];
  const capMs = isNum(settings.timeoutMs) && settings.timeoutMs > 0 ? Math.min(settings.timeoutMs, CDP_TIMEOUT_MS) : CDP_TIMEOUT_MS;
  if (!isRecord(ledger) || typeof ledger.begin !== 'function') throw new Stopped('ledger-missing', { label });
  if (!isRecord(domain) || typeof domain.left !== 'function') throw new Stopped('domain-missing', { label });
  if (typeof connectFn !== 'function') throw new Stopped('connect-missing', { label });
  const entry = ledger.begin(domain, 'cdp:connect:' + label, capMs,
    () => connectFn(settings.url, { timeoutMs: Math.max(1, Math.min(capMs, domain.left(Date.now()))) }),
    { onLate: result => closeLateConnection(result, evidence, label) });
  return ledger.wait(entry).then(cdp => {
    if (!isRecord(cdp) || typeof cdp.send !== 'function' || typeof cdp.close !== 'function') throw new Stopped('cdp-shape', { label });
    return cdp;
  });
}

/**
 * 清理阶段的每一次真实命令：先看阶段还开着吗、还有没有预算，再投递。
 * remaining() 归零就是零——绝不回落成"再给一份 cap"。
 */
export function stageDispatch(options) {
  const settings = isRecord(options) ? options : {};
  const name = typeof settings.label === 'string' && settings.label !== '' ? settings.label : 'dispatch';
  const stage = settings.stage;
  if (!isRecord(stage)) throw new Stopped('stage-unknown', { label: name });
  if (stage.closed === true) throw new Stopped('stage-closed', { label: name });
  const stageLeft = typeof stage.remaining === 'function' ? stage.remaining() : 0;
  if (!isNum(stageLeft) || stageLeft <= 0) throw new Stopped('stage-budget', { label: name, remainingMs: isNum(stageLeft) ? stageLeft : null });
  const wanted = isNum(settings.capMs) && settings.capMs > 0 ? Math.min(settings.capMs, stageLeft) : stageLeft;
  if (!(wanted > 0)) throw new Stopped('stage-budget', { label: name, remainingMs: stageLeft });
  if (!isRecord(settings.ledger) || typeof settings.ledger.run !== 'function') throw new Stopped('ledger-missing', { label: name });
  return settings.ledger.run(settings.domain, name, wanted, settings.thunk);
}

/** 主体那条窗口写：先查主体域预算，再动写闸。过期域一条命令都不发。 */
export function sendWindowWrite(options) {
  const settings = isRecord(options) ? options : {};
  const capMs = isNum(settings.timeoutMs) && settings.timeoutMs > 0 ? settings.timeoutMs : CDP_TIMEOUT_MS;
  const gate = settings.writeGate;
  if (!isRecord(gate) || typeof gate.write !== 'function') throw new Stopped('write-gate-not-ready', {});
  const ledger = settings.ledger;
  if (!isRecord(ledger) || typeof ledger.begin !== 'function') throw new Stopped('ledger-missing', {});
  const entry = ledger.begin(settings.domain, 'browser:Browser.setWindowBounds', capMs,
    () => gate.write(settings.windowId, settings.bounds, settings.guard));
  return ledger.wait(entry);
}

/**
 * 恢复前的两条屏障：广义账本（主体任何一条已发命令的原始 promise）+ 窗口写闸。
 * 只要有一条没结算，就不许写恢复 bounds——unknown 不冒充"已经停下"。
 */
export function restoreReadiness(dispatched, barrier) {
  const wide = isRecord(dispatched) ? dispatched : {};
  const narrow = isRecord(barrier) ? barrier : {};
  const wideOk = wide.settled === true;
  const narrowOk = narrow.settled === true;
  if (wideOk && narrowOk) return { ok: true, code: null, reason: null, pending: 0 };
  const count = value => (isNum(value) && value > 0 ? Math.round(value) : 0);
  return {
    ok: false,
    code: 'previous-write-unknown',
    reason: wideOk ? (narrow.reason === undefined ? null : narrow.reason) : (wide.reason === undefined ? null : wide.reason),
    pending: Math.max(count(wide.pending), count(narrow.pending)),
  };
}

/**
 * 清理预算的账：卫生花了多少（真实耗时），后面的阶段还剩多少。
 * 阶段预算还要再和 cleanupRemaining() 取 min，真正把关的是那个绝对 deadline。
 */
export function cleanupBudget(hygieneMs) {
  const raw = isNum(hygieneMs) && hygieneMs > 0 ? Math.round(hygieneMs) : 0;
  const hygiene = Math.min(raw, CLEANUP_HYGIENE_MS);
  const totalMs = Math.max(0, CLEANUP_TOTAL_MS - hygiene);
  return { hygieneMs: hygiene, totalMs, totalWithHygieneMs: hygiene + totalMs, capMs: CLEANUP_TOTAL_MS };
}

/**
 * 窗口写入闸：把"主体写窗口"与"清理里恢复窗口"严格分开。
 * - 主体只能经 write() 写；finally 第一件事 closeBody() 就把它关死（迟到的闭包也写不进去）。
 * - 每次写都记下**原始**那条 CDP promise —— 不是外面那层 withTimeout 竞速，屏障等的是原始命令。
 * - 恢复只能经 restoreWrite() 写，而且必须先等原始命令结算；结算不了就如实报 unknown：
 *   既不假装那条命令"已经停了"（它可能仍被应用），也绝不再叠一条新写上去。
 */
export function createWindowWriteGate(options) {
  const settings = isRecord(options) ? options : {};
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  let send = typeof settings.send === 'function' ? settings.send : null;
  const state = { bodyOpen: true, sent: 0, settled: 0, last: null };
  const pending = new Set();

  const sendNow = (method, params) => {
    if (typeof send !== 'function') throw new Stopped('write-gate-not-ready', { method });
    return send(method, params);
  };

  // 派生链永不 reject：原始 promise 由调用方自己 await，这里只关心它"结算没结算"。
  const track = raw => {
    const entry = { atMs: now() };
    entry.wait = Promise.resolve(raw).then(
      () => { state.settled += 1; pending.delete(entry); },
      () => { state.settled += 1; pending.delete(entry); },
    );
    pending.add(entry);
    return entry;
  };

  const waitSettled = async ms => {
    if (pending.size === 0) return { settled: true, pending: 0 };
    const left = isNum(ms) ? Math.max(0, ms) : 0;
    if (left <= 0) return { settled: false, reason: 'no-budget', pending: pending.size };
    const waiters = [...pending].map(entry => entry.wait);
    let timer = null;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve('timeout'), Math.max(1, Math.min(left, 2_147_483_647)));
    });
    try {
      const outcome = await Promise.race([Promise.all(waiters).then(() => 'settled'), timeout]);
      // 这一批结算了，但期间可能又发了新的写：那就还没稳。
      if (outcome === 'settled' && pending.size === 0) return { settled: true, pending: 0 };
      return { settled: false, reason: outcome === 'settled' ? 'new-write-appeared' : 'timeout', pending: pending.size };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    attach(next) {
      send = typeof next === 'function' ? next : null;
    },
    /** 主体写入：关死之后一律拒绝，不靠调用方自觉。 */
    write(windowId, bounds, guard) {
      if (state.bodyOpen !== true) throw new Stopped('window-writes-closed', { reason: 'the body is over' });
      if (typeof guard === 'function') guard();
      const raw = sendNow('Browser.setWindowBounds', { windowId, bounds });
      track(raw);
      state.sent += 1;
      state.last = { atMs: now(), method: 'Browser.setWindowBounds', from: 'body' };
      return raw;
    },
    closeBody() {
      state.bodyOpen = false;
    },
    get bodyOpen() {
      return state.bodyOpen;
    },
    get pendingCount() {
      return pending.size;
    },
    waitSettled,
    /**
     * 恢复写入：只在清理阶段、只经当前那个还没关的 StageRunner。
     * 屏障不过就抛 previous-write-unknown，一条新写都不发。
     */
    async restoreWrite(stage, windowId, bounds) {
      if (state.bodyOpen !== false) throw new Stopped('window-writes-closed', { reason: 'the body is still open' });
      if (!stage || stage.closed === true) throw new Stopped('window-writes-closed', { reason: 'the stage is closed' });
      const left = typeof stage.remaining === 'function' ? stage.remaining() : 0;
      if (!isNum(left) || left <= 0) throw new Stopped('window-writes-closed', { reason: 'the stage has no budget left' });
      const barrier = await waitSettled(left);
      if (barrier.settled !== true) {
        throw new Stopped('previous-write-unknown', { pending: barrier.pending, reason: barrier.reason });
      }
      // 屏障是 await：等回来之后阶段可能已经被 watchdog 关掉、预算也可能已经用完。
      // 这里必须再查一遍，否则会在这段时间里发出一条没人预算、也没人看守的恢复写。
      if (stage.closed === true) {
        throw new Stopped('window-writes-closed', { reason: 'the stage closed while waiting for the barrier' });
      }
      const leftAfterBarrier = typeof stage.remaining === 'function' ? stage.remaining() : 0;
      if (!isNum(leftAfterBarrier) || leftAfterBarrier <= 0) {
        throw new Stopped('window-writes-closed', { reason: 'the stage ran out of budget while waiting for the barrier' });
      }
      const raw = sendNow('Browser.setWindowBounds', { windowId, bounds });
      track(raw);
      state.sent += 1;
      state.last = { atMs: now(), method: 'Browser.setWindowBounds', from: 'restore' };
      return await raw;
    },
    /** 报告用：terminated 永远 false —— 超时之后那条命令仍可能被应用，不伪造结论。 */
    snapshot() {
      return {
        sent: state.sent,
        settled: state.settled,
        pending: pending.size,
        bodyOpen: state.bodyOpen,
        terminated: false,
        last: state.last ? { atMs: state.last.atMs, method: state.last.method, from: state.last.from } : null,
      };
    },
  };
}

export function shotLedger(limit) {
  const cap = isPosInt(limit) ? limit : MAX_SHOTS;
  let taken = 0;
  return {
    take(name) {
      if (taken >= cap) throw new Stopped('shot-budget', { limit: cap, name });
      taken += 1;
      return taken;
    },
    get count() { return taken; },
    get remaining() { return cap - taken; },
  };
}

/**
 * 报告装配：identity 只从 identity 入参取，像素结论只从 pixels 入参取，sameSurface 永远是常量。
 * 这样"身份证成了"永远改不了"像素看见了"，反之亦然。
 */
/**
 * 报告里的 cleanup 段。只搬真实记录过的证据：缺的就是 null，绝不补成"已经停下"或"已经恢复"。
 * budgetAccountingMs / hardEndAt / barrier / windowWrites 是 90s 主体预算与 60s 清理预算那份账的原始事实：
 * 少了它们，事后就看不出阶段用的是哪条绝对 deadline、屏障有没有真的等到、以及有没有晚到的窗口写。
 */
export function cleanupReportOf(cleanup, outcome) {
  const own = isRecord(cleanup) ? cleanup : {};
  const result = isRecord(outcome) ? outcome : {};
  return {
    ok: result.ok === true,
    browserClosed: own.browserClosed === true,
    killedByPath: own.killedByPath === true,
    hygieneMs: own.hygieneMs === undefined ? null : own.hygieneMs,
    hygieneBudgetMs: own.hygieneBudgetMs === undefined ? null : own.hygieneBudgetMs,
    budget: own.budget === undefined ? null : own.budget,
    budgetAccountingMs: own.budgetAccountingMs === undefined ? null : own.budgetAccountingMs,
    hardEndAt: own.hardEndAt === undefined ? null : own.hardEndAt,
    startedAt: own.startedAt === undefined ? null : own.startedAt,
    domains: own.domains === undefined ? null : own.domains,
    launch: own.launch === undefined ? null : own.launch,
    dispatch: own.dispatch === undefined ? null : own.dispatch,
    barrier: own.barrier === undefined ? null : own.barrier,
    windowWrites: own.windowWrites === undefined ? null : own.windowWrites,
    evidence: Array.isArray(own.evidence) ? own.evidence.slice() : [],
    restore: result.restore === undefined ? null : result.restore,
    reverify: result.reverify === undefined ? null : result.reverify,
    close: result.close === undefined ? null : result.close,
    stop: result.stop === undefined ? null : result.stop,
  };
}

export function composeReport(identity, pixels) {
  const id = isRecord(identity) ? identity : {};
  const px = isRecord(pixels) ? pixels : {};
  return {
    schema: 'browser-overlay-probe/1',
    scope: 'isolated-only',
    pointerOutput: 'none',
    productionGeometryChanged: false,
    calibrationEnabled: false,
    sameSurface: SAME_SURFACE,
    identity: {
      binding: id.binding === undefined ? null : id.binding,
      windowId: id.windowId === undefined ? null : id.windowId,
      hwnd: id.hwnd === undefined ? null : id.hwnd,
      matchedPid: id.matchedPid === undefined ? null : id.matchedPid,
      dpiScale: id.dpiScale === undefined ? null : id.dpiScale,
      moves: id.moves === undefined ? null : id.moves,
      factors: id.factors === undefined ? null : id.factors,
      uniqueWindow: id.uniqueWindow === undefined ? null : id.uniqueWindow,
      uniqueRenderer: id.uniqueRenderer === undefined ? null : id.uniqueRenderer,
    },
    overlayCapture: px.overlayCapture === undefined ? 'inconclusive' : px.overlayCapture,
    overlayReason: px.overlayReason === undefined ? null : px.overlayReason,
    preconditions: px.preconditions === undefined ? null : px.preconditions,
    controls: px.controls === undefined ? null : px.controls,
    baseline: px.baseline === undefined ? null : px.baseline,
    geometry: px.geometry === undefined ? null : px.geometry,
    paths: px.paths === undefined ? null : px.paths,
    shots: px.shots === undefined ? [] : px.shots,
    pixelJobs: px.pixelJobs === undefined ? [] : px.pixelJobs,
    rounds: px.rounds === undefined ? [] : px.rounds,
    dom: px.dom === undefined ? null : px.dom,
  };
}

// ---------------------------------------------------------------------------
// 帧差（只比较本 profile 枚举到的窗口）
// ---------------------------------------------------------------------------

function rectDelta(before, after) {
  return { dx: after.x - before.x, dy: after.y - before.y, dw: after.width - before.width, dh: after.height - before.height };
}

export function diffFrames(before, after, intendedHwnd) {
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
    return {
      hwnd: win.hwnd,
      intended: win.hwnd === intendedHwnd,
      visible: win.visible,
      windowRect: win.windowRect,
      delta: prior ? rectDelta(prior.windowRect, win.windowRect) : null,
      children: children.map(entry => {
        const older = priorChildren.get(entry.hwnd);
        return {
          hwnd: entry.hwnd,
          visible: entry.visible,
          clientRect: entry.clientRect,
          delta: older ? rectDelta(older.clientRect, entry.clientRect) : null,
          appeared: !older,
        };
      }),
    };
  });
  return { added, removed, rows };
}

/**
 * 一次位移的因果判定：只有目标窗口（和它的 renderer）按 dip×dpiScale 动了，别的一动都不许动。
 * 因子 = 物理位移 / DIP 位移，只做交叉核验用，不充绝对坐标转换证明。
 */
export function assessMove(diff, dip, dpiScale) {
  const reasons = [];
  const rows = isRecord(diff) && Array.isArray(diff.rows) ? diff.rows : [];
  const target = rows.find(row => row.intended === true);
  if (!target) {
    return { ok: false, reasons: ['intended-window-missing'], observed: null, factors: { x: null, y: null } };
  }
  if (target.visible !== true) reasons.push('intended-window-not-visible');
  if (!isRecord(target.delta)) reasons.push('intended-window-has-no-baseline');
  const wanted = { dx: dip.dx * dpiScale, dy: dip.dy * dpiScale };
  if (isRecord(target.delta)) {
    if (!near(target.delta.dx, wanted.dx, PIXEL_TOLERANCE)) reasons.push('intended-dx');
    if (!near(target.delta.dy, wanted.dy, PIXEL_TOLERANCE)) reasons.push('intended-dy');
    if (!near(target.delta.dw, 0, PIXEL_TOLERANCE)) reasons.push('intended-dw');
    if (!near(target.delta.dh, 0, PIXEL_TOLERANCE)) reasons.push('intended-dh');
  }
  for (const row of rows) {
    if (row.intended === true) continue;
    if (isRecord(row.delta)) {
      if (!near(row.delta.dx, 0, PIXEL_TOLERANCE) || !near(row.delta.dy, 0, PIXEL_TOLERANCE)) reasons.push('other-window-moved:' + row.hwnd);
    }
    for (const child of row.children || []) {
      if (!isRecord(child.delta)) continue;
      if (!near(child.delta.dx, 0, CHILD_TOLERANCE) || !near(child.delta.dy, 0, CHILD_TOLERANCE)) reasons.push('other-child-moved:' + child.hwnd);
    }
  }
  const widgets = (target.children || []).filter(child => isRecord(child.delta));
  if (widgets.length !== 1) reasons.push('renderer-count:' + widgets.length);
  for (const child of widgets) {
    if (!near(child.delta.dx, wanted.dx, CHILD_TOLERANCE)) reasons.push('renderer-dx');
    if (!near(child.delta.dy, wanted.dy, CHILD_TOLERANCE)) reasons.push('renderer-dy');
  }
  const factors = { x: null, y: null };
  if (isRecord(target.delta)) {
    if (dip.dx !== 0) factors.x = target.delta.dx / dip.dx;
    if (dip.dy !== 0) factors.y = target.delta.dy / dip.dy;
  }
  return { ok: reasons.length === 0, reasons, observed: isRecord(target.delta) ? target.delta : null, factors };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const artifactsDir = path.join(ROOT, 'artifacts', 'browser-overlay-probe-' + stamp);
  const reportPath = path.join(artifactsDir, 'report.json');
  const steps = [];
  const evidence = [];
  const step = (name, data) => { steps.push(Object.assign({ name, atMs: Date.now() - startedAt }, data || {})); };
  const budgetDeadline = startedAt + TOTAL_BUDGET_MS;
  // 两个预算域：主体这条在这里定，清理那条在 finally 里按 cleanupStart 另定，谁也不继承谁的截止。
  const bodyDomain = makeBudgetDomain('body', budgetDeadline);
  let cleanupDomain = null;
  const guardBudget = () => {
    if (!(bodyDomain.left(Date.now()) > 0)) throw new Stopped('total-budget', { domain: 'body', ms: TOTAL_BUDGET_MS });
  };
  const ledger = createDispatchLedger({ now: () => Date.now() });
  // 每次连接都过账本：连接本身没有超时，挂住时也要能被记账、被 wait 限制，晚到时被关掉。
  // 晚到连接的处置只写在 openConnection 里（main 与离线测试共用），这里不再另抄一份。
  const openCdpAs = (domain, connectFn, url, label) =>
    openConnection({ ledger, domain, connectFn, url, label, evidence, timeoutMs: CDP_TIMEOUT_MS });
  const fetchJsonAs = (domain, url, capMs) => ledger.run(domain, 'fetch:' + url.replace(/^https?:\/\/[^/]+/, ''),
    isNum(capMs) && capMs > 0 ? capMs : 3000, () => fetchJson(url));

  const state = {
    identity: {},
    pixels: { shots: [], pixelJobs: [], rounds: [], overlayCapture: 'inconclusive' },
    launched: null,
    content: null,
    helperCalls: 0,
    cleanupHygieneMs: 0,
  };

  let driver;
  let arbiter;
  let browserCdp;
  let tabCdp;
  let port = 0;
  let browserWsUrl = '';
  let profileDir = '';
  let verified = false;
  let intendedHwnd = 0;
  let matchedPid = 0;
  let windowId = 0;
  let contentBefore = null;
  let base = null;
  let normalizedFrom = null;
  let moved = false;
  // 窗口写入闸：主体写、清理恢复写分开；finally 一进门就关死主体那一侧。
  const writeGate = createWindowWriteGate({ now: Date.now });
  let readBounds = null;
  let setBounds = null;
  let helperCall = async () => { throw new Stopped('helper-not-ready'); };
  // 这三个要在 finally 里也能用（恢复回读 / 复核 helper / 复核与关闭 CDP），所以声明在函数作用域。
  let helperCallAs = async () => { throw new Stopped('helper-not-ready'); };
  let readBoundsWith = () => async () => { throw new Stopped('bounds-not-ready'); };
  let sendBrowserAs = async () => { throw new Stopped('browser-not-ready'); };
  // 清理里的回读/helper：命令前查 stage.closed / stage.remaining / cleanup 域余额（见 stageDispatch）。
  let readBoundsWithStage = async () => { throw new Stopped('bounds-not-ready'); };
  let helperCallWithStage = async () => { throw new Stopped('helper-not-ready'); };
  let overlayEnabled = false;
  let domInstalled = false;
  let stopReason = null;
  let cleanupResult = null;
  let restoreOutcome = null;

  try {
    if (process.platform !== 'win32') throw new Stopped('not-windows', { platform: process.platform });
    if (!fs.existsSync(PIXELS_SCRIPT)) throw new StaleBuild(['scripts/browser-overlay-pixels.ps1']);

    // ---- preflight：lib/ 必须是当前构建 ----
    const modules = {};
    const wanted = {
      'lib/browser/cdp.js': ['connectCdp', 'pageTargets', 'pageLayout', 'readWindowBounds', 'readTabViewport', 'browserEndpoint'],
      'lib/browser/edge.js': ['findBrowser', 'launchBrowser', 'launchArgs', 'browserCandidates'],
      'lib/desktop/driver.js': ['createDesktopDriver'],
      'lib/desktop/arbiter.js': ['createArbiter'],
      'lib/shared/faults.js': ['Faults'],
      'lib/computer.js': ['readProfileAnswer'],
    };
    const missing = [];
    for (const specifier of Object.keys(wanted)) {
      let module;
      try { module = await import(pathToFileURL(path.join(ROOT, specifier)).href); }
      catch (error) { throw new StaleBuild([specifier + ' (' + errorText(error) + ')']); }
      for (const name of wanted[specifier]) if (typeof module[name] !== 'function' && typeof module[name] !== 'object') missing.push(specifier + ' -> ' + name);
      modules[specifier] = module;
    }
    if (missing.length) throw new StaleBuild(missing);
    const cdpLib = modules['lib/browser/cdp.js'];
    const edgeLib = modules['lib/browser/edge.js'];
    const driverLib = modules['lib/desktop/driver.js'];
    const arbiterLib = modules['lib/desktop/arbiter.js'];
    const faultsLib = modules['lib/shared/faults.js'];
    const computerLib = modules['lib/computer.js'];

    fs.mkdirSync(artifactsDir, { recursive: true });
    profileDir = path.join(artifactsDir, 'profile');
    if (fs.existsSync(profileDir)) throw new Stopped('profile-exists', { profileDir });
    if (!process.env.EVOLUTION_CU_BROKER_PIPE) throw new Stopped('arbiter-pipe-missing', {});

    arbiter = arbiterLib.createArbiter();
    driver = driverLib.createDesktopDriver({ faults: new faultsLib.Faults(), callMs: HELPER_CALL_MS, arbiter });
    // helper 是天然慢的读：也过账本，晚返回时不许顺手触发下一步。
    helperCallAs = (domain, op, args, capMs) => ledger.run(domain, 'helper:' + op,
      isNum(capMs) && capMs > 0 ? capMs : HELPER_CALL_MS,
      () => { state.helperCalls += 1; return driver.call(op, args); });
    helperCall = (op, args) => helperCallAs(bodyDomain, op, args);
    await helperCall('cursor', {});
    step('helper-alive');

    // ---- 启动隔离浏览器（正式 launchBrowser / launchArgs，不加任何 DPR 参数） ----
    const binary = edgeLib.findBrowser(edgeLib.browserCandidates());
    if (!binary) throw new Stopped('browser-not-found', {});
    // A：预算不够完整 20s 就零投递（一次都不 spawn）。B：发起前先落可恢复的记录，失败也留 profile 与 command。
    const gate = launchGate(bodyDomain.left(Date.now()), LAUNCH_BUDGET_MS);
    state.launch = { binary, profileDir, command: [binary].concat(edgeLib.launchArgs(profileDir)), gate };
    if (gate.ok !== true) throw new Stopped('launch-budget', gate);
    state.launched = { binary, profileDir, command: state.launch.command };
    try {
      port = await ledger.run(bodyDomain, 'launch', LAUNCH_TIMEOUT_MS,
        () => edgeLib.launchBrowser(binary, profileDir, Math.max(1, Math.min(LAUNCH_TIMEOUT_MS, bodyDomain.left(Date.now())))));
    } catch (error) {
      // 超时/失败时浏览器可能已经起来了但没有 port：记 launch-unknown，保留 attempt 与 profile，退出码非 0。
      state.launch.unknown = { reason: errorText(error), portKnown: false };
      throw new Stopped('launch-unknown', { profileDir, binary, reason: errorText(error) });
    }
    state.launched.port = port;
    step('launched', { port });

    const version = await fetchJsonAs(bodyDomain, endpointOfPort(port) + '/json/version');
    browserWsUrl = isRecord(version) && typeof version.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : '';
    if (!browserWsUrl) throw new Stopped('browser-ws-missing', {});
    if (portOfUrl(browserWsUrl) !== port) throw new Stopped('browser-ws-port-mismatch', { ws: browserWsUrl, port });

    browserCdp = await openCdpAs(bodyDomain, cdpLib.connectCdp, browserWsUrl, 'browser');
    sendBrowserAs = (domain, method, params, capMs) => ledger.run(domain, 'browser:' + method,
      isNum(capMs) && capMs > 0 ? capMs : CDP_TIMEOUT_MS, () => browserCdp.send(method, params));
    const sendBrowser = (method, params) => sendBrowserAs(bodyDomain, method, params);
    // 闸记账的是**原始** send 返回的 promise，外面那层 withTimeout 只是给主体自己的等待设上限。
    writeGate.attach((method, params) => browserCdp.send(method, params));

    // ---- 身份 1/5：SystemInfo 完整 PID 分区（严格：坏记录整读数作废） ----
    const browserPids = readBrowserPids(await sendBrowser('SystemInfo.getProcessInfo'));
    if (!browserPids.length) throw new Stopped('sysinfo-empty', {});

    // ---- 身份 2/5：helper(browserProfile) 精确 profile 证明（唯一 matched） ----
    const profileAnswer = await helperCall('browserProfile', { expected: profileDir, pids: browserPids });
    const matched = computerLib.readProfileAnswer(profileAnswer, browserPids, profileDir);
    if (!matched) throw new Stopped('profile-not-proven', { pids: browserPids });
    if (matched.length !== 1) throw new Stopped('profile-not-unique', { matched });
    matchedPid = matched[0];
    verified = true;
    step('profile-proven', { matchedPid, pids: browserPids });

    // ---- 身份 3/5：content 里唯一可见窗口 + 唯一 renderer ----
    const rawContentBefore = await helperCall('content', { pid: matchedPid });
    contentBefore = contentOf(rawContentBefore, 'before');
    const visibleWindows = contentBefore.windows.filter(win => win.visible && !win.minimized && !win.cloaked);
    if (visibleWindows.length !== 1) throw new Stopped('window-not-unique', { visible: visibleWindows.map(win => win.hwnd) });
    const host = visibleWindows[0];
    if (host.pid !== matchedPid) throw new Stopped('window-pid-mismatch', { hwnd: host.hwnd, pid: host.pid });
    if (!isNum(host.dpi) || host.dpi <= 0) throw new Stopped('window-dpi-unknown', { hwnd: host.hwnd, dpi: host.dpi });
    const widgets = contentBefore.renderer.filter(entry => entry.parent === host.hwnd && entry.className === RENDER_WIDGET_CLASS && entry.visible);
    if (widgets.length !== 1) throw new Stopped('renderer-not-unique', { hwnd: host.hwnd, count: widgets.length });
    intendedHwnd = host.hwnd;
    const dpiScale = host.dpi / 96;
    state.identity = Object.assign({}, state.identity, {
      hwnd: host.hwnd,
      matchedPid,
      dpiScale,
      uniqueWindow: { hwnd: host.hwnd, pid: host.pid, dpi: host.dpi, clientRect: host.clientRect },
      uniqueRenderer: { hwnd: widgets[0].hwnd, parent: widgets[0].parent, className: widgets[0].className, clientRect: widgets[0].clientRect },
    });
    step('native', { hwnd: host.hwnd, dpi: host.dpi, clientRect: host.clientRect, renderer: widgets[0].clientRect });

    // ---- 页面：唯一 page target，自有 data: 页 ----
    const rawTargets = await fetchJsonAs(bodyDomain, endpointOfPort(port) + '/json/list');
    const pageLike = Array.isArray(rawTargets) ? rawTargets.filter(entry => isRecord(entry) && entry.type === 'page') : [];
    // pageTargets 也是真实命令（HTTP 查 /json/list 再走 CDP），一样先查主体域预算再发。
    const targets = await ledger.run(bodyDomain, 'cdp:pageTargets', CDP_TIMEOUT_MS, () => cdpLib.pageTargets(port));
    if (pageLike.length !== 1 || targets.length !== 1) throw new Stopped('page-target-count', { jsonList: pageLike.length, cdp: targets.length });
    const target = targets[0];
    tabCdp = await openCdpAs(bodyDomain, cdpLib.connectCdp, target.webSocketDebuggerUrl, 'tab');
    const sendTab = (method, params) => ledger.run(bodyDomain, 'tab:' + method, CDP_TIMEOUT_MS, () => tabCdp.send(method, params));
    await sendTab('Page.enable', {});

    const evaluate = async expression => {
      const answer = await sendTab('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
      if (!isRecord(answer)) throw new Stopped('evaluate-shape', {});
      if (answer.exceptionDetails) throw new Stopped('evaluate-exception', { expression: expression.slice(0, 48) });
      if (!isRecord(answer.result)) throw new Stopped('evaluate-shape', {});
      return answer.result.value;
    };

    await sendTab('Page.navigate', { url: TEST_DATA_URL });
    const ready = await waitReady(evaluate, guardBudget, bodyDomain);
    if (!ready) {
      const tree = await sendTab('Page.getFrameTree', {});
      const frameId = isRecord(tree) && isRecord(tree.frameTree) && isRecord(tree.frameTree.frame) ? tree.frameTree.frame.id : null;
      if (typeof frameId !== 'string' || !frameId) throw new Stopped('frame-tree-shape', {});
      await sendTab('Page.setDocumentContent', { frameId, html: TEST_HTML });
      if (!(await waitReady(evaluate, guardBudget, bodyDomain))) throw new Stopped('page-not-ready', {});
    }
    step('page-ready');

    // ---- 身份 4/5：windowId ↔ HWND 的两次真实位移因果 ----
    const answer = await sendBrowser('Browser.getWindowForTarget', { targetId: target.id });
    const found = readWindowForTarget(answer);
    if (!found) throw new Stopped('window-id-missing', {});
    windowId = found.windowId;
    state.identity = Object.assign({}, state.identity, { windowId });
    // 同一个读，主体用主体域、清理恢复回读用清理域：闭包带域，谁也不继承过期的截止。
    readBoundsWith = domain => async () => readBoundsOnly(await sendBrowserAs(domain, 'Browser.getWindowBounds', { windowId }));
    readBounds = readBoundsWith(bodyDomain);
    readBoundsWithStage = stage => async () => readBoundsOnly(await stageDispatch({
      ledger, stage, domain: cleanupDomain, label: 'browser:Browser.getWindowBounds', capMs: CDP_TIMEOUT_MS,
      thunk: () => browserCdp.send('Browser.getWindowBounds', { windowId }),
    }));
    helperCallWithStage = (stage, op, args) => stageDispatch({
      ledger, stage, domain: cleanupDomain, label: 'helper:' + op, capMs: HELPER_CALL_MS,
      thunk: () => { state.helperCalls += 1; return driver.call(op, args); },
    });
    setBounds = async bounds => {
      // 主体域的预算先查，命令后发；moved 仍先于写（写失败也算"可能已经动过窗口"）。
      await sendWindowWrite({
        ledger, writeGate, domain: bodyDomain, windowId, bounds, timeoutMs: CDP_TIMEOUT_MS,
        guard: () => { moved = true; },
      });
    };

    const first = await readBounds();
    const stateNow = typeof first.windowState === 'string' ? first.windowState : 'normal';
    if (stateNow === 'minimized') throw new Stopped('window-minimized', {});
    if (stateNow !== 'normal') {
      normalizedFrom = stateNow;
      await setBounds({ windowState: 'normal' });
      await boundedSleep(bodyDomain, SETTLE_MS);
    }
    const baselineBounds = await readBounds();
    if (![baselineBounds.left, baselineBounds.top, baselineBounds.width, baselineBounds.height].every(isNum)) {
      throw new Stopped('bounds-unavailable', {});
    }
    base = { left: baselineBounds.left, top: baselineBounds.top, width: baselineBounds.width, height: baselineBounds.height };
    if (!near(found.bounds.left, base.left, PIXEL_TOLERANCE) || !near(found.bounds.top, base.top, PIXEL_TOLERANCE)) {
      evidence.push('getWindowForTarget 与 getWindowBounds 的 left/top 不一致（只记证据，不据此推断身份）');
    }

    /**
     * 一次位移：setBounds → settle → 回读 → content → 与**前一帧**做差。
     * fromContent 必须是这次位移之前的快照，否则第二次位移会被算成累计位移。
     */
    const applyMove = async (label, dip, fromBounds, fromContent) => {
      guardBudget();
      if (!isNum(fromBounds.left) || !isNum(fromBounds.top)) throw new Stopped(label + '-bounds-unknown', { fromBounds });
      await setBounds({ left: Math.round(fromBounds.left + dip.dx), top: Math.round(fromBounds.top + dip.dy) });
      await boundedSleep(bodyDomain, SETTLE_MS);
      const observed = await readBounds();
      if (!isNum(observed.left) || !isNum(observed.top)) throw new Stopped(label + '-bounds-unknown', { observed });
      if (!near(observed.left, fromBounds.left + dip.dx, PIXEL_TOLERANCE) || !near(observed.top, fromBounds.top + dip.dy, PIXEL_TOLERANCE)) {
        throw new Stopped(label + '-bounds-not-applied', { fromBounds, observed });
      }
      const after = contentOf(await helperCall('content', { pid: matchedPid }), label);
      return { observed, after, diff: diffFrames(fromContent, after, intendedHwnd) };
    };

    const firstMove = await applyMove('move-a', MOVE_A, base, contentBefore);
    const firstAssess = assessMove(firstMove.diff, MOVE_A, dpiScale);
    step('move-a', { dip: MOVE_A, assess: firstAssess });
    if (!firstAssess.ok) throw new Stopped('move-a-not-causal', { reasons: firstAssess.reasons });

    const secondMove = await applyMove('move-b', MOVE_B, firstMove.observed, firstMove.after);
    const secondAssess = assessMove(secondMove.diff, MOVE_B, dpiScale);
    step('move-b', { dip: MOVE_B, assess: secondAssess });
    if (!secondAssess.ok) throw new Stopped('move-b-not-causal', { reasons: secondAssess.reasons });

    const factorChecks = ['x', 'y'].map(axis => {
      const a = firstAssess.factors[axis];
      const b = secondAssess.factors[axis];
      const reference = Math.max(Math.abs(isNum(a) ? a : 0), Math.abs(isNum(b) ? b : 0));
      const ok = isNum(a) && isNum(b) && reference > 0 && Math.abs(a - b) <= FACTOR_RELATIVE_TOLERANCE * reference;
      return { axis, first: a, second: b, ok };
    });
    if (!factorChecks.every(check => check.ok)) throw new Stopped('factor-not-reproduced', { factorChecks });

    // 回到原始 bounds（像素阶段不移动窗口；清理阶段的 restore 仍会再确认一次）
    await setBounds({ left: base.left, top: base.top, width: base.width, height: base.height });
    await boundedSleep(bodyDomain, SETTLE_MS);
    const restored = await readBounds();
    if (!near(restored.left, base.left, PIXEL_TOLERANCE) || !near(restored.top, base.top, PIXEL_TOLERANCE)) {
      throw new Stopped('restore-before-pixels', { base, restored });
    }

    // ---- 身份 5/5：位移恢复后的几何快照（像素预测只用它） ----
    const afterRestore = contentOf(await helperCall('content', { pid: matchedPid }), 'after-restore');
    const hostWin = afterRestore.windows.find(win => win.hwnd === intendedHwnd);
    if (!hostWin) throw new Stopped('window-gone-after-restore', { hwnd: intendedHwnd });
    if (hostWin.pid !== matchedPid) throw new Stopped('window-pid-changed', { hwnd: hostWin.hwnd, pid: hostWin.pid });
    const afterWidgets = afterRestore.renderer.filter(entry => entry.parent === intendedHwnd && entry.className === RENDER_WIDGET_CLASS && entry.visible);
    if (afterWidgets.length !== 1) throw new Stopped('renderer-not-unique-after-restore', { count: afterWidgets.length });
    const windowClientRect = hostWin.clientRect;
    const rendererClientRect = afterWidgets[0].clientRect;
    state.identity = Object.assign({}, state.identity, {
      binding: 'windowIdHwndCausalOnly',
      moves: { a: firstAssess.observed, b: secondAssess.observed, factors: factorChecks },
    });

    // ---- 像素阶段 ----
    const pixelsStage = new StageRunner({ label: 'pixels', now: () => Date.now(), endAt: budgetDeadline });
    // 这是截图张数的账，和上面那本投递账（const ledger）是两本账：同名的 const 会把这个 try 域里的
    // 投递账整个遮住，后面每条 helper/CDP 投递都会在运行到这一行之前报 TDZ（Cannot access 'ledger' before initialization）。
    const shotBudget = shotLedger(MAX_SHOTS);
    const images = [];
    const pause = async stageName => { pixelsStage.assertOpen(stageName); await boundedSleep(bodyDomain, SETTLE_MS); };

    const nativeShot = async name => {
      pixelsStage.assertOpen('native-' + name);
      shotBudget.take('native-' + name);
      const file = path.join(artifactsDir, 'native-' + name + '.png');
      const edge = Math.max(windowClientRect.width, windowClientRect.height);
      const meta = readShotMeta(await helperCall('shot', {
        hwnd: intendedHwnd, file, edge, grow: 1, x: 0, y: 0, w: 0, h: 0, markX: -1, markY: -1,
      }));
      if (!meta) throw new Stopped('native-shot-meta', { name });
      if (!shotIsUnscaled(meta)) throw new Stopped('native-shot-scaled', { name, meta });
      if (meta.clientWidth !== windowClientRect.width || meta.clientHeight !== windowClientRect.height) {
        throw new Stopped('native-shot-client-mismatch', { name, meta, windowClientRect });
      }
      const id = 'native-' + name;
      images.push({ id, file: path.basename(file), width: meta.width, height: meta.height, bytes: fs.statSync(file).size });
      state.pixels.shots.push({ id, path: file, width: meta.width, height: meta.height });
      return { id, file: path.basename(file), width: meta.width, height: meta.height };
    };

    const surfaceShot = async name => {
      pixelsStage.assertOpen('surface-' + name);
      shotBudget.take('surface-' + name);
      const shot = await sendTab('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const encoded = isRecord(shot) && typeof shot.data === 'string' ? shot.data : '';
      if (encoded.length < 128) throw new Stopped('surface-shot-data', { name });
      const data = Buffer.from(encoded, 'base64');
      const header = readPngHeader(data);
      if (!header) throw new Stopped('surface-shot-header', { name });
      if (header.bitDepth !== 8 || (header.colorType !== 2 && header.colorType !== 6) || header.interlace !== 0) {
        throw new Stopped('surface-shot-unsupported', { name, header });
      }
      const file = path.join(artifactsDir, 'surface-' + name + '.png');
      fs.writeFileSync(file, data);
      const id = 'surface-' + name;
      images.push({ id, file: path.basename(file), width: header.width, height: header.height, bytes: data.length });
      state.pixels.shots.push({ id, path: file, width: header.width, height: header.height });
      return { id, file: path.basename(file), width: header.width, height: header.height };
    };

    const analyse = async (label, manifest, spec) => {
      pixelsStage.assertOpen('pixels-' + label);
      const manifestFile = path.join(artifactsDir, 'pixels-' + label + '.json');
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      // 像素分析只能吃主体预算剩下的：没有余量就不启动，绝不给自己补一个"最少 1s"。
      const leftMs = pixelsStage.remaining();
      if (leftMs <= 0) throw new Stopped('pixels-budget', { label, remainingMs: leftMs });
      const timeoutMs = Math.min(PIXELS_CALL_MS, leftMs);
      const startedPixel = Date.now();
      const child = spawnSync(POWERSHELL[0], POWERSHELL.slice(1).concat([PIXELS_SCRIPT, '-Manifest', manifestFile]), {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      const elapsedMs = Date.now() - startedPixel;
      if (child.error) throw new Stopped('pixels-spawn', { label, error: errorText(child.error) });
      if (!Number.isInteger(child.status)) throw new Stopped('pixels-status', { label, status: child.status, signal: child.signal });
      const answer = parsePixelStdout(child.stdout);
      const reading = readPixelsReport(answer, spec);
      state.pixels.pixelJobs.push({
        label,
        status: child.status,
        elapsedMs,
        // 像素脚本是同步调用：它会阻塞到这里，超时也由 timeoutMs 硬切，不会留下"还在飞"的 promise。
        timeoutMs,
        synchronous: true,
        ok: reading.ok === true,
        error: reading.ok === true ? null : { code: reading.code, detail: reading.detail },
        jobs: reading.ok === true
          ? reading.results.map(result => ({
            kind: result.kind,
            a: result.a,
            b: result.b,
            regions: result.regions.map(region => ({ name: region.name, changed: region.changed, total: region.total, bbox: region.bbox })),
          }))
          : null,
      });
      if (reading.ok !== true) throw new Stopped('pixels-' + reading.code, { label, detail: reading.detail });
      guardBudget();
      return reading;
    };

    const manifestOf = (phaseImages, regionList, jobList) => ({
      schema: PIXEL_SCHEMA,
      root: artifactsDir,
      limits: {
        maxImages: 24,
        maxJobs: 16,
        maxRegions: 8,
        maxImageBytes: 33554432,
        maxTotalBytes: 100663296,
        maxRegionPixels: 4000000,
        maxComparePixels: 40000000,
      },
      images: phaseImages.map(image => ({ id: image.id, file: image.file, width: image.width, height: image.height })),
      regions: regionList,
      jobs: jobList,
    });

    // 期望里必须带上区域原点：只比尺寸的话，脚本把区域裁剪挪到别处也能"对上"。
    const specOf = manifest => ({
      images: manifest.images.map(image => ({ id: image.id, width: image.width, height: image.height })),
      jobs: manifest.jobs.map(job => ({
        kind: job.kind,
        a: job.a,
        b: job.b,
        regions: (job.regions && job.regions.length)
          ? job.regions.map(name => {
            const region = manifest.regions.find(entry => entry.name === name);
            return { name: region.name, x: region.x, y: region.y, width: region.width, height: region.height };
          })
          : [{
            name: 'full',
            x: 0,
            y: 0,
            width: manifest.images.find(entry => entry.id === job.a).width,
            height: manifest.images.find(entry => entry.id === job.a).height,
          }],
      })),
    });

    // ---- B0：空页双路基线 ----
    const b0Native = await nativeShot('B0');
    const b0Surface = await surfaceShot('B0');
    guardBudget();

    const metrics = readPageMetrics(await evaluate(METRICS_EXPRESSION));
    if (metrics && metrics.title !== TEST_TITLE) throw new Stopped('page-title-mismatch', { title: metrics.title });
    const layout = await ledger.run(bodyDomain, 'cdp:pageLayout', CDP_TIMEOUT_MS, () => cdpLib.pageLayout(tabCdp));
    const preconditions = checkPreconditions({
      metrics,
      layout,
      nativeSize: { width: b0Native.width, height: b0Native.height },
      surfaceSize: { width: b0Surface.width, height: b0Surface.height },
      windowClientRect,
      rendererClientRect,
    });
    state.pixels.preconditions = Object.assign({}, preconditions, {
      measured: metrics,
      layout: isRecord(layout) ? layout : null,
      nativeImage: { width: b0Native.width, height: b0Native.height },
      surfaceImage: { width: b0Surface.width, height: b0Surface.height },
    });
    if (!preconditions.ok) throw new Stopped('preconditions', { reasons: preconditions.reasons });

    // ---- 预测框：native 原点减窗口客户区原点；surface 原点是视口 0,0 ----
    const origin = nativePngOrigin(windowClientRect, rendererClientRect);
    if (!origin) throw new Stopped('origin-invalid', { windowClientRect, rendererClientRect });
    const nativeBox = boxFromCss(BOX_CSS, metrics.dpr, origin);
    const surfaceBox = boxFromCss(BOX_CSS, metrics.dpr);
    if (!nativeBox || !surfaceBox) throw new Stopped('predicted-box-invalid', { nativeBox, surfaceBox });

    const nativeRegions = buildRegions('native', nativeBox, { x: 0, y: 0, width: b0Native.width, height: b0Native.height });
    const surfaceRegions = buildRegions('surface', surfaceBox, { x: 0, y: 0, width: b0Surface.width, height: b0Surface.height });
    if (!nativeRegions || !surfaceRegions) throw new Stopped('region-unavailable', { nativeBox, surfaceBox, origin });
    const regionList = [nativeRegions.inside, ...nativeRegions.outside, surfaceRegions.inside, ...surfaceRegions.outside];
    state.pixels.geometry = {
      windowClientRect,
      rendererClientRect,
      origin,
      cssBox: BOX_CSS,
      nativeBox,
      surfaceBox,
      nativeRegions,
      surfaceRegions,
      dpr: metrics.dpr,
    };
    step('predicted', { origin, nativeBox, surfaceBox });

    // ---- P1：正控（两条通道都必须看见已知纯色块） ----
    const added = await evaluate(BOX_ADD);
    if (added !== true) throw new Stopped('box-not-added', {});
    await pause('p1');
    const p1Native = await nativeShot('P1');
    const p1Surface = await surfaceShot('P1');
    const controlManifest = manifestOf(
      [b0Native, b0Surface, p1Native, p1Surface],
      regionList,
      [
        { kind: 'compare', a: 'native-B0', b: 'native-P1', regions: [nativeRegions.inside.name, ...nativeRegions.outside.map(region => region.name)] },
        { kind: 'compare', a: 'surface-B0', b: 'surface-P1', regions: [surfaceRegions.inside.name, ...surfaceRegions.outside.map(region => region.name)] },
      ],
    );
    const controlReading = await analyse('control', controlManifest, specOf(controlManifest));
    const pick = (result, plan) => ({
      inside: result.regions.find(region => region.name === plan.inside.name),
      outside: plan.outside.map(region => result.regions.find(entry => entry.name === region.name)),
    });
    const controlNative = judgeHighlight(Object.assign({ expected: nativeBox }, pick(controlReading.results[0], nativeRegions)));
    const controlSurface = judgeHighlight(Object.assign({ expected: surfaceBox }, pick(controlReading.results[1], surfaceRegions)));
    state.pixels.controls = { native: controlNative, surface: controlSurface };
    step('control', { native: controlNative, surface: controlSurface });

    // ---- B1：移除盒子后重取，必须与 B0 逐像素相同 ----
    const removed = await evaluate(BOX_REMOVE);
    if (removed !== true) throw new Stopped('box-not-removed', {});
    await pause('b1');
    const b1Native = await nativeShot('B1');
    const b1Surface = await surfaceShot('B1');
    const baselineManifest = manifestOf(
      [b0Native, b0Surface, b1Native, b1Surface],
      [],
      [
        { kind: 'equal', a: 'native-B0', b: 'native-B1' },
        { kind: 'equal', a: 'surface-B0', b: 'surface-B1' },
      ],
    );
    const baselineReading = await analyse('baseline', baselineManifest, specOf(baselineManifest));
    const baseline = {
      native: baselineReading.results[0].regions[0].changed === 0,
      surface: baselineReading.results[1].regions[0].changed === 0,
      nativeChanged: baselineReading.results[0].regions[0].changed,
      surfaceChanged: baselineReading.results[1].regions[0].changed,
    };
    state.pixels.baseline = baseline;
    step('baseline', baseline);

    // ---- DOM 负控（只证明 Overlay 指令没改主世界 DOM） ----
    const domBase = readDomState(await evaluate(DOM_INSTALL));
    if (!domBase) throw new Stopped('dom-observer', {});
    domInstalled = true;

    // ---- 三轮：highlight 两路 + hide 两路 ----
    await sendTab('Overlay.enable', {});
    overlayEnabled = true;
    const roundEvidence = { native: [], surface: [] };

    for (let index = 1; index <= ROUNDS; index += 1) {
      const round = String(index);
      pixelsStage.assertOpen('round-' + round + '-highlight');
      await sendTab('Overlay.highlightRect', {
        x: BOX_CSS.x, y: BOX_CSS.y, width: BOX_CSS.width, height: BOX_CSS.height,
        color: OVERLAY_COLOR, outlineColor: OVERLAY_OUTLINE,
      });
      await pause('round-' + round + '-highlight-settle');
      const highlightNative = await nativeShot('R' + round + 'H');
      const highlightSurface = await surfaceShot('R' + round + 'H');

      await sendTab('Overlay.hideHighlight', {});
      await pause('round-' + round + '-hide-settle');
      const hideNative = await nativeShot('R' + round + 'D');
      const hideSurface = await surfaceShot('R' + round + 'D');

      const roundDom = readDomState(await evaluate(DOM_READ));
      const roundManifest = manifestOf(
        [b1Native, b1Surface, highlightNative, highlightSurface, hideNative, hideSurface],
        regionList,
        [
          { kind: 'compare', a: 'native-B1', b: highlightNative.id, regions: [nativeRegions.inside.name, ...nativeRegions.outside.map(region => region.name)] },
          { kind: 'compare', a: 'surface-B1', b: highlightSurface.id, regions: [surfaceRegions.inside.name, ...surfaceRegions.outside.map(region => region.name)] },
          { kind: 'equal', a: 'native-B1', b: hideNative.id },
          { kind: 'equal', a: 'surface-B1', b: hideSurface.id },
        ],
      );
      const roundReading = await analyse('round-' + round, roundManifest, specOf(roundManifest));
      const dom = {
        ok: Boolean(roundDom) && roundDom.mutations === 0 && roundDom.hash === domBase.hash && roundDom.length === domBase.length,
        mutations: roundDom ? roundDom.mutations : null,
        hash: roundDom ? roundDom.hash : null,
        baselineHash: domBase.hash,
      };
      const nativeEvidence = {
        index,
        path: 'native',
        highlight: judgeHighlight(Object.assign({ expected: nativeBox }, pick(roundReading.results[0], nativeRegions))),
        hidden: { identical: roundReading.results[2].regions[0].changed === 0, changed: roundReading.results[2].regions[0].changed },
        dom,
      };
      const surfaceEvidence = {
        index,
        path: 'surface',
        highlight: judgeHighlight(Object.assign({ expected: surfaceBox }, pick(roundReading.results[1], surfaceRegions))),
        hidden: { identical: roundReading.results[3].regions[0].changed === 0, changed: roundReading.results[3].regions[0].changed },
        dom,
      };
      roundEvidence.native.push(nativeEvidence);
      roundEvidence.surface.push(surfaceEvidence);
      state.pixels.rounds.push({ index, native: nativeEvidence, surface: surfaceEvidence });
      step('round-' + round, { native: nativeEvidence.highlight, surface: surfaceEvidence.highlight, dom });
    }

    const verdict = overlayVerdict({
      preconditions,
      controls: { native: { ok: controlNative.visible === true }, surface: { ok: controlSurface.visible === true } },
      baseline: { native: baseline.native, surface: baseline.surface },
      paths: { native: judgeRounds(roundEvidence.native), surface: judgeRounds(roundEvidence.surface) },
    });
    state.pixels.overlayCapture = verdict.overlayCapture;
    state.pixels.overlayReason = verdict.reason;
    state.pixels.paths = { native: judgeRounds(roundEvidence.native), surface: judgeRounds(roundEvidence.surface) };
    state.pixels.dom = { baseline: domBase, installed: true };
    step('verdict', verdict);
  } catch (error) {
    const stopped = asStopped(error);
    if (stopped instanceof StaleBuild) {
      stopReason = { code: 'stale-build', detail: stopped.message };
    } else if (stopped instanceof Stopped) {
      stopReason = { code: stopped.code, detail: stopped.detail === undefined ? null : stopped.detail };
    } else {
      stopReason = { code: 'unexpected', detail: errorText(error) };
      state.pixels.overlayCapture = 'inconclusive';
    }
    if (!state.pixels.preconditions || state.pixels.preconditions.ok !== true) state.pixels.overlayCapture = 'inconclusive';
  } finally {
    // ---- 清理：只有一个绝对 60s deadline；写门一进门就关，恢复只能走 restore 阶段的专用写入口 ----
    const cleanupStart = Date.now();
    const deadline = cleanupDeadline(cleanupStart);
    // 清理自己的预算域：主体域已经过期也不影响这里的恢复/复核/关闭（反过来也成立）。
    cleanupDomain = makeBudgetDomain('cleanup', deadline.hardEnd);
    writeGate.closeBody();
    const notes = [];
    // 三步卫生共用 2s 上限，各自也受同一个绝对 deadline 约束；没有预算就真的跳过。
    const hygiene = async (label, wanted, run) => {
      if (!wanted) return;
      const startedAt = Date.now();
      const ms = hygieneStepMs(deadline, startedAt - cleanupStart, startedAt);
      if (ms <= 0) { notes.push(label + ': 清理预算已经用完，跳过'); return; }
      try { await ledger.run(cleanupDomain, label, ms, run); }
      catch (error) { notes.push(label + ': ' + errorText(error)); }
    };
    await hygiene('dom-disconnect', Boolean(domInstalled && tabCdp && !tabCdp.closed),
      () => tabCdp.send('Runtime.evaluate', { expression: DOM_DISCONNECT, returnByValue: true }));
    await hygiene('overlay-hide', Boolean(overlayEnabled && tabCdp && !tabCdp.closed),
      () => tabCdp.send('Overlay.hideHighlight', {}));
    await hygiene('overlay-disable', Boolean(overlayEnabled && tabCdp && !tabCdp.closed),
      () => tabCdp.send('Overlay.disable', {}));
    // 真实耗时，不再截断成 2s：账上的数必须就是墙钟上的数，否则后面的阶段会偷偷多出预算。
    state.cleanupHygieneMs = Math.max(0, Date.now() - cleanupStart);
    if (notes.length) evidence.push(...notes);

    const budget = cleanupBudget(state.cleanupHygieneMs);
    // 阶段预算 = min(账上剩的, 绝对 deadline 上真剩的)；到 0 就真的不跑，不再补"最少 1s"。
    const stageBudgetMs = Math.min(budget.totalMs, cleanupRemaining(deadline, Date.now()));
    const browserVerified = Boolean(verified && browserCdp && !browserCdp.closed);
    const identityUsable = browserVerified && Boolean(windowId && base);
    const restorePayload = moved && identityUsable ? {
      stage: null,
      base,
      normalizedFrom,
      windowId,
      // 恢复写入不在这里给：由 restore 回调换成写闸的 restoreWrite（主体写已经关死）。
      setBounds: null,
      // 恢复回读与复核读 helper 都走清理域：绝不能继承已经过期的 body 截止。
      readBounds: readBoundsWith(cleanupDomain),
      helperCall: (op, args) => helperCallAs(cleanupDomain, op, args),
      matchedPid,
      intendedHwnd,
      contentBefore: contentBefore || null,
    } : null;

    const cleanup = {
      startedAt: new Date().toISOString(),
      evidence: [],
      browserClosed: false,
      killedByPath: false,
      hygieneMs: state.cleanupHygieneMs,
      hygieneBudgetMs: Math.min(state.cleanupHygieneMs, CLEANUP_HYGIENE_MS),
      budget: stageBudgetMs,
      budgetAccountingMs: budget.totalMs,
      hardEndAt: new Date(deadline.hardEnd).toISOString(),
      // 两个预算域各自的截止；launch 的 attempt 记录也在这份报告里（失败时 profile/command 仍可追溯）。
      domains: {
        body: { label: bodyDomain.label, endAt: new Date(bodyDomain.endAt).toISOString(), remainingMs: bodyDomain.left(Date.now()) },
        cleanup: { label: cleanupDomain.label, endAt: new Date(cleanupDomain.endAt).toISOString(), remainingMs: cleanupDomain.left(Date.now()) },
      },
      launch: state.launch === undefined ? null : state.launch,
    };
    if (state.cleanupHygieneMs > CLEANUP_HYGIENE_MS) {
      cleanup.evidence.push('Overlay 卫生用了 ' + state.cleanupHygieneMs + 'ms，超过 2s 上限；后面的阶段只剩 ' + stageBudgetMs + 'ms');
    }

    try {
      cleanupResult = await runCleanup({
        now: Date.now,
        // 阶段只能吃同一个绝对 deadline 上剩下的；用完了就是 0（各阶段按 no-budget 跳过，绝不硬撑）
        totalMs: stageBudgetMs,
        requireRestore: moved,
        requireReverify: browserVerified,
        requireClose: browserVerified,
        restore: restorePayload
          ? async stage => {
            // 屏障：主体发出去的命令结算了吗？两条都结算了才允许写恢复 bounds。
            const stageLeft = typeof stage.remaining === 'function' ? stage.remaining() : 0;
            const waitMs = Math.min(Math.max(0, Number(stageLeft) || 0), 5_000);
            // 两条屏障：广义账本（主体任何一条已发命令的原始 promise）+ 窗口写闸（只关于 setWindowBounds）。
            // 先把"正在等"记进报告：阶段看门狗杀进来时也要留下屏障没过的痕迹。两条各吃一半等待预算，合起来不超阶段剩余。
            const half = waitMs > 1 ? Math.round(waitMs / 2) : waitMs;
            cleanup.barrier = { waiting: true, stageLeftMs: waitMs, dispatched: null, barrier: null };
            const dispatched = await ledger.waitSettled(half, 'body');
            const barrier = await writeGate.waitSettled(Math.max(0, waitMs - half));
            const readiness = restoreReadiness(dispatched, barrier);
            cleanup.barrier = Object.assign({}, barrier, { waiting: false, stageLeftMs: waitMs, dispatched, readiness });
            if (dispatched.settled !== true) {
              cleanup.evidence.push('主体还有 ' + dispatched.pending + ' 条命令没结算（' + String(dispatched.reason || 'unknown') + '）：等的超时只结束等待，它们可能仍会被应用，报告不声称已经停下');
            }
            if (readiness.ok !== true) {
              // 任意一条屏障没过都算"恢复不许开始"：未知就是未知，既不写恢复 bounds，也不谎称已恢复。
              cleanup.evidence.push('恢复前的主体屏障没过（' + String(readiness.code) + '，pending ' + readiness.pending + '），按规则一个恢复 bounds 都不写');
              return {
                ok: false,
                stateRestored: false,
                confidence: 'unknown',
                barrier: cleanup.barrier,
                steps: [{ name: 'write-barrier', ok: false, observed: { dispatched, barrier, readiness }, error: readiness.code }],
              };
            }
            restorePayload.stage = stage;
            // 恢复里的回读与 helper 也走阶段口径：每条命令前都查 stage 与 cleanup 域余额（0 就是 0）。
            restorePayload.readBounds = readBoundsWithStage(stage);
            restorePayload.helperCall = (op, args) => helperCallWithStage(stage, op, args);
            // 恢复写入换成写闸的专用入口（主体写已在 finally 入口关死）。
            restorePayload.setBounds = bounds => writeGate.restoreWrite(stage, windowId, bounds);
            return await restoreWindow(restorePayload);
          }
          : (moved
            ? async () => ({ ok: false, stateRestored: false, confidence: 'unknown', steps: [{ name: 'restore', ok: false, error: '身份未核实，按规则不向未知 windowId 写入 bounds' }] })
            : null),
        reverify: async stage => {
          // 每一次真实命令都过 stageDispatch：先看 stage 还开着吗、还剩多少，余额 0 就一条都不发。
          const fresh = await stageDispatch({
            ledger, stage, domain: cleanupDomain, label: 'fetch:/json/version', capMs: 3_000,
            thunk: () => fetchJson(endpointOfPort(port) + '/json/version'),
          });
          const freshWs = isRecord(fresh) && typeof fresh.webSocketDebuggerUrl === 'string' ? fresh.webSocketDebuggerUrl : '';
          if (freshWs !== browserWsUrl) throw new Stopped('reverify-ws-mismatch', { expected: browserWsUrl, observed: freshWs });
          await stage.assertOpen('reverify-sysinfo');
          const pids = readBrowserPids(await stageDispatch({
            ledger, stage, domain: cleanupDomain, label: 'browser:SystemInfo.getProcessInfo', capMs: CDP_TIMEOUT_MS,
            thunk: () => browserCdp.send('SystemInfo.getProcessInfo', {}),
          }));
          if (!pids.length || !pids.includes(matchedPid)) throw new Stopped('reverify-pid-gone', { pids, matchedPid });
          await stage.assertOpen('reverify-profile');
          const confirmed = computerLib.readProfileAnswer(
            await helperCallWithStage(stage, 'browserProfile', { expected: profileDir, pids }),
            pids, profileDir);
          if (!confirmed || confirmed.length !== 1 || confirmed[0] !== matchedPid) {
            throw new Stopped('reverify-profile', { matched: confirmed, matchedPid });
          }
          return { wsUrl: browserWsUrl, browserPids: pids, matchedPid };
        },
        close: async stage => {
          await stage.assertOpen('close');
          await stageDispatch({
            ledger, stage, domain: cleanupDomain, label: 'browser:Browser.close', capMs: CDP_TIMEOUT_MS,
            thunk: () => browserCdp.send('Browser.close', {}),
          });
          const closed = await waitForBrowserClosed({ port, pid: matchedPid, stage, evidence: cleanup.evidence });
          if (closed.closed !== true) throw new Stopped('close-unconfirmed', {});
          cleanup.browserClosed = true;
          return { closed: true };
        },
        stop: driver ? async () => { await driver.stop(); } : null,
      });
    } catch (error) {
      cleanup.evidence.push('cleanup threw: ' + errorText(error));
    }
    // 主体写入早在 finally 入口就关死了；这里只记账：清理结束时还有没有窗口命令悬着。
    // 账本事实在清理跑完之后再取一次：那时候的 pending 才是退出时仍未结算的那批。
    cleanup.dispatch = ledger.snapshot();
    cleanup.windowWrites = writeGate.snapshot();
    if (cleanup.windowWrites.pending > 0) {
      cleanup.evidence.push('清理结束时仍有 ' + cleanup.windowWrites.pending + ' 条 setWindowBounds 没结算：它们可能仍被应用，报告不声称已经停下');
    }

    restoreOutcome = restoreReportFromOutcome(cleanupResult && cleanupResult.restore, moved);
    const cleanupOutcome = cleanupResult || { ok: false, restore: null, reverify: null, close: null, stop: null, evidence: ['cleanup-not-run'] };

    // 连接收尾（只关自己的 socket，绝不按路径杀进程）
    if (tabCdp) await closeCdpQuietly(tabCdp, 'tab', cleanup.evidence);
    if (browserCdp) await closeCdpQuietly(browserCdp, 'browser', cleanup.evidence);
    if (arbiter) disposeArbiterQuietly(arbiter, cleanup.evidence);

    const final = Object.assign(composeReport(state.identity, state.pixels), {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      host: { platform: process.platform, arch: process.arch, node: process.version },
      stopReason,
      steps,
      evidence,
      helperCalls: state.helperCalls,
      launched: state.launched,
      // 序列化只经这个纯函数：四类真实证据（两笔预算、屏障、窗口写账）一个都不许在路上丢掉。
      cleanup: cleanupReportOf(cleanup, cleanupOutcome),
      restore: restoreOutcome,
      reportPath,
    });
    final.thresholdsMet = thresholdsMet(final);
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(final, null, 2) + '\n');
    return final;
  }
}

function contentOf(answer, where) {
  try {
    return readContent(answer, where);
  } catch (error) {
    const stopped = asStopped(error);
    if (stopped instanceof Stopped) throw stopped;
    throw new Stopped('content-invalid', { where });
  }
}

function readBoundsOnly(answer) {
  if (!isRecord(answer)) throw new Stopped('bounds-shape', {});
  const bounds = answer.bounds;
  if (!isRecord(bounds)) throw new Stopped('bounds-shape', {});
  const row = {
    left: isNum(bounds.left) ? bounds.left : null,
    top: isNum(bounds.top) ? bounds.top : null,
    width: isNum(bounds.width) ? bounds.width : null,
    height: isNum(bounds.height) ? bounds.height : null,
  };
  if (typeof bounds.windowState === 'string') row.windowState = bounds.windowState;
  return row;
}

function readWindowForTarget(answer) {
  if (!isRecord(answer)) return null;
  const windowId = answer.windowId;
  if (!Number.isInteger(windowId) || windowId < 0) return null;
  return { windowId, bounds: readBoundsOnly(answer) };
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Stopped('http-status', { url, status: response.status });
  return await response.json();
}

/**
 * 等页面就绪。轮询之间的那一觉只由 boundedSleep 睡一次：它自己就 await 了 sleeper，
 * 返回值 0 表示主体域里没有余额，等过一次就不要再等第二次（以前这里又 sleep(slept)，
 * 剩余预算不多时会多等一个同样长的 100ms，白吃掉最后一点预算）。
 * sleepFn 只给离线测试注入假时钟用，真跑时仍是 sleep。
 */
export async function waitReady(evaluate, guard, domain, sleepFn) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    guard();
    const value = await evaluate(METRICS_EXPRESSION).catch(() => null);
    if (isRecord(value) && value.readyState === 'complete' && value.title === TEST_TITLE) return true;
    // 轮询之间的等待也算主体域的时间：域里没有余额就到此为止（调用方会报 page-not-ready）。
    const slept = await boundedSleep(domain, 100, sleepFn);
    if (!(slept > 0)) return false;
  }
  return false;
}

function parsePixelStdout(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue;
    try { return JSON.parse(lines[index]); } catch { continue; }
  }
  return null;
}

function restoreReportFromOutcome(outcome, wasMoved) {
  if (outcome && outcome.skipped === true) {
    if (outcome.reason === 'not-needed' && wasMoved !== true) return { notNeeded: true, reason: 'not-needed' };
    return { ok: false, confidence: 'unknown', skipped: true, reason: outcome.reason || 'skipped', steps: [] };
  }
  if (outcome && outcome.ok === true && outcome.value) return outcome.value;
  if (outcome && outcome.ok === false) {
    return { ok: false, confidence: 'unknown', steps: [{ name: 'restore', ok: false, error: outcome.error || outcome.reason || 'restore-not-confirmed' }] };
  }
  return wasMoved ? { ok: false, confidence: 'unknown', steps: [] } : null;
}

// ---------------------------------------------------------------------------
// 直跑入口（import 本模块不会有任何副作用）
// ---------------------------------------------------------------------------

const invokedDirectly = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    const report = await main();
    const summary = [
      'OVERLAY',
      report.overlayCapture,
      'identity=' + String(report.identity && report.identity.binding),
      'native=' + String(report.paths && report.paths.native && report.paths.native.visible),
      'surface=' + String(report.paths && report.paths.surface && report.paths.surface.visible),
      'shots=' + String(report.shots ? report.shots.length : 0),
      'cleanup=' + String(report.cleanup && report.cleanup.ok === true),
      'report=' + report.reportPath,
    ].join(' ');
    console.log(summary);
    process.exitCode = overlayExitCode(report);
  } catch (error) {
    const stopped = asStopped(error);
    console.error(errorText(stopped));
    process.exitCode = stopped instanceof StaleBuild ? 3 : 4;
  }
}

export {
  Stopped,
  StaleBuild,
  cleanupSchedule,
};
