import { pageLayout, type Cdp, type PageLayout } from './cdp.ts';
import { PAGE_LIB } from './pageLib.ts';
import type { Anchor, Condition, ExtractSpec, Target } from '../procedures/format.ts';
import {
  CancelledError, UncertainError, currentSignal, emitFor, inCallChain, runAction,
  type ActionPatch, type ActionScope, type Arbiter, type RunActionOptions,
} from '../desktop/arbiter.ts';
import { realTimers, type Timers } from '../shared/timers.ts';
import type { ActionDescriptor, ActionPhase, PhysicalPoint } from '../tool.ts';

export interface Control { ref: number; role: string; name: string; view: boolean; value: string }
interface Snapshot { url: string; title: string; controls: Control[]; text: string }
export type Row = Record<string, string>;

/** Everything one tab can do; the procedure engine's `Driver` is the anchor-only part of it. */
export interface Page {
  open(url: string): Promise<void>;
  read(options?: { page?: number; ref?: number }): Promise<string>;
  brief(): Promise<string>;
  click(target: Target): Promise<void>;
  type(target: Target, text: string): Promise<void>;
  press(key: string): Promise<void>;
  scroll(direction: 'up' | 'down', target?: Target): Promise<void>;
  wait(condition: Condition, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  has(condition: Condition): Promise<boolean>;
  extract(spec: ExtractSpec): Promise<Row[]>;
  evaluate(script: string, args: Record<string, unknown>): Promise<unknown>;
  shot(): Promise<Buffer>;
  bringToFront(): Promise<void>;
  /**
   * Lets go of anything this page still holds down, for a stop that arrives while a step is in flight. True means
   * nothing is held any more; false means that could not be proven and the input engine has to stay shut.
   *
   * True proves only that the release was answered, or that nothing was held: it does not prove the step that was cut
   * off has settled. That step still reports its own outcome through the audit, and only that settlement says whether
   * it is over.
   */
  halt(): Promise<boolean>;
}

const PER_PAGE = 40, TEXT_BUDGET = 1200;
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 }, Delete: { code: 'Delete', keyCode: 46 }, Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 },
};
export const PAGE_KEYS = Object.keys(KEYS);

export const describeAnchor = (anchor: Anchor) => [anchor.role, anchor.name && `「${anchor.name}」`, anchor.text && `文字「${anchor.text}」`, anchor.css && `选择器 ${anchor.css}`, anchor.nth && `第 ${anchor.nth + 1} 个`].filter(Boolean).join(' ');
const describeTarget = (target: Target) => 'ref' in target ? `编号 ${target.ref}` : describeAnchor(target.anchor);
const missing = (target: Target) => new Error('ref' in target
  ? `编号 ${target.ref} 对应的元素已经不在页面上了，先 page_read 再用新编号`
  : `页面上找不到 ${describeAnchor(target.anchor)}`);

/** One numbered line per control, `perPage` of them, then the text the agent can see; what `page_read` returns. */
export function formatRead(snapshot: Snapshot, page = 1, perPage = PER_PAGE, textBudget = TEXT_BUDGET): string {
  const pages = Math.max(1, Math.ceil(snapshot.controls.length / perPage));
  const shown = snapshot.controls.slice((page - 1) * perPage, page * perPage);
  const lines = [`${snapshot.title || '（无标题）'} · ${snapshot.url}`];
  for (const control of shown) lines.push(`[${control.ref}] ${control.role} ${control.name}${control.value ? ` = ${control.value}` : ''}${control.view ? '' : '（屏外）'}`);
  if (!snapshot.controls.length) lines.push('（没有可操作的元素）');
  if (pages > 1) lines.push(`（控件第 ${Math.min(page, pages)}/${pages} 页；${page < pages ? `page=${page + 1} 看后面` : '已是最后一页'}）`);
  if (snapshot.text) lines.push('—— 页面文字 ——', snapshot.text.length > textBudget ? snapshot.text.slice(0, textBudget) + '…' : snapshot.text);
  return lines.join('\n');
}

/** A point in the page's own coordinates (CSS px). It is not a screen position, and this module never treats it as one. */
export interface PagePoint { x: number; y: number }
/** Turns a page point into a physical screen point, or null when that mapping cannot be proven. Measured, never guessed. */
export type PagePhysical = (css: PagePoint) => PhysicalPoint | null;
/**
 * Measures where one tab is on the screen, given that tab's id and a reader for its own layout (the CSS width every scale
 * has to be divided by, read over CDP rather than from the page, which can lie about itself). Returning null means the
 * mapping could not be proven for this input, and the caller then reports no position at all.
 */
export type PageLayoutReader = () => Promise<PageLayout | null>;
export type PageGeometryProvider = (targetId: string, layout: PageLayoutReader) => Promise<PagePhysical | null>;

export interface PageDeps {
  /** Which tab this page drives; without it no screen position is ever reported. */
  targetId?: string;
  /** How this tab sits on the screen. Nothing here invents it when it is missing. */
  geometry?: PageGeometryProvider;
  /** The call's own signal, read again before every input so a stop is noticed before the next byte goes out. */
  interrupt?: () => AbortSignal | undefined;
  /** Why the browser cut this step short, when it did: a timeout is not a stop, and the two report differently. */
  stopReason?: () => 'stop' | 'timeout' | undefined;
  /**
   * The arbiter this tab's input belongs to. A page created by a Browser is given that browser's own instance, so input
   * sent on a path that never entered a tool call still waits its turn in the same queue and reports to the same sink
   * instead of falling back to a process-wide one. A page made on its own may leave it out and get the fallback.
   */
  arbiter?: Arbiter;
  timers?: Timers;
}

export function createPage(cdp: Cdp, deps: PageDeps = {}): Page {
  // A new document restarts the page's numbering; carrying the highest number seen keeps an old number from ever naming another element.
  let highest = 0;
  // What this page owes the mouse and the keyboard: each flag is armed before its input goes out, so a command whose answer
  // never comes back still leaves the page in a state a stop can put right.
  let down: PagePoint | undefined;
  let held: { key: string; code: string; keyCode: number } | undefined;
  let typing = false;
  let running = false;
  const timers = deps.timers ?? realTimers;
  async function call<T>(expression: string): Promise<T> {
    const result = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression: `(() => {window.__evolutionCUBase = ${highest};${PAGE_LIB};\nreturn (${expression});\n})()`, returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value as T;
  }
  async function snapshot(ref?: number): Promise<Snapshot> {
    if (ref !== undefined && !Number.isSafeInteger(ref)) throw new Error(`编号 ${String(ref)} 不是有效的元素编号`);
    const data = await call<Snapshot | { missing: true } | null>(`window.__evolutionCU.snapshot(${JSON.stringify(ref ?? null)}, ${TEXT_BUDGET})`);
    // A page between documents, or an answer that came back empty, is not a page structure: say so plainly instead of
    // tripping over a null the moment the answer is inspected.
    if (!data || typeof data !== 'object') throw new Error('读不到页面结构，页面可能正在切换或暂时没有响应。');
    if ('missing' in data) throw missing({ ref: ref! });
    highest = data.controls.reduce((top, control) => Number.isSafeInteger(control.ref) && control.ref > top ? control.ref : top, highest);
    return data;
  }
  async function pointOf(target: Target): Promise<{ x: number; y: number }> {
    const point = await call<{ x: number; y: number } | { covered: true; by: string } | null>(`window.__evolutionCU.point(${JSON.stringify(target)})`);
    if (!point) throw missing(target);
    if ('covered' in point) throw new Error(`${describeTarget(target)} 被别的东西挡住了（${point.by}），先关掉它或滚动一下`);
    return point;
  }
  /** The audit line for this action, if it has a scope (a page used on its own has none, and gets no events). */
  const mark = (scope: ActionScope | undefined, phase: ActionPhase, patch: ActionPatch = {}): void => {
    if (scope) emitFor(scope, phase, patch);
  };
  /**
   * A measured screen point, or none at all: a mapping that answers with anything but two finite numbers has proved
   * nothing, and a point rounded to whole pixels is what the audit can honestly claim.
   */
  const screenOf = (physical: PagePhysical | null, css: PagePoint): PhysicalPoint | null => {
    if (!physical) return null;
    let point: PhysicalPoint | null = null;
    try { point = physical(css); } catch { return null; }
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    return { x: Math.round(point.x), y: Math.round(point.y) };
  };
  /** A patch that says where on the screen this input goes — or, when that cannot be measured, one that names no place at all. */
  const toward = (point: PhysicalPoint | null): ActionPatch => point ? { space: 'physical', to: point } : { space: 'window' };
  const sampled = (point: PhysicalPoint | null): ActionPatch => point
    ? { space: 'physical', to: point, sampleSource: 'client-to-screen', sampleMs: Date.now() }
    : { space: 'window', sampleMs: Date.now() };

  /** Nothing more is sent once this call has been cancelled. */
  function check(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new CancelledError('用户取消了这一步，没有继续发送输入。');
  }
  /** Waits for `work`, but gives up the moment the call is cancelled: a command that never answers must not hold the queue. */
  function withStop<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return work;
    return new Promise<T>((resolve, reject) => {
      const fail = () => reject(new CancelledError('用户取消了这一步。'));
      if (signal.aborted) { fail(); return; }
      signal.addEventListener('abort', fail, { once: true });
      work.then(
        value => { signal.removeEventListener('abort', fail); resolve(value); },
        error => { signal.removeEventListener('abort', fail); reject(error); },
      );
    });
  }
  const mouseParams = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ type, x, y, button: 'left', clickCount: 1, pointerType: 'mouse', ...extra });
  const sendMouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => cdp.send('Input.dispatchMouseEvent', mouseParams(type, x, y, extra));
  const mouse = (signal: AbortSignal | undefined, type: string, x: number, y: number, extra: Record<string, unknown> = {}) => {
    check(signal);
    return withStop(sendMouse(type, x, y, extra), signal);
  };
  const sendKey = (params: Record<string, unknown>) => cdp.send('Input.dispatchKeyEvent', params);
  const keys = (signal: AbortSignal | undefined, params: Record<string, unknown>) => {
    check(signal);
    return withStop(sendKey(params), signal);
  };

  /** A release during a stop may not wait out a dead connection: no answer in half a second means "cannot tell". */
  function bounded<T>(work: Promise<T>, ms = 500): Promise<T | 'timeout'> {
    return new Promise((resolve, reject) => {
      const timer = timers.set(() => resolve('timeout'), ms);
      work.then(
        value => { timers.clear(timer); resolve(value); },
        error => { timers.clear(timer); reject(error); },
      );
    });
  }
  /** Puts the left button back up. False means that could not be proven, so the engine has to stay shut. */
  async function lift(): Promise<boolean> {
    if (!down) return true;
    const { x, y } = down;
    let released = false;
    try { released = await bounded(sendMouse('mouseReleased', x, y)) !== 'timeout'; } catch { released = false; }
    if (!released) return false;
    down = undefined;
    return true;
  }
  /** Puts the pressed key back up the same way. */
  async function liftKey(): Promise<boolean> {
    if (!held) return true;
    const { key, code, keyCode } = held;
    let released = false;
    try { released = await bounded(sendKey({ type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode })) !== 'timeout'; } catch { released = false; }
    if (!released) return false;
    held = undefined;
    return true;
  }

  /**
   * One release for the whole page: a stop and the failing step it stopped may both need it, and the button and the key
   * are laid to rest exactly once — not twice, and not one before the other.
   */
  let letting: Promise<{ lifted: boolean; released: boolean; key?: string }> | undefined;
  function letGo(): Promise<{ lifted: boolean; released: boolean; key?: string }> {
    if (!letting) {
      const done = (async () => {
        const key = held?.key;
        const lifted = await lift();
        const released = await liftKey();
        return key === undefined ? { lifted, released } : { lifted, released, key };
      })();
      letting = done;
      const forget = () => { if (letting === done) letting = undefined; };
      done.then(forget, forget);
    }
    return letting;
  }

  /**
   * What actually happened, before the failure is allowed out. A step the user stopped is over once nothing is left
   * pressed; anything that cannot be proven to have stopped is uncertain, so the arbiter keeps the gate shut instead of
   * letting the next input find a button still down.
   */
  async function settle(error: unknown, signal: AbortSignal | undefined): Promise<never> {
    const released = await letGo();
    if (!released.lifted) throw new UncertainError('点击按下去以后没能确认松开，鼠标可能还按着，这一步的结果不明。');
    if (!released.released) throw new UncertainError(`按了 ${released.key ?? '这个键'} 以后没能确认松开，这个键可能还按着，这一步的结果不明。`);
    if (error instanceof UncertainError) throw error;
    // A page script that may still be running can still change the page after this call is gone.
    if (running) throw new UncertainError('页面脚本可能还在跑，这一步的结果不明。');
    // Text that was being typed may have gone out in part.
    if (typing) throw new UncertainError('输入的文字可能只发出去了一部分，这一步的结果不明。');
    // A timeout cut the step, but the input it had already sent may have reached the page with its answer lost.
    if (deps.stopReason?.() === 'timeout') throw new UncertainError('浏览器操作超时了，超时不算已经停下，这一步可能已经发出去，结果不明。');
    if (error instanceof CancelledError) throw error;
    // The connection died under this step: whether what it sent arrived is not knowable from here.
    if (cdp.closed) throw new UncertainError('浏览器连接断了，这一步可能已经发出去，结果不明。');
    if (signal?.aborted) throw new CancelledError('用户取消了这一步。');
    throw error;
  }

  /**
   * How this tab's own pixels map to the screen, measured for this input and never assumed: without a proof there is no
   * position, and the audit says only that the page was operated. It is called inside the action's own turn, while the
   * lease is held, after the page has settled — finding a point can scroll the element into view, so a measurement taken
   * earlier would describe a content area the input no longer uses — and only then does any input go out. The
   * measurement is a helper read in that same lease and takes none of its own; three seconds without it means no
   * position for this action.
   */
  async function place(layout: PageLayoutReader): Promise<PagePhysical | null> {
    const targetId = deps.targetId;
    if (!deps.geometry || !targetId) return null;
    try {
      const measured = await bounded(deps.geometry(targetId, layout), 3_000);
      if (measured === 'timeout' || !measured) return null;
      // A mapping only names a position when this tab's own layout could be read: without it there is no telling which
      // content area those numbers describe, so the action names no place at all rather than a guessed one.
      return (await layout()) ? measured : null;
    } catch { return null; }
  }

  /** Where one of this tab's CSS points lands on the screen for the action asking, or null when nothing measured it. */
  type Locator = (css: PagePoint) => Promise<PhysicalPoint | null>;

  // One layout read per action, shared by the geometry provider, a scroll that needs the middle of the page and the
  // place() gate, so a step either knows this tab's content area or has proven it cannot read one — never two answers.
  // It is cleared at the start of every action, so a window or zoom change between actions is picked up again.
  let layoutRead: Promise<PageLayout | null> | undefined;
  const layout: PageLayoutReader = () => (layoutRead ??= pageLayout(cdp));

  /**
   * One real input, inside the trusted chain: the arbiter owns the queue, the lease, the monotonic seq and the audit, so a
   * web input shows up for its agent exactly like a desktop one and two agents' inputs never mix. No caller is taken from
   * here — the identity is the one the tool layer already put in this call's context.
   *
   * The action is handed a locator rather than a position, because its own point is only known once the page has settled:
   * the locator measures once, at the first point the action asks about, which is after that point was found and before
   * the input it leads to.
   */
  async function act<T>(
    move: ActionDescriptor,
    work: (scope: ActionScope | undefined, signal: AbortSignal | undefined, at: Locator) => Promise<T>,
    options: { pointers?: boolean } = {},
  ): Promise<T> {
    const outer = deps.interrupt?.();
    // Two sources can cut this step short — the browser stopping it and the tool call being cancelled — and one signal
    // covering both keeps the checks below honest whichever way the stop arrived.
    const inner = currentSignal();
    const signal = outer && inner && outer !== inner ? AbortSignal.any([outer, inner]) : outer ?? inner;
    check(signal);
    const run = async (scope: ActionScope | undefined, at: Locator): Promise<T> => {
      // The arbiter's scope signal also aborts when the whole input engine is told to cancel, so this step listens to it
      // rather than only to the stop that arrived through this browser.
      const stop = scope?.signal ?? signal;
      try { return await work(scope, stop, at); } catch (error) { return await settle(error, stop); }
    };
    // Input takes the machine's one input lease even when the caller never entered a tool call (the self-test and the
    // routine runner drive a page directly). The identity is not invented: without a trusted caller the arbiter records
    // the action as legacy, which is exactly what it is, and the step still waits its turn, can be cancelled, and leaves
    // a real record behind. The page's own arbiter is used when it has one, so this input joins the queue of the
    // ComputerUse it belongs to rather than a process-wide fallback. Every page a browser makes carries that browser's
    // own instance — the one a ComputerUse also hands its tool calls, or the one the browser made for itself — so a page
    // driven with no call around it (the self-test, the routine runner) still queues, cancels and reports on the same
    // arbiter as its caller's input, instead of a process-wide default.
    //
    // The place is measured inside this action's own turn, after the lease is held and before any input is sent: a number
    // taken while the step was still queued can be stale by the time it runs, and the audit must name the place this
    // input actually went to. The turn is announced without a position (queued/granted), and the measurement itself is
    // one helper read inside the same lease — it takes no lease of its own and holds none back.
    //
    // Only pointer input has a place on the screen. Keys, typed text, a navigation and a script have none, and measuring
    // for them would either waste a measurement or claim a position the action never used.
    // This action starts its own measurement: a layout read by the previous action is not evidence about this one.
    layoutRead = undefined;
    const owner = deps.arbiter;
    // Inside a call the instance that call is running in decides, so the identity and the sink are the caller's own; outside
    // any call — the self test, a saved routine, a page made by hand — the browser's own instance decides, so even that input
    // waits in the same queue and is honoured by the same stop. Neither branch invents an identity: it comes from above.
    const claim = <U>(descriptor: ActionDescriptor, body: (scope: ActionScope) => Promise<U>, runOptions: RunActionOptions): Promise<U> =>
      owner && !inCallChain() ? owner.runAction(descriptor, body, runOptions) : runAction(descriptor, body, runOptions);
    return await claim(move, async scope => {
      // A step that is already cancelled gets nothing measured on its behalf: the measurement would be work for an input
      // that will never be sent.
      check(scope.signal);
      // One measurement per action, taken when the action first knows its own point: by then the page has finished any
      // scrolling that finding the point caused, and no input has gone out yet. Asking again reuses the same reading.
      let measuring: Promise<PagePhysical | null> | null = null;
      const at: Locator = async css => {
        if (options.pointers === false) return null;
        check(scope.signal);
        if (measuring === null) measuring = place(layout);
        const mapping = await measuring;
        check(scope.signal);
        return mapping ? screenOf(mapping, css) : null;
      };
      return await run(scope, at);
    }, { space: 'window', signal });
  }
  async function has(condition: Condition): Promise<boolean> { return await call<boolean>(`window.__evolutionCU.has(${JSON.stringify(condition)})`); }
  return {
    async open(url) {
      // A navigation sends no pointer or key input, but it does change the page another agent may be reading through this
      // same browser, so it takes its turn in the chain like everything else.
      await act({ kind: 'other', label: `打开 ${url}` }, async (scope, signal) => {
        mark(scope, 'executing');
        await withStop(cdp.send('Page.enable'), signal);
        let release = () => {};
        const loaded = new Promise<void>(resolve => {
          const timer = setTimeout(() => { release(); resolve(); }, 15_000);
          const off = cdp.on(method => { if (method === 'Page.loadEventFired') { release(); resolve(); } });
          release = () => { clearTimeout(timer); off(); };
        });
        try {
          const navigated = await withStop(cdp.send<{ errorText?: string }>('Page.navigate', { url }), signal);
          if (navigated.errorText) throw new Error(`打不开 ${url}：${navigated.errorText}`);
          await withStop(loaded, signal);
        } finally { release(); }
        mark(scope, 'progress');
      }, { pointers: false });
    },
    async read({ page = 1, ref } = {}) { return formatRead(await snapshot(ref), page); },
    async brief() { return formatRead(await snapshot(), 1, 15, 300); },
    async click(target) {
      await act({ kind: 'click', label: `点击 ${describeTarget(target)}` }, async (scope, signal, at) => {
        // The point comes first: finding it can scroll the element into view, and where the content area sits only settles
        // once that has happened. The measurement follows the point, in this same turn, and only then does input go out.
        const { x, y } = await pointOf(target);
        const point = await at({ x, y });
        mark(scope, 'approaching', toward(point));
        await mouse(signal, 'mouseMoved', x, y, { button: 'none', clickCount: 0 });
        mark(scope, 'executing', sampled(point));
        // Arm the release before the press is sent: if its answer never comes back, a stop still knows to let go.
        down = { x, y };
        await mouse(signal, 'mousePressed', x, y, { buttons: 1 });
        mark(scope, 'progress', sampled(point));
        await mouse(signal, 'mouseReleased', x, y);
        down = undefined;
      });
    },
    async type(target, text) {
      await act({ kind: 'type', label: `在 ${describeTarget(target)} 输入` }, async (scope, signal) => {
        const focused = await call<'ok' | 'missing' | 'unfocusable'>(`window.__evolutionCU.focus(${JSON.stringify(target)})`);
        if (focused === 'missing') throw missing(target);
        if (focused === 'unfocusable') throw new Error(`${describeTarget(target)} 这个元素不能输入`);
        mark(scope, 'executing');
        typing = true;
        await withStop(cdp.send('Input.insertText', { text }), signal);
        typing = false;
        mark(scope, 'progress');
      }, { pointers: false });
    },
    async press(key) {
      const spec = KEYS[key];
      if (!spec) throw new Error(`不认识按键 ${key}，可用：${PAGE_KEYS.join('、')}`);
      await act({ kind: 'key', label: `按键 ${key}` }, async (scope, signal) => {
        mark(scope, 'executing');
        // A key held down when the call dies is a key still down in the page: arm it before it goes out.
        held = { key, code: spec.code, keyCode: spec.keyCode };
        await keys(signal, { type: 'keyDown', key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, ...(spec.text ? { text: spec.text } : {}) });
        mark(scope, 'progress');
        await keys(signal, { type: 'keyUp', key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode });
        held = undefined;
      }, { pointers: false });
    },
    async scroll(direction, target) {
      await act({ kind: 'scroll', label: target ? `滚动 ${describeTarget(target)}` : '滚动页面' }, async (scope, signal, at) => {
        // The scroll point is found first — a targeted scroll can move the page to reach its element — and the
        // measurement follows it, before the wheel event goes out.
        const middle = target ? null : await layout();
        if (!target && !middle) throw new Error('读不到页面尺寸，无法确定滚轮要发的中间位置。');
        const { x, y } = target ? await pointOf(target) : { x: middle!.cssWidth / 2, y: middle!.cssHeight / 2 };
        const point = await at({ x, y });
        mark(scope, 'approaching', toward(point));
        mark(scope, 'executing', sampled(point));
        await mouse(signal, 'mouseWheel', x, y, { button: 'none', clickCount: 0, deltaX: 0, deltaY: direction === 'down' ? 600 : -600 });
        mark(scope, 'progress', sampled(point));
      });
    },
    async wait(condition, timeoutMs, signal) {
      const deadline = Date.now() + timeoutMs;
      let lastError = '';
      for (;;) {
        signal?.throwIfAborted();
        try { if (await has(condition)) return; } catch (error) { lastError = error instanceof Error ? error.message : String(error); /* the page may be between documents */ }
        if (Date.now() >= deadline) throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒没等到${lastError ? `（最后一次出错：${lastError}）` : ''}`);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    },
    has,
    async extract(spec) { return await call<Row[]>(`window.__evolutionCU.extract(${JSON.stringify(spec)})`); },
    async evaluate(script, args) {
      // A page script runs with the page's own authority and can act after this call is gone, so it holds the input lease
      // until it has certainly ended; the ten-second race inside the page is a limit on waiting, not proof of stopping.
      return await act({ kind: 'other', label: '在页面上跑脚本' }, async (scope, signal) => {
        mark(scope, 'executing');
        running = true;
        const result = await withStop(cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
          expression: `Promise.race([(async (args) => {\n${script}\n})(${JSON.stringify(args)}), new Promise((_, reject) => setTimeout(() => reject(new Error('页面脚本超过十秒没有结束')), 10000))])`, returnByValue: true, awaitPromise: true, timeout: 10_000,
        }), signal);
        if (result.exceptionDetails) {
          const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
          if (!detail.includes('页面脚本超过十秒没有结束')) running = false; // the script itself threw, so it did end
          if (running) throw new UncertainError('页面脚本超过十秒还没有结束，不能确定它已经停下，这一步的结果不明。');
          throw new Error(`页面脚本出错：${detail}`);
        }
        running = false;
        mark(scope, 'progress');
        return result.result.value ?? null;
      }, { pointers: false });
    },
    // Looking only, so these stay outside the input chain on purpose. Anything that sends input belongs in act(), where
    // the lease, the audit and the release are; putting it here would send it with none of the three.
    async shot() { return Buffer.from((await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })).data, 'base64'); },
    async bringToFront() { await cdp.send('Page.bringToFront'); },
    async halt() {
      const released = await letGo();
      return released.lifted && released.released;
    },
  };
}
