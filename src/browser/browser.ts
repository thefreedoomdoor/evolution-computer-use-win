import { errorText, type Faults } from '../shared/faults.ts';
import { createQueue } from '../shared/queue.ts';
import { realTimers, type Timers } from '../shared/timers.ts';
import { CancelledError, createArbiter, UncertainError, type Arbiter } from '../desktop/arbiter.ts';
import { closeTarget, connectCdp, newTarget, pageTargets, type Cdp, type Target } from './cdp.ts';
import { findBrowser, launchBrowser, runningPort } from './edge.ts';
import { createPage, type Page, type PageGeometryProvider } from './page.ts';

export interface BrowserStatus { state: 'missing' | 'stopped' | 'running'; binary: string | null }
export type Browser = ReturnType<typeof createBrowser>;

/** What a screen mapping is built from: the port that answered, the tab it answered for, and the connection to that tab. */
export interface GeometryPageInfo { port: number; targetId: string; cdp: Cdp; profileDir: string }
/**
 * Builds the screen mapping for one tab. It is asked once per connection, because the mapping needs the port and the
 * connection of the browser that is actually up; the provider it returns measures again before every action, so nothing
 * is remembered across a window that may have moved since.
 */
export type GeometryResolver = (info: GeometryPageInfo) => PageGeometryProvider | undefined;

/**
 * The agent's one browser: adopted when it already runs on its profile, started otherwise, reconnected after it was closed.
 * Every operation — the page tools, saved procedures, the routines — goes through one queue, so two of
 * them never act on the same page at once, and each one carries the identity and the cancellation of the call that asked
 * for it across that queue instead of picking them up from whatever ran before.
 * A stop or a timeout does not cut the connection out from under a click: it aborts the step, lets the page it was using
 * put back any button or key still held while the connection still works, and only then drops the connection, so nothing
 * the step had in flight can reach the browser afterwards. If putting input back cannot be confirmed, the input arbiter is
 * poisoned and the step reports an unknown outcome, rather than handing a pressed button to the next agent.
 * Stopping drops the connection only: the window and its pages stay.
 */
export function createBrowser(deps: {
  profileDir: string; faults: Faults; timeoutMs?: number;
  /** Where this browser's tab actually sits on the screen, measured by whoever owns that browser; absent means no position is known. */
  geometry?: PageGeometryProvider;
  /** The same, built for the browser that just answered; a resolver that throws means no position is known, not a broken page tool. */
  geometryResolver?: GeometryResolver; timers?: Timers;
  /**
   * The arbiter this browser's input belongs to. Given one, a stop or a timeout that cannot prove the page let go poisons
   * that instance directly, instead of hoping the caller's own settlement got there first, and every page this browser
   * makes sends its input through it. Absent, the process-wide fallback is used exactly as before.
   */
  arbiter?: Arbiter;
  find?: () => string | undefined; running?: (profileDir: string) => Promise<number>; launch?: (binary: string, profileDir: string) => Promise<number>;
  targets?: (port: number) => Promise<Target[]>; open?: (port: number) => Promise<Target>; close?: (port: number, id: string) => Promise<void>; connect?: (url: string) => Promise<Cdp>;
}) {
  const find = deps.find ?? (() => findBrowser()), running = deps.running ?? runningPort, launch = deps.launch ?? launchBrowser;
  const targets = deps.targets ?? pageTargets, open = deps.open ?? (port => newTarget(port)), close = deps.close ?? closeTarget, connect = deps.connect ?? (url => connectCdp(url));
  const queue = createQueue('浏览器', { limit: 8, timeoutMs: deps.timeoutMs ?? 120_000, timeoutMessage: '浏览器操作超时（两分钟）；如果这一步会向外发出，可能已经发出，先看页面再决定' });
  /**
   * The input arbiter this browser belongs to: the instance a ComputerUse handed over, or one of its own. Handing its own
   * one in is what ties the pages, the stop verdicts and the tool calls to a single queue and a single poison.
   */
  const owner = deps.arbiter ?? createArbiter();
  /** A browser that made its own instance closes it when it stops; one that was given an instance leaves its life to its owner. */
  const owned = deps.arbiter === undefined;
  const timers = deps.timers ?? realTimers;
  /**
   * How long a stop lets a page settle by itself before it closes the connection anyway. Longer than the longest bound a
   * page puts on its own step — three seconds measuring a position, half a second letting a button go — so a stop only
   * gives up on the gate when the page really stopped answering, not while it is still finishing the input it sent.
   */
  const SETTLE_GRACE_MS = 5_000;
  let main: { cdp: Cdp; page: Page } | undefined;
  /** Bumped on every stop and cancellation, so a connection that finishes late knows it is no longer wanted. */
  let generation = 0;
  /** The signal of the step holding the queue, handed to the page so a stop reaches its input at once. */
  let jobSignal: AbortSignal | undefined;
  /** Why that step was cut short, so the page reports a timeout as unknown rather than as a clean stop. */
  let jobStop: 'stop' | 'timeout' | undefined;
  /** Lets go of what the page in use is holding down; set when that page exists, cleared when it is dropped. */
  let haltPage: (() => Promise<boolean>) | undefined;
  /** Steps in flight: a stop with none has nothing to put back and can drop the connection straight away. */
  let busy = 0;
  /** Stops waiting for the last step to settle, so the connection outlives the input that was still coming out of it. */
  let resting: Array<() => void> = [];

  async function port(): Promise<number> {
    const adopted = await running(deps.profileDir);
    if (adopted) return adopted;
    const binary = find();
    if (!binary) throw new Error('这台电脑上找不到 Edge 或 Chrome');
    return await launch(binary, deps.profileDir);
  }
  /** Failures to reach the browser itself are faults; a page that refuses a click is not. */
  async function reach<T>(work: () => Promise<T>): Promise<T> {
    try { const value = await work(); deps.faults.clear('computer'); return value; }
    catch (error) { deps.faults.set('computer', `专用浏览器没能打开：${errorText(error)}`); throw error; }
  }
  function dropMain(): void { main?.cdp.close(); main = undefined; haltPage = undefined; }
  /** Resolves when no step is in flight; a stop with none returns at once. */
  function idle(): Promise<void> {
    if (busy === 0) return Promise.resolve();
    return new Promise<void>(resolve => { resting.push(resolve); });
  }
  /**
   * Waits until no step is in flight — the step keeps the slot through its own settlement, so this is the page's action
   * having given its lease back — but not forever: a page that ignores a stop must not hold the exit open. Either way what
   * happens next is the same; an unsettled step is the unknown case and the broker decides.
   */
  function settled(): Promise<void> {
    return new Promise<void>(resolve => {
      let timer: unknown;
      let done = false;
      const finish = (): void => { if (done) return; done = true; if (timer !== undefined) timers.clear(timer); resolve(); };
      idle().then(finish);
      timer = timers.set(finish, SETTLE_GRACE_MS);
    });
  }
  /**
   * Runs `job` in the queue with a signal that aborts when the queue cancels it (timeout or stop). The slot is held
   * until the step has really let go: the cancel path aborts, puts back what the page holds down while the connection
   * still works, and only then drops the connection. Its answer is the queue's own error, or an unknown outcome when the
   * release could not be confirmed or when a timeout was reported as a stop.
   */
  function inQueue<T>(job: (signal: AbortSignal) => Promise<T>, onCancel: () => void): Promise<T> {
    return queue.run(cancelled => {
      const controller = new AbortController();
      jobSignal = controller.signal;
      busy += 1;
      // A stop that arrives after this step is over concerns nothing in it, and must not touch the next one's page.
      let done = false;
      // Set the moment a stop starts, so the step reports the stop's own verdict rather than the bare cancellation it saw first.
      let stopping = false;
      // A stop while a click is in flight must not pass the hold on: the page is asked to let go before the socket closes.
      const stopped = cancelled.catch(async (error: unknown) => {
        if (done) throw error;
        stopping = true;
        const timedOut = !queue.stopped;
        jobStop = timedOut ? 'timeout' : 'stop';
        generation += 1;
        controller.abort();
        const released = haltPage ? await haltPage() : true;
        onCancel();
        // Shutting the input gate is this browser's own decision, so it names the instance it belongs to rather than
        // reading one out of whatever context happens to be current: a stop that arrives from outside a call has none.
        const shut = (reason: string): void => { owner.poison(reason); };
        if (!released) {
          shut('取消时没能确认把按住的按钮或键放回去，输入状态不明。');
          throw new UncertainError('取消时没能确认把按住的按钮或键放回去，鼠标或按键可能还按着，这一步的结果不明。');
        }
        if (timedOut) {
          // Cut by the clock, not by the user: what the step already sent may still land, so the gate stays shut until
          // someone resets it. The page's own settlement reports the same unknown outcome inside the action's audit.
          shut('浏览器操作超时了，超时不算已经停下，这一步的结果不明。');
          throw new UncertainError('浏览器操作超时了，超时不算已经停下：如果这一步会向外发出，可能已经发出，先看页面再决定下一步。');
        }
        throw error;
      });
      stopped.catch(() => {});
      const work = (async () => {
        try {
          const value = await Promise.race([job(controller.signal), stopped]);
          // A stop that began while this step ran decides the outcome even if the step happened to finish on its own:
          // the caller asked for it to stop and the connection is about to go.
          if (stopping) await stopped;
          done = true;
          return value;
        } catch (error) {
          // A stop decides the outcome even when the step itself failed a moment earlier: only the stop knows whether the
          // button came back up, and "cancelled" would claim a clean stop it cannot prove.
          if (stopping) await stopped;
          throw error;
        } finally {
          done = true;
          busy -= 1;
          if (jobSignal === controller.signal) { jobSignal = undefined; jobStop = undefined; }
          if (busy === 0) { const waiting = resting; resting = []; for (const wake of waiting) wake(); }
        }
      })();
      return work;
    });
  }
  /**
   * A page that knows which tab it is (for the screen mapping) and which step is allowed to stop it. A mapping that
   * cannot be built leaves the page without one: its actions are still real input, they are just audited without a
   * position, which is the only honest answer when the tab's place on the screen is unknown.
   */
  function pageOf(cdp: Cdp, targetId: string, at: number): Page {
    let geometry: PageGeometryProvider | undefined;
    try { geometry = deps.geometry ?? deps.geometryResolver?.({ port: at, targetId, cdp, profileDir: deps.profileDir }); }
    catch { geometry = undefined; }
    return createPage(cdp, { targetId, geometry, interrupt: () => jobSignal, stopReason: () => jobStop, arbiter: owner, timers });
  }
  async function mainPage(): Promise<Page> {
    if (main && !main.cdp.closed) return main.page;
    const mine = generation;
    const connected = await reach(async () => {
      const at = await port();
      const target = (await targets(at))[0] ?? await open(at);
      return { at, target, cdp: await connect(target.webSocketDebuggerUrl) };
    });
    if (mine !== generation || queue.stopped) { connected.cdp.close(); throw new CancelledError('浏览器操作已取消'); }
    const page = pageOf(connected.cdp, connected.target.id, connected.at);
    main = { cdp: connected.cdp, page };
    haltPage = () => page.halt();
    return page;
  }
  /** One operation on the main tab. */
  function run<T>(work: (page: Page, signal: AbortSignal) => Promise<T>): Promise<T> {
    return inQueue(async signal => {
      const page = await mainPage();
      // The main page outlives one step, so it is the step's own job to say what a stop of it must let go of.
      haltPage = () => page.halt();
      return await work(page, signal);
    }, dropMain);
  }
  return {
    run,
    /** Work in a tab of its own, closed afterwards, so the page the agent is on stays as it was. */
    scratch<T>(work: (page: Page, signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
      let cdp: Cdp | undefined;
      return inQueue(async signal => {
        // The caller may have given up while this waited in the queue; then it must not open a tab nobody reads.
        caller?.throwIfAborted();
        const at = await reach(port);
        caller?.throwIfAborted();
        const target = await reach(() => open(at));
        try {
          signal.throwIfAborted();
          cdp = await reach(() => connect(target.webSocketDebuggerUrl));
          signal.throwIfAborted();
          const page = pageOf(cdp, target.id, at);
          haltPage = () => page.halt();
          return await work(page, signal);
        } finally { haltPage = undefined; cdp?.close(); await close(at, target.id); }
      }, () => cdp?.close());
    },
    /** Brings its window forward, for the user to scan a login code or watch. */
    show(): Promise<void> { return run(page => page.bringToFront()); },
    status(): BrowserStatus {
      const binary = find() ?? null;
      return { state: !binary ? 'missing' : main && !main.cdp.closed ? 'running' : 'stopped', binary };
    },
    /**
     * Stops taking work and closes what is idle. A step in flight is first aborted, asked to put back what it holds and
     * given its own settlement; only then is the connection dropped, so a click that was going out is finished on a live
     * connection instead of being cut off mid-press. An instance this browser made is disposed last, after that
     * settlement: a lease that was given back leaves the slot free, one that was not stays unknown, as it must.
     */
    async stop(): Promise<void> {
      generation += 1;
      queue.stop();
      // Nothing running means nothing holds input down: close at once, synchronously, so a caller that does not wait for
      // this promise still gets a closed connection.
      if (busy === 0) {
        if (owned) owner.dispose();
        dropMain();
        return;
      }
      await settled();
      if (owned) owner.dispose();
      dropMain();
    },
  };
}
