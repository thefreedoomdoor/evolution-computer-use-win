/**
 * The pure parts of the geometry resolver, checked against the shapes the desktop helper and CDP really produce.
 *
 * Every number here is a fixture. These tests prove that a shape is accepted or refused exactly as documented; they do not
 * prove that a machine measures its own windows that way, and they are not a substitute for the isolated-desktop
 * acceptance run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AXIS_AGREEMENT,
  CONTENT_OP,
  CSS_AGREEMENT,
  MAX_PROFILE_PIDS,
  PHYSICAL_UNITS,
  PINCH_AGREEMENT,
  RENDER_WIDGET_CLASS,
  createGeometryResolver,
  measureScale,
  pickCandidate,
  readContentAnswer,
  rectWithin,
  toPhysical,
  viewportCss,
} from '../src/browser/geometry.ts';
import type {
  ContentAnswer,
  GeometryCandidate,
  ScreenGeometry,
  WitnessVerdict,
  WitnessViewport,
} from '../src/browser/geometry.ts';
import type { PageLayout } from '../src/browser/cdp.ts';

const HOST = 0x1a2b3c;
const RENDER = 0x556677;
const PID = 4242;
const OTHER_PID = 4343;
const LAYOUT: PageLayout = { cssWidth: 1280, cssHeight: 755.2, pageZoom: 1 };
// 外框必须完整包住客户区（rectWithin 右侧也留边框）：客户区右边界为 -1928+2000=72，
// 因此外框右边界至少要到 72，这里取 64px 右边框（与左侧 72px 边框同量级），窗口右边界为 136。
const WINDOW_RECT = { x: -2000, y: 0, width: 2136, height: 1350 };
const CLIENT_RECT = { x: -1928, y: 40, width: 2000, height: 1260 };
const CONTENT_RECT = { x: -1928, y: 120, width: 2000, height: 1180 };

function rawWindow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hwnd: HOST,
    pid: PID,
    className: 'Chrome_WidgetWin_1',
    title: 'about:blank',
    visible: true,
    minimized: false,
    cloaked: false,
    dpi: 120,
    windowRect: { ...WINDOW_RECT },
    frameRect: null,
    clientRect: { ...CLIENT_RECT },
    ...over,
  };
}

function rawRenderer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hwnd: RENDER,
    parent: HOST,
    className: RENDER_WIDGET_CLASS,
    pid: PID,
    visible: true,
    clientRect: { ...CONTENT_RECT },
    ...over,
  };
}

function without(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

function rawAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    units: PHYSICAL_UNITS,
    dpiAwareness: 2,
    windows: [rawWindow()],
    renderer: [rawRenderer()],
    rendererTruncated: false,
    ...over,
  };
}

function answerOf(over: Record<string, unknown> = {}): ContentAnswer {
  const parsed = readContentAnswer(rawAnswer(over));
  assert.ok(parsed, 'fixture must parse');
  return parsed;
}

/** A viewport with no classic scrollbar and no pinch: every reading names the same box. */
function viewportOf(over: Partial<WitnessViewport> = {}): WitnessViewport {
  return {
    innerWidthCss: LAYOUT.cssWidth,
    innerHeightCss: LAYOUT.cssHeight,
    rootClientWidthCss: LAYOUT.cssWidth,
    rootClientHeightCss: LAYOUT.cssHeight,
    cdpLayoutWidthCss: LAYOUT.cssWidth,
    cdpLayoutHeightCss: LAYOUT.cssHeight,
    cdpVisualScale: 1,
    cdpVisualWidthCss: LAYOUT.cssWidth,
    cdpVisualHeightCss: LAYOUT.cssHeight,
    cdpVisualOffsetX: 0,
    cdpVisualOffsetY: 0,
    ...over,
  };
}

function geometryOf(over: Partial<ScreenGeometry> = {}): ScreenGeometry {
  return {
    targetId: 'tab-1',
    originX: CONTENT_RECT.x,
    originY: CONTENT_RECT.y,
    width: CONTENT_RECT.width,
    height: CONTENT_RECT.height,
    scaleX: 1.5625,
    scaleY: 1.5625,
    cssWidth: LAYOUT.cssWidth,
    cssHeight: LAYOUT.cssHeight,
    dpiAwareness: 2,
    measuredAt: 1,
    source: 'render-widget+witness',
    evidence: ['fixture'],
    ...over,
  };
}

interface Scene {
  deps: {
    helper: (op: string, args: Record<string, unknown>) => Promise<unknown>;
    profilePids: () => number[];
    witness?: (targetId: string, candidate: GeometryCandidate) => Promise<WitnessVerdict>;
    now: () => number;
  };
  contentCalls: Array<{ op: string; args: Record<string, unknown> }>;
  witnessCalls: GeometryCandidate[];
}

function scene(options: {
  replies?: Record<number, unknown>;
  pids?: number[];
  witness?: (targetId: string, candidate: GeometryCandidate) => Promise<WitnessVerdict>;
  viewport?: Partial<WitnessViewport>;
} = {}): Scene {
  const contentCalls: Array<{ op: string; args: Record<string, unknown> }> = [];
  const witnessCalls: GeometryCandidate[] = [];
  const replies = options.replies ?? { [PID]: rawAnswer() };
  const pids = options.pids ?? [PID];
  let stamps = 0;
  return {
    contentCalls,
    witnessCalls,
    deps: {
      helper: async (op, args) => {
        contentCalls.push({ op, args });
        if (op !== CONTENT_OP) throw new Error('unexpected op ' + op);
        const pid = args.pid;
        if (typeof pid !== 'number' || !(pid in replies)) throw new Error('unexpected pid ' + String(pid));
        return replies[pid];
      },
      profilePids: () => pids,
      witness: async (targetId, candidate) => {
        witnessCalls.push(candidate);
        if (options.witness) return await options.witness(targetId, candidate);
        return { ok: true, viewport: viewportOf(options.viewport), evidence: ['隔离世界: 证据'] };
      },
      now: () => 1_000 + stamps++,
    },
  };
}

/** A classic scrollbar: the layout viewport is wider than the root client box. */
const SCROLLBAR_WIDTH_CSS = 15;

// ---------------------------------------------------------------- readContentAnswer

test('readContentAnswer 接受生产回包并保留负坐标', () => {
  const answer = readContentAnswer(rawAnswer());
  assert.ok(answer);
  assert.equal(answer.units, PHYSICAL_UNITS);
  assert.equal(answer.dpiAwareness, 2);
  assert.equal(answer.rendererTruncated, false);
  assert.equal(answer.windows.length, 1);
  assert.equal(answer.windows[0].hwnd, HOST);
  assert.deepEqual(answer.windows[0].clientRect, CLIENT_RECT);
  assert.equal(answer.renderer[0].parent, HOST);
  assert.equal(answer.renderer[0].className, RENDER_WIDGET_CLASS);
});

test('readContentAnswer 保留 units=null 由上层门禁拒绝，而不是在此猜测', () => {
  const answer = readContentAnswer(rawAnswer({ units: null }));
  assert.ok(answer);
  assert.equal(answer.units, null);
});

test('readContentAnswer 拒绝缺失或非布尔的 rendererTruncated', () => {
  const missing = rawAnswer();
  delete missing.rendererTruncated;
  assert.equal(readContentAnswer(missing), null);
  assert.equal(readContentAnswer(rawAnswer({ rendererTruncated: 'no' })), null);
});

test('readContentAnswer 拒绝非数组的 windows / renderer', () => {
  assert.equal(readContentAnswer(rawAnswer({ windows: {} })), null);
  assert.equal(readContentAnswer(rawAnswer({ renderer: null })), null);
});

test('readContentAnswer 拒绝畸形矩形与非正 hwnd', () => {
  assert.equal(readContentAnswer(rawAnswer({ windows: [rawWindow({ clientRect: { x: 0, y: 0, width: NaN, height: 10 } })] })), null);
  assert.equal(readContentAnswer(rawAnswer({ windows: [rawWindow({ windowRect: { x: 0, y: 0, width: 0, height: 10 } })] })), null);
  assert.equal(readContentAnswer(rawAnswer({ windows: [rawWindow({ hwnd: 0 })] })), null);
  assert.equal(readContentAnswer(rawAnswer({ windows: [rawWindow({ pid: 1.5 })] })), null);
  assert.equal(readContentAnswer(rawAnswer({ renderer: [rawRenderer({ parent: -1 })] })), null);
  assert.equal(readContentAnswer(rawAnswer({ renderer: [rawRenderer({ clientRect: null })] })), null);
});

test('readContentAnswer 拒绝未测量的窗口状态，不把缺失当 false', () => {
  // A window whose state was never measured must not become "visible, not minimized, not cloaked" by default: that is
  // precisely the reading that would let an unmeasured window pass as the one the tab lives in.
  assert.equal(readContentAnswer(rawAnswer({ windows: [without(rawWindow(), 'visible')] })), null);
  assert.equal(readContentAnswer(rawAnswer({ windows: [without(rawWindow(), 'minimized')] })), null);
  assert.equal(readContentAnswer(rawAnswer({ windows: [without(rawWindow(), 'cloaked')] })), null);
  assert.equal(readContentAnswer(rawAnswer({ windows: [rawWindow({ visible: 'true' })] })), null);
  assert.equal(readContentAnswer(rawAnswer({ windows: [rawWindow({ minimized: 0 })] })), null);
  assert.equal(readContentAnswer(rawAnswer({ windows: [rawWindow({ cloaked: null })] })), null);
});

test('readContentAnswer 拒绝未测量的 renderer 可见性', () => {
  assert.equal(readContentAnswer(rawAnswer({ renderer: [without(rawRenderer(), 'visible')] })), null);
  assert.equal(readContentAnswer(rawAnswer({ renderer: [rawRenderer({ visible: 'yes' })] })), null);
  assert.equal(readContentAnswer(rawAnswer({ renderer: [rawRenderer({ visible: 1 })] })), null);
});

test('readContentAnswer 拒绝非对象回包与坏 units 类型', () => {
  assert.equal(readContentAnswer(null), null);
  assert.equal(readContentAnswer('ok'), null);
  assert.equal(readContentAnswer([]), null);
  assert.equal(readContentAnswer(rawAnswer({ units: 7 })), null);
  assert.equal(readContentAnswer(rawAnswer({ dpiAwareness: 'per-monitor' })), null);
});

// ---------------------------------------------------------------- pickCandidate

test('pickCandidate 恰好一个合法窗口与一个可见 renderer 时选中它', () => {
  // 夹具合同：客户区落在窗口外框内，renderer 内容区落在客户区内（外框-客户区、客户区-内容区都是真实包含关系）。
  assert.ok(rectWithin(CLIENT_RECT, WINDOW_RECT));
  assert.ok(rectWithin(CONTENT_RECT, CLIENT_RECT));
  const picked = pickCandidate([answerOf()], [PID]);
  assert.ok(picked);
  assert.equal(picked.window.hwnd, HOST);
  assert.equal(picked.renderer.hwnd, RENDER);
  assert.equal(picked.dpiAwareness, 2);
});

test('pickCandidate 两个候选窗口即歧义', () => {
  const answer = answerOf({ windows: [rawWindow(), rawWindow({ hwnd: 0x2b3c4d })] });
  assert.equal(pickCandidate([answer], [PID]), null);
});

test('pickCandidate 忽略不属于该 profile 的窗口', () => {
  const answer = answerOf({ windows: [rawWindow(), rawWindow({ hwnd: 0x2b3c4d, pid: OTHER_PID })] });
  const picked = pickCandidate([answer], [PID]);
  assert.ok(picked);
  assert.equal(picked.window.hwnd, HOST);
  assert.equal(
    pickCandidate([answerOf({ windows: [rawWindow({ hwnd: 0x2b3c4d, pid: OTHER_PID })] })], [PID]),
    null,
  );
});

test('pickCandidate 拒绝不可见、最小化、被 cloaked 的窗口', () => {
  assert.equal(pickCandidate([answerOf({ windows: [rawWindow({ visible: false })] })], [PID]), null);
  assert.equal(pickCandidate([answerOf({ windows: [rawWindow({ minimized: true })] })], [PID]), null);
  assert.equal(pickCandidate([answerOf({ windows: [rawWindow({ cloaked: true })] })], [PID]), null);
});

test('pickCandidate 拒绝客户区不在外框内的窗口', () => {
  const answer = answerOf({ windows: [rawWindow({ clientRect: { x: -3000, y: 40, width: 2000, height: 1260 } })] });
  assert.equal(pickCandidate([answer], [PID]), null);
});

test('pickCandidate 拒绝没有 renderer、或没有可见匹配 renderer 的窗口', () => {
  assert.equal(pickCandidate([answerOf({ renderer: [] })], [PID]), null);
  assert.equal(pickCandidate([answerOf({ renderer: [rawRenderer({ visible: false })] })], [PID]), null);
  assert.equal(pickCandidate([answerOf({ renderer: [rawRenderer({ className: 'Chrome_WidgetWin_0' })] })], [PID]), null);
  assert.equal(pickCandidate([answerOf({ renderer: [rawRenderer({ parent: 0x2b3c4d })] })], [PID]), null);
});

test('pickCandidate 拒绝内容区超出窗口客户区的 renderer', () => {
  const answer = answerOf({ renderer: [rawRenderer({ clientRect: { x: -1928, y: 40, width: 2000, height: 1300 } })] });
  assert.equal(pickCandidate([answer], [PID]), null);
});

test('pickCandidate 拒绝两个可见内容区', () => {
  const answer = answerOf({ renderer: [rawRenderer(), rawRenderer({ hwnd: 0x667788 })] });
  assert.equal(pickCandidate([answer], [PID]), null);
});

test('pickCandidate 跨回包按 hwnd 去重，同一窗口只算一次', () => {
  const answer = answerOf();
  const picked = pickCandidate([answer, answer], [PID]);
  assert.ok(picked);
  assert.equal(picked.window.hwnd, HOST);
});

test('pickCandidate 允许不可见候选与可见候选并存', () => {
  const answer = answerOf({ renderer: [rawRenderer(), rawRenderer({ hwnd: 0x667788, visible: false, className: 'Intermediate D3D Window' })] });
  const picked = pickCandidate([answer], [PID]);
  assert.ok(picked);
  assert.equal(picked.renderer.hwnd, RENDER);
});

test('rectWithin 允许 1 像素舍入但不允许真正越界', () => {
  assert.equal(rectWithin({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 }), true);
  assert.equal(rectWithin({ x: -1, y: 0, width: 11, height: 10 }, { x: 0, y: 0, width: 10, height: 10 }), true);
  assert.equal(rectWithin({ x: -2, y: 0, width: 12, height: 10 }, { x: 0, y: 0, width: 10, height: 10 }), false);
});

// ---------------------------------------------------------------- viewportCss

test('viewportCss 无滚条时两侧读到同一个盒子（等价分支）', () => {
  assert.deepEqual(viewportCss(viewportOf()), { width: LAYOUT.cssWidth, height: LAYOUT.cssHeight });
});

test('viewportCss 经典竖滚条页：CDP 报完整 viewport 时直接用它作分母', () => {
  const viewport = viewportOf({
    rootClientWidthCss: LAYOUT.cssWidth - SCROLLBAR_WIDTH_CSS,
    cdpLayoutWidthCss: LAYOUT.cssWidth,
  });
  assert.deepEqual(viewportCss(viewport), { width: LAYOUT.cssWidth, height: LAYOUT.cssHeight });
});

test('viewportCss 经典竖滚条页：CDP 报排滚条 client 时分母仍是完整 viewport', () => {
  const viewport = viewportOf({
    rootClientWidthCss: LAYOUT.cssWidth - SCROLLBAR_WIDTH_CSS,
    cdpLayoutWidthCss: LAYOUT.cssWidth - SCROLLBAR_WIDTH_CSS,
    cdpVisualWidthCss: LAYOUT.cssWidth - SCROLLBAR_WIDTH_CSS,
  });
  assert.deepEqual(viewportCss(viewport), { width: LAYOUT.cssWidth, height: LAYOUT.cssHeight });
});

test('viewportCss 经典横滚条页独立决定另一轴', () => {
  const viewport = viewportOf({
    rootClientHeightCss: LAYOUT.cssHeight - SCROLLBAR_WIDTH_CSS,
    cdpLayoutHeightCss: LAYOUT.cssHeight,
  });
  assert.deepEqual(viewportCss(viewport), { width: LAYOUT.cssWidth, height: LAYOUT.cssHeight });
});

test('viewportCss CDP 值与两侧都对不上时视为矛盾，不拿经验宽度补差', () => {
  const viewport = viewportOf({
    rootClientWidthCss: LAYOUT.cssWidth - SCROLLBAR_WIDTH_CSS,
    cdpLayoutWidthCss: LAYOUT.cssWidth - 8,
  });
  assert.equal(viewportCss(viewport), null);
});

test('viewportCss 允许 1 CSS px 舍入，超过则视为矛盾', () => {
  assert.deepEqual(viewportCss(viewportOf({ cdpLayoutWidthCss: LAYOUT.cssWidth + CSS_AGREEMENT })), {
    width: LAYOUT.cssWidth,
    height: LAYOUT.cssHeight,
  });
  assert.equal(viewportCss(viewportOf({ cdpLayoutWidthCss: LAYOUT.cssWidth + CSS_AGREEMENT + 0.5 })), null);
});

test('viewportCss 拒绝 root 比 inner 更宽、零值与非有限数', () => {
  assert.equal(viewportCss(viewportOf({ rootClientWidthCss: LAYOUT.cssWidth + 20 })), null);
  assert.equal(viewportCss(viewportOf({ innerWidthCss: 0 })), null);
  assert.equal(viewportCss(viewportOf({ rootClientHeightCss: -1 })), null);
  assert.equal(viewportCss(viewportOf({ cdpLayoutWidthCss: NaN })), null);
  assert.equal(viewportCss(viewportOf({ cdpLayoutHeightCss: Infinity })), null);
});

test('viewportCss 捏合缩放时 fail closed，不输出未经证明的物理点', () => {
  assert.equal(viewportCss(viewportOf({ cdpVisualScale: 1.5 })), null);
  assert.equal(viewportCss(viewportOf({ cdpVisualScale: 0.5 })), null);
  assert.equal(viewportCss(viewportOf({ cdpVisualScale: NaN })), null);
  assert.deepEqual(viewportCss(viewportOf({ cdpVisualScale: 1 + PINCH_AGREEMENT })), {
    width: LAYOUT.cssWidth,
    height: LAYOUT.cssHeight,
  });
});

test('viewportCss 视觉视口被平移（pan）时 fail closed', () => {
  assert.equal(viewportCss(viewportOf({ cdpVisualOffsetX: 12 })), null);
  assert.equal(viewportCss(viewportOf({ cdpVisualOffsetY: -3 })), null);
  assert.equal(viewportCss(viewportOf({ cdpVisualOffsetX: CSS_AGREEMENT + 0.5 })), null);
  assert.deepEqual(viewportCss(viewportOf({ cdpVisualOffsetX: CSS_AGREEMENT })), {
    width: LAYOUT.cssWidth,
    height: LAYOUT.cssHeight,
  });
});

test('viewportCss 视觉视口尺寸必须与某一侧实测一致，否则视为矛盾', () => {
  assert.equal(viewportCss(viewportOf({ cdpVisualWidthCss: 900 })), null);
  const scrollbar = viewportOf({
    rootClientWidthCss: LAYOUT.cssWidth - SCROLLBAR_WIDTH_CSS,
    cdpVisualWidthCss: LAYOUT.cssWidth - SCROLLBAR_WIDTH_CSS,
  });
  assert.deepEqual(viewportCss(scrollbar), { width: LAYOUT.cssWidth, height: LAYOUT.cssHeight });
});

// ---------------------------------------------------------------- measureScale

test('measureScale 两轴一致时返回实测比例', () => {
  const scale = measureScale(CONTENT_RECT, { width: LAYOUT.cssWidth, height: LAYOUT.cssHeight });
  assert.ok(scale);
  assert.equal(scale.scaleX, 1.5625);
  assert.equal(scale.scaleY, 1.5625);
});

test('measureScale 两轴不一致时返回 null，不做经验补差', () => {
  const shortClient = { width: LAYOUT.cssWidth - SCROLLBAR_WIDTH_CSS, height: LAYOUT.cssHeight };
  assert.equal(measureScale(CONTENT_RECT, shortClient), null);
});

test('measureScale 允许 1 像素舍入造成的微小差异', () => {
  const scale = measureScale(CONTENT_RECT, { width: LAYOUT.cssWidth, height: LAYOUT.cssHeight + 0.1 });
  assert.ok(scale);
  assert.ok(Math.abs(scale.scaleX - scale.scaleY) / Math.min(scale.scaleX, scale.scaleY) < AXIS_AGREEMENT);
});

test('measureScale 拒绝零尺寸、零布局与非有限数', () => {
  assert.equal(measureScale({ ...CONTENT_RECT, width: 0 }, { width: LAYOUT.cssWidth, height: LAYOUT.cssHeight }), null);
  assert.equal(measureScale(CONTENT_RECT, { width: 0, height: LAYOUT.cssHeight }), null);
  assert.equal(measureScale(CONTENT_RECT, { width: LAYOUT.cssWidth, height: NaN }), null);
  assert.equal(measureScale({ ...CONTENT_RECT, height: Infinity }, { width: LAYOUT.cssWidth, height: LAYOUT.cssHeight }), null);
});

// ---------------------------------------------------------------- toPhysical

test('toPhysical 负原点照发并取整', () => {
  const geometry = geometryOf();
  assert.deepEqual(toPhysical(geometry, { x: 640, y: 400 }), { x: -928, y: 745 });
  assert.deepEqual(toPhysical(geometry, { x: 0, y: 0 }), { x: -1928, y: 120 });
});

test('toPhysical 接受内容区边界点，包括滚条所在的那一列', () => {
  const geometry = geometryOf();
  assert.deepEqual(toPhysical(geometry, { x: LAYOUT.cssWidth, y: LAYOUT.cssHeight }), { x: 72, y: 1300 });
});

test('toPhysical 拒绝区域外与非有限点，绝不夹取', () => {
  const geometry = geometryOf();
  assert.equal(toPhysical(geometry, { x: -0.5, y: 0 }), null);
  assert.equal(toPhysical(geometry, { x: 0, y: LAYOUT.cssHeight + 0.5 }), null);
  assert.equal(toPhysical(geometry, { x: NaN, y: 0 }), null);
  assert.equal(toPhysical(geometry, { x: 0, y: Infinity }), null);
});

test('toPhysical 在比例为 0 或非有限时不会造出一个点', () => {
  assert.equal(toPhysical(geometryOf({ scaleX: 0, scaleY: 0 }), { x: 1, y: 1 }), null);
  assert.equal(toPhysical(geometryOf({ scaleX: 0, scaleY: 1.5625 }), { x: 1, y: 1 }), null);
  assert.equal(toPhysical(geometryOf({ scaleX: NaN, scaleY: 1.5625 }), { x: 1, y: 1 }), null);
});

// ---------------------------------------------------------------- resolver: success

test('resolver 成功路径：逐 pid 查一次、只读 content、witness 收到候选', async () => {
  const s = scene();
  const resolver = createGeometryResolver(s.deps);
  const geometry = await resolver.measure('tab-1', async () => LAYOUT);
  assert.ok(geometry);
  assert.equal(s.contentCalls.length, 1);
  assert.equal(s.contentCalls[0].op, CONTENT_OP);
  assert.deepEqual(Object.keys(s.contentCalls[0].args), ['pid']);
  assert.equal(s.contentCalls[0].args.pid, PID);
  assert.equal(s.witnessCalls.length, 1);
  assert.equal(s.witnessCalls[0].targetId, 'tab-1');
  assert.equal(s.witnessCalls[0].hwnd, HOST);
  assert.equal(s.witnessCalls[0].layout.cssWidth, LAYOUT.cssWidth);
  assert.deepEqual(s.witnessCalls[0].content, CONTENT_RECT);
  assert.equal(geometry.originX, -1928);
  assert.equal(geometry.originY, 120);
  assert.equal(geometry.width, 2000);
  assert.equal(geometry.height, 1180);
  assert.equal(geometry.scaleX, 1.5625);
  assert.equal(geometry.cssWidth, LAYOUT.cssWidth);
  assert.equal(geometry.source, 'render-widget+witness');
  assert.ok(geometry.evidence.length >= 5);
  assert.ok(geometry.evidence.some(line => line.includes(PHYSICAL_UNITS)));
  assert.ok(geometry.evidence.some(line => line.includes('CSS viewport')));
});

test('resolver 每次输入重新测量，不跨调用缓存', async () => {
  const s = scene();
  const resolver = createGeometryResolver(s.deps);
  const first = await resolver.measure('tab-1', async () => LAYOUT);
  const second = await resolver.measure('tab-1', async () => LAYOUT);
  assert.ok(first && second);
  assert.equal(s.contentCalls.length, 2);
  assert.ok(second.measuredAt > first.measuredAt);
});

test('resolver 经典竖滚条页不再被误拒：分母取完整 viewport', async () => {
  const s = scene({
    viewport: {
      rootClientWidthCss: LAYOUT.cssWidth - SCROLLBAR_WIDTH_CSS,
      cdpLayoutWidthCss: LAYOUT.cssWidth,
    },
  });
  const geometry = await createGeometryResolver(s.deps).measure('tab-1', async () => LAYOUT);
  assert.ok(geometry);
  assert.equal(geometry.cssWidth, LAYOUT.cssWidth);
  assert.equal(geometry.scaleX, geometry.scaleY);
  assert.deepEqual(toPhysical(geometry, { x: LAYOUT.cssWidth, y: 0 }), { x: 72, y: 120 });
});

test('resolver 在 CDP 只报排滚条 client 时仍用隔离世界的完整 viewport', async () => {
  // 这一页里 CDP 侧的三处读数（layout metrics / layout viewport / visual viewport）都只有排掉经典滚条的
  // client 宽度；隔离世界的 innerWidth 仍是完整 1280。module 自己的 PageLayout 来自同一路 CDP metrics，
  // 因此也必须报 1265（生产契约要求 witness 的 cdpLayoutWidthCss 与 layout().cssWidth 一致，不容忍 15px 差）。
  const cdpLayout: PageLayout = { ...LAYOUT, cssWidth: LAYOUT.cssWidth - SCROLLBAR_WIDTH_CSS };
  const s = scene({
    viewport: {
      rootClientWidthCss: LAYOUT.cssWidth - SCROLLBAR_WIDTH_CSS,
      cdpLayoutWidthCss: LAYOUT.cssWidth - SCROLLBAR_WIDTH_CSS,
      cdpVisualWidthCss: LAYOUT.cssWidth - SCROLLBAR_WIDTH_CSS,
    },
  });
  const geometry = await createGeometryResolver(s.deps).measure('tab-1', async () => cdpLayout);
  assert.ok(geometry);
  // 除数取隔离世界的完整 viewport（1280），不是排掉滚条的 1265。
  assert.equal(geometry.cssWidth, LAYOUT.cssWidth);
  assert.equal(geometry.scaleX, 1.5625);
  assert.equal(geometry.height, CONTENT_RECT.height);
  assert.deepEqual(toPhysical(geometry, { x: LAYOUT.cssWidth, y: 0 }), { x: 72, y: 120 });
});

// ---------------------------------------------------------------- resolver: fail closed

test('resolver 在 units 为 null 时拒绝，witness 不会被咨询', async () => {
  const s = scene({ replies: { [PID]: rawAnswer({ units: null }) } });
  const resolver = createGeometryResolver(s.deps);
  assert.equal(await resolver.measure('tab-1', async () => LAYOUT), null);
  assert.equal(s.witnessCalls.length, 0);
});

test('resolver 在窗口状态未测量时拒绝，witness 不会被咨询', async () => {
  const s = scene({ replies: { [PID]: rawAnswer({ windows: [without(rawWindow(), 'minimized')] }) } });
  const resolver = createGeometryResolver(s.deps);
  assert.equal(await resolver.measure('tab-1', async () => LAYOUT), null);
  assert.equal(s.witnessCalls.length, 0);
});

test('resolver 在 renderer 可见性未测量时拒绝', async () => {
  const s = scene({ replies: { [PID]: rawAnswer({ renderer: [without(rawRenderer(), 'visible')] }) } });
  assert.equal(await createGeometryResolver(s.deps).measure('tab-1', async () => LAYOUT), null);
  assert.equal(s.witnessCalls.length, 0);
});

test('resolver 在窗口最小化或 renderer 不可见时不产出几何', async () => {
  const minimized = scene({ replies: { [PID]: rawAnswer({ windows: [rawWindow({ minimized: true })] }) } });
  assert.equal(await createGeometryResolver(minimized.deps).measure('tab-1', async () => LAYOUT), null);
  assert.equal(minimized.witnessCalls.length, 0);
  const hidden = scene({ replies: { [PID]: rawAnswer({ renderer: [rawRenderer({ visible: false })] }) } });
  assert.equal(await createGeometryResolver(hidden.deps).measure('tab-1', async () => LAYOUT), null);
  assert.equal(hidden.witnessCalls.length, 0);
});

test('resolver 在 rendererTruncated 为真时拒绝', async () => {
  const s = scene({ replies: { [PID]: rawAnswer({ rendererTruncated: true }) } });
  const resolver = createGeometryResolver(s.deps);
  assert.equal(await resolver.measure('tab-1', async () => LAYOUT), null);
});

test('resolver 在 profilePids 为空或过多时不查询 helper', async () => {
  const empty = scene({ pids: [] });
  assert.equal(await createGeometryResolver(empty.deps).measure('tab-1', async () => LAYOUT), null);
  assert.equal(empty.contentCalls.length, 0);
  const many = scene({ pids: Array.from({ length: MAX_PROFILE_PIDS + 1 }, (_, index) => 5000 + index) });
  assert.equal(await createGeometryResolver(many.deps).measure('tab-1', async () => LAYOUT), null);
  assert.equal(many.contentCalls.length, 0);
});

test('resolver 对重复 pid 只查一次', async () => {
  const s = scene({ pids: [PID, PID, PID] });
  const geometry = await createGeometryResolver(s.deps).measure('tab-1', async () => LAYOUT);
  assert.ok(geometry);
  assert.equal(s.contentCalls.length, 1);
});

test('resolver 在多个进程中各有一个窗口时视为歧义', async () => {
  const s = scene({
    pids: [PID, OTHER_PID],
    replies: {
      [PID]: rawAnswer(),
      [OTHER_PID]: rawAnswer({ windows: [rawWindow({ hwnd: 0x2b3c4d, pid: OTHER_PID })] }),
    },
  });
  assert.equal(await createGeometryResolver(s.deps).measure('tab-1', async () => LAYOUT), null);
});

test('resolver 在 helper 抛错或回包畸形时返回 null', async () => {
  const throwing = scene({ replies: {} });
  assert.equal(await createGeometryResolver(throwing.deps).measure('tab-1', async () => LAYOUT), null);
  const broken = scene({ replies: { [PID]: { units: PHYSICAL_UNITS } } });
  assert.equal(await createGeometryResolver(broken.deps).measure('tab-1', async () => LAYOUT), null);
});

test('resolver 在布局读不到、为零或抛错时返回 null 且不查 helper', async () => {
  const none = scene();
  assert.equal(await createGeometryResolver(none.deps).measure('tab-1', async () => null), null);
  assert.equal(none.contentCalls.length, 0);
  const zero = scene();
  assert.equal(await createGeometryResolver(zero.deps).measure('tab-1', async () => ({ ...LAYOUT, cssWidth: 0 })), null);
  const throwing = scene();
  assert.equal(
    await createGeometryResolver(throwing.deps).measure('tab-1', async () => { throw new Error('cdp closed'); }),
    null,
  );
});

test('resolver 在两轴不一致时返回 null（不猜滚条）', async () => {
  const s = scene({ replies: { [PID]: rawAnswer({ renderer: [rawRenderer({ clientRect: { x: -1928, y: 120, width: 1985, height: 1180 } })] }) } });
  assert.equal(await createGeometryResolver(s.deps).measure('tab-1', async () => LAYOUT), null);
  assert.equal(s.witnessCalls.length, 1, 'the witness runs before the ratio is computed');
});

test('resolver 没有 witness 时拒绝输出几何', async () => {
  const s = scene();
  const deps = { ...s.deps };
  delete deps.witness;
  assert.equal(await createGeometryResolver(deps).measure('tab-1', async () => LAYOUT), null);
});

test('resolver 在 witness 说否时拒绝，理由不外泄为坐标', async () => {
  const no = scene({ witness: async () => ({ ok: false, reason: '后台 tab' }) });
  assert.equal(await createGeometryResolver(no.deps).measure('tab-1', async () => LAYOUT), null);
});

test('resolver 在 witness 抛错时拒绝', async () => {
  const broken = scene({ witness: async () => { throw new Error('isolated world closed'); } });
  assert.equal(await createGeometryResolver(broken.deps).measure('tab-1', async () => LAYOUT), null);
});

test('resolver 在 witness 说 yes 却不给测量时拒绝', async () => {
  const s = scene({ witness: async () => ({ ok: true } as unknown as WitnessVerdict) });
  assert.equal(await createGeometryResolver(s.deps).measure('tab-1', async () => LAYOUT), null);
});

test('resolver 在 witness 的测量与自己的 CDP 读数不一致时拒绝', async () => {
  const s = scene({ viewport: { cdpLayoutWidthCss: LAYOUT.cssWidth - 6 } });
  assert.equal(await createGeometryResolver(s.deps).measure('tab-1', async () => LAYOUT), null);
});

test('resolver 在 pinch 缩放时拒绝，不输出未经证明的物理点', async () => {
  const s = scene({
    viewport: {
      cdpVisualScale: 1.25,
      cdpVisualWidthCss: LAYOUT.cssWidth * 1.25,
      cdpVisualHeightCss: LAYOUT.cssHeight * 1.25,
    },
  });
  assert.equal(await createGeometryResolver(s.deps).measure('tab-1', async () => LAYOUT), null);
});

test('resolver 对空 targetId 直接拒绝', async () => {
  const s = scene();
  assert.equal(await createGeometryResolver(s.deps).measure('', async () => LAYOUT), null);
  assert.equal(s.contentCalls.length, 0);
});

test('resolver 的 evidence 带上 witness 自己给出的证据', async () => {
  const s = scene({ witness: async () => ({
    ok: true,
    viewport: viewportOf(),
    evidence: ['隔离世界: root clientWidth 1265 / layout 1280'],
  }) });
  const geometry = await createGeometryResolver(s.deps).measure('tab-1', async () => LAYOUT);
  assert.ok(geometry);
  assert.ok(geometry.evidence.some(line => line.includes('隔离世界')));
});

// ---------------------------------------------------------------- provider seam

test('provider 用同一份几何放置一笔动作里的两个点', async () => {
  const s = scene();
  const resolver = createGeometryResolver(s.deps);
  const place = await resolver('tab-1', async () => LAYOUT);
  assert.ok(place);
  assert.deepEqual(place({ x: 0, y: 0 }), { x: -1928, y: 120 });
  assert.deepEqual(place({ x: 640, y: 400 }), { x: -928, y: 745 });
  assert.equal(s.contentCalls.length, 1, 'one measurement per action, not one per point');
});

test('provider 在测量失败时返回 null，不返回坐标函数', async () => {
  const s = scene({ replies: { [PID]: rawAnswer({ units: null }) } });
  const resolver = createGeometryResolver(s.deps);
  assert.equal(await resolver('tab-1', async () => LAYOUT), null);
});

test('provider 对区域外点返回 null，动作因此不带坐标', async () => {
  const s = scene();
  const resolver = createGeometryResolver(s.deps);
  const place = await resolver('tab-1', async () => LAYOUT);
  assert.ok(place);
  assert.equal(place({ x: LAYOUT.cssWidth + 1, y: 0 }), null);
});
