import { errorText } from '../shared/faults.ts';

/** One DevTools socket to one page target; a request the browser never answers times out instead of hanging a tool call. Ported from dsh-inner-browser-use (MIT, see NOTICE.md). */
export interface Cdp {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(listener: (method: string, params: Record<string, unknown>) => void): () => void;
  close(): void;
  readonly closed: boolean;
}

export function connectCdp(url: string, options: { timeoutMs?: number } = {}): Promise<Cdp> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const socket = new WebSocket(url);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; method: string; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  let next = 1, closed = false;
  socket.addEventListener('message', event => {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`)); else entry.resolve(message.result ?? {});
      return;
    }
    if (message.method) for (const listener of listeners) { try { listener(message.method, message.params ?? {}); } catch { /* one listener's failure costs that event only */ } }
  });
  socket.addEventListener('close', () => {
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('浏览器连接已断开')); }
    pending.clear();
  });
  const cdp: Cdp = {
    send<T>(method: string, params: Record<string, unknown> = {}) {
      if (closed) return Promise.reject(new Error('浏览器连接已断开'));
      const id = next++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: 浏览器没有回应`)); }, timeoutMs);
        pending.set(id, { resolve: value => resolve(value as T), reject, method, timer });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch { pending.delete(id); clearTimeout(timer); reject(new Error('浏览器连接已断开')); }
      });
    },
    on(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { try { socket.close(); } catch { /* already closed */ } },
    get closed() { return closed; },
  };
  return new Promise((resolve, reject) => {
    const fail = () => { clearTimeout(timer); cdp.close(); reject(new Error('连不上浏览器的调试端口')); };
    const timer = setTimeout(fail, timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(cdp); }, { once: true });
    socket.addEventListener('error', fail, { once: true });
  });
}

/**
 * Where a browser listening on `port` answers on this machine. One place, because the tab bookkeeping, the page tools and
 * any measurement of where that browser sits on the screen all have to mean the same browser.
 */
export function browserEndpoint(port: number): string { return `http://127.0.0.1:${port}`; }

export interface Target { id: string; type: string; url: string; title: string; webSocketDebuggerUrl: string }

export async function pageTargets(port: number, fetchImpl: typeof fetch = fetch): Promise<Target[]> {
  const response = await fetchImpl(`${browserEndpoint(port)}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`读不到浏览器的标签页（HTTP ${response.status}）`);
  return (await response.json() as Target[]).filter(target => target.type === 'page' && target.webSocketDebuggerUrl);
}

/** Chromium 111+ takes only PUT here. */
export async function newTarget(port: number, url = 'about:blank', fetchImpl: typeof fetch = fetch): Promise<Target> {
  const response = await fetchImpl(`${browserEndpoint(port)}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`开不了新标签页（HTTP ${response.status}）`);
  return await response.json() as Target;
}

/** Closing a tab is best-effort cleanup, so a failure is deliberately not reported. */
export async function closeTarget(port: number, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl(`${browserEndpoint(port)}/json/close/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(3000) }).catch(() => undefined);
}

/**
 * One tab's own size as the browser states it, not as the page states it: a page can redefine its own `innerWidth`, so a
 * scale divided by that number would be a fabrication. Both sizes are CSS pixels, unrounded and unconverted.
 */
export interface PageLayout { cssWidth: number; cssHeight: number; pageZoom: number }

/** A window's outer box in DIP as the browser reports it. This is not a screen position; it still has to be matched. */
export interface WindowBounds { windowId: number; left: number; top: number; width: number; height: number; windowState?: string }

function finite(...values: unknown[]): boolean { return values.every(value => typeof value === 'number' && Number.isFinite(value)); }

/** Reads `Page.getLayoutMetrics`; null when the answer does not carry a real size, which is a failed proof, not a zero. */
export function readLayout(answer: unknown): PageLayout | null {
  const metrics = answer as { cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }; visualViewport?: { scale?: number } } | null;
  const box = metrics?.cssLayoutViewport;
  const cssWidth = box?.clientWidth, cssHeight = box?.clientHeight;
  if (!finite(cssWidth, cssHeight) || (cssWidth as number) <= 0 || (cssHeight as number) <= 0) return null;
  const zoom = metrics?.visualViewport?.scale;
  return { cssWidth: cssWidth as number, cssHeight: cssHeight as number, pageZoom: finite(zoom) && (zoom as number) > 0 ? zoom as number : 1 };
}

/** Reads `Browser.getWindowForTarget`. Negative edges are legitimate on a multi-monitor desktop and are kept as sent. */
export function readWindowBounds(answer: unknown): WindowBounds | null {
  const reported = answer as { windowId?: number; bounds?: { left?: number; top?: number; width?: number; height?: number; windowState?: string } } | null;
  const windowId = reported?.windowId, bounds = reported?.bounds;
  if (!finite(windowId) || !bounds) return null;
  const { left, top, width, height, windowState } = bounds;
  if (!finite(left, top, width, height) || (width as number) <= 0 || (height as number) <= 0) return null;
  return {
    windowId: windowId as number, left: left as number, top: top as number, width: width as number, height: height as number,
    ...(windowState ? { windowState } : {}),
  };
}

/** One tab's CSS size, read over the very connection that will send input to it. */
export async function pageLayout(cdp: Cdp): Promise<PageLayout | null> {
  try { return readLayout(await cdp.send('Page.getLayoutMetrics')); } catch { return null; }
}

/** The browser-level socket behind a port. Only `Browser.*` answers there, and it belongs to no tab. */
async function browserSocket(port: number, fetchImpl: typeof fetch): Promise<string | null> {
  const response = await fetchImpl(`${browserEndpoint(port)}/json/version`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) return null;
  const version = await response.json() as { webSocketDebuggerUrl?: string };
  return version.webSocketDebuggerUrl ?? null;
}

/** A plain object, which is what every CDP answer worth reading is. */
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object'; }

/**
 * The visual viewport: the box the user sees when pinch-zoom or a swipe has moved it inside the layout viewport.
 * `offsetX/offsetY` are relative to that layout viewport and stay 0 for ordinary scrolling, while `pageX/pageY` move with
 * the document; only the offsets can be compared with the CSS box the input addresses.
 */
export interface VisualViewportRead {
  offsetX: number; offsetY: number; pageX: number | null; pageY: number | null;
  scale: number; clientWidth: number; clientHeight: number;
}

/** Reads `cssVisualViewport`; null when a value it has to compare with is missing, which is a failed measurement. */
export function readVisualViewport(answer: unknown): VisualViewportRead | null {
  const metrics = answer as { cssVisualViewport?: { offsetX?: unknown; offsetY?: unknown; pageX?: unknown; pageY?: unknown; scale?: unknown; clientWidth?: unknown; clientHeight?: unknown } } | null;
  const box = metrics?.cssVisualViewport;
  if (!box) return null;
  const { offsetX, offsetY, pageX, pageY, scale, clientWidth, clientHeight } = box;
  if (!finite(offsetX, offsetY, scale, clientWidth, clientHeight)) return null;
  if ((scale as number) <= 0 || (clientWidth as number) <= 0 || (clientHeight as number) <= 0) return null;
  return {
    offsetX: offsetX as number, offsetY: offsetY as number,
    pageX: finite(pageX) ? pageX as number : null, pageY: finite(pageY) ? pageY as number : null,
    scale: scale as number, clientWidth: clientWidth as number, clientHeight: clientHeight as number,
  };
}

/** The CSS pixel box the input addresses, read inside the tab in a world the document cannot instrument. */
export interface CssViewportReading {
  innerWidthCss: number; innerHeightCss: number;
  rootClientWidthCss: number; rootClientHeightCss: number;
  cdpLayoutWidthCss: number; cdpLayoutHeightCss: number;
  cdpVisualScale: number; cdpVisualWidthCss: number; cdpVisualHeightCss: number;
  cdpVisualOffsetX: number; cdpVisualOffsetY: number;
}
export type ViewportWitnessReading = { ok: true; viewport: CssViewportReading; evidence: string[] } | { ok: false; reason: string };

/**
 * Measures, inside this tab's own isolated world, the CSS viewport that CDP input addresses right now, and proves that
 * this target is the visible document of the window whose process is one of this browser's browser processes.
 *
 * Nothing here activates the window or switches a tab: visibility is what the document says about itself and what the
 * browser reports for the same frame before and after the measurement, and a document that navigated in between makes the
 * reading useless rather than merely stale. Anything the protocol does not support fails the measurement.
 */
export const WITNESS_WORLD = 'evolution-cu-viewport';
const WITNESS_EXPRESSION = `(() => {
  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const native = fn => typeof fn === 'function' && /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(fn));
  const getter = (prototype, key) => {
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, key) : undefined;
    return !!descriptor && 'get' in descriptor && native(descriptor.get);
  };
  const root = document.documentElement;
  const intact = getter(Window.prototype, 'innerWidth')
    && getter(Window.prototype, 'innerHeight')
    && getter(Element.prototype, 'clientWidth')
    && getter(Element.prototype, 'clientHeight')
    && !hasOwn(window, 'innerWidth') && !hasOwn(window, 'innerHeight')
    && !hasOwn(root, 'clientWidth') && !hasOwn(root, 'clientHeight')
    && document.defaultView === window;
  return {
    realmIntact: intact,
    visibility: String(document.visibilityState || ''),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    rootClientWidth: root.clientWidth,
    rootClientHeight: root.clientHeight,
  };
})()`;

interface WitnessValue { realmIntact: boolean; visibility: string; innerWidth: number; innerHeight: number; rootClientWidth: number; rootClientHeight: number }

function readWitnessValue(value: unknown): WitnessValue | null {
  if (!record(value)) return null;
  const { realmIntact, visibility, innerWidth, innerHeight, rootClientWidth, rootClientHeight } = value;
  if (realmIntact !== true || typeof visibility !== 'string') return null;
  if (!finite(innerWidth, innerHeight, rootClientWidth, rootClientHeight)) return null;
  if ((innerWidth as number) <= 0 || (innerHeight as number) <= 0) return null;
  if ((rootClientWidth as number) < 0 || (rootClientHeight as number) < 0) return null;
  return {
    realmIntact: true, visibility,
    innerWidth: innerWidth as number, innerHeight: innerHeight as number,
    rootClientWidth: rootClientWidth as number, rootClientHeight: rootClientHeight as number,
  };
}

function hex(value: number): string { return '0x' + Math.trunc(value).toString(16); }

/**
 * The one context that is this tab's own isolated world, bound by the id the browser handed out for it and by the
 * announcement that names that same world in that same frame. A bare context id is reused after a navigation and says
 * nothing about which world or which document it belongs to, so a browser that does not announce a unique id gets no
 * measurement at all rather than a reading from whatever now holds that number.
 */
interface WorldContext { id: number; uniqueId: string; name: string; frameId: string }

const CONTEXT_WAIT_MS = 2_000;

/** How far the visual viewport may sit from the layout's own scale before the reading stops meaning anything. */
const PINCH_AGREEMENT = 0.001;

function readContextAnnouncement(params: unknown): WorldContext | null {
  const context = record(params) ? params.context : undefined;
  if (!record(context)) return null;
  const { id, uniqueId, name, auxData } = context;
  const frameId = record(auxData) ? auxData.frameId : undefined;
  if (!Number.isInteger(id) || (id as number) <= 0) return null;
  if (typeof uniqueId !== 'string' || uniqueId === '') return null;
  if (typeof frameId !== 'string' || frameId === '') return null;
  return { id: id as number, uniqueId, name: typeof name === 'string' ? name : '', frameId };
}

function readContextLoss(params: unknown): { id: number | null; uniqueId: string | null } {
  const source = record(params) ? params : {};
  const id = Number.isInteger(source.executionContextId) ? source.executionContextId as number : null;
  const uniqueId = typeof source.executionContextUniqueId === 'string' && source.executionContextUniqueId !== ''
    ? source.executionContextUniqueId : null;
  return { id, uniqueId };
}

/**
 * The worlds this connection has announced, the ones that are gone, and the one world this read may use: the world it
 * just created, in the frame it read, still alive, exactly as the browser itself announced it. The id the protocol
 * returns for the world is only a number the announcement has to match; the usable handle is the unique id the
 * announcement carries, which a plain context id cannot replace.
 *
 * A wait ends when an announcement arrives, when the browser destroys or clears contexts, or after a bounded time — it
 * never polls, and `off` takes the listener down again.
 */
function watchContexts(cdp: Cdp): {
  lost: Set<string>;
  look: (id: number, frameId: string) => Promise<WorldContext | null>;
  off: () => void;
} {
  const contexts = new Map<number, WorldContext>();
  const seen = new Set<number>();
  const lost = new Set<string>();
  let wake: (() => void) | null = null;
  const notice = (): void => { const call = wake; wake = null; call?.(); };
  const off = cdp.on((method, params) => {
    if (method === 'Runtime.executionContextCreated') {
      const announced = readContextAnnouncement(params);
      if (announced) { contexts.set(announced.id, announced); seen.add(announced.id); }
      notice();
      return;
    }
    if (method === 'Runtime.executionContextDestroyed') {
      const gone = readContextLoss(params);
      if (gone.id !== null) contexts.delete(gone.id);
      if (gone.uniqueId) lost.add(gone.uniqueId);
      notice();
      return;
    }
    if (method === 'Runtime.executionContextsCleared') {
      // Everything announced so far belonged to a document that is gone. Clearing the candidates is not enough: every
      // world that was alive is dead, and a numeric id the browser hands out again must not inherit any of them.
      for (const known of contexts.values()) lost.add(known.uniqueId);
      contexts.clear();
      notice();
    }
  });
  const look = (id: number, frameId: string): Promise<WorldContext | null> => new Promise<WorldContext | null>(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let probe: () => void = () => {};
    const finish = (value: WorldContext | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (wake === probe) wake = null;
      resolve(value);
    };
    probe = (): void => {
      const known = contexts.get(id);
      if (known && known.name === WITNESS_WORLD && known.frameId === frameId && !lost.has(known.uniqueId)) {
        finish(known);
        return;
      }
      // This id was announced to this read and is gone now (destroyed, or wiped by a cleared document). A world the
      // browser recreates later arrives under a fresh id of its own, so nothing older can be picked up from here.
      if (!known && seen.has(id)) { finish(null); return; }
      // Still waiting. A wake says only that the browser said something, not that it said the thing this read needs, so
      // the wait is armed again here — an announcement about another world would otherwise take the only wake with it
      // and the relevant one that follows would have nobody left to tell, ending the read on its timer instead.
      wake = probe;
    };
    wake = probe;
    timer = setTimeout(() => finish(null), CONTEXT_WAIT_MS);
    probe();
  });
  return { lost, look, off };
}

/**
 * This tab's CSS viewport right now, read inside a world the document cannot instrument and cross-checked against the
 * layout the same connection reports: window inner size, the document's own client box, the CDP layout viewport and the
 * visual viewport, all at one moment of one document. A visual viewport that is zoomed or panned is refused, because the
 * CSS points the input speaks then no longer describe what is on screen. It is a measurement of the tab, not a place on
 * the screen — turning it into a position also needs proof that the tab and a native content area are one surface, which
 * this does not claim.
 */
export async function readTabViewport(
  cdp: Cdp,
  candidate: { targetId: string; pid: number; layout: PageLayout },
  options: { browserPids?: () => Promise<number[]> } = {},
): Promise<ViewportWitnessReading> {
  try {
    if (typeof candidate?.targetId !== 'string' || candidate.targetId === '') return { ok: false, reason: '没有要测量的标签页' };
    if (!finite(candidate.pid) || candidate.pid <= 0 || !Number.isInteger(candidate.pid)) return { ok: false, reason: '窗口不属于这个浏览器的任何进程' };
    const tree = await cdp.send<{ frameTree?: { frame?: { id?: string; loaderId?: string } } }>('Page.getFrameTree');
    const frame = tree?.frameTree?.frame;
    if (!frame?.id) return { ok: false, reason: '读不到这个标签页的框架' };
    // Without the document's id, the read after the measurement cannot tell whether the same document is still there.
    if (typeof frame.loaderId !== 'string' || frame.loaderId === '') return { ok: false, reason: '读不到这份文档的编号' };
    // The world is measured through the context the browser itself announces for it, over this very connection: the
    // announcement and the id this browser returned for the world have to name one and the same context.
    const watch = watchContexts(cdp);
    const lost = watch.lost;
    let answer: { result?: { value?: unknown }; exceptionDetails?: unknown } | undefined;
    let world: WorldContext | null = null;
    try {
      await cdp.send('Runtime.enable');
      // The protocol returns only the numeric id of the new world; the unique id comes from its announcement.
      const created = await cdp.send<{ executionContextId?: number }>('Page.createIsolatedWorld', { frameId: frame.id, worldName: WITNESS_WORLD, grantUniveralAccess: false });
      const id = created?.executionContextId;
      if (!Number.isInteger(id) || (id as number) <= 0) return { ok: false, reason: '这个浏览器没有给出可以测量的隔离世界' };
      world = await watch.look(id as number, frame.id);
      if (!world) return { ok: false, reason: '这个浏览器没有正式登记这个隔离世界（缺少上下文编号），量不了' };
      answer = await cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression: WITNESS_EXPRESSION, returnByValue: true, awaitPromise: false, uniqueContextId: world.uniqueId });
    } finally {
      watch.off();
      // The announcement stream is not left running for a measurement that is over, whether it succeeded or not.
      try { await cdp.send('Runtime.disable'); } catch { /* the connection may already be gone; the listener is off */ }
    }
    if (!answer) return { ok: false, reason: '这个浏览器没有回答隔离世界里的测量' };
    if (!world) return { ok: false, reason: '这个浏览器没有正式登记这个隔离世界（缺少上下文编号），量不了' };
    const reading = world;
    if (lost.has(reading.uniqueId)) return { ok: false, reason: '隔离世界在读数的时候被销毁了' };
    if (answer.exceptionDetails) return { ok: false, reason: '隔离世界里的测量出错了' };
    const value = readWitnessValue(answer?.result?.value);
    if (!value) return { ok: false, reason: '隔离世界里的窗口大小不是可信的读法' };
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const layout = readLayout(metrics);
    const visual = readVisualViewport(metrics);
    if (!layout || !visual) return { ok: false, reason: '读不到这个标签页的页面尺寸' };
    if (Math.abs(layout.cssWidth - candidate.layout.cssWidth) > 1 || Math.abs(layout.cssHeight - candidate.layout.cssHeight) > 1) {
      return { ok: false, reason: '两次读到的页面尺寸不一样' };
    }
    const after = await cdp.send<{ frameTree?: { frame?: { id?: string; loaderId?: string } } }>('Page.getFrameTree');
    if (after?.frameTree?.frame?.loaderId !== frame.loaderId) return { ok: false, reason: '读数的时候页面换了一份文档' };
    if (value.visibility !== 'visible') return { ok: false, reason: '这个标签页现在不可见（' + value.visibility + '）' };
    if (!options.browserPids) return { ok: false, reason: '没有核对窗口属于哪个浏览器进程' };
    const pids = await options.browserPids();
    if (!Array.isArray(pids) || !pids.includes(candidate.pid)) {
      return { ok: false, reason: '窗口进程不在这个浏览器的浏览器进程里（窗口 pid ' + candidate.pid + '，浏览器进程 ' + (pids ?? []).join('/') + '）' };
    }
    // The tab has to belong to a window the browser itself names. A CDP window id is not a native handle, but without one
    // there is no window at all to talk about, and a measurement that cannot say which window its tab lives in is not a
    // proof of anything.
    let windowId: number | null = null;
    try {
      const frameWindow = readWindowBounds(await cdp.send('Browser.getWindowForTarget', { targetId: candidate.targetId }));
      windowId = frameWindow?.windowId ?? null;
    } catch { windowId = null; }
    if (windowId === null || !Number.isInteger(windowId) || windowId <= 0) {
      return { ok: false, reason: '查不到这个标签页在哪个窗口里，量不了' };
    }
    const viewport: CssViewportReading = {
      innerWidthCss: value.innerWidth, innerHeightCss: value.innerHeight,
      rootClientWidthCss: value.rootClientWidth, rootClientHeightCss: value.rootClientHeight,
      cdpLayoutWidthCss: layout.cssWidth, cdpLayoutHeightCss: layout.cssHeight,
      cdpVisualScale: visual.scale, cdpVisualWidthCss: visual.clientWidth, cdpVisualHeightCss: visual.clientHeight,
      cdpVisualOffsetX: visual.offsetX, cdpVisualOffsetY: visual.offsetY,
    };
    if (!Object.values(viewport).every(number => typeof number === 'number' && Number.isFinite(number))) {
      return { ok: false, reason: '隔离世界里的窗口大小不是可信的读法' };
    }
    // A visual viewport that is zoomed or panned is not the layout viewport its CSS points belong to, and nothing here
    // measures that transform: a position derived from it would name a place the input never reaches.
    const near = (one: number, other: number): boolean => Math.abs(one - other) <= 1;
    if (Math.abs(visual.scale - 1) > PINCH_AGREEMENT || Math.abs(visual.offsetX) > 1 || Math.abs(visual.offsetY) > 1) {
      return { ok: false, reason: '这个标签页被缩放或平移过，量出来的位置不能当作布局视口的位置' };
    }
    if (!(near(visual.clientWidth, value.innerWidth) || near(visual.clientWidth, value.rootClientWidth))
      || !(near(visual.clientHeight, value.innerHeight) || near(visual.clientHeight, value.rootClientHeight))) {
      return { ok: false, reason: '看到的可视区域和这个标签页的视口对不上，量不了' };
    }
    return {
      ok: true,
      viewport,
      evidence: [
        // This says which browser serves the window. It is not a claim that the target and a native content area are one
        // surface, and this read makes no claim about where the tab sits on the screen.
        '窗口进程 pid ' + candidate.pid + ' 是这个浏览器的进程之一',
        '隔离世界 ' + reading.uniqueId + '（上下文 ' + reading.id + '，' + reading.name + '，frame ' + reading.frameId + '）：窗口 ' + value.innerWidth + ' x ' + value.innerHeight
          + '，root client ' + value.rootClientWidth + ' x ' + value.rootClientHeight,
        'CDP layout ' + layout.cssWidth + ' x ' + layout.cssHeight + '，visual ' + visual.clientWidth + ' x ' + visual.clientHeight
          + ' scale ' + visual.scale + ' offset ' + visual.offsetX + ',' + visual.offsetY
          + (visual.pageY === null ? '' : '（文档 ' + String(visual.pageX) + ',' + String(visual.pageY) + '，仅审计）'),
        '文档 ' + value.visibility + '，loader ' + String(frame.loaderId),
        // A CDP window id says the tab belongs to a window this browser knows about. It is not the native handle, and the
        // DIP bounds it comes with are never used as screen pixels, so it stays a clue about where the tab lives.
        '浏览器窗口 id ' + windowId + '（DIP 编号，不是原生窗口句柄）',
      ],
    };
  } catch (error) {
    return { ok: false, reason: '量不到这个标签页的视口：' + errorText(error) };
  }
}

/**
 * A tab's place on the screen, as the browser's own wiring asks for it: the viewport read above, then proof that this tab
 * and the native content area it is measured against are one and the same surface. That proof is still being worked out
 * and does not exist yet, so there is no position to hand out. The answer is "no position" every time — never a number
 * nobody measured — and the page tools keep running as real input audited without a position.
 */
export async function readViewportWitness(
  cdp: Cdp,
  candidate: { targetId: string; pid: number; layout: PageLayout },
  options: { browserPids?: () => Promise<number[]> } = {},
): Promise<ViewportWitnessReading> {
  const reading = await readTabViewport(cdp, candidate, options);
  if (!reading.ok) return reading;
  return { ok: false, reason: '量到了这个标签页的视口，但还不能证明它和那个原生内容区是同一表面，给不出屏幕位置' };
}

/**
 * The browser processes this connection belongs to, as the browser itself lists them. Only the `browser` type names a
 * process that can own a window; a renderer or a GPU process is not one.
 *
 * A list that cannot be read whole is no answer at all. An entry that claims to be the browser but carries no real
 * process id, or an entry that cannot even be classified, means the browser's account of itself is damaged: this returns
 * nothing rather than handing back whatever happened to parse, because dropping the damaged entries would make a partial
 * list look complete and completeness is exactly what the caller relies on. Named non-browser processes may be left out,
 * and repeated ids collapse into one.
 */
export async function browserProcessIds(cdp: Cdp): Promise<number[]> {
  const answer = await cdp.send('SystemInfo.getProcessInfo');
  const list = (answer as { processInfo?: unknown }).processInfo;
  if (!Array.isArray(list)) return [];
  const ids = new Set<number>();
  for (const entry of list) {
    if (!record(entry) || Array.isArray(entry)) return [];
    const type = entry.type;
    if (typeof type !== 'string' || type === '') return [];
    if (type !== 'browser') continue;
    const id = entry.id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return [];
    ids.add(id);
  }
  return [...ids];
}

/**
 * The browser processes serving one port, asked on the browser-level socket that port answers on. An empty list means the
 * association could not be read at all - not that this browser has no process - so a measurement that needs it fails.
 */
export async function profileBrowserPids(
  port: number,
  options: { fetchImpl?: typeof fetch; connect?: (url: string) => Promise<Cdp>; timeoutMs?: number } = {},
): Promise<number[]> {
  let socket: string | null;
  try { socket = await browserSocket(port, options.fetchImpl ?? fetch); } catch { return []; }
  if (!socket) return [];
  let cdp: Cdp | undefined;
  try {
    cdp = await (options.connect ?? (url => connectCdp(url, { timeoutMs: options.timeoutMs ?? 5_000 })))(socket);
    return await browserProcessIds(cdp);
  } catch { return []; } finally { cdp?.close(); }
}
