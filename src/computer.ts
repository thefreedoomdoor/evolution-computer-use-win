import { join } from 'node:path';
import { Faults, errorText } from './shared/faults.ts';
import { createBrowser, type Browser, type GeometryPageInfo } from './browser/browser.ts';
import { profileBrowserPids, readViewportWitness } from './browser/cdp.ts';
import { MAX_PROFILE_PIDS, createGeometryResolver, type GeometryResolver as ScreenMapping } from './browser/geometry.ts';
import { createProcedureLibrary } from './procedures/library.ts';
import { createJsonlSink, type MessageSink } from './procedures/messages.ts';
import { createRoutines } from './procedures/routines.ts';
import { computerTools } from './tools.ts';
import type { ActionSink, ToolResult, ToolSpec, TrustedCallerContext } from './tool.ts';
import { createArbiter, withCall } from './desktop/arbiter.ts';
import { createDesktop, windowsNamed, type Desktop } from './desktop/desktop.ts';
import { createDesktopDriver, type DesktopDriver } from './desktop/driver.ts';
import { createScreen, type Screen } from './desktop/screen.ts';
import type { DesktopMode } from './desktop/mode.ts';
import { createInbox } from './inbox/inbox.ts';
import { createAudit, type AuditSink } from './audit.ts';
import { readAppearance } from './appearance.ts';
import { matchAppPolicy, readAppPolicies, type PolicyTarget } from './policies.ts';
import { loadIndex, resolveApp } from './apps/index.ts';
import { runInit, hasInitReport, indexMissing, type InitReport } from './init.ts';

/** A helper as the module uses it; only foreground mode's is started ahead of use. */
type Hands = {
  call(op: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  running(): boolean;
  /** May finish asynchronously: a real helper waits for its exit, a test double may just return. */
  stop(): void | Promise<void>;
} & Partial<Pick<DesktopDriver, 'start'>>;
type Inbox = { status(): { waiting: string[] }; stop(): void };

export interface ComputerUseOptions {
  /** Holds `procedures/` (what the agent learned), `browser/` (its browser profile, with logins) and `messages.jsonl`. */
  dataDir: string;
  /** Overrides for the two folders, e.g. one procedures folder shared by several agents, each with a browser of its own. */
  proceduresDir?: string; profileDir?: string;
  /** Where procedures file the messages they read; `false` files nothing. Default: `<dataDir>/messages.jsonl`. */
  messages?: MessageSink | false;
  /** The name on the banner the user sees while the agent acts on their computer. */
  name?: string;
  /** The taskbar watch that comes with desktop control; `false` leaves it off. */
  inbox?: false | { timeZone?: string; ignore?: string[]; pollMs?: number; quietMs?: number };
  faults?: Faults;
  /** The tool list changed (desktop control turned on or off, foreground mode began or ended). */
  onToolsChanged?(): void;
  /** The user pressed stop on the banner; hosts that keep the stop across restarts persist it here. */
  onHalt?(): void;
  /** 审计写不进去时说的话：审计绝不弄坏一次操作，所以它只能记日志（默认不打扰任何人）。 */
  log?(text: string): void;
  /** Every desktop action as a typed event (queued → … → succeeded), for the renderer; called on the host's event loop. */
  onAction?: ActionSink;
  // For tests and hosts that bring their own.
  browser?: Browser; platform?: NodeJS.Platform;
  desktopDriver?(events: (name: string) => void): Hands;
  foregroundDriver?(events: (name: string) => void): Hands;
  inboxHelper?(): Hands;
}

/** The mailbox keeps at most this many unread inbox words; older ones give way. */
const MAILBOX = 20;

/**
 * How long a shutdown lets the leases it just cancelled finish their own cleanup before it retires the input arbiter
 * (Arbiter.settled in src/desktop/arbiter.ts). A step that is measured and then cancelled settles in about three
 * seconds, so four leaves it room. Running out changes nothing about the fence: the shutdown retires anyway, and the
 * broker orphans whatever lease was still open instead of handing it to another agent.
 */
const SETTLE_BUDGET_MS = 4_000;

/**
 * How the page tools learn where their tab sits on the screen, for one browser that just answered. The browser says
 * which processes serve it, the desktop helper says which of those were started with this agent's own profile and then
 * measures the window the render widget is in, and the tab itself has to witness that it is the visible document of
 * that window (src/browser/cdp.ts). Each layer can say "unknown", and then the step still runs — as real input, audited
 * without a position — instead of inventing a place on the screen.
 *
 * One measurement makes one reading: the port's processes and the helper's verdict about them are asked at most once,
 * shared by the profile check and by the witness step it leads to, and the next measurement asks again.
 */
export function browserGeometry(deps: {
  /** One operation through the desktop helper; only window geometry and the profile check are read here. */
  helper: (op: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** The browser processes serving a port; absent asks the browser itself on that port. */
  browserPids?: (port: number) => Promise<number[]>;
}): (info: GeometryPageInfo) => ScreenMapping {
  const readPids = (port: number) => (deps.browserPids ?? profileBrowserPids)(port);
  return info => {
    let reading: Promise<number[]> | undefined;
    const fresh = () => {
      reading = proveProfile(deps.helper, info, readPids);
      return reading;
    };
    return createGeometryResolver({
      helper: deps.helper,
      profilePids: fresh,
      witness: (targetId, candidate) => readViewportWitness(
        info.cdp,
        { targetId, pid: candidate.pid, layout: candidate.layout },
        { browserPids: () => reading ?? fresh() },
      ),
    });
  };
}

/**
 * This agent's browser processes for one tab's port, proven against the profile it was told to use. The browser names the
 * processes serving the port; the desktop helper reports which of them were started with that profile. Only the proven
 * ids go on. Every doubt — no desktop control, a helper that errors or does not know the operation, an answer that does
 * not add up — leaves the list empty, so the step is audited without a position rather than following a guess. The
 * profile path is a request, never evidence: it is handed to the helper and nothing read back from a command line is
 * echoed or treated as proof of anything beyond "this process was started with that profile".
 */
async function proveProfile(
  helper: (op: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  info: GeometryPageInfo,
  readPids: (port: number) => Promise<number[]>,
): Promise<number[]> {
  let portPids: unknown;
  try { portPids = await readPids(info.port); } catch { return []; }
  // A reading is taken whole or not at all: a value that is not a list, or a list holding one entry that is not a
  // finite positive whole pid, fails the whole measurement. Dropping the unusable entries would let the helper
  // certify a set that is not the set the browser named. Repeated ids are folded only after every entry has passed,
  // and the helper is asked about the deduped set — at most MAX_PROFILE_PIDS of them.
  if (!Array.isArray(portPids)) return [];
  const list: number[] = [];
  for (const one of portPids) {
    if (typeof one !== 'number' || !Number.isFinite(one) || !Number.isInteger(one) || one <= 0) return [];
    list.push(one);
  }
  const asked = [...new Set(list)];
  if (asked.length === 0 || asked.length > MAX_PROFILE_PIDS) return [];
  let answer: unknown;
  try { answer = await helper('browserProfile', { expected: info.profileDir, pids: asked }); } catch { return []; }
  return readProfileAnswer(answer, asked, info.profileDir) ?? [];
}

/**
 * Reads one `browserProfile` answer strictly enough to trust it as a partition of exactly the ids that were asked about.
 * The answer counts only when it says every process was readable and every one of them names the requested profile, when
 * the returned expected path is the same profile that was asked for, when matched and unmatched divide the asked ids into
 * two disjoint groups with nothing foreign and nothing missing, and when at least one id is matched. Anything else — a
 * missing field, a category that overlaps, a pid that was never asked about, a count that does not add up — yields null
 * instead of the largest subset that happens to look right.
 */
export function readProfileAnswer(value: unknown, asked: readonly number[], want: string): number[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const answer = value as Record<string, unknown>;
  if (answer.status !== 'matched') return null;
  if (answer.complete !== true) return null;
  if (!Array.isArray(answer.unknown) || answer.unknown.length !== 0) return null;
  // A reason for being incomplete cannot sit beside a claim of completeness; the helper only names one when it is not.
  if (answer.incompleteReason !== null) return null;
  if (typeof answer.expected !== 'string' || !sameProfile(answer.expected, want)) return null;
  const candidates = answer.candidates;
  if (typeof candidates !== 'number' || !Number.isInteger(candidates) || candidates <= 0) return null;
  const askedSet = new Set(asked);
  if (askedSet.size === 0 || askedSet.size > MAX_PROFILE_PIDS) return null;
  const matched = profilePidList(answer.matched, askedSet);
  const unmatched = profilePidList(answer.unmatched, askedSet);
  if (!matched || !unmatched) return null;
  if (matched.length === 0) return null;
  if (candidates !== matched.length + unmatched.length) return null;
  const seen = new Set<number>([...matched, ...unmatched]);
  if (seen.size !== matched.length + unmatched.length) return null;
  if (seen.size !== askedSet.size) return null;
  return matched;
}

/** One side of the partition: positive integers that were asked about, each at most once. */
function profilePidList(value: unknown, asked: ReadonlySet<number>): number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) return null;
    if (!asked.has(item) || out.includes(item)) return null;
    out.push(item);
  }
  return out;
}

/** Whether two spellings name one profile folder: case, slashes and a trailing separator do not make a different one. */
function sameProfile(answer: string, want: string): boolean {
  const shape = (path: string) => path.replace(/\//g, '\\').replace(/\\+/g, '\\').replace(/\\+$/, '').toLowerCase();
  const left = shape(answer);
  const right = shape(want);
  return left !== '' && left === right;
}

/**
 * Self-evolving computer use, for any agent host. The plugin knows no platform: it gives the agent a browser of its
 * own and page primitives; what the agent learns with them lives in `procedures/`, found again by `computer_use` and
 * replayed by `procedure_run`, repaired by the agent when a site changes. With the user's switch it also uses their
 * computer, through a Windows helper in a child process: in the background, or, while the user keeps foreground mode
 * on, with the real mouse and keyboard through a helper they approved as administrator. While that switch is on, the
 * inbox watches the taskbar too, with a helper of its own.
 */
export function createComputerUse(options: ComputerUseOptions) {
  const faults = options.faults ?? new Faults();
  const library = createProcedureLibrary(options.proceduresDir ?? join(options.dataDir, 'procedures'), { faults });
  /** One machine-wide arbiter for this agent's desktop input; the renderer hears every action through `onAction`. */
  const arbiter = createArbiter({ sink: options.onAction });
  const browser = options.browser ?? createBrowser({
    profileDir: options.profileDir ?? join(options.dataDir, 'browser'),
    faults,
    // This browser's real input belongs to this agent's arbiter: a page made here sends its input through this instance
    // and this instance is the one poisoned when a stop could not be finished cleanly.
    arbiter,
    // A tab's place on screen is measured through the desktop helper; with desktop control off there is none, and the
    // page tools still work — their actions are simply audited without a position.
    geometryResolver: browserGeometry({
      helper: (op, args) => {
        const hands = desktopUse?.driver;
        if (!hands) throw new Error('没有打开桌面控制，量不了浏览器窗口在屏幕上的位置。');
        return hands.call(op, args);
      },
    }),
  });
  const messages = options.messages === false ? undefined : options.messages ?? createJsonlSink(join(options.dataDir, 'messages.jsonl'));
  const routines = createRoutines({ library, browser });
  const companion = () => options.name?.trim() || 'DSH';
  /** 审计：桌面每一步（turns 里记）和工具调用（call 里记）都写进同一个目录，给用户的审计窗口读。 */
  const audit = createAudit(options.log ? { log: options.log } : {});
  /** turns 只看 screenshots() 决定要不要把截图交过来；落不落盘由审计按 appearance 再判一次。 */
  const audited: AuditSink = { record: entry => audit.record(entry), screenshots: () => readAppearance().auditLog.screenshots };
  /** Said with the agent's next result: the user stopped it between steps. */
  const notices: string[] = [];
  /** Inbox words not read yet, and whether the agent has been told there are some. */
  const mailbox: string[] = [];
  let mailHinted = false;
  let desktopUse: { driver: Hands; desktop: Desktop; inbox?: Inbox; foreground?: { driver: Hands; screen: Screen } } | undefined;
  /** 用户自己选了前台模式没有：按应用策略借来的管理员助手不算。 */
  let userForeground = false;
  /** 上一次 open 把 agent 放到哪个模式上；同一个程序后来的动作跟着它走。 */
  let activeMode: 'foreground' | 'background' | undefined;
  /** 借来的模式属于哪个程序：换到别的程序时它不再管用。 */
  let activeFor: string | undefined;
  let cached: { revision: string; tools: ToolSpec[] } | undefined;
  // Switches and shutdowns run one after another: turning desktop off and straight back on must not open a second helper
  // beside one whose exit has not been confirmed. A stop that never confirms keeps the poison and blocks the next start.
  let switching: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = switching.then(work, work);
    switching = run.then(() => undefined, () => undefined);
    return run;
  }

  const signFault = (text: string | undefined) => { if (text) faults.set('desktop-sign', text); else faults.clear('desktop-sign'); };
  const revision = () => `${desktopUse ? 'desktop' : ''}|${desktopUse?.foreground ? 'foreground' : ''}|${desktopUse?.inbox ? 'inbox' : ''}`;
  function changed(before: string): void { if (revision() !== before) options.onToolsChanged?.(); }

  async function stopForeground(): Promise<void> {
    // 先让正在跑的那一步看到取消（helper 写 cancel 标志、补 UP/KEYUP），再等它真正退出。
    arbiter.cancelCurrent();
    activeMode = undefined; activeFor = undefined;
    const foreground = desktopUse?.foreground;
    if (!foreground) return;
    foreground.screen.reset();
    delete desktopUse!.foreground;
    // The helper may still hold a button: stop() raises the cancel flag and waits for its real exit before returning.
    await foreground.driver.stop();
  }
  // What was recorded goes with the switch, like the window that was open.
  async function stopDesktop(): Promise<void> {
    arbiter.cancelCurrent();
    userForeground = false; activeMode = undefined; activeFor = undefined;
    const use = desktopUse, foreground = use?.foreground;
    desktopUse = undefined;
    use?.inbox?.stop(); use?.desktop.reset();
    // Clear the foreground helper and the background one together: both may hold a button, so await their real exit.
    const frontStopped = foreground ? (foreground.screen.reset(), foreground.driver.stop()) : Promise.resolve();
    await Promise.all([frontStopped, use?.driver.stop()]);
    mailbox.length = 0; mailHinted = false; faults.clear('desktop-sign');
    // The desktop helper exiting cleanly says nothing about the browser's input: a page action cut off mid-press leaves
    // the same unknown state, and this one arbiter serves both. So the switch never clears the poison — turning desktop
    // control off and on again is not evidence that anything recovered, and the next input stays blocked until the owner
    // explicitly resets this instance. A switch that leaves no poison behind is still as usable as before.
  }
  /** The user pressed stop. A step that was cut off says so itself; otherwise the agent hears it with its next result. */
  function halt(): void {
    if (!desktopUse) return;
    // A long press/drag lets go at once: the abort raises the helper's cancel flag instead of waiting out its hold.
    arbiter.cancelCurrent();
    const back = desktopUse.desktop.halt(), front = desktopUse.foreground?.screen.halt();
    options.onHalt?.();
    if (back.cut || front?.cut === true) return;
    const recording = back.recording || front?.recording === true;
    notices.push(`（用户刚才按了停下：在用户解除之前，不能再操作用户的电脑。${recording ? '正在录的那一段停在了按下的地方，录到的还能用 desktop review 看。' : ''}先问问用户。）`);
  }
  const events = (name: string) => { if (name === 'stop') halt(); };
  const windows = () => (options.platform ?? process.platform) === 'win32';
  /** The taskbar is watched with a helper of its own, so a slow look never holds up a step the agent takes. */
  function startInbox(settings: Exclude<ComputerUseOptions['inbox'], false | undefined>): Inbox {
    const helper = options.inboxHelper?.() ?? createDesktopDriver({ faults, as: { fault: 'inbox-helper', name: '信箱的助手', stopped: '信箱停了' } });
    const inbox = createInbox({
      helper, faults, timeZone: settings.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      // Kept for the agent to read when it is free: words pushed into the middle of its work would pull it off its task.
      tell: async text => { mailbox.push(text); mailbox.splice(0, mailbox.length - MAILBOX); mailHinted = false; return true; },
      ignore: () => settings.ignore ?? [], ...(settings.pollMs === undefined ? {} : { pollMs: settings.pollMs }), ...(settings.quietMs === undefined ? {} : { quietMs: settings.quietMs }),
    });
    inbox.start();
    return { status: () => inbox.status(), stop: () => { inbox.stop(); helper.stop(); } };
  }
  function readMail(): string | undefined {
    if (!mailbox.length) return undefined;
    const text = mailbox.join('\n\n');
    mailbox.length = 0; mailHinted = false;
    return text;
  }
  function tools(): ToolSpec[] {
    const current = revision();
    if (cached?.revision === current) return cached.tools;
    const list = computerTools({
      browser, library, ...(messages ? { messages } : {}), routines: () => routines(), health: () => faults.list(),
      init: async input => {
        const report = await init(input);
        return `${report.ok ? '初始化完成，全部通过。' : '初始化完成，有失败项。'}\n报告：${report.reportMarkdown ?? report.reportJson ?? '（没有写报告）'}`;
      },
      mode: desktopMode, setMode: setDesktopMode, pick,
      ...(desktopUse ? { desktop: desktopUse.desktop } : {}), ...(desktopUse?.foreground ? { screen: desktopUse.foreground.screen } : {}),
      ...(desktopUse?.inbox ? { inbox: readMail } : {}),
    });
    cached = { revision: current, tools: list };
    return list;
  }
  /** What the agent should hear besides the result itself: a stop it missed, and that the inbox has something. */
  function asides(): string {
    const lines = notices.splice(0);
    if (mailbox.length && !mailHinted) { lines.push('（信箱有新动静，手头的事做完了用 inbox_read 看。）'); mailHinted = true; }
    return lines.length ? `\n${lines.join('\n')}` : '';
  }

  /** Which of the three states the user's computer is in now. */
  function desktopMode(): DesktopMode {
    if (!desktopUse) return 'off';
    // 按应用策略借来的管理员助手不算用户选了前台：全局模式始终是用户选的那个。
    return userForeground && desktopUse.foreground ? 'foreground' : 'background';
  }
  /** Desktop control, on or off; the helper itself starts only when the agent first acts. Returns why it could not, or nothing. */
  async function setDesktop(on: boolean): Promise<string | undefined> {
    return serial(async () => {
      const before = revision();
      if (!on) { await stopDesktop(); faults.clear('desktop'); changed(before); return undefined; }
      if (desktopUse) return undefined;
      if (!windows()) { faults.set('desktop', '桌面控制目前只支持 Windows'); return '桌面控制目前只支持 Windows'; }
      const driver = options.desktopDriver?.(events) ?? createDesktopDriver({ faults, events, arbiter });
    // The agent's own browser (CDP) opens the page behind everything else, so opening a URL never takes the user's focus.
    const desktop = createDesktop({
      driver, companion, signFault, audit: audited,
      // 软件位置表只在启动时才有，读不到就让 launch 回到开始菜单那条旧路。
      apps: { resolve: name => { try { const index = loadIndex(options.dataDir); return index ? resolveApp(name, index) : undefined; } catch { return undefined; } } },
      browse: url => browser.run(async page => {
        await page.open(url);
        const title = await page.evaluate('return document.title', {});
        return typeof title === 'string' && title ? title : undefined;
      }),
    });
      desktopUse = { driver, desktop, ...(options.inbox === false ? {} : { inbox: startInbox(options.inbox ?? {}) }) };
      faults.clear('desktop');
      changed(before);
      return undefined;
    });
  }
  /**
   * Foreground mode, on top of desktop control: turning it on asks the user, through UAC, to let a helper run as
   * administrator, and the desktop tool works the whole screen until it is turned off or the process ends. Nothing
   * keeps it across a restart, so each time it is on the user has approved it. Returns why it could not, or nothing.
   */
  async function startForeground(): Promise<string | undefined> {
    const before = revision();
    if (!desktopUse) return '先打开桌面控制';
    if (desktopUse.foreground) return undefined;
    const driver = options.foregroundDriver?.(events) ?? createDesktopDriver({ faults, events, elevated: true, arbiter });
    try { await driver.start?.(); }
    catch (error) { await driver.stop(); return errorText(error); }
    if (!desktopUse) { await driver.stop(); return '桌面控制已经关掉了'; }
    desktopUse.foreground = { driver, screen: createScreen({ hands: driver, eyes: desktopUse.driver, companion, signFault, audit: audited }) };
    changed(before);
    return undefined;
  }
  /** The user's own switch: remembered even when the UAC request is refused, in which case background mode stays on. */
  async function setForeground(on: boolean): Promise<string | undefined> {
    return serial(async () => {
      const before = revision();
      if (!on) { userForeground = false; await stopForeground(); changed(before); return undefined; }
      const why = await startForeground();
      userForeground = !why;
      return why;
    });
  }
  /**
   * Which mode this step runs in: a per-app policy speaks first, and without one the user's global mode stands.
   * A policy that says foreground borrows the administrator helper only for as long as the agent stays on that
   * program, so the global switch the user sees never moves; a refusal makes this one step fail, as the contract says.
   */
  async function decideMode(input: Record<string, unknown>): Promise<'foreground' | 'background'> {
    const global: 'foreground' | 'background' = userForeground ? 'foreground' : 'background';
    if (!desktopUse) return global;
    const policies = readAppPolicies();
    const action = typeof input.action === 'string' ? input.action : '';
    const named = typeof input.app === 'string' ? input.app.trim() : '';
    const surface = activeMode === 'foreground' ? desktopUse.foreground?.screen : desktopUse.desktop;
    const about = surface?.about?.();
    let target: PolicyTarget | undefined = named ? { app: named } : about ? { app: about.app, exe: about.exe, title: about.title } : undefined;
    // Which program this step is on: the one it names, else the one the agent is already on. A step on the program
    // whose policy chose the mode keeps it, so a click after an open neither asks for UAC again nor drops to desktop.
    const who = named || target?.app;
    const same = activeMode !== undefined && who !== undefined && who === activeFor;
    if (!policies.length || !target) return same || who === undefined ? (activeMode ?? global) : global;
    // A program not open yet cannot be told by its executable: look it up in the window list so exe: policies know it too.
    if (named && !target.exe) {
      try {
        const found = windowsNamed(await desktopUse.desktop.windows(), named)[0];
        if (found) target = { app: named, exe: found.exe, title: found.title };
      } catch { /* nothing listed: match by the agent's name alone */ }
    }
    const decided = matchAppPolicy(policies, target)?.mode;
    // 换到别的程序就是换了个地方：策略说什么就是什么，没有策略就回到全局模式，借来的模式不跟过去。
    if (action === 'open' || !same) {
      // 借来的管理员助手只服务于那个程序，离开就关掉，不让它一直以管理员身份闲着。
      // 借来的管理员助手必须先确认退出，下一步才可能换程序或再开一个：不等它就换会造成两个 helper 同时注入。
      if (activeMode === 'foreground' && !userForeground && decided !== 'foreground') await serial(() => stopForeground());
      activeMode = decided;
      activeFor = decided ? who : undefined;
    }
    return decided ?? activeMode ?? global;
  }
  /** Hands this step to the mode the policies chose; a foreground policy that cannot start its helper fails this step. */
  async function pick(input: Record<string, unknown>): Promise<{ live: Pick<Desktop, 'act'>; screen: boolean } | undefined> {
    if (!desktopUse) return undefined;
    const mode = await decideMode(input);
    if (mode === 'foreground' && !desktopUse.foreground) {
      const why = await serial(() => startForeground());
      if (why) throw new Error(`这个程序按你的设置要用前台模式，但没能启动管理员助手：${why}`);
    }
    if (mode === 'foreground' && desktopUse.foreground) return { live: desktopUse.foreground.screen, screen: true };
    return { live: desktopUse.desktop, screen: false };
  }
  /**
   * One switch for the three states. `foreground` asks the user through UAC; when that request is refused the
   * background mode stays on, so a refusal never leaves the agent without the computer it already had.
   */
  async function setDesktopMode(mode: DesktopMode): Promise<string | undefined> {
    if (mode === 'off') { await setDesktop(false); faults.clear('foreground-mode'); return undefined; }
    const why = await setDesktop(true);
    if (why) return why;
    if (mode === 'background') { faults.clear('foreground-mode'); return await setForeground(false); }
    const refused = await setForeground(true);
    // A refused UAC prompt is worth saying out loud; the background mode the agent already had stays on.
    if (refused) faults.set('foreground-mode', `前台模式没有打开，用的是后台模式：${refused}`);
    else faults.clear('foreground-mode');
    return refused;
  }

  /**
   * 工具层的一条审计：page_*、computer_use、procedure_*、inbox_read、desktop_mode 都是 agent 在用户这边做的事。
   * desktop 自己的每一步在动作层已经记过（turns 里），这里不重复。
   */
  function auditedTool(name: string, args: Record<string, unknown>, ok: boolean, text: string): void {
    if (name === 'desktop') return;
    try {
      audit.record({
        at: new Date(), tool: name, action: toolPhrase(name, args), app: '', ok, result: text,
        reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : undefined,
      });
    } catch { /* 审计坏了也不能弄坏一次工具调用 */ }
  }

  /** 用户主动 init：临时把桌面控制打开（不启动助手），这样桌面自测也有东西可测。 */
  async function init(opts: { full?: boolean; selftest?: boolean; allowNetwork?: boolean } = {}): Promise<InitReport> {
    const was = desktopUse !== undefined;
    if (!was) await setDesktop(true);
    try {
      return await runInit({
        dataDir: options.dataDir, browser, ...(desktopUse ? { desktop: desktopUse.desktop } : {}),
        full: opts.full ?? true, selftest: opts.selftest ?? true, allowNetwork: opts.allowNetwork, report: 'init', log: options.log,
      });
    } finally {
      if (!was) await setDesktop(false);
    }
  }
  /** DSH 每次启动时跑：总是增量扫描；第一次（还没有 init 报告）补一次完整扫描和自测。 */
  async function autoInit(): Promise<InitReport | undefined> {
    if (process.env.EVOLUTION_CU_NO_AUTO_INIT === '1') return undefined;
    const first = indexMissing(options.dataDir) || !hasInitReport(options.dataDir);
    options.log?.(first ? '第一次启动：完整扫描软件位置并自测…' : '启动检查：增量扫描软件位置…');
    try {
      return await runInit({
        dataDir: options.dataDir, browser, ...(desktopUse ? { desktop: desktopUse.desktop } : {}),
        full: first, selftest: first, allowNetwork: false, report: 'startup', alsoInitReport: first, log: options.log,
      });
    } catch (error) {
      options.log?.(`启动检查失败：${errorText(error)}`);
      return undefined;
    }
  }

  return {
    faults, library,
    init,
    autoInit,
    /** Capability bit: `call` threads the host-supplied trusted caller into every tool, and input arbitration keys identity off it. A gateway must refuse a runtime without it rather than call it un-attributed. */
    acceptsCaller: true as const,
    /** The tools as they stand now; the list changes only with the user's switches. */
    tools,
    /** Runs one tool by name. A failure rejects with the reason the agent should read. */
    async call(name: string, args: unknown, signal: AbortSignal = new AbortController().signal, caller?: TrustedCallerContext): Promise<ToolResult> {
      const tool = tools().find(entry => entry.name === name);
      if (!tool) throw new Error(`没有 ${name} 这个工具${name === 'desktop' ? '：桌面控制没有打开，要请用户打开' : ''}`);
      const asked = (args ?? {}) as Record<string, unknown>;
      let result: ToolResult;
      // The trusted caller (when the host supplies one) and the call's one id scope the whole call, so every phase of an
      // action carries the same requestId and the agent identity is never taken from tool arguments.
      try {
        result = await withCall(caller, signal, () => tool.execute(args as Record<string, unknown>, { signal, ...(caller ? { caller } : {}) }), arbiter);
      } catch (error) { auditedTool(name, asked, false, errorText(error)); throw new Error(errorText(error) + asides(), { cause: error }); }
      auditedTool(name, asked, true, result.text);
      return { ...result, text: result.text + asides() };
    },
    desktopOn: () => desktopUse !== undefined,
    foregroundOn: () => userForeground,
    /** off / background / foreground, as one word rather than something the host has to infer. */
    desktopMode,
    setDesktop,
    setForeground,
    setDesktopMode,
    /** Stops the agent as the banner's stop button does: every action on the computer is refused until `release`. */
    halt,
    /** The user lets the agent use the computer again after a stop. */
    release(): void { desktopUse?.desktop.release(); desktopUse?.foreground?.screen.release(); },
    halted: () => desktopUse?.desktop.halted() === true || desktopUse?.foreground?.screen.halted() === true,
    /** The routine on the host's own schedule: every `onAlarm` procedure once, a line each; nothing when there are none. */
    routines: () => routines(),
    status: () => ({
      browser: browser.status(), dir: library.dir,
      categories: library.categories().map(({ name, guide }) => ({
        name, guide: guide.trim() !== '',
        operations: library.list().filter(entry => entry.procedure.category === name).map(({ procedure, path }) => ({ name: procedure.name, description: procedure.description, onAlarm: procedure.onAlarm === true, last: library.lastRun(path) ?? null })),
      })),
      desktop: desktopUse ? { running: desktopUse.driver.running(), mode: desktopMode(), foreground: userForeground, halted: desktopUse.desktop.halted(), recent: (desktopUse.foreground?.screen ?? desktopUse.desktop).recent().slice(0, 5) } : null,
      inbox: desktopUse?.inbox ? { ...desktopUse.inbox.status(), unread: mailbox.length } : null,
      faults: faults.list(),
    }),
    /** Brings the agent's browser window forward, for the user to log in or watch. */
    show: () => browser.show(),
    async stop(): Promise<void> {
      // Before the first await: a stop takes no new input from here on. A step whose outcome was already unknown keeps
      // the reason it carries — that poison says more than shutting down does. Otherwise the instance is marked as
      // closing, so work still queued behind this shutdown can no longer be granted and reach the helper while the
      // browser and its helpers are being put away. Everything unfinished is cancelled right here, synchronously: the
      // step in flight must not be overtaken by a step that was only waiting for a turn.
      const closing = '这个实例正在关闭，新的输入没有开始。';
      if (arbiter.poisonedReason() === undefined) arbiter.poison(closing);
      arbiter.cancelCurrent();
      try {
        // Waited for: a browser gives the step in flight its chance to put the button back and settle on a live
        // connection, so the arbiter below is disposed only after that input has really finished.
        await browser.stop();
        await serial(() => stopDesktop());
      } finally {
        // In the finally, so a browser or desktop stop that fails still ends the same way: this instance takes no more
        // input either way, and leaving the arbiter alive would keep a broker connection that nobody will ever use.
        // Bounded wait before the arbiter retires. dispose() sets `retired`, which makes a lease that is still unwinding
        // skip its release: retiring first would leave the broker holding a lease nobody ever hands back, and the next
        // agent would wait on it. This is observational only — it takes no lease, sends the broker nothing and clears no
        // poison — so a budget that expires still ends in the same retire-and-fence below, and a wait that fails on its
        // own (it has no way to fail today) is not allowed to skip that retire: the outcome of the stop stays the outcome
        // of the stops above.
        await arbiter.settled(SETTLE_BUDGET_MS).catch(() => false);
        // Last of all, once this agent's own work has been stopped and its helpers have exited: the arbiter closes its
        // broker connection for good. It keeps any poison it carries, cancels what it still had queued, and never sends
        // the broker an abandon — a lease whose state is unknown stays closed instead of being handed to somebody else.
        arbiter.dispose();
        library.clearFaults();
        faults.clear('computer', 'desktop', 'foreground-mode');
      }
    },
  };
}
/** 审计里的 action：工具名加上这次用的参数；中文说法在 audit.ts 那边生成。 */
function toolPhrase(name: string, args: Record<string, unknown>): string {
  const said = (key: string) => typeof args[key] === 'string' ? args[key] as string : '';
  const shown = (key: string) => args[key] === undefined || args[key] === null ? '' : String(args[key]);
  switch (name) {
    case 'page_open': return `page_open ${said('url')}`.trim();
    case 'page_read': return `page_read ${[shown('page'), shown('ref')].filter(Boolean).join(' ')}`.trim();
    case 'page_click': return `page_click ${shown('ref')}`.trim();
    // 在页面里打的字可能是密码，审计只留编号，不留内容。
    case 'page_type': return `page_type ${shown('ref')}`.trim();
    case 'page_press': return `page_press ${said('key')}`.trim();
    case 'page_scroll': return `page_scroll ${said('direction')} ${shown('ref')}`.trim();
    case 'page_wait': return `page_wait ${said('text').slice(0, 40)} ${shown('ref')}`.trim();
    case 'page_shot': return 'page_shot';
    case 'page_eval': return 'page_eval';
    case 'computer_use': return `computer_use ${said('target')}`.trim();
    case 'procedure_run': return `procedure_run ${said('path')}`.trim();
    case 'procedure_save': return 'procedure_save';
    case 'procedure_note': return `procedure_note ${said('category')}`.trim();
    case 'procedure_routines': return 'procedure_routines';
    case 'inbox_read': return 'inbox_read';
    case 'desktop_mode': return `desktop_mode ${said('mode')}`.trim();
    default: return name;
  }
}
export type ComputerUse = ReturnType<typeof createComputerUse>;
