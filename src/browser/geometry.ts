/**
 * Where one page's own CSS pixels sit on the physical screen.
 *
 * The page is never asked where it is: a page can replace its own \`innerWidth\`, \`screenX\` or \`getBoundingClientRect\`, so
 * nothing it says about the screen can prove a screen position. The proof has to come from outside the page:
 *
 *   1. the operating system names the browser window that the browser process of this exact profile owns (the \`content\`
 *      helper reads that in the same pixel space the real input uses, and it states whether those pixels are physical);
 *   2. the tab's own layout size is read over CDP, because the page can lie about it (:85-100 of ./cdp.ts);
 *   3. the tab is tied to that one window by a caller-supplied witness (task-63), because a window id, a window title and a
 *      render-widget class name are candidates, never proof;
 *   4. the witness (task-63) proves, inside the tab's own isolated world, that this target is the visible document of that
 *      window, and it measures the CSS pixel box that CDP input addresses at that same instant;
 *   5. the scale is measured - the content area's physical size over that whole CSS viewport, per axis - and the two axes
 *      must agree, because one measured ratio is the only thing this module multiplies with.
 *
 * The witness comes before the scale, and it has to hand back its measurement, because the numbers decide what the ratio
 * even means. A classic scrollbar occupies physical width inside the content area, and whether CDP's layout viewport is
 * reported with or without that scrollbar is a property of this machine's browser build rather than something this module
 * may assume. From the witness's two readings - window.innerWidth/innerHeight, which include a classic scrollbar, and
 * documentElement.clientWidth/clientHeight, which exclude it - plus the CDP value read over the same connection that will
 * send the input, the ratio gets a denominator that is known to be the whole viewport. The scrollbar's width is never
 * subtracted anywhere: it only ever exists as a difference between two real measurements of one tab.
 *
 * Any step that cannot be proven returns null: no position at all, which the input chain then reports as a window-space
 * action with no point and no path, and the audit keeps only "the page was operated". A guessed point would move a real
 * pointer to a place the agent never proved, so there is no fallback here, no cache across inputs and no tolerance for a
 * ratio that does not agree with itself.
 *
 * Nothing here activates a window, switches a tab or takes focus: visibility is only ever read.
 */
import type { PageLayout } from './cdp.ts';
import type { PageGeometryProvider, PageLayoutReader, PagePoint } from './page.ts';
import type { PhysicalPoint } from '../tool.ts';

/** The read-only helper operation that reports window and render-widget rectangles (src/desktop/win32.ps1). */
export const CONTENT_OP = 'content';
/** The only class name Chrome and Edge use for a web content surface; still only a candidate, filtered by structure below. */
export const RENDER_WIDGET_CLASS = 'Chrome_RenderWidgetHostHWND';
/** The only unit statement that lets these rectangles be treated as physical screen pixels. */
export const PHYSICAL_UNITS = 'physical-screen-pixels';
/** More browser processes than this and the candidate set is no longer known to be complete, so nothing is picked. */
export const MAX_PROFILE_PIDS = 8;
/**
 * How far the two measured axes may disagree, relative to the smaller one. One physical pixel of rounding on a 2000 px
 * content width is 0.05%, so this is loose enough for integer rectangles and far too tight for a scrollbar (a 15 px
 * scrollbar on a 1280 px page shows up as ~1.2%). This is a consistency check between two measurements of one tab; it is
 * never an argument about identity, because two surfaces of the same size are not for that reason the same surface.
 */
export const AXIS_AGREEMENT = 0.002;
/** Two readings of one CSS box, taken at the same instant, may differ by this much: one CSS pixel and no more. */
export const CSS_AGREEMENT = 1;
/**
 * How close the visual viewport's pinch scale has to be to 1 for the layout viewport to be the box the input addresses.
 * Pinch gestures transform the visual viewport inside the layout viewport, and how CDP input coordinates behave under that
 * transform is not established on this machine, so any pinch at all means no position instead of a guessed one.
 */
export const PINCH_AGREEMENT = 0.001;
/** Rectangles are integers taken from two Win32 calls, so containment is checked with this much slack. */
export const RECT_SLACK = 1;

/** A rectangle in physical screen pixels. Negative coordinates are ordinary: a monitor left of the primary one. */
export interface PhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One top-level window as the \`content\` helper reports it. */
export interface ContentWindow {
  hwnd: number;
  pid: number;
  className: string;
  title: string;
  /** Measured by the helper. An omitted or non-boolean flag makes the whole reply unusable; it is never defaulted. */
  visible: boolean;
  minimized: boolean;
  cloaked: boolean;
  dpi: number | null;
  /** The window rectangle including its border. */
  windowRect: PhysicalRect;
  /** The DWM-visible frame, when the system reports one. */
  frameRect: PhysicalRect | null;
  /** The client area: the same pixel space the real input uses. */
  clientRect: PhysicalRect;
}

/** One descendant window that might be a web content surface. */
export interface ContentRenderer {
  hwnd: number;
  parent: number;
  className: string;
  pid: number;
  /** Measured, for the same reason as ContentWindow.visible. */
  visible: boolean;
  clientRect: PhysicalRect;
}

/** The \`content\` helper reply, after strict parsing. */
export interface ContentAnswer {
  units: string | null;
  dpiAwareness: number | null;
  windows: ContentWindow[];
  renderer: ContentRenderer[];
  rendererTruncated: boolean;
}

/** The single window and the single content surface this measurement picked. */
export interface GeometryCandidate {
  targetId: string;
  hwnd: number;
  pid: number;
  layout: PageLayout;
  /** The content area in physical screen pixels. */
  content: PhysicalRect;
  /** The window's client area in physical screen pixels. */
  window: PhysicalRect;
}

/**
 * The CSS pixel box the input addresses, measured inside the tab itself, together with the independent readings that let
 * the CDP connection's own metrics be cross-checked against it and its visual viewport be shown to be the same box.
 *
 * The inner readings are the whole layout viewport and are what every ratio divides by. The root readings are that same
 * viewport with a classic scrollbar excluded. The CDP layout readings come from the connection that will send the input.
 * All of them are measured at the same instant from the same document, so a scrollbar's width is only ever the difference
 * between two real readings, never a computed constant.
 *
 * Which box CDP reports is not classified into "includes" or "excludes" a scrollbar: each axis requires it to equal one of
 * the two real readings, and the divisor stays the whole viewport either way. When no classic scrollbar takes space the two
 * readings are one box, so both matching is an equivalence rather than an ambiguity.
 */
export interface WitnessViewport {
  /** window.innerWidth, read in a world the document cannot instrument: the whole layout viewport, the width divisor. */
  innerWidthCss: number;
  /** window.innerHeight: the height divisor. */
  innerHeightCss: number;
  /** documentElement.clientWidth: the same viewport with a classic scrollbar excluded. Cross-check only. */
  rootClientWidthCss: number;
  /** documentElement.clientHeight. Cross-check only. */
  rootClientHeightCss: number;
  /** Page.getLayoutMetrics cssLayoutViewport.clientWidth, over the connection that will send the input. */
  cdpLayoutWidthCss: number;
  /** Page.getLayoutMetrics cssLayoutViewport.clientHeight, over the same connection. */
  cdpLayoutHeightCss: number;
  /** Page.getLayoutMetrics cssVisualViewport.scale: 1 unless the tab is pinch-zoomed. */
  cdpVisualScale: number;
  /** cssVisualViewport.clientWidth, in CSS pixels. */
  cdpVisualWidthCss: number;
  /** cssVisualViewport.clientHeight. */
  cdpVisualHeightCss: number;
  /**
   * Page.getLayoutMetrics cssVisualViewport.offsetX: the visual viewport's offset within the layout viewport, which is what
   * a pinch gesture's pan changes. It is not cssVisualViewport.pageX, which is measured from the document origin and moves
   * with ordinary scrolling; a page scrolled with no pinch at all therefore reports 0 here.
   */
  cdpVisualOffsetX: number;
  /** cssVisualViewport.offsetY, measured from the layout viewport origin for the same reason. */
  cdpVisualOffsetY: number;
}

/**
 * Proof that the tab really is the visible document of that window, and that its CSS viewport is the box the input chain
 * addresses.
 *
 * Task-63 owns this: it is the only component that can read the target's own document state, and it may only read it. It
 * must never activate the window, switch the tab or take focus. A yes has to carry the viewport measurement, because a yes
 * with no numbers leaves the ratio undefined; the witness is handed the layout this module read so it can state whether
 * its own reading of the same connection agrees, instead of trusting a second, unrelated value.
 */
export type GeometryWitness = (targetId: string, candidate: GeometryCandidate) => Promise<WitnessVerdict>;

export type WitnessVerdict =
  | { ok: true; viewport: WitnessViewport; evidence?: string[] }
  | { ok: false; reason?: string };

/** What one measurement proved. Everything in it was read for this input; nothing is carried over to the next one. */
export interface ScreenGeometry {
  targetId: string;
  /** Physical screen position of the content area's top-left corner. */
  originX: number;
  originY: number;
  /** Physical size of the content area. */
  width: number;
  height: number;
  /** Measured physical pixels per CSS pixel, per axis. They agree by construction; they are kept apart, not averaged. */
  scaleX: number;
  scaleY: number;
  /** The whole CSS viewport the input chain addresses, per axis: the denominator the scales were measured against. */
  cssWidth: number;
  cssHeight: number;
  /** Audit only: the DPI awareness of the helper thread that reported the rectangles. */
  dpiAwareness: number | null;
  measuredAt: number;
  source: 'render-widget+witness';
  evidence: string[];
}

export type GeometryResolver = PageGeometryProvider & {
  measure(targetId: string, layout: PageLayoutReader): Promise<ScreenGeometry | null>;
};

/** Everything this module needs is injected; it never starts a process, never opens CDP and never reads the desktop. */
export interface GeometryDeps {
  /** The \`content\` operation of the desktop helper: \`helper('content', { pid })\`. */
  helper: (op: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Pids of the browser processes that belong to this exact excluded profile, as resolved by the caller. */
  profilePids: () => Promise<number[]> | number[];
  /** Task-63's proof that the target is the visible document of the candidate window. */
  witness?: GeometryWitness;
  now?: () => number;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A usable rectangle: all four numbers present and finite, and a positive size. */
export function isRect(value: unknown): value is PhysicalRect {
  if (!isObject(value)) return false;
  const { x, y, width, height } = value;
  return finite(x) && finite(y) && finite(width) && finite(height) && width > 0 && height > 0;
}

/** Whether \`inner\` fits inside \`outer\`. A content area that is not inside its window is another window's surface. */
export function rectWithin(inner: PhysicalRect, outer: PhysicalRect): boolean {
  return inner.x >= outer.x - RECT_SLACK
    && inner.y >= outer.y - RECT_SLACK
    && inner.x + inner.width <= outer.x + outer.width + RECT_SLACK
    && inner.y + inner.height <= outer.y + outer.height + RECT_SLACK;
}

function readRect(value: unknown): PhysicalRect | null {
  return isRect(value) ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
}

function readWindow(value: unknown): ContentWindow | null {
  if (!isObject(value)) return null;
  const hwnd = value.hwnd;
  const pid = value.pid;
  const className = value.className;
  const title = value.title;
  const windowRect = readRect(value.windowRect);
  const clientRect = readRect(value.clientRect);
  if (!finite(hwnd) || !Number.isInteger(hwnd) || hwnd <= 0) return null;
  if (!finite(pid) || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof className !== 'string' || typeof title !== 'string') return null;
  if (!windowRect || !clientRect) return null;
  const { visible, minimized, cloaked } = value;
  // These three decide whether a window may be treated as the one the tab is in, so "unknown" must stay unknown: a missing
  // or non-boolean flag is not false, and defaulting it to false would let an unmeasured window pass as a visible one.
  if (typeof visible !== 'boolean' || typeof minimized !== 'boolean' || typeof cloaked !== 'boolean') return null;
  const dpi = value.dpi;
  const frameRect = value.frameRect === null || value.frameRect === undefined ? null : readRect(value.frameRect);
  return {
    hwnd,
    pid,
    className,
    title,
    visible,
    minimized,
    cloaked,
    dpi: finite(dpi) ? dpi : null,
    windowRect,
    frameRect,
    clientRect,
  };
}

function readRenderer(value: unknown): ContentRenderer | null {
  if (!isObject(value)) return null;
  const hwnd = value.hwnd;
  const parent = value.parent;
  const pid = value.pid;
  const className = value.className;
  const clientRect = readRect(value.clientRect);
  if (!finite(hwnd) || !Number.isInteger(hwnd) || hwnd <= 0) return null;
  if (!finite(parent) || !Number.isInteger(parent) || parent <= 0) return null;
  if (!finite(pid) || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof className !== 'string' || !clientRect) return null;
  // Whether this surface is the visible one decides which content area the pointer may use, so an unmeasured flag is
  // unusable rather than false.
  const visible = value.visible;
  if (typeof visible !== 'boolean') return null;
  return { hwnd, parent, className, pid, visible, clientRect };
}

/**
 * Parses one helper reply, strictly.
 *
 * Anything missing or of the wrong shape makes the whole reply unusable rather than "mostly usable": a reply that cannot
 * be read exactly as it was promised is exactly the reply that cannot be trusted about pixels.
 */
export function readContentAnswer(reply: unknown): ContentAnswer | null {
  if (!isObject(reply)) return null;
  const units = reply.units === null || reply.units === undefined ? null : reply.units;
  if (units !== null && typeof units !== 'string') return null;
  const dpiAwareness = reply.dpiAwareness === null || reply.dpiAwareness === undefined ? null : reply.dpiAwareness;
  if (dpiAwareness !== null && !finite(dpiAwareness)) return null;
  if (!Array.isArray(reply.windows) || !Array.isArray(reply.renderer)) return null;
  if (typeof reply.rendererTruncated !== 'boolean') return null;
  const windows: ContentWindow[] = [];
  for (const entry of reply.windows) {
    const window = readWindow(entry);
    if (!window) return null;
    windows.push(window);
  }
  const renderer: ContentRenderer[] = [];
  for (const entry of reply.renderer) {
    const surface = readRenderer(entry);
    if (!surface) return null;
    renderer.push(surface);
  }
  return { units, dpiAwareness, windows, renderer, rendererTruncated: reply.rendererTruncated };
}

/**
 * Picks the one window and the one content surface that the answer proves.
 *
 * Exactly one valid top-level window among the profile's own processes, exactly one visible render widget inside it, and
 * nothing else: two windows, two surfaces, a hidden or minimized or cloaked window all mean the answer does not say which
 * one the tab is in, and a truncated candidate list means the answer does not say there is no other one.
 */
export function pickCandidate(
  answers: ContentAnswer[],
  pids: number[],
): { window: ContentWindow; renderer: ContentRenderer; dpiAwareness: number | null } | null {
  const own = new Set(pids);
  const windows: ContentWindow[] = [];
  const seenWindows = new Set<number>();
  const renderer: ContentRenderer[] = [];
  const seenRenderers = new Set<number>();
  let dpiAwareness: number | null = null;
  for (const answer of answers) {
    if (dpiAwareness === null) dpiAwareness = answer.dpiAwareness;
    for (const window of answer.windows) {
      if (!own.has(window.pid) || !window.visible || window.minimized || window.cloaked) continue;
      if (!rectWithin(window.clientRect, window.windowRect)) continue;
      if (seenWindows.has(window.hwnd)) continue;
      seenWindows.add(window.hwnd);
      windows.push(window);
    }
    for (const surface of answer.renderer) {
      if (seenRenderers.has(surface.hwnd)) continue;
      seenRenderers.add(surface.hwnd);
      renderer.push(surface);
    }
  }
  if (windows.length !== 1) return null;
  const window = windows[0];
  const content = renderer.filter(surface => surface.parent === window.hwnd
    && surface.visible
    && surface.className === RENDER_WIDGET_CLASS
    && rectWithin(surface.clientRect, window.clientRect));
  if (content.length !== 1) return null;
  return { window, renderer: content[0], dpiAwareness };
}

/**
 * The CSS box the input addresses: the whole layout viewport the witness measured, per axis, or null.
 *
 * Each axis is checked on its own, because a classic scrollbar can take space on one axis only, so the readings can agree
 * on one axis and differ by the scrollbar on the other. On each axis the value CDP reports has to equal one of the two real
 * readings; that is an equivalence when no scrollbar takes space, and a choice of two proven boxes when one does. The
 * divisor is the whole viewport in every accepted case - never the narrower root box, and never a reading with a scrollbar
 * width subtracted from it. A value matching neither reading means the connection and the tab are not describing one
 * viewport, so no divisor is known to be right.
 *
 * Pinch zoom and a pinch's pan are refused rather than mapped: the visual viewport has to be the layout viewport at the same
 * size and offset, because how input coordinates behave inside a transformed visual viewport is not established on this
 * machine. Ordinary document scrolling is not a pinch and not a pan: it moves cssVisualViewport.pageX/pageY, which are not
 * read here, and leaves offsetX/offsetY at 0, so a scrolled page is unaffected. A zoomed or pinch-panned tab therefore
 * produces no point at all, rather than a point that arithmetic alone would have placed.
 */
export function viewportCss(viewport: WitnessViewport): { width: number; height: number } | null {
  const axis = (inner: number, root: number, cdp: number): number | null => {
    if (!finite(inner) || !finite(root) || !finite(cdp)) return null;
    if (inner <= 0 || root <= 0 || cdp <= 0) return null;
    // A scrollbar can only make the root box narrower than the viewport that contains it.
    if (root > inner + CSS_AGREEMENT) return null;
    // One of the two real readings has to be the box this connection reports; with no classic scrollbar they are the same
    // reading, so both matching is an equivalence, not an ambiguity.
    if (Math.abs(cdp - inner) <= CSS_AGREEMENT) return inner;
    if (Math.abs(cdp - root) <= CSS_AGREEMENT) return inner;
    return null;
  };
  const width = axis(viewport.innerWidthCss, viewport.rootClientWidthCss, viewport.cdpLayoutWidthCss);
  const height = axis(viewport.innerHeightCss, viewport.rootClientHeightCss, viewport.cdpLayoutHeightCss);
  if (width === null || height === null) return null;

  const visual = [
    viewport.cdpVisualScale,
    viewport.cdpVisualWidthCss,
    viewport.cdpVisualHeightCss,
    viewport.cdpVisualOffsetX,
    viewport.cdpVisualOffsetY,
  ];
  if (!visual.every(finite)) return null;
  if (Math.abs(viewport.cdpVisualScale - 1) > PINCH_AGREEMENT) return null;
  if (Math.abs(viewport.cdpVisualOffsetX) > CSS_AGREEMENT) return null;
  if (Math.abs(viewport.cdpVisualOffsetY) > CSS_AGREEMENT) return null;
  // The visual viewport's own size is not used as a divisor, so it only has to be one of the two measured boxes - whether
  // this browser reports it with or without a classic scrollbar is not assumed.
  const visualWidth = [viewport.innerWidthCss, viewport.rootClientWidthCss];
  const visualHeight = [viewport.innerHeightCss, viewport.rootClientHeightCss];
  if (!visualWidth.some((value) => Math.abs(viewport.cdpVisualWidthCss - value) <= CSS_AGREEMENT)) return null;
  if (!visualHeight.some((value) => Math.abs(viewport.cdpVisualHeightCss - value) <= CSS_AGREEMENT)) return null;
  return { width, height };
}

/**
 * The ratio that maps CSS pixels to physical pixels, measured on both axes: the content area's physical size over the
 * whole CSS viewport the input chain addresses.
 *
 * Both axes must produce the same ratio, because they describe the same CSS pixel space. When they do not, the surfaces
 * being compared are not consistent measurements of one viewport, and the answer is null rather than a factor adjusted by
 * an assumed scrollbar or zoom.
 */
export function measureScale(
  content: PhysicalRect,
  css: { width: number; height: number },
): { scaleX: number; scaleY: number } | null {
  const scaleX = content.width / css.width;
  const scaleY = content.height / css.height;
  if (!finite(scaleX) || !finite(scaleY) || scaleX <= 0 || scaleY <= 0) return null;
  const gap = Math.abs(scaleX - scaleY);
  if (gap > AXIS_AGREEMENT * Math.min(scaleX, scaleY)) return null;
  return { scaleX, scaleY };
}

/**
 * One CSS point in physical screen pixels, or null.
 *
 * A point outside the content area is not clamped: clamping would put the pointer somewhere the page never pointed at.
 */
export function toPhysical(geometry: ScreenGeometry, css: PagePoint): PhysicalPoint | null {
  if (!finite(css.x) || !finite(css.y)) return null;
  if (!finite(geometry.scaleX) || !finite(geometry.scaleY)) return null;
  if (geometry.scaleX <= 0 || geometry.scaleY <= 0) return null;
  if (css.x < 0 || css.y < 0 || css.x > geometry.cssWidth || css.y > geometry.cssHeight) return null;
  const x = Math.round(geometry.originX + css.x * geometry.scaleX);
  const y = Math.round(geometry.originY + css.y * geometry.scaleY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function describeRect(rect: PhysicalRect): string {
  return 'x=' + rect.x + ' y=' + rect.y + ' w=' + rect.width + ' h=' + rect.height;
}

function hex(value: number): string {
  return '0x' + Math.trunc(value).toString(16);
}

/**
 * Builds the resolver the browser page asks for one input at a time.
 *
 * Nothing is cached between inputs: a window can move, a tab can be resized and a monitor's scale can change, so a
 * measurement from an earlier input is not evidence about this one. The returned provider is a closure over exactly the
 * measurement it just took, so the start and end of one action are placed with the same geometry, and a second action
 * measures again.
 */
export function createGeometryResolver(deps: GeometryDeps): GeometryResolver {
  const now = deps.now ?? (() => Date.now());

  async function measure(targetId: string, layout: PageLayoutReader): Promise<ScreenGeometry | null> {
    try {
      if (typeof targetId !== 'string' || targetId === '') return null;
      const pids = await deps.profilePids();
      if (!Array.isArray(pids)) return null;
      const wanted: number[] = [];
      for (const pid of pids) {
        if (finite(pid) && Number.isInteger(pid) && pid > 0 && !wanted.includes(pid)) wanted.push(pid);
      }
      if (wanted.length === 0 || wanted.length > MAX_PROFILE_PIDS) return null;
      const metrics = await layout();
      if (!metrics) return null;
      const { cssWidth, cssHeight } = metrics;
      if (!finite(cssWidth) || !finite(cssHeight) || cssWidth <= 0 || cssHeight <= 0) return null;
      const answers: ContentAnswer[] = [];
      for (const pid of wanted) {
        const answer = readContentAnswer(await deps.helper(CONTENT_OP, { pid }));
        if (!answer) return null;
        // Null units means these rectangles were measured by a thread that is not per-monitor DPI aware: Windows may still
        // be scaling them for that thread, so multiplying them would place the pointer by a factor nobody measured.
        if (answer.units !== PHYSICAL_UNITS) return null;
        // A truncated list means "no other surface was found" cannot be concluded, so no surface can be picked.
        if (answer.rendererTruncated) return null;
        answers.push(answer);
      }
      const picked = pickCandidate(answers, wanted);
      if (!picked) return null;
      const witness = deps.witness;
      // The candidate is a rectangle the operating system reported, not a proof that this tab is the one inside it, and the
      // witness is also the only reader that can say which CSS box the input chain addresses. It is therefore consulted
      // before any ratio is computed, and its measurement - not the CDP layout metrics - is what the ratio divides by.
      if (!witness) return null;
      const verdict = await witness(targetId, {
        targetId,
        hwnd: picked.window.hwnd,
        pid: picked.window.pid,
        layout: metrics,
        content: picked.renderer.clientRect,
        window: picked.window.clientRect,
      });
      if (!verdict || verdict.ok !== true) return null;
      const measured = verdict.viewport;
      if (!measured) return null;
      // The witness read the same connection's layout value over its own channel; if that number is not the one this
      // module holds, the two are not describing one layout and neither can be used.
      if (Math.abs(measured.cdpLayoutWidthCss - cssWidth) > CSS_AGREEMENT) return null;
      if (Math.abs(measured.cdpLayoutHeightCss - cssHeight) > CSS_AGREEMENT) return null;
      const viewport = viewportCss(measured);
      if (!viewport) return null;
      const scale = measureScale(picked.renderer.clientRect, viewport);
      if (!scale) return null;
      const evidence = [
        '窗口: ' + hex(picked.window.hwnd) + ' pid ' + picked.window.pid + ' 客户区 ' + describeRect(picked.window.clientRect),
        '内容区: ' + hex(picked.renderer.hwnd) + ' ' + describeRect(picked.renderer.clientRect),
        'CSS viewport: ' + viewport.width + ' x ' + viewport.height + '（inner ' + measured.innerWidthCss
          + ' x ' + measured.innerHeightCss + '，root client ' + measured.rootClientWidthCss
          + ' x ' + measured.rootClientHeightCss + '，CDP layout ' + measured.cdpLayoutWidthCss
          + ' x ' + measured.cdpLayoutHeightCss + '，CDP visual ' + measured.cdpVisualWidthCss
          + ' x ' + measured.cdpVisualHeightCss + ' scale ' + measured.cdpVisualScale
          + ' offset ' + measured.cdpVisualOffsetX + ',' + measured.cdpVisualOffsetY + '）',
        '缩放: 实测 ' + scale.scaleX + ' / ' + scale.scaleY + '，两轴相对差 '
          + ((Math.abs(scale.scaleX - scale.scaleY) / Math.min(scale.scaleX, scale.scaleY)) * 100).toFixed(3) + '%',
        '单位: ' + PHYSICAL_UNITS + '，dpiAwareness ' + String(picked.dpiAwareness) + '（仅审计）',
        ...(verdict.evidence ?? ['witness: 该 tab 就是此窗口的可见文档，并给出完整 viewport 测量']),
      ];
      return {
        targetId,
        originX: picked.renderer.clientRect.x,
        originY: picked.renderer.clientRect.y,
        width: picked.renderer.clientRect.width,
        height: picked.renderer.clientRect.height,
        scaleX: scale.scaleX,
        scaleY: scale.scaleY,
        cssWidth: viewport.width,
        cssHeight: viewport.height,
        dpiAwareness: picked.dpiAwareness,
        measuredAt: now(),
        source: 'render-widget+witness',
        evidence,
      };
    } catch {
      // A helper that failed, a witness that threw, a connection that closed: nothing was proven, so nothing is placed.
      return null;
    }
  }

  const provider: PageGeometryProvider = async (targetId, layout) => {
    const geometry = await measure(targetId, layout);
    if (!geometry) return null;
    return (css: PagePoint) => toPhysical(geometry, css);
  };

  return Object.assign(provider, { measure });
}
