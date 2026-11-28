/**
 * 私有 Overlay 可行性探针（task-106）的离线回归。
 *
 * 这里只测两件事，且都不碰真实桌面：
 *   1) 探针导出的纯函数：几何换算、前提拒绝、阈值判据、身份与像素分离、清理预算；
 *   2) 像素比较器（scripts/browser-overlay-pixels.ps1）对**离线小 PNG** 的读写与拒绝。
 *
 * 不启动浏览器、不取窗口、不发输入、不读屏；PNG 全部由本文件现场生成。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  Stopped,
  assessMove,
  boxFromCss,
  boundedSleep,
  buildRegions,
  checkPreconditions,
  cleanupBudget,
  cleanupDeadline,
  cleanupRemaining,
  cleanupReportOf,
  closeLateConnection,
  composeReport,
  createDispatchLedger,
  createWindowWriteGate,
  diffFrames,
  hygieneStepMs,
  judgeHighlight,
  launchGate,
  makeBudgetDomain,
  judgeRounds,
  nativePngOrigin,
  openConnection,
  overlayExitCode,
  overlayVerdict,
  readDomState,
  readPageMetrics,
  readPixelsReport,
  readPngHeader,
  readShotMeta,
  restoreReadiness,
  sendWindowWrite,
  shotIsUnscaled,
  shotLedger,
  stageDispatch,
  thresholdsMet,
  waitReady,
} from '../scripts/browser-overlay-probe.mjs';
import * as PROBE from '../scripts/browser-overlay-probe.mjs';
import { cleanupSchedule } from '../scripts/browser-surface-probe.mjs';

const PIXELS_SCRIPT = fileURLToPath(new URL('../scripts/browser-overlay-pixels.ps1', import.meta.url));
const PROBE_SCRIPT = fileURLToPath(new URL('../scripts/browser-overlay-probe.mjs', import.meta.url));
const WINDOWS = process.platform === 'win32';

/** 现成的 Windows PowerShell；PATH 为空时用 System32 下的绝对路径。 */
const POWERSHELL_EXE = (() => {
  for (const root of [process.env.SystemRoot, process.env.windir, 'C:\\Windows']) {
    if (!root) continue;
    const file = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(file)) return file;
  }
  return 'powershell.exe';
})();
const POWERSHELL = [POWERSHELL_EXE, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
const TEST_TMP = process.env.TEMP || process.env.TMP || (typeof os.tmpdir === 'function' ? os.tmpdir() : '');

// ---------------------------------------------------------------------------
// 现场生成 PNG（不依赖任何图片库；只造 8-bit、非隔行的 RGB / RGBA / 灰度）
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let round = 0; round < 8; round += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, sum]);
}

/**
 * 造一张 width×height 的 PNG：整幅填 fill，可选地把 rect 区域涂成另一色。
 * colorType 2 = RGB，6 = RGBA，0 = 灰度（灰度用来验证像素脚本会拒绝）。
 */
function makePng(width, height, colorType, fill, rect) {
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = Buffer.alloc((width * channels + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    raw[at] = 0;
    at += 1;
    for (let x = 0; x < width; x += 1) {
      const inside = Boolean(rect) && x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
      const color = inside ? rect.color : fill;
      for (let channel = 0; channel < channels; channel += 1) {
        raw[at] = color[channel] === undefined ? 255 : color[channel];
        at += 1;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * 把 IHDR 里声明的宽高改大，文件本身还是那张几十像素的小图。
 * 像素脚本的 Header() 只读 33 字节、不校验 CRC，所以这正好模拟"头声明很大"的那种输入。
 */
function withHugeHeader(png, width, height) {
  const copy = Buffer.from(png);
  copy.writeUInt32BE(width, 16);
  copy.writeUInt32BE(height, 20);
  return copy;
}

const WHITE = [255, 255, 255];
const MAGENTA = [255, 0, 255];

/** 一个用完即删的临时目录：像素脚本只读这里的图。 */
function fixtureDir(t) {
  assert.ok(TEST_TMP, '需要一个临时目录来放离线 PNG');
  const dir = fs.mkdtempSync(path.join(TEST_TMP, 'evolution-overlay-pixels-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runPixels(dir, manifest) {
  const file = path.join(dir, 'manifest-' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(file, JSON.stringify(manifest));
  const child = spawnSync(POWERSHELL[0], POWERSHELL.slice(1).concat([PIXELS_SCRIPT, '-Manifest', file]), {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  let answer = null;
  try {
    answer = JSON.parse(String(child.stdout || '').trim());
  } catch {
    answer = null;
  }
  return { status: child.status, answer, stdout: String(child.stdout || ''), stderr: String(child.stderr || '') };
}

// ---------------------------------------------------------------------------
// 1. 模块面
// ---------------------------------------------------------------------------

test('探针模块只导出离线纯函数，导入时不会启动浏览器或桌面', () => {
  for (const name of ['readPngHeader', 'nativePngOrigin', 'boxFromCss', 'buildRegions', 'checkPreconditions',
    'judgeHighlight', 'judgeRounds', 'overlayVerdict', 'thresholdsMet', 'overlayExitCode', 'cleanupBudget',
    'cleanupDeadline', 'cleanupRemaining', 'cleanupReportOf', 'hygieneStepMs', 'createWindowWriteGate',
    'makeBudgetDomain', 'launchGate', 'createDispatchLedger', 'boundedSleep',
    'closeLateConnection', 'openConnection', 'stageDispatch', 'sendWindowWrite', 'restoreReadiness',
    'composeReport', 'shotLedger', 'readPixelsReport', 'readPageMetrics', 'readDomState', 'readShotMeta',
    'shotIsUnscaled', 'diffFrames', 'assessMove', 'waitReady']) {
    assert.equal(typeof PROBE[name], 'function', name + ' 应该是可离线调用的纯函数');
  }
  // Stopped 是导出给测试断言错误码用的类型。
  assert.equal(typeof Stopped, 'function');
  assert.equal(new Stopped('shot-budget', { limit: 1 }).code, 'shot-budget');
  // 入口不导出：只有直跑才会执行 main()，测试导入不会启动任何东西。
  assert.equal(typeof PROBE.main, 'undefined');
  const source = fs.readFileSync(PROBE_SCRIPT, 'utf8');
  assert.match(source, /invokedDirectly/);
  assert.match(source, /process\.argv\[1\]/);
});

test('探针源码里没有任何输入/窗口控制调用（只做测量与截图）', () => {
  const source = fs.readFileSync(PROBE_SCRIPT, 'utf8');
  for (const forbidden of ['SendInput', 'SetCursorPos', 'SetForegroundWindow', 'ShowWindow', 'PostMessage',
    'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'dispatchMouseEvent', 'setWindowBoundsOnly']) {
    assert.equal(source.includes(forbidden), false, '探针不应出现 ' + forbidden);
  }
  // 只在自有窗口上写 bounds：主体写与清理里的恢复写都必须经过同一道写闸。
  assert.match(source, /createWindowWriteGate/);
  assert.match(source, /window-writes-closed/);
  assert.equal(source.includes('windowWritesAllowed'), false, '写闸替掉了原来那个布尔门');
  assert.match(source, /experiment-scoped-not-proven/);
});

test('像素脚本是纯解码器：没有桌面/输入 PInvoke，也没有截图调用', () => {
  const source = fs.readFileSync(PIXELS_SCRIPT, 'utf8');
  // 一切原生互操作都要禁止：这个进程只允许 System.Drawing 解码。
  for (const forbidden of ['DllImport', 'Add-Type -MemberDefinition', 'PrintWindow', 'CopyFromScreen',
    'System.Windows.Forms', 'FindWindow', 'EnumWindows']) {
    assert.equal(source.includes(forbidden), false, '像素脚本不应出现 ' + forbidden);
  }
  // 去掉 PowerShell 块注释 / 行注释与 C# 行注释，剩下的才是可执行代码。
  const code = source
    .replace(/<#[\s\S]*?#>/g, '')
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, '').replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
  for (const forbidden of ['SendInput', 'SetCursorPos', 'SetForegroundWindow', 'ShowWindow', 'PostMessage', 'user32']) {
    assert.equal(code.includes(forbidden), false, '可执行代码里不应出现 ' + forbidden);
  }
  assert.match(source, /browser-overlay-pixels\/1/);
  // 纯 ASCII：PowerShell 5.1 会按 ANSI 代码页解码无 BOM 的 .ps1，非 ASCII 注释会被拆坏。
  assert.equal(/[^\x00-\x7f]/.test(source), false);
});

// ---------------------------------------------------------------------------
// 2. 几何换算（PNG 原点不是屏幕原点）
// ---------------------------------------------------------------------------

test('nativePngOrigin 用「renderer 客户区屏幕原点 − 窗口客户区屏幕原点」得到 PNG 原点', () => {
  assert.deepEqual(
    nativePngOrigin({ x: 100, y: 140, width: 800, height: 600 }, { x: 100, y: 140, width: 800, height: 600 }),
    { x: 0, y: 0 },
  );
  // 浏览器自己的工具栏占掉顶部 40px：renderer 在窗口客户区里向下偏 40。
  assert.deepEqual(
    nativePngOrigin({ x: 100, y: 140, width: 800, height: 600 }, { x: 100, y: 180, width: 800, height: 560 }),
    { x: 0, y: 40 },
  );
  assert.equal(nativePngOrigin({ x: 100, y: 140, width: 0, height: 600 }, { x: 100, y: 140, width: 800, height: 600 }), null);
  assert.equal(nativePngOrigin(null, { x: 0, y: 0, width: 10, height: 10 }), null);
});

test('boxFromCss 把 CSS 框按实测 DPR 与 PNG 原点换算成预测像素框', () => {
  const css = { x: 120, y: 100, width: 240, height: 160 };
  assert.deepEqual(boxFromCss(css, 1, { x: 0, y: 0 }), { x: 120, y: 100, width: 240, height: 160 });
  assert.deepEqual(boxFromCss(css, 1, { x: 0, y: 40 }), { x: 120, y: 140, width: 240, height: 160 });
  assert.deepEqual(boxFromCss({ x: 10, y: 10, width: 10, height: 10 }, 2, { x: 0, y: 0 }), { x: 20, y: 20, width: 20, height: 20 });
  // 没有原点就当屏幕坐标（surface 路径），但不能靠猜 DPR 得到框。
  assert.equal(boxFromCss(css, 0, { x: 0, y: 0 }), null);
  assert.equal(boxFromCss(css, Number.NaN, { x: 0, y: 0 }), null);
  assert.equal(boxFromCss({ x: 0, y: 0, width: 0, height: 10 }, 1, { x: 0, y: 0 }), null);
  assert.equal(boxFromCss(null, 1, { x: 0, y: 0 }), null);
});

test('buildRegions 的 inside 就是预测框本身，outside 全部落在框外且在图内', () => {
  const image = { x: 0, y: 0, width: 800, height: 600 };
  const box = { x: 120, y: 140, width: 240, height: 160 };
  const regions = buildRegions('native', box, image);
  assert.ok(regions);
  assert.deepEqual(
    { name: regions.inside.name, x: regions.inside.x, y: regions.inside.y, width: regions.inside.width, height: regions.inside.height },
    { name: 'native-inside', x: 120, y: 140, width: 240, height: 160 },
  );
  assert.ok(regions.outside.length > 0, '至少要有一块框外区域当负控');
  for (const region of regions.outside) {
    assert.ok(region.width > 0 && region.height > 0, '框外区域必须有面积');
    assert.ok(region.x + region.width <= image.width && region.y + region.height <= image.height, '框外区域必须在图内');
    const overlaps = region.x < box.x + box.width && box.x < region.x + region.width
      && region.y < box.y + box.height && box.y < region.y + region.height;
    assert.equal(overlaps, false, region.name + ' 不能压到预测框上');
  }
  // 预测框跑出图片边界就没有可信的负控可用。
  assert.equal(buildRegions('native', { x: 700, y: 0, width: 240, height: 160 }, image), null);
});

// ---------------------------------------------------------------------------
// 3. 截图元数据与页面读数
// ---------------------------------------------------------------------------

test('readShotMeta/shotIsUnscaled 只接受未缩放的合法回复', () => {
  assert.deepEqual(readShotMeta({ width: 800, height: 600, clientWidth: 800, clientHeight: 600 }),
    { width: 800, height: 600, clientWidth: 800, clientHeight: 600 });
  assert.equal(shotIsUnscaled({ width: 800, height: 600, clientWidth: 800, clientHeight: 600 }), true);
  // helper 的 Render 缩放后宽高就不等于客户区：逐像素比较不能用。
  assert.equal(shotIsUnscaled({ width: 1280, height: 960, clientWidth: 2560, clientHeight: 1920 }), false);
  assert.equal(readShotMeta({ width: 0, height: 600, clientWidth: 800, clientHeight: 600 }), null);
  assert.equal(readShotMeta({ width: 800, height: 600, clientWidth: 800 }), null);
  assert.equal(readShotMeta(null), null);
});

test('readPageMetrics 要求全部数值字段与 readyState；readDomState 拒绝负 mutations', () => {
  const good = {
    dpr: 1, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    visualScale: 1, visualWidth: 800, visualHeight: 600, visualOffsetX: 0, visualOffsetY: 0,
    readyState: 'complete', title: 'overlay probe',
  };
  assert.equal(readPageMetrics(good).dpr, 1);
  assert.equal(readPageMetrics({ ...good, dpr: '1' }), null);
  assert.equal(readPageMetrics({ ...good, dpr: 0 }), null);
  assert.equal(readPageMetrics({ ...good, readyState: 3 }), null);
  assert.equal(readPageMetrics(null), null);
  assert.deepEqual(readDomState({ mutations: 0, hash: 7, length: 42 }), { mutations: 0, hash: 7, length: 42 });
  assert.equal(readDomState({ mutations: -1, hash: 7, length: 42 }), null);
  assert.equal(readDomState({ mutations: 0, hash: 7, length: 0 }), null);
});

// ---------------------------------------------------------------------------
// 4. 前提：DPR 必须实测为 1，不缩放、不滚动、尺寸一致
// ---------------------------------------------------------------------------

const HAPPY = {
  metrics: {
    dpr: 1, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    visualScale: 1, visualWidth: 800, visualHeight: 600, visualOffsetX: 0, visualOffsetY: 0,
    readyState: 'complete', title: 'overlay probe',
  },
  layout: { cssWidth: 800, cssHeight: 600, pageZoom: 1 },
  nativeSize: { width: 800, height: 600, clientWidth: 800, clientHeight: 600 },
  surfaceSize: { width: 800, height: 600 },
  windowClientRect: { x: 100, y: 140, width: 800, height: 600 },
  rendererClientRect: { x: 100, y: 140, width: 800, height: 600 },
};

test('DPR=1、无缩放、无滚动、尺寸一致时前提才成立', () => {
  const verdict = checkPreconditions(HAPPY);
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.dpr, 1);
  assert.deepEqual(verdict.expectedSurface, { width: 800, height: 600 });
});

test('DPR 不是 1 就拒绝（Phase A 只在 DPR=1 上有意义，不靠乘以 DPR/96 去猜）', () => {
  const scaled = {
    ...HAPPY,
    metrics: { ...HAPPY.metrics, dpr: 1.25, innerWidth: 800, visualWidth: 800 },
    nativeSize: { width: 1000, height: 750, clientWidth: 1000, clientHeight: 750 },
    surfaceSize: { width: 1000, height: 750 },
    windowClientRect: { x: 100, y: 140, width: 1000, height: 750 },
    rendererClientRect: { x: 100, y: 140, width: 1000, height: 750 },
    layout: { cssWidth: 800, cssHeight: 600, pageZoom: 1 },
  };
  const verdict = checkPreconditions(scaled);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reasons, ['dpr-not-1']);
  assert.equal(verdict.expectedSurface.width, 1000);
});

test('页面缩放、页面滚动、视觉视口偏移、尺寸不符都被拒绝', () => {
  assert.deepEqual(checkPreconditions({ ...HAPPY, layout: { ...HAPPY.layout, pageZoom: 1.1 } }).reasons, ['page-zoom-not-1']);
  assert.deepEqual(checkPreconditions({ ...HAPPY, metrics: { ...HAPPY.metrics, scrollY: 3 } }).reasons, ['page-scrolled']);
  assert.deepEqual(checkPreconditions({ ...HAPPY, metrics: { ...HAPPY.metrics, visualScale: 2 } }).reasons, ['visual-scale-not-1']);
  assert.deepEqual(checkPreconditions({ ...HAPPY, metrics: { ...HAPPY.metrics, visualOffsetY: 5 } }).reasons, ['visual-viewport-offset']);
  assert.deepEqual(checkPreconditions({ ...HAPPY, nativeSize: { width: 1280, height: 960, clientWidth: 1280, clientHeight: 960 } }).reasons, ['native-size-mismatch']);
  assert.deepEqual(checkPreconditions({ ...HAPPY, surfaceSize: { width: 795, height: 600 } }).reasons, ['surface-size-mismatch']);
  assert.deepEqual(checkPreconditions({ ...HAPPY, metrics: { ...HAPPY.metrics, innerWidth: 790 } }).reasons, ['inner-width-mismatch']);
  assert.deepEqual(checkPreconditions({ ...HAPPY, metrics: null }).reasons, ['page-metrics-invalid']);
  assert.deepEqual(checkPreconditions({ ...HAPPY, layout: { cssWidth: 0, cssHeight: 600, pageZoom: 1 } }).reasons, ['layout-invalid']);
});

// ---------------------------------------------------------------------------
// 5. 判据：阈值是常量，先定后测
// ---------------------------------------------------------------------------

function row(name, changed, total, bbox) {
  return { name, x: 0, y: 0, width: Math.max(1, bbox ? bbox.width : 10), height: Math.max(1, bbox ? bbox.height : 10), changed, total, ratio: changed / total, bbox: bbox || null };
}

test('矩形内变化 ≥90%、矩形外 ≤0.5% 才算「看得见」，且高亮必须落在预测框上', () => {
  const expected = { x: 120, y: 140, width: 240, height: 160 };
  const good = judgeHighlight({
    inside: row('native-inside', 38400, 38400, expected),
    outside: [row('native-outside-right', 0, 20000), row('native-outside-below', 4, 40000)],
    expected,
  });
  assert.equal(good.shown, true);
  assert.equal(good.visible, true);
  assert.equal(good.geometryOk, true);
  assert.deepEqual(good.reasons, []);
  assert.equal(good.ratio, 1);

  // 只有一小块变：没过 90%。
  const weak = judgeHighlight({ inside: row('native-inside', 19200, 38400, expected), outside: [], expected });
  assert.equal(weak.shown, false);
  assert.deepEqual(weak.reasons, ['inside-unchanged']);

  // 矩形外变了 1%：超过 0.5% 容差。
  const leak = judgeHighlight({
    inside: row('native-inside', 38400, 38400, expected),
    outside: [row('native-outside-right', 200, 20000)],
    expected,
  });
  assert.equal(leak.shown, false);
  assert.deepEqual(leak.reasons, ['outside-changed']);

  assert.deepEqual(judgeHighlight({ inside: null, outside: [], expected }).reasons, ['inside-region-missing']);
});

test('高亮偏移超过 ±2px 记 geometry-offset：不能靠反推校准掩盖位置不对', () => {
  const expected = { x: 120, y: 140, width: 240, height: 160 };
  const off = judgeHighlight({
    inside: row('native-inside', 38400, 38400, { x: 130, y: 145, width: 240, height: 160 }),
    outside: [],
    expected,
  });
  assert.equal(off.shown, true, '仍然看得见');
  assert.equal(off.geometryOk, false);
  assert.equal(off.visible, false, '位置不对不算可见结论');
  assert.deepEqual(off.reasons, ['geometry-offset']);
  assert.deepEqual(off.offset, { dx: 10, dy: 5, dw: 0, dh: 0 });

  // 2px 以内算命中（像素容差）。
  const near = judgeHighlight({
    inside: row('native-inside', 38400, 38400, { x: 122, y: 138, width: 240, height: 160 }),
    outside: [],
    expected,
  });
  assert.equal(near.geometryOk, true);
  assert.equal(near.visible, true);
});

test('三轮一致 = 每轮都看得见 + hide 后逐像素回基线 + DOM 没变', () => {
  const expected = { x: 120, y: 140, width: 240, height: 160 };
  const round = () => ({
    highlight: judgeHighlight({ inside: row('native-inside', 38400, 38400, expected), outside: [row('native-outside', 0, 1000)], expected }),
    hidden: { identical: true },
    dom: { ok: true, mutations: 0 },
  });
  const judged = judgeRounds([round(), round(), round()]);
  assert.equal(judged.rounds, 3);
  assert.equal(judged.visible, true);
  assert.equal(judged.hiddenAll, true);
  assert.equal(judged.domAll, true);
  assert.equal(judged.geometryMismatch, false);
  assert.equal(judged.consistent, true);

  // 有一轮 hide 后没回基线：整组不一致。
  const drifted = judgeRounds([round(), { ...round(), hidden: { identical: false } }, round()]);
  assert.equal(drifted.hiddenAll, false);
  assert.equal(drifted.consistent, false);

  // DOM 被改了（说明这条路径不是纯 Overlay）。
  const touched = judgeRounds([round(), { ...round(), dom: { ok: false, mutations: 2 } }, round()]);
  assert.equal(touched.domAll, false);
  assert.equal(touched.consistent, false);

  assert.equal(judgeRounds([]).consistent, false);
  assert.equal(judgeRounds(null).rounds, 0);
});

test('两轮以上同向偏移才算几何问题（单轮抖动不算）', () => {
  const expected = { x: 120, y: 140, width: 240, height: 160 };
  const shifted = () => judgeHighlight({
    inside: row('native-inside', 38400, 38400, { x: 160, y: 140, width: 240, height: 160 }),
    outside: [],
    expected,
  });
  const one = judgeRounds([
    { highlight: shifted(), hidden: { identical: true }, dom: { ok: true } },
    { highlight: judgeHighlight({ inside: row('native-inside', 38400, 38400, expected), outside: [], expected }), hidden: { identical: true }, dom: { ok: true } },
    { highlight: judgeHighlight({ inside: row('native-inside', 38400, 38400, expected), outside: [], expected }), hidden: { identical: true }, dom: { ok: true } },
  ]);
  assert.equal(one.mismatchRounds, 1);
  assert.equal(one.geometryMismatch, false);

  const two = judgeRounds([
    { highlight: shifted(), hidden: { identical: true }, dom: { ok: true } },
    { highlight: shifted(), hidden: { identical: true }, dom: { ok: true } },
    { highlight: judgeHighlight({ inside: row('native-inside', 38400, 38400, expected), outside: [], expected }), hidden: { identical: true }, dom: { ok: true } },
  ]);
  assert.equal(two.mismatchRounds, 2);
  assert.equal(two.geometryMismatch, true);
  assert.equal(two.consistent, false);
});

// ---------------------------------------------------------------------------
// 6. 结论词表与「身份 ≠ 像素」
// ---------------------------------------------------------------------------

const READY = { ok: true, reasons: [], dpr: 1, expectedSurface: { width: 800, height: 600 } };
const CONTROL_OK = { native: { ok: true, visible: true }, surface: { ok: true, visible: true } };
const BASELINE_OK = { native: true, surface: true };
const PATH_VISIBLE = { visible: true, hiddenAll: true, domAll: true, geometryMismatch: false, consistent: true };
const PATH_BLIND = { visible: false, hiddenAll: true, domAll: true, geometryMismatch: false, consistent: true };

test('overlayVerdict 的词表固定：both / native-only / neither / geometry-mismatch / inconclusive', () => {
  assert.equal(overlayVerdict({ preconditions: READY, controls: CONTROL_OK, baseline: BASELINE_OK, paths: { native: PATH_VISIBLE, surface: PATH_VISIBLE } }).overlayCapture, 'both');
  assert.equal(overlayVerdict({ preconditions: READY, controls: CONTROL_OK, baseline: BASELINE_OK, paths: { native: PATH_VISIBLE, surface: PATH_BLIND } }).overlayCapture, 'native-only');
  const neither = overlayVerdict({ preconditions: READY, controls: CONTROL_OK, baseline: BASELINE_OK, paths: { native: PATH_BLIND, surface: PATH_BLIND } });
  assert.equal(neither.overlayCapture, 'neither');
  // 只有 surface 看见：不认（私有 overlay 应该出现在窗口内容里，而不是合成表面）
  const surfaceOnly = overlayVerdict({ preconditions: READY, controls: CONTROL_OK, baseline: BASELINE_OK, paths: { native: PATH_BLIND, surface: PATH_VISIBLE } });
  assert.equal(surfaceOnly.overlayCapture, 'inconclusive');
  assert.equal(surfaceOnly.reason, 'surface-only');
  const mismatch = overlayVerdict({ preconditions: READY, controls: CONTROL_OK, baseline: BASELINE_OK, paths: { native: { ...PATH_VISIBLE, geometryMismatch: true }, surface: PATH_BLIND } });
  assert.equal(mismatch.overlayCapture, 'geometry-mismatch');
  // 前置条件、正控、基线任一不过，一律 inconclusive，不许降级成结论。
  assert.equal(overlayVerdict({ preconditions: { ok: false, reasons: ['dpr-not-1'] }, controls: CONTROL_OK, baseline: BASELINE_OK, paths: { native: PATH_VISIBLE, surface: PATH_VISIBLE } }).reason, 'preconditions');
  assert.equal(overlayVerdict({ preconditions: READY, controls: { native: { ok: false }, surface: CONTROL_OK.surface }, baseline: BASELINE_OK, paths: { native: PATH_VISIBLE, surface: PATH_VISIBLE } }).reason, 'positive-control');
  assert.equal(overlayVerdict({ preconditions: READY, controls: CONTROL_OK, baseline: { native: false, surface: true }, paths: { native: PATH_VISIBLE, surface: PATH_VISIBLE } }).reason, 'baseline-drift');
  assert.equal(overlayVerdict({ preconditions: READY, controls: CONTROL_OK, baseline: BASELINE_OK, paths: null }).reason, 'path-evidence-missing');
});

test('identity 与 pixels 分开：像素结论不会提升身份绑定', () => {
  const report = composeReport(
    { binding: 'windowId-hwnd-causal-only', windowId: 7, hwnd: 1234, matchedPid: 99, dpiScale: 1, uniqueWindow: true, uniqueRenderer: true },
    { overlayCapture: 'native-only', overlayReason: 'window-content-only' },
  );
  assert.equal(report.identity.binding, 'windowId-hwnd-causal-only');
  assert.equal(report.identity.windowId, 7);
  assert.equal(report.overlayCapture, 'native-only');
  assert.equal(report.sameSurface, 'experiment-scoped-not-proven');
  assert.equal(report.pointerOutput, 'none');
  assert.equal(report.productionGeometryChanged, false);
  assert.equal(report.calibrationEnabled, false);
  assert.equal(Object.prototype.hasOwnProperty.call(report.identity, 'overlayCapture'), false);

  // 哪怕像素很漂亮，身份为空也不能凭空补上。
  const blank = composeReport(null, { overlayCapture: 'both' });
  assert.equal(blank.identity.binding, null);
  assert.equal(blank.identity.windowId, null);
  assert.equal(blank.overlayCapture, 'both');
  assert.deepEqual(blank.shots, []);
  assert.deepEqual(blank.rounds, []);
  // 默认（没有像素结论）就是 inconclusive，不是成功。
  assert.equal(composeReport({ binding: 'x' }).overlayCapture, 'inconclusive');
});

test('清理没确认就永远不是成功：退出码与阈值都要清理证据', () => {
  const good = composeReport(
    { binding: 'windowId-hwnd-causal-only', windowId: 7, hwnd: 1234, matchedPid: 99 },
    { overlayCapture: 'native-only', paths: { native: PATH_VISIBLE, surface: PATH_BLIND } },
  );
  assert.equal(thresholdsMet(good), true);
  assert.equal(overlayExitCode({ ...good, cleanup: { ok: true, browserClosed: true }, restore: { ok: true } }), 0);

  // 清理没确认：即使像素门槛全过，也只能是 2。
  assert.equal(overlayExitCode({ ...good, cleanup: { ok: false, browserClosed: false }, restore: { ok: true } }), 2);
  assert.equal(overlayExitCode({ ...good, cleanup: { ok: true, browserClosed: false }, restore: { ok: true } }), 2);
  // 窗口没恢复也不能算成功。
  assert.equal(overlayExitCode({ ...good, cleanup: { ok: true, browserClosed: true }, restore: { ok: false, confidence: 'unknown' } }), 2);
  // 没搬过窗口（notNeeded）则不需要 restore 证据。
  assert.equal(overlayExitCode({ ...good, cleanup: { ok: true, browserClosed: true }, restore: { notNeeded: true } }), 0);
  // stale build / 未预期异常有专用退出码。
  assert.equal(overlayExitCode({ ...good, stopReason: { code: 'stale-build' }, cleanup: { ok: true, browserClosed: true } }), 3);
  assert.equal(overlayExitCode({ ...good, stopReason: { code: 'unexpected' }, cleanup: { ok: true, browserClosed: true } }), 4);
  assert.equal(overlayExitCode(null), 4);

  // native 没看见就不是成功；只有 native-only / both 能谈成功。
  const blind = composeReport({ binding: 'windowId-hwnd-causal-only' }, { overlayCapture: 'neither', paths: { native: PATH_BLIND, surface: PATH_BLIND } });
  assert.equal(thresholdsMet(blind), false);
  assert.equal(overlayExitCode({ ...blind, cleanup: { ok: true, browserClosed: true }, restore: { notNeeded: true } }), 2);
  // both 还要求 surface 也看见。
  const bothButBlindSurface = composeReport({ binding: 'windowId-hwnd-causal-only' }, { overlayCapture: 'both', paths: { native: PATH_VISIBLE, surface: PATH_BLIND } });
  assert.equal(thresholdsMet(bothButBlindSurface), false);
});

// ---------------------------------------------------------------------------
// 7. 预算：Overlay 卫生与清理同一份 60s，抓图有硬上限
// ---------------------------------------------------------------------------

test('Overlay 卫生（hide/disable）算在同一份 60s 清理预算里', () => {
  assert.deepEqual(cleanupBudget(0), { hygieneMs: 0, totalMs: 60000, totalWithHygieneMs: 60000, capMs: 60000 });
  assert.deepEqual(cleanupBudget(9000), { hygieneMs: 2000, totalMs: 58000, totalWithHygieneMs: 60000, capMs: 60000 });
  assert.deepEqual(cleanupBudget(undefined), { hygieneMs: 0, totalMs: 60000, totalWithHygieneMs: 60000, capMs: 60000 });

  const started = 1000;
  const hygiene = cleanupBudget(1500);
  const schedule = cleanupSchedule(started, { totalMs: hygiene.totalMs });
  assert.ok(schedule.hardEnd - started <= hygiene.totalMs, '清理阶段总长不超过预算');
  assert.ok(schedule.restoreEnd <= schedule.reverifyEnd);
  assert.ok(schedule.reverifyEnd <= schedule.closeEnd);
  assert.ok(schedule.closeEnd <= schedule.stopEnd);
  assert.ok(hygiene.hygieneMs + (schedule.stopEnd - started) <= hygiene.capMs, '卫生 + 清理不超过 60s 上限');
});

test('抓图账本最多 18 次，超出就抛 shot-budget（不静默多拍）', () => {
  const ledger = shotLedger(3);
  assert.equal(ledger.count, 0);
  assert.equal(ledger.remaining, 3);
  ledger.take('b0-native');
  ledger.take('b0-surface');
  ledger.take('p1-native');
  assert.equal(ledger.count, 3);
  assert.equal(ledger.remaining, 0);
  assert.throws(() => ledger.take('extra'), (error) => error instanceof Stopped && error.code === 'shot-budget');
  const full = shotLedger();
  assert.equal(full.remaining, 18);
});

// ---------------------------------------------------------------------------
// 8. 离线像素答案的严格解析（假数据：形状/长度/尺寸/bbox 都要对得上）
// ---------------------------------------------------------------------------

const ANSWER_IMAGES = [
  { id: 'a', file: 'a.png', width: 40, height: 30, bytes: 120, colorType: 2, pixelFormat: 'Format24bppRgb' },
  { id: 'b', file: 'b.png', width: 40, height: 30, bytes: 130, colorType: 2, pixelFormat: 'Format24bppRgb' },
];
const ANSWER_REGION = { name: 'inside', x: 4, y: 3, width: 12, height: 10, changed: 80, alphaChanged: 0, total: 120, bbox: { x: 5, y: 4, width: 10, height: 8 }, meanA: { r: 255, g: 255, b: 255 }, meanB: { r: 200, g: 120, b: 200 } };
const EXPECTED = {
  images: [{ id: 'a', width: 40, height: 30 }, { id: 'b', width: 40, height: 30 }],
  jobs: [{ kind: 'compare', a: 'a', b: 'b', regions: [{ name: 'inside', x: 4, y: 3, width: 12, height: 10 }] }],
};

test('readPixelsReport 只接受声明过的图与区域，并算出比例', () => {
  const answer = {
    ok: true, schema: 'browser-overlay-pixels/1', images: ANSWER_IMAGES, comparedPixels: 120,
    results: [{ job: 0, kind: 'compare', a: 'a', b: 'b', regions: [ANSWER_REGION] }],
  };
  const reading = readPixelsReport(answer, EXPECTED);
  assert.equal(reading.ok, true);
  const region = reading.results[0].regions[0];
  assert.equal(region.changed, 80);
  assert.equal(region.total, 120);
  assert.equal(region.ratio, 80 / 120);
  assert.deepEqual(region.bbox, { x: 5, y: 4, width: 10, height: 8 });

  const reject = (patch, code) => {
    const tampered = JSON.parse(JSON.stringify(answer));
    patch(tampered);
    const reading2 = readPixelsReport(tampered, EXPECTED);
    assert.equal(reading2.ok, false, '应该拒绝：' + code);
    assert.equal(reading2.code, code);
  };
  reject(a => { a.images.pop(); }, 'images');
  reject(a => { a.images[0].width = 41; }, 'dimensions');
  reject(a => { a.images[0].pixelFormat = 'Format8bppIndexed'; }, 'format');
  reject(a => { a.images[0].bytes = 0; }, 'images');
  reject(a => { a.results[0].regions[0].name = 'other'; }, 'results');
  reject(a => { a.results[0].regions[0].width = 13; }, 'dimensions');
  reject(a => { a.results[0].regions[0].changed = 0; }, 'results');
  reject(a => { a.results[0].regions[0].meanB.r = 300; }, 'results');
  reject(a => { a.results.push(a.results[0]); }, 'results');
  reject(a => { a.schema = 'other/1'; }, 'schema');

  // 脚本自己拒绝时，错误码原样透出。
  const refused = readPixelsReport({ ok: false, schema: 'browser-overlay-pixels/1', error: { code: 'region-out-of-bounds', detail: 'job 0 inside' } }, EXPECTED);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'region-out-of-bounds');
  assert.equal(readPixelsReport(null, EXPECTED).code, 'shape');
});

test('readPixelsReport 允许 equal job 不带 regions（整幅比较，结果名叫 full）', () => {
  const expected = {
    images: [{ id: 'a', width: 40, height: 30 }],
    jobs: [{ kind: 'equal', a: 'a', b: 'a', regions: [] }],
  };
  const answer = {
    ok: true, schema: 'browser-overlay-pixels/1',
    images: [{ id: 'a', file: 'a.png', width: 40, height: 30, bytes: 100, colorType: 2, pixelFormat: 'Format24bppRgb' }],
    results: [{ job: 0, kind: 'equal', a: 'a', b: 'a', regions: [{ name: 'full', x: 0, y: 0, width: 40, height: 30, changed: 0, alphaChanged: 0, total: 1200, bbox: null, meanA: { r: 255, g: 255, b: 255 }, meanB: { r: 255, g: 255, b: 255 } }] }],
  };
  const reading = readPixelsReport(answer, expected);
  assert.equal(reading.ok, true);
  assert.equal(reading.results[0].regions[0].name, 'full');
  assert.equal(reading.results[0].regions[0].ratio, 0);
});

// ---------------------------------------------------------------------------
// 9. 真实小 PNG：像素脚本的读取、比较与拒绝（不经过浏览器，只读磁盘文件）
// ---------------------------------------------------------------------------

test('像素脚本读真实 PNG：品红块被看见、位置对、hide 后回基线', { skip: !WINDOWS && 'powershell 只在这台 Windows 上' }, t => {
  const dir = fixtureDir(t);
  fs.writeFileSync(path.join(dir, 'b0.png'), makePng(40, 30, 2, WHITE));
  fs.writeFileSync(path.join(dir, 'hl.png'), makePng(40, 30, 2, WHITE, { x: 5, y: 4, width: 10, height: 8, color: MAGENTA }));
  fs.writeFileSync(path.join(dir, 'back.png'), makePng(40, 30, 2, WHITE));

  const manifest = {
    schema: 'browser-overlay-pixels/1',
    root: dir,
    images: [
      { id: 'b0', file: 'b0.png', width: 40, height: 30 },
      { id: 'hl', file: 'hl.png', width: 40, height: 30 },
      { id: 'back', file: 'back.png', width: 40, height: 30 },
    ],
    regions: [
      { name: 'inside', x: 4, y: 3, width: 12, height: 10 },
      { name: 'outside', x: 20, y: 0, width: 20, height: 30 },
    ],
    jobs: [
      { kind: 'compare', a: 'b0', b: 'hl', regions: ['inside', 'outside'] },
      { kind: 'equal', a: 'b0', b: 'back' },
    ],
  };
  const run = runPixels(dir, manifest);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.answer, run.stdout);

  const reading = readPixelsReport(run.answer, {
    images: manifest.images,
    jobs: [
      { kind: 'compare', a: 'b0', b: 'hl', regions: [{ name: 'inside', x: 4, y: 3, width: 12, height: 10 }, { name: 'outside', x: 20, y: 0, width: 20, height: 30 }] },
      { kind: 'equal', a: 'b0', b: 'back', regions: [] },
    ],
  });
  assert.equal(reading.ok, true);

  const inside = reading.results[0].regions[0];
  assert.equal(inside.changed, 80, '品红块 10×8=80 像素全变');
  assert.equal(inside.bbox.x, 5);
  assert.equal(inside.bbox.y, 4);
  assert.equal(inside.bbox.width, 10);
  assert.equal(inside.bbox.height, 8);
  const outside = reading.results[0].regions[1];
  assert.equal(outside.changed, 0, '框外一个像素都不该变');
  assert.equal(outside.bbox, null);
  assert.equal(reading.results[1].regions[0].name, 'full');
  assert.equal(reading.results[1].regions[0].changed, 0, 'hide 之后应与基线逐像素相同');
});

test('像素脚本对图数、尺寸、区域、缺图、越界一律整包拒绝', { skip: !WINDOWS && 'powershell 只在这台 Windows 上' }, t => {
  const dir = fixtureDir(t);
  fs.writeFileSync(path.join(dir, 'a.png'), makePng(40, 30, 2, WHITE));
  fs.writeFileSync(path.join(dir, 'b.png'), makePng(40, 30, 2, WHITE, { x: 5, y: 4, width: 10, height: 8, color: MAGENTA }));
  fs.writeFileSync(path.join(dir, 'tall.png'), makePng(40, 31, 2, WHITE));
  fs.writeFileSync(path.join(dir, 'gray.png'), makePng(8, 8, 0, [128]));
  // 头里声明 60000×60000、文件本身只有 40×30：解码前就必须拒，绝不去分配那么大的位图。
  fs.writeFileSync(path.join(dir, 'huge.png'), withHugeHeader(makePng(40, 30, 2, WHITE), 60000, 60000));

  const base = {
    schema: 'browser-overlay-pixels/1',
    root: dir,
    images: [{ id: 'a', file: 'a.png', width: 40, height: 30 }, { id: 'b', file: 'b.png', width: 40, height: 30 }],
    regions: [{ name: 'inside', x: 4, y: 3, width: 12, height: 10 }],
    jobs: [{ kind: 'compare', a: 'a', b: 'b', regions: ['inside'] }],
  };
  const expectRefusal = (patch, code) => {
    const manifest = JSON.parse(JSON.stringify(base));
    patch(manifest);
    const run = runPixels(dir, manifest);
    assert.equal(run.status, 2, '拒绝时退出码必须是 2：' + code);
    assert.ok(run.answer, run.stdout);
    assert.equal(run.answer.ok, false);
    assert.equal(run.answer.error.code, code);
  };

  expectRefusal(m => { m.images[0].width = 41; }, 'dimension-mismatch');
  expectRefusal(m => { m.images[0].file = 'nope.png'; }, 'missing-image');
  expectRefusal(m => { m.images[0].file = '../a.png'; }, 'path-outside-root');
  expectRefusal(m => { m.images[0].file = path.join(dir, 'a.png'); }, 'path-outside-root');
  expectRefusal(m => { m.regions[0].width = 40; }, 'region-out-of-bounds');
  expectRefusal(m => { m.regions[0].name = 'inside'; m.regions.push({ name: 'inside', x: 0, y: 0, width: 2, height: 2 }); }, 'duplicate-region');
  expectRefusal(m => { m.images = Array.from({ length: 25 }, (unused, index) => ({ id: 'i' + index, file: 'a.png', width: 40, height: 30 })); }, 'too-many-images');
  expectRefusal(m => { m.images = [{ id: 'g', file: 'gray.png', width: 8, height: 8 }]; m.jobs = [{ kind: 'equal', a: 'g', b: 'g' }]; m.regions = []; }, 'unsupported-png');
  expectRefusal(m => { m.images[1] = { id: 'b', file: 'tall.png', width: 40, height: 31 }; m.regions = []; m.jobs = [{ kind: 'equal', a: 'a', b: 'b' }]; }, 'dimension-mismatch');
  expectRefusal(m => { m.limits = { maxComparePixels: 50 }; }, 'compare-too-big');
  expectRefusal(m => { m.jobs = [{ kind: 'compare', a: 'a', b: 'b' }]; }, 'bad-job');
  expectRefusal(m => { m.schema = 'other/1'; }, 'bad-schema');
  // 解码前的尺寸/像素上限：头里声明的尺寸先拒，再谈解码。
  expectRefusal(m => { m.images[0] = { id: 'a', file: 'huge.png', width: 60000, height: 60000 }; }, 'image-side-too-big');
  // 清单只能把上限调低：1200 像素的图配 1000 的上限就该拒。
  expectRefusal(m => { m.limits = { maxImagePixels: 1000 }; }, 'image-pixels-too-big');
  // 两张 1200 像素的图各解码一次是 2400，比较时再各解码一次，3000 的总额度因此到比较那一步才用完。
  expectRefusal(m => { m.limits = { maxDecodedPixels: 3000 }; }, 'decoded-pixels-too-big');
});

// ---------------------------------------------------------------------------
// 10. 帧差与位移（身份因果链的离线部分）
// ---------------------------------------------------------------------------

const RENDER_WIDGET = 'Chrome_RenderWidgetHostHWND';

/** 只描述本 profile 枚举到的窗口（helper content 的形状）。 */
function frame(left, extraWindows, extraRenderers, top) {
  const y = top === undefined ? 100 : top;
  return {
    windows: [
      { hwnd: 11, visible: true, windowRect: { x: left, y, width: 800, height: 600 } },
      ...(extraWindows || []),
    ],
    renderer: [
      { hwnd: 12, parent: 11, className: RENDER_WIDGET, visible: true, clientRect: { x: left, y: y + 40, width: 800, height: 560 } },
      ...(extraRenderers || []),
    ],
  };
}

test('diffFrames 只比较本 profile 的窗口；窗口集合变了就直接拒绝', () => {
  const diff = diffFrames(frame(100), frame(311), 11);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.rows.length, 1);
  assert.equal(diff.rows[0].hwnd, 11);
  assert.equal(diff.rows[0].intended, true);
  assert.deepEqual(diff.rows[0].delta, { dx: 211, dy: 0, dw: 0, dh: 0 });
  assert.equal(diff.rows[0].children.length, 1);
  assert.deepEqual(diff.rows[0].children[0].delta, { dx: 211, dy: 0, dw: 0, dh: 0 });

  // 多出一个窗口：不能声称「只有目标动了」。
  assert.throws(
    () => diffFrames(frame(100), frame(311, [{ hwnd: 21, visible: true, windowRect: { x: 0, y: 0, width: 10, height: 10 } }]), 11),
    (error) => error instanceof Stopped && error.code === 'window-set-changed',
  );
});

test('assessMove 要求只有目标窗口和它的 renderer 按 dip×dpiScale 动', () => {
  // 位移 (211, -97)：两次因子都是 1，说明物理像素就等于 DIP×dpiScale。
  const moved = assessMove(diffFrames(frame(100, undefined, undefined, 100), frame(311, undefined, undefined, 3), 11), { dx: 211, dy: -97 }, 1);
  assert.deepEqual(moved.reasons, []);
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.factors, { x: 1, y: 1 });

  // 位移对不上就是失败，不许反推因子掩盖。
  const short = assessMove(diffFrames(frame(100), frame(204), 11), { dx: 211, dy: 0 }, 1);
  assert.equal(short.ok, false);
  assert.ok(short.reasons.includes('intended-dx'), JSON.stringify(short.reasons));

  // 别的窗口跟着动：不算因果，单独记。
  const neighbours = diffFrames(frame(100, [{ hwnd: 31, visible: true, windowRect: { x: 500, y: 500, width: 100, height: 100 } }]), frame(311, [{ hwnd: 31, visible: true, windowRect: { x: 520, y: 500, width: 100, height: 100 } }]), 11);
  const noisy = assessMove(neighbours, { dx: 211, dy: 0 }, 1);
  assert.equal(noisy.ok, false);
  assert.ok(noisy.reasons.some(reason => reason.startsWith('other-window-moved:')), JSON.stringify(noisy.reasons));
});

// ---------------------------------------------------------------------------
// 11. 清理预算是一条绝对 deadline（不是"每段各给一份"）
// ---------------------------------------------------------------------------

test('清理只有一份 60s：卫生的每一步都从里面扣，扣完就是 0，不再补一份', () => {
  const deadline = cleanupDeadline(1_000);
  assert.deepEqual(deadline, { startMs: 1_000, hardEnd: 61_000, capMs: 60_000 });
  assert.equal(cleanupRemaining(deadline, 1_000), 60_000);
  assert.equal(cleanupRemaining(deadline, 55_000), 6_000);
  assert.equal(cleanupRemaining(deadline, 61_000), 0);
  assert.equal(cleanupRemaining(deadline, 120_000), 0, '越过 deadline 就是 0，不能变成负数');
  assert.equal(cleanupRemaining(null, 1_000), 0);

  // 单步 ≤700ms、卫生合计 ≤2s，而且每一步都还得落在同一个 hardEnd 里。
  assert.equal(hygieneStepMs(deadline, 0, 1_000, 700), 700);
  assert.equal(hygieneStepMs(deadline, 700, 2_000, 700), 700);
  assert.equal(hygieneStepMs(deadline, 1_500, 3_000, 700), 500, '2s 只剩 500ms 就只能拿 500ms');
  assert.equal(hygieneStepMs(deadline, 2_000, 3_000, 700), 0, '2s 用完了就不许再花');
  assert.equal(hygieneStepMs(deadline, 0, 60_500, 700), 500, '不许越过 hardEnd');
  assert.equal(hygieneStepMs(deadline, 0, 61_000, 700), 0);
  assert.equal(hygieneStepMs(null, 0, 1_000, 700), 0);

  // 卫生真花了 1900ms，后面的阶段就是 58100ms；两者相加仍是 60s。
  const used = 1_900;
  const budget = cleanupBudget(used);
  assert.deepEqual(budget, { hygieneMs: 1_900, totalMs: 58_100, totalWithHygieneMs: 60_000, capMs: 60_000 });
  const schedule = cleanupSchedule(1_000, { totalMs: Math.min(budget.totalMs, cleanupRemaining(deadline, 1_000 + used)) });
  assert.ok(used + (schedule.stopEnd - schedule.startedAtMs) <= budget.capMs, '卫生加各阶段不得超过同一份上限');
});

// ---------------------------------------------------------------------------
// 12. 窗口写入闸：屏障等的是原始 CDP 命令，不知道就说不知道
// ---------------------------------------------------------------------------

test('写闸只认原始 setWindowBounds 的结算：没结算就挡住恢复，也绝不报告成"已经停下"', async () => {
  const calls = [];
  const pending = [];
  const gate = createWindowWriteGate({ now: () => 1_000 });
  gate.attach((method, params) => {
    calls.push({ method, params });
    return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
  });

  let moved = 0;
  const body = gate.write(7, { left: 10, top: 20 }, () => { moved += 1; });
  assert.equal(moved, 1, 'moved 必须在真正发出去之前就记下：写失败也算可能动过窗口');
  assert.equal(gate.pendingCount, 1);
  assert.equal(gate.bodyOpen, true);
  assert.deepEqual(calls, [{ method: 'Browser.setWindowBounds', params: { windowId: 7, bounds: { left: 10, top: 20 } } }]);

  // 主体结束：清理一进门就关门，之后只准走恢复写。
  gate.closeBody();
  assert.equal(gate.bodyOpen, false);

  // 还没结算：恢复写一条都不许发，并且要说"不知道"（预算给得很短，免得白等一轮）。
  const stage = { closed: false, remaining: () => 5_000 };
  const tight = { closed: false, remaining: () => 40 };
  await assert.rejects(
    gate.restoreWrite(tight, 7, { left: 0, top: 0 }),
    error => error instanceof Stopped && error.code === 'previous-write-unknown',
  );
  assert.equal(calls.length, 1, 'unknown 的时候不许发第二条写');

  pending[0].resolve({});
  await body;
  assert.equal(gate.pendingCount, 0);

  // 结算之后才允许恢复写；恢复写自己也要结算才算完。
  const restore = gate.restoreWrite(stage, 7, { left: 0, top: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { method: 'Browser.setWindowBounds', params: { windowId: 7, bounds: { left: 0, top: 0 } } });
  const during = gate.snapshot();
  assert.equal(during.terminated, false, '还在飞的那条写不能被报告成已经停下');
  assert.equal(during.pending, 1);
  pending[1].resolve({});
  await restore;
  const after = gate.snapshot();
  assert.equal(after.pending, 0);
  assert.equal(after.settled, 2);
  assert.equal(after.sent, 2);

  // 主体一关，迟到的闭包也写不进来（上面已经关过，closeBody 是幂等的）。
  assert.equal(gate.bodyOpen, false);
  assert.throws(() => gate.write(7, { left: 1 }, () => {}), error => error instanceof Stopped && error.code === 'window-writes-closed');
  // 恢复写还要求阶段活着、还有预算。
  await assert.rejects(gate.restoreWrite({ closed: true, remaining: () => 5_000 }, 7, { left: 0, top: 0 }),
    error => error instanceof Stopped && error.code === 'window-writes-closed');
  await assert.rejects(gate.restoreWrite({ closed: false, remaining: () => 0 }, 7, { left: 0, top: 0 }),
    error => error instanceof Stopped && error.code === 'window-writes-closed');
  // 一条都没多发出去。
  assert.equal(calls.length, 2);
});

test('屏障没有预算时报 no-budget，不会把"没等到"说成"等到了"', async () => {
  const gate = createWindowWriteGate({ now: () => 1_000 });
  gate.attach(() => new Promise(() => {}));
  // 手上没有写：结算就是结算，预算无关。
  assert.deepEqual(await gate.waitSettled(0), { settled: true, pending: 0 });
  gate.write(3, { left: 0, top: 0 }, () => {});
  assert.deepEqual(await gate.waitSettled(0), { settled: false, reason: 'no-budget', pending: 1 });
  assert.equal(gate.snapshot().terminated, false);
});

// ---------------------------------------------------------------------------
// 13. 像素答案里的区域原点必须与声明完全一致
// ---------------------------------------------------------------------------

test('readPixelsReport 要求区域原点与声明等值：换了位置但尺寸相同也不能对上', () => {
  const answer = {
    ok: true, schema: 'browser-overlay-pixels/1', images: ANSWER_IMAGES, comparedPixels: 120,
    results: [{ job: 0, kind: 'compare', a: 'a', b: 'b', regions: [ANSWER_REGION] }],
  };
  assert.equal(readPixelsReport(answer, EXPECTED).ok, true, '原点一致时通过');

  const shifted = JSON.parse(JSON.stringify(answer));
  shifted.results[0].regions[0].x = 5;
  assert.equal(readPixelsReport(shifted, EXPECTED).code, 'results', '原点被挪过就必须拒');

  const moved = JSON.parse(JSON.stringify(answer));
  moved.results[0].regions[0].y = 4;
  assert.equal(readPixelsReport(moved, EXPECTED).code, 'results');

  // 声明里没有原点：那是调用方的问题，不能拿 0 顶上。
  const noOrigin = {
    images: EXPECTED.images,
    jobs: [{ kind: 'compare', a: 'a', b: 'b', regions: [{ name: 'inside', width: 12, height: 10 }] }],
  };
  assert.equal(readPixelsReport(answer, noOrigin).code, 'expected');
});

// ---------------------------------------------------------------------------
// 14. 恢复写等屏障等到一半，阶段被关掉 / 预算用完：结算之后也不许再发恢复写
//     （先进入 await waitSettled，再改 stage 状态，最后才让原始写结算）
// ---------------------------------------------------------------------------

test('屏障还在等待时阶段被关掉：结算之后也不许再发恢复写', async () => {
  const calls = [];
  const pending = [];
  const gate = createWindowWriteGate({ now: () => 1_000 });
  gate.attach((method, params) => {
    calls.push({ method, params });
    // 只有主体那一条挂在手里。万一流出第二条（不该发生的恢复写）就立刻结算，
    // 免得修复前这条用例卡在 await 上变成超时，而不是一条说得清的断言。
    if (calls.length === 1) return new Promise(resolve => { pending.push({ resolve }); });
    return Promise.resolve({});
  });

  const body = gate.write(7, { left: 10, top: 20 }, () => {});
  gate.closeBody();
  const stage = { closed: false, remaining: () => 5_000 };
  const restore = gate.restoreWrite(stage, 7, { left: 0, top: 0 });
  // 让它真的进到 await 里面：进入前的检查已经做过了，之后的任何状态变化都得在等待之后再查一遍。
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, '屏障没结算之前不许发恢复写');

  // 等待期间阶段被 watchdog 关掉，然后原始写才结算。
  stage.closed = true;
  pending[0].resolve({});
  await body;

  await assert.rejects(
    restore,
    error => error instanceof Stopped && error.code === 'window-writes-closed',
    '等待期间阶段已经关掉：必须拒，不能等结算完就照发',
  );
  assert.equal(calls.length, 1, '阶段在等待期间关掉之后，一条 Browser.setWindowBounds 都不许多发');
  assert.equal(gate.snapshot().sent, 1);
});

test('屏障还在等待时阶段预算用完：结算之后也不许再发恢复写', async () => {
  const calls = [];
  const pending = [];
  const gate = createWindowWriteGate({ now: () => 1_000 });
  gate.attach((method, params) => {
    calls.push({ method, params });
    if (calls.length === 1) return new Promise(resolve => { pending.push({ resolve }); });
    return Promise.resolve({});
  });

  let left = 5_000;
  const body = gate.write(7, { left: 10, top: 20 }, () => {});
  gate.closeBody();
  const stage = { closed: false, remaining: () => left };
  const restore = gate.restoreWrite(stage, 7, { left: 0, top: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, '屏障没结算之前不许发恢复写');

  // 等待期间这一阶段的预算被别的东西吃光，然后原始写才结算。
  left = 0;
  pending[0].resolve({});
  await body;

  await assert.rejects(
    restore,
    error => error instanceof Stopped && error.code === 'window-writes-closed',
    '等待期间阶段已经没有预算：必须拒，不能拿进入 await 之前那次读数继续发',
  );
  assert.equal(calls.length, 1, '预算在等待期间用完之后，一条 Browser.setWindowBounds 都不许多发');
  assert.equal(gate.snapshot().sent, 1);
});

// ---------------------------------------------------------------------------
// 15. 报告里的 cleanup 段必须原样带上四类真实证据；缺了就写 null，不许补成"已经停下"
// ---------------------------------------------------------------------------

test('cleanupReportOf 把两笔预算、屏障和窗口写账原样搬进报告', () => {
  const barrier = { settled: true, pending: 0 };
  const windowWrites = {
    sent: 2, settled: 2, pending: 0, bodyOpen: false, terminated: false,
    last: { atMs: 5, method: 'Browser.setWindowBounds', from: 'restore' },
  };
  const cleanup = {
    startedAt: '2026-11-27T00:00:00.000Z',
    evidence: ['a'],
    browserClosed: true,
    killedByPath: false,
    hygieneMs: 900,
    hygieneBudgetMs: 900,
    budget: 59_100,
    budgetAccountingMs: 59_100,
    hardEndAt: '2026-11-27T00:01:00.000Z',
    barrier,
    windowWrites,
  };
  const outcome = { ok: true, restore: { ok: true }, reverify: { ok: true }, close: { ok: true }, stop: { ok: true } };
  const report = cleanupReportOf(cleanup, outcome);

  // 这四类必须真的出现在键里：字段丢了就等于没记，报告也就无法自证。
  for (const key of ['budgetAccountingMs', 'hardEndAt', 'barrier', 'windowWrites']) {
    assert.ok(Object.prototype.hasOwnProperty.call(report, key), key + ' 丢了就等于没记');
  }
  assert.equal(report.budgetAccountingMs, 59_100);
  assert.equal(report.hardEndAt, '2026-11-27T00:01:00.000Z');
  assert.deepEqual(report.barrier, barrier, '屏障结论要原样进报告：settled 与 pending 都是事实');
  assert.deepEqual(report.windowWrites, windowWrites, '窗口写账要原样进报告');
  assert.equal(report.windowWrites.terminated, false, '没确认停下就是 false，绝不能写成 true');
  assert.equal(report.ok, true);
  assert.equal(report.browserClosed, true);
  assert.deepEqual(report.evidence, ['a']);

  // evidence 是拷贝：报告写完以后调用方再改数组，不能把已落盘的记录改掉。
  cleanup.evidence.push('b');
  assert.deepEqual(report.evidence, ['a']);
});

test('cleanupReportOf 缺证据时写 null，不虚构已停下或已恢复', () => {
  const report = cleanupReportOf({ evidence: [], hygieneMs: 0 }, { ok: false });
  for (const key of ['budgetAccountingMs', 'hardEndAt', 'barrier', 'windowWrites', 'domains', 'launch', 'dispatch',
    'startedAt', 'restore', 'reverify', 'close', 'stop']) {
    assert.equal(report[key], null, key + ' 没有记录时必须是 null');
  }
  assert.equal(report.ok, false);
  assert.equal(report.browserClosed, false);
  assert.deepEqual(report.evidence, []);
  // 报告写在 finally 的尾巴上：这里一抛就什么都不留，所以空输入也不许抛。
  assert.equal(cleanupReportOf(undefined, undefined).windowWrites, null);
  assert.equal(cleanupReportOf(null, null).ok, false);
});
// ---------------------------------------------------------------------------
// 16. 两域预算、启动门槛与命令账本（纯函数，不发起任何进程/连接）
// ---------------------------------------------------------------------------

test('预算域按域算剩余，启动门槛不够完整 20s 就零投递', () => {
  const body = makeBudgetDomain('body', 5_000);
  assert.equal(body.label, 'body');
  assert.equal(body.left(1_000), 4_000);
  assert.equal(body.left(5_000), 0);
  assert.equal(body.left(9_000), 0, '过点之后剩余恒为 0，不许变负再被当成预算');
  assert.equal(makeBudgetDomain('body', null).left(0), 0, 'endAt 不合法时域是关死的');

  assert.deepEqual(launchGate(20_000, 20_000), { ok: true, needMs: 20_000, remainingMs: 20_000 });
  const refused = launchGate(19_999, 20_000);
  assert.equal(refused.ok, false, '剩 19999ms 也不够完整 20s：一次都不发起');
  assert.equal(refused.code, 'launch-budget');
  assert.equal(launchGate(undefined, 20_000).ok, false);
  // 被启动门槛拦下也是停：退出码按清理未确认算非 0。
  assert.equal(overlayExitCode({ stopReason: { code: 'launch-budget', detail: null } }), 2);
});

test('账本先查预算再投递：域用完时 thunk 一次都不调用，投递上限取 min', async () => {
  const at = 1_000;
  const ledger = createDispatchLedger({ now: () => at });
  const expired = makeBudgetDomain('body', at);
  let calls = 0;
  assert.throws(
    () => ledger.begin(expired, 'browser:Page.captureScreenshot', 5_000, () => { calls += 1; return Promise.resolve('x'); }),
    (error) => error instanceof Stopped && error.code === 'budget-exhausted',
  );
  assert.equal(calls, 0, '预算没了就不许把命令发出去');
  assert.equal(ledger.snapshot().sent, 0);

  const roomy = makeBudgetDomain('body', 6_000);
  const capped = ledger.begin(roomy, 'helper:cursor', 9_000, () => Promise.resolve('ok'));
  assert.equal(capped.cap, 5_000, '上限取 min(capMs, 域剩余)');
  const tighter = ledger.begin(roomy, 'tab:Overlay.hideHighlight', 1_200, () => Promise.resolve('ok'));
  assert.equal(tighter.cap, 1_200, 'cap 更小时不许放大成剩余');
  assert.equal(await ledger.wait(capped), 'ok');
  assert.equal(ledger.snapshot().sent, 2);
});

test('两个域互不继承：主体过期不影响清理，清理过期则一条都不发', async () => {
  const at = 1_000;
  const ledger = createDispatchLedger({ now: () => at });
  const body = makeBudgetDomain('body', at);
  const cleanup = makeBudgetDomain('cleanup', at + 60_000);
  let bodyCalls = 0;
  assert.throws(
    () => ledger.begin(body, 'browser:Browser.close', 5_000, () => { bodyCalls += 1; return Promise.resolve(); }),
    (error) => error instanceof Stopped && error.code === 'budget-exhausted',
  );
  assert.equal(bodyCalls, 0);
  const sent = ledger.begin(cleanup, 'browser:SystemInfo.getProcessInfo', 5_000, () => Promise.resolve('pids'));
  assert.equal(await ledger.wait(sent), 'pids', '主体域过期不能把清理的复核/关闭也一起拒掉');

  const spent = makeBudgetDomain('cleanup', at - 1);
  assert.throws(
    () => ledger.begin(spent, 'browser:Browser.close', 5_000, () => Promise.resolve()),
    (error) => error instanceof Stopped && error.code === 'budget-exhausted',
  );
});

test('等待超时只结束等待：原始命令仍记 pending，晚到不会再发第二条且晚到连接被关掉', async () => {
  const at = 1_000;
  const ledger = createDispatchLedger({ now: () => at });
  const body = makeBudgetDomain('body', at + 60_000);
  const box = { resolve: (value) => { void value; } };
  const connection = { closed: false, close() { this.closed = true; }, send() { return Promise.resolve({}); } };
  const evidence = [];
  let connects = 0;
  // 走 main 用的同一个 openConnection：晚到连接的处置不是测试里另抄一份（账目对象当连接 close 的写法已被替掉）。
  const connecting = openConnection({
    ledger, domain: body, label: 'tab', url: 'ws://tab', evidence, timeoutMs: 20,
    connectFn: () => { connects += 1; return new Promise(resolve => { box.resolve = resolve; }); },
  });
  await assert.rejects(connecting, (error) => error instanceof Stopped && error.code === 'wait-timeout');
  assert.equal(ledger.snapshot().pending, 1, '等的超时不是命令停下：账本里还欠着一条');
  assert.equal(ledger.snapshot().sent, 1);
  assert.equal(ledger.snapshot().terminated, false);

  box.resolve(connection);
  await new Promise(resolve => setTimeout(resolve, 10));
  const after = ledger.snapshot();
  assert.equal(after.pending, 0);
  assert.equal(after.sent, 1, '晚到只结算那一条，绝不顺手再发一条');
  assert.equal(connects, 1);
  assert.equal(after.entries[0].outcome, 'settled');
  assert.equal(after.entries[0].timedOut, true);
  assert.equal(after.lateAdopted, 1);
  assert.equal(connection.closed, true, '晚到的连接必须被关掉，不能就这样丢掉');
  assert.equal(evidence.some(line => line.includes('晚到的连接已经关掉')), true, 'main 侧的证据链也要写着它被关掉了');
  // 报告里只有事实字段：没有 promise，也没有连接对象。
  assert.equal(JSON.stringify(after).includes('promise'), false);
});

test('boundedSleep 不越过域剩余，报告写两域/账本/启动事实', async () => {
  const spent = makeBudgetDomain('body', 1_000);
  const slept = [];
  assert.equal(await boundedSleep(spent, 5_000, async ms => { slept.push(ms); }), 0, '域已经过点就一分钟都不睡');
  assert.deepEqual(slept, []);
  const roomy = makeBudgetDomain('body', Date.now() + 10_000);
  const wanted = await boundedSleep(roomy, 60_000, async ms => { slept.push(ms); });
  assert.equal(wanted > 0 && wanted <= 10_000, true, '睡的时间取 min(想要, 域剩余)');
  assert.equal(slept.length, 1);

  const dispatch = { sent: 2, settled: 1, pending: 1, lateAdopted: 0, terminated: false, entries: [] };
  const domains = {
    body: { label: 'body', endAt: '2026-11-27T00:01:30.000Z', remainingMs: 0 },
    cleanup: { label: 'cleanup', endAt: '2026-11-27T00:02:30.000Z', remainingMs: 30_000 },
  };
  const launch = { binary: 'b', profileDir: 'p', gate: { ok: true, needMs: 20_000, remainingMs: 40_000 } };
  const report = cleanupReportOf({ evidence: [], domains, launch, dispatch }, { ok: false });
  assert.deepEqual(report.domains, domains);
  assert.deepEqual(report.launch, launch);
  assert.deepEqual(report.dispatch, dispatch);
  assert.equal(report.ok, false, '有没结算的命令就不是 ok');
});

// ---------------------------------------------------------------------------
// 17. 主路径的窄 helper：预算先查再投递、阶段归零就零投递、屏障不过就不恢复
// ---------------------------------------------------------------------------

test('主体的窗口写先查主体域预算：过期域一条都不发，写闸也没动', async () => {
  const at = 1_000;
  const ledger = createDispatchLedger({ now: () => at });
  const calls = [];
  const gate = createWindowWriteGate({
    now: () => at,
    send: (method, params) => { calls.push({ method, params }); return Promise.resolve({ bounds: { left: 1, top: 2 } }); },
  });
  await assert.rejects(
    async () => sendWindowWrite({
      ledger, writeGate: gate, domain: makeBudgetDomain('body', at - 1), windowId: 7,
      bounds: { left: 1, top: 2 }, timeoutMs: 50,
    }),
    (error) => error instanceof Stopped && error.code === 'budget-exhausted',
  );
  assert.deepEqual(calls, [], '域过期时连写闸都不该被调用');
  assert.equal(gate.snapshot().sent, 0);
  assert.equal(ledger.snapshot().sent, 0);

  // finally 入口 closeBody() 之后：即使主体域还有预算，也一条都不发。
  gate.closeBody();
  await assert.rejects(
    async () => sendWindowWrite({
      ledger, writeGate: gate, domain: makeBudgetDomain('body', at + 60_000), windowId: 7,
      bounds: { left: 1, top: 2 }, timeoutMs: 50,
    }),
    (error) => error instanceof Stopped && error.code === 'window-writes-closed',
  );
  assert.deepEqual(calls, []);
  assert.equal(gate.snapshot().sent, 0);
  assert.equal(ledger.snapshot().sent, 0, '写闸自己抛错的那些也不该在账本上留一条已发');
});

test('晚到的是失败而不是连接：不去 close 一个错误对象，没有 close 的连接也只留事实', () => {
  const evidence = [];
  const refused = new Error('connect refused');
  const outcome = closeLateConnection({ ok: false, value: refused }, evidence, 'tab');
  assert.equal(outcome.closed, false);
  assert.equal(outcome.reason, 'late-attempt-failed');
  assert.equal('close' in refused, false, '错误对象不该被当成连接');
  assert.equal(evidence.some(line => line.includes('没有连接可关')), true);
  const noClose = closeLateConnection({ ok: true, value: { send() { return Promise.resolve({}); } } }, evidence, 'tab2');
  assert.equal(noClose.closed, false);
  assert.equal(noClose.reason, 'no-close');
  assert.equal(evidence.some(line => line.includes('没有 close 可用')), true);
});

test('清理阶段每条命令前都看 stage 与 cleanup 余额：0 就零投递，绝不 || cap 重生', async () => {
  const at = 1_000;
  const ledger = createDispatchLedger({ now: () => at });
  const cleanup = makeBudgetDomain('cleanup', at + 60_000);
  let calls = 0;
  const thunk = () => { calls += 1; return Promise.resolve('ok'); };

  await assert.rejects(
    async () => stageDispatch({ ledger, stage: { closed: false, remaining: () => 0 }, domain: cleanup, label: 'browser:Browser.close', capMs: 5_000, thunk }),
    (error) => error instanceof Stopped && error.code === 'stage-budget',
    'stage 剩余是 0 就是 0：cap 不能把命令救回来',
  );
  assert.equal(calls, 0);
  await assert.rejects(
    async () => stageDispatch({ ledger, stage: { closed: true, remaining: () => 5_000 }, domain: cleanup, label: 'browser:Browser.close', capMs: 5_000, thunk }),
    (error) => error instanceof Stopped && error.code === 'stage-closed',
  );
  assert.equal(calls, 0);
  await assert.rejects(
    async () => stageDispatch({ ledger, stage: { closed: false, remaining: () => 5_000 }, domain: makeBudgetDomain('cleanup', at - 1), label: 'browser:Browser.close', capMs: 5_000, thunk }),
    (error) => error instanceof Stopped && error.code === 'budget-exhausted',
  );
  assert.equal(calls, 0);
  assert.equal(ledger.snapshot().sent, 0);

  assert.equal(await stageDispatch({
    ledger, stage: { closed: false, remaining: () => 1_200 }, domain: cleanup,
    label: 'browser:SystemInfo.getProcessInfo', capMs: 5_000, thunk,
  }), 'ok');
  assert.equal(calls, 1);
  assert.equal(ledger.snapshot().entries[0].cap, 1_200, '等待上限取 min(cap, stage 剩余)');
  assert.equal(ledger.snapshot().sent, 1);
});

test('两条屏障任一没结算就不许恢复 bounds：unknown 不冒充已恢复', () => {
  const settled = { settled: true, pending: 0 };
  const pendingWide = { settled: false, pending: 2, reason: 'wait-timeout' };
  const pendingGate = { settled: false, pending: 1, reason: 'no-budget' };
  assert.deepEqual(restoreReadiness(settled, settled), { ok: true, code: null, reason: null, pending: 0 });

  const wide = restoreReadiness(pendingWide, settled);
  assert.equal(wide.ok, false);
  assert.equal(wide.code, 'previous-write-unknown');
  assert.equal(wide.pending, 2);
  assert.equal(wide.reason, 'wait-timeout');

  const narrow = restoreReadiness(settled, pendingGate);
  assert.equal(narrow.ok, false);
  assert.equal(narrow.reason, 'no-budget');

  assert.equal(restoreReadiness(pendingWide, pendingGate).pending, 2, '两条都在飞时 pending 取大的那个');
  // 回调根本没跑（没有证据）也不能算通过。
  assert.equal(restoreReadiness(undefined, undefined).ok, false);
});

// ---------------------------------------------------------------------------
// 18. 就绪轮询只等一次（不再睡完 boundedSleep 再睡一遍）
// ---------------------------------------------------------------------------

test('waitReady 每轮只睡一次：第一次没 ready、第二次 ready 时正好睡一次 100ms', async () => {
  // 假时钟：sleepFn 推进它，域余额从它算出来，所以「睡了多久」完全可观测。
  let clock = 0;
  const sleeps = [];
  const domain = { label: 'body', left: () => Math.max(0, 5_000 - clock) };
  const answers = [
    { readyState: 'loading', title: 'overlay probe' },
    { readyState: 'complete', title: 'overlay probe' },
  ];
  let evaluates = 0;
  const ready = await waitReady(
    async () => { const value = answers[evaluates]; evaluates += 1; return value; },
    () => {},
    domain,
    async ms => { sleeps.push(ms); clock += ms; },
  );
  assert.equal(ready, true);
  assert.equal(evaluates, 2, '第一次不 ready、第二次 ready：正好读两遍');
  assert.deepEqual(sleeps, [100], '每轮只睡一次；睡完再 sleep(slept) 就会变成 [100, 100]');
  assert.equal(clock, 100, '等待真的走了一次 100ms，不是忙轮询');
});

test('waitReady 域里只剩 30ms 时最多等这 30ms，不会再多睡第二个 30ms', async () => {
  let clock = 0;
  const sleeps = [];
  const domain = { label: 'body', left: () => Math.max(0, 30 - clock) };
  let evaluates = 0;
  const ready = await waitReady(
    async () => { evaluates += 1; return { readyState: 'loading', title: 'overlay probe' }; },
    () => {},
    domain,
    async ms => { sleeps.push(ms); clock += ms; },
  );
  assert.equal(ready, false);
  assert.deepEqual(sleeps, [30], '预算只剩 30 就只有一次 30；重复等待会变成 [30, 30] 并越过预算');
  assert.equal(evaluates, 2, '第二轮 evaluate 还是没 ready，boundedSleep 看到余额 0 就返回，于是收工');
});

test('waitReady 域里没有余额时一次都不睡', async () => {
  const sleeps = [];
  let evaluates = 0;
  const ready = await waitReady(
    async () => { evaluates += 1; return { readyState: 'loading', title: 'overlay probe' }; },
    () => {},
    { label: 'body', left: () => 0 },
    async ms => { sleeps.push(ms); },
  );
  assert.equal(ready, false);
  assert.equal(evaluates, 1);
  assert.deepEqual(sleeps, [], '没有余额就一秒都不等');
});

test('waitReady 不注入 sleepFn 时也用真的 sleep 等过一次（main 走的就是这条路）', async () => {
  const started = Date.now();
  const ready = await waitReady(
    async () => ({ readyState: 'loading', title: 'overlay probe' }),
    () => {},
    { label: 'body', left: () => 40 },
  );
  const elapsed = Date.now() - started;
  assert.equal(ready, false);
  assert.ok(elapsed >= 20, '默认路径必须真的等过（域剩 40ms），不是空转一下就返回；实测 ' + elapsed + 'ms');
});

// ---------------------------------------------------------------------------
// 19. 真的把 main 跑到第一次外部投递：投递账与截图账不再互相遮蔽
// ---------------------------------------------------------------------------

const SURFACE_SCRIPT = fileURLToPath(new URL('../scripts/browser-surface-probe.mjs', import.meta.url));

/**
 * 在独立的临时树里照原样复制探针源码，lib/ 全部换成有限 IO 桩，然后用当前那个 node
 * 真跑一遍 CLI 入口（不是 import 后调私有函数，也不是源码正则）：
 *   - 走到 helper:cursor，说明 try 域里的投递账没有被同名的截图账遮蔽（旧码在这里就 TDZ）；
 *   - findBrowser 桩返回 null，于是在 launch 之前就按 browser-not-found 受控停下，一条 launch 都没有。
 * 这里只断言"受控停止"，绝不把它当成 browserClosed / cleanup ok：没开过的浏览器不能写成已关闭。
 */
test('真的跑 main 到第一次外部投递：helper:cursor 发出一次后停在 browser-not-found，零 launch 零网络', { skip: !WINDOWS && 'Win32 才跑真正的 main 入口' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-main-smoke-'));
  t.after(() => {
    const own = path.resolve(root);
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!own.startsWith(tempRoot) || !path.basename(own).startsWith('overlay-main-smoke-')) {
      throw new Error('临时目录不是本次 mkdtemp 建的那个，拒绝删除: ' + own);
    }
    fs.rmSync(own, { recursive: true, force: true });
  });

  const src = lines => lines.join('\n') + '\n';
  const put = (rel, text) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };

  put('package.json', src(['{ "type": "module" }']));
  // 两份真实探针原样复制（main 一个字节都不改）；像素脚本只用来过"存在"检查，绝不被调用。
  put('scripts/browser-overlay-probe.mjs', fs.readFileSync(PROBE_SCRIPT, 'utf8'));
  put('scripts/browser-surface-probe.mjs', fs.readFileSync(SURFACE_SCRIPT, 'utf8'));
  put('scripts/browser-overlay-pixels.ps1', fs.readFileSync(PIXELS_SCRIPT, 'utf8'));
  assert.equal(fs.readFileSync(path.join(root, 'scripts/browser-overlay-probe.mjs'), 'utf8'), fs.readFileSync(PROBE_SCRIPT, 'utf8'),
    'smoke 跑的必须是当前源码，不是改写过的副本');

  // 桩子每做一笔动作就在 stderr 打一行 SMOKE {...}，测试据此判断有没有真的越界。
  // 位置要跟导入方对得上：lib/browser、lib/desktop、lib/shared 里的 '../smoke-note.js' 落在 lib/ 下，
  // lib/computer.js 的 './smoke-note.js' 也落在 lib/ 下。以前把 note 放在临时根，六次 preflight 导入
  // 全部失败 → StaleBuild → 受控停在退出码 3，看起来像探针问题，其实是这棵树搭错了。
  put('lib/smoke-note.js', src([
    'export function note(who, what, extra) {',
    "  try { console.error('SMOKE ' + JSON.stringify(Object.assign({ who, what }, extra || {}))); } catch {}",
    '}',
  ]));
  put('lib/browser/cdp.js', src([
    "import { note } from '../smoke-note.js';",
    "const refuse = name => () => { note('cdp', name); throw new Error('cdp stub must not run: ' + name); };",
    "export const connectCdp = refuse('connectCdp');",
    "export const pageTargets = refuse('pageTargets');",
    "export const pageLayout = refuse('pageLayout');",
    "export const readWindowBounds = refuse('readWindowBounds');",
    "export const readTabViewport = refuse('readTabViewport');",
    "export const browserEndpoint = refuse('browserEndpoint');",
  ]));
  put('lib/browser/edge.js', src([
    "import { note } from '../smoke-note.js';",
    "export const browserCandidates = () => { note('edge', 'browserCandidates'); return ['C:/smoke/msedge.exe']; };",
    "export const findBrowser = () => { note('edge', 'findBrowser'); return null; };",
    "export const launchArgs = () => { note('edge', 'launchArgs'); throw new Error('launch must not run'); };",
    "export const launchBrowser = async () => { note('edge', 'launchBrowser'); throw new Error('launch must not run'); };",
  ]));
  put('lib/desktop/driver.js', src([
    "import { note } from '../smoke-note.js';",
    'export function createDesktopDriver(options) {',
    "  note('driver', 'create', { callMs: options && options.callMs, hasArbiter: Boolean(options && options.arbiter) });",
    '  return {',
    "    async call(op, args) { note('driver', 'call', { op }); return { ok: true, op, stubbed: true }; },",
    "    async stop() { note('driver', 'stop'); },",
    '  };',
    '}',
  ]));
  put('lib/desktop/arbiter.js', src([
    "import { note } from '../smoke-note.js';",
    'export function createArbiter() {',
    "  note('arbiter', 'create');",
    "  return { dispose() { note('arbiter', 'dispose'); } };",
    '}',
  ]));
  put('lib/shared/faults.js', src([
    "import { note } from '../smoke-note.js';",
    'export class Faults {',
    "  constructor() { note('faults', 'construct'); }",
    '}',
  ]));
  put('lib/computer.js', src([
    "import { note } from './smoke-note.js';",
    "export function readProfileAnswer() { note('computer', 'readProfileAnswer'); return null; }",
  ]));
  // 在入口之前就换掉全局 fetch：主体和 finally 都发不出一条网络请求。
  put('smoke-preload.mjs', src([
    "const log = row => { try { console.error('SMOKE ' + JSON.stringify(row)); } catch {} };",
    "globalThis.fetch = async url => { log({ who: 'fetch', what: 'attempt', url: String(url) }); throw new Error('smoke: network forbidden'); };",
  ]));

  const started = Date.now();
  const child = spawnSync(process.execPath, [
    '--import', pathToFileURL(path.join(root, 'smoke-preload.mjs')).href,
    path.join(root, 'scripts/browser-overlay-probe.mjs'),
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: Object.assign({}, process.env, { EVOLUTION_CU_BROKER_PIPE: 'overlay-smoke-' + path.basename(root) }),
  });
  const elapsed = Date.now() - started;

  assert.equal(child.error, undefined, '子进程必须自己退出，不能靠超时被杀: ' + String(child.error && child.error.message));
  assert.equal(child.signal, null);
  assert.ok(elapsed < 60_000, '受控停止必须很快，实测 ' + elapsed + 'ms');
  assert.doesNotMatch(child.stderr, /Cannot access 'ledger' before initialization/,
    '两本账不能互相遮蔽：TDZ 会让第一条 helper 投递就炸');
  // 先把这次受控停止的诊断装好：失败信息里直接带 stopReason / steps / 投递账，省得再回头猜。
  const artifactsRoot = path.join(root, 'artifacts');
  const runs = fs.existsSync(artifactsRoot)
    ? fs.readdirSync(artifactsRoot).filter(name => name.startsWith('browser-overlay-probe-'))
    : [];
  const runDir = runs.length === 1 ? path.join(artifactsRoot, runs[0]) : null;
  const reportFile = runDir ? path.join(runDir, 'report.json') : null;
  const report = reportFile && fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
  const dispatch = report && report.cleanup && report.cleanup.dispatch ? report.cleanup.dispatch : null;
  const diag = JSON.stringify({
    status: child.status,
    runs,
    stopReason: report ? report.stopReason : 'no-report',
    steps: report ? report.steps.map(one => one.name) : 'no-report',
    helperCalls: report ? report.helperCalls : 'no-report',
    launched: report ? report.launched : 'no-report',
    dispatch: dispatch ? {
      sent: dispatch.sent, settled: dispatch.settled, pending: dispatch.pending, lateAdopted: dispatch.lateAdopted,
      entries: dispatch.entries.map(one => ({ domain: one.domain, label: one.label, settled: one.settled, ok: one.ok, error: one.error })),
    } : 'no-report',
  });

  assert.equal(child.status, 2, '受控停止（没开过浏览器、cleanup 未确认）退出码必须是 2，不是 0/3/4；诊断: ' + diag);
  assert.equal(runs.length, 1, '一次运行只该有一个产物目录；诊断: ' + diag);
  assert.ok(report, '必须留下 report.json 才能核对收尾；诊断: ' + diag);

  assert.equal(report.stopReason && report.stopReason.code, 'browser-not-found', '没有真浏览器时只能停在 browser-not-found');
  assert.equal(report.helperCalls, 1, '只有 cursor 那一次 helper 调用，且它必须真的发出去');
  assert.equal(report.launched, null, '一条 launch 都不许发生');
  assert.equal(report.cleanup.launch, null);
  assert.deepEqual(report.steps.map(one => one.name), ['helper-alive']);
  assert.deepEqual(fs.readdirSync(path.join(artifactsRoot, runs[0])).filter(name => name.endsWith('.png')), [], '一张截图都不许产生');

  const entries = dispatch.entries;
  assert.equal(dispatch.sent, entries.length, '总账的条数要和明细对得上；诊断: ' + diag);
  assert.equal(dispatch.settled, entries.filter(one => one.settled === true).length, '结算数要和明细一致；诊断: ' + diag);
  assert.equal(dispatch.pending, 0, '退出时不许有悬着没结算的投递；诊断: ' + diag);
  assert.equal(dispatch.lateAdopted, 0);
  assert.equal(dispatch.terminated, false);

  // 主体阶段：真的只发过 helper:cursor 这一笔，而且它必须结算成功。
  const bodyEntries = entries.filter(one => one.domain === 'body');
  assert.deepEqual(bodyEntries.map(one => one.label), ['helper:cursor'], '主体阶段只允许 helper:cursor 一笔投递；诊断: ' + diag);
  assert.equal(bodyEntries.every(one => one.settled === true && one.ok === true), true, 'cursor 必须真的发出去并结算；诊断: ' + diag);

  // 清理阶段：现有只读收尾照样跑，但没开过浏览器，只可能有查询式投递（reverify 的 fetch /json/version，
  // 端口 0），而且全被 fetch 桩挡下 ⇒ 不许记成成功、更不许出现 launch / CDP / 第二笔 helper / 窗口写。
  const fetchEntries = entries.filter(one => one.label.startsWith('fetch:'));
  for (const one of entries.filter(one => one.domain !== 'body')) {
    assert.ok(fetchEntries.includes(one), '清理阶段只允许查询式投递，实际: ' + one.label + '；诊断: ' + diag);
    assert.equal(one.settled, true, '被桩挡下的投递也要结算；诊断: ' + diag);
    assert.notEqual(one.ok, true, '桩当场拒绝，不许记成成功；诊断: ' + diag);
    assert.match(String(one.error), /smoke: network forbidden/, '失败必须是被 fetch 桩挡下的那次，不是真实网络；诊断: ' + diag);
  }
  for (const bad of ['launch', 'browser:Browser.close', 'browser:SystemInfo.getProcessInfo']) {
    assert.equal(entries.some(one => one.label === bad), false, bad + ' 不许出现在这笔收尾里；诊断: ' + diag);
  }
  assert.equal(entries.some(one => one.label.startsWith('browser:')), false, '一条 CDP 命令都不许发出；诊断: ' + diag);
  assert.equal(entries.some(one => one.label.startsWith('helper:') && one.label !== 'helper:cursor'), false, '第二次 helper 调用不许发生；诊断: ' + diag);
  assert.equal(entries.some(one => one.label.startsWith('hygiene:')), false, '没要求 Overlay 卫生就不许有卫生投递；诊断: ' + diag);

  assert.equal(report.cleanup.windowWrites.sent, 0, '没有窗口就不许有 setWindowBounds');
  assert.equal(report.cleanup.windowWrites.pending, 0);
  assert.equal(report.cleanup.browserClosed, false, '没开过浏览器就不许写成已关闭');
  assert.equal(report.cleanup.ok, false, '清理没走完（close skipped）不许写成 ok');
  assert.equal(report.cleanup.close && report.cleanup.close.skipped, true);
  assert.equal(report.cleanup.stop && report.cleanup.stop.ok, true, 'driver.stop 必须真的被调用并结算');
  assert.ok(report.cleanup.reverify && report.cleanup.reverify.skipped === false, 'reverify 阶段必须真的跑过，不是跳过；诊断: ' + diag);
  assert.equal(report.cleanup.reverify.ok, false, '没开过浏览器，reverify 只能记成未确认（它唯一那笔查询被 fetch 桩挡住）；诊断: ' + diag);

  const marks = child.stderr.split('\n').filter(line => line.startsWith('SMOKE ')).map(line => JSON.parse(line.slice(6)));
  assert.deepEqual(marks.filter(row => row.who === 'driver' && row.what === 'call').map(row => row.op), ['cursor'],
    'helper 只许调用 cursor 一次');
  assert.equal(marks.filter(row => row.who === 'driver' && row.what === 'stop').length, 1, 'cleanup 必须停过一次 driver');
  assert.equal(marks.filter(row => row.who === 'arbiter' && row.what === 'dispose').length, 1);
  assert.equal(marks.filter(row => row.who === 'edge' && row.what === 'findBrowser').length, 1);
  const fetchMarks = marks.filter(row => row.who === 'fetch');
  assert.equal(fetchMarks.length, fetchEntries.length, '被挡下的每次查询都要在总账里各记一笔，反之亦然；诊断: ' + diag);
  for (const row of fetchMarks) assert.match(String(row.url), /^http:\/\/127\.0\.0\.1:0\//,
    '只有端口 0 这种“根本没起来”的地址才允许被尝试，绝不连真实端点；诊断: ' + diag);
  for (const name of ['launchBrowser', 'launchArgs', 'connectCdp', 'pageTargets', 'pageLayout', 'readWindowBounds', 'readTabViewport', 'browserEndpoint']) {
    assert.equal(marks.some(row => row.what === name), false, name + ' 不许被调用');
  }
  assert.equal(marks.some(row => row.who === 'computer'), false, '没到 profile 分支');
});
