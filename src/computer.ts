import { join } from 'node:path';
import { Faults, errorText } from './shared/faults.ts';
import { createBrowser, type Browser } from './browser/browser.ts';
import { createProcedureLibrary } from './procedures/library.ts';
import { createJsonlSink, type MessageSink } from './procedures/messages.ts';
import { createRoutines } from './procedures/routines.ts';
import { computerTools } from './tools.ts';
import type { ToolResult, ToolSpec } from './tool.ts';
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
type Hands = Pick<DesktopDriver, 'call' | 'running' | 'stop'> & Partial<Pick<DesktopDriver, 'start'>>;
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
  // For tests and hosts that bring their own.
  browser?: Browser; platform?: NodeJS.Platform;
  desktopDriver?(events: (name: string) => void): Hands;
  foregroundDriver?(events: (name: string) => void): Hands;
  inboxHelper?(): Hands;
}

/** The mailbox keeps at most this many unread inbox words; older ones give way. */
const MAILBOX = 20;

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
  const browser = options.browser ?? createBrowser({ profileDir: options.profileDir ?? join(options.dataDir, 'browser'), faults });
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

  const signFault = (text: string | undefined) => { if (text) faults.set('desktop-sign', text); else faults.clear('desktop-sign'); };
  const revision = () => `${desktopUse ? 'desktop' : ''}|${desktopUse?.foreground ? 'foreground' : ''}|${desktopUse?.inbox ? 'inbox' : ''}`;
  function changed(before: string): void { if (revision() !== before) options.onToolsChanged?.(); }

  function stopForeground(): void {
    activeMode = undefined; activeFor = undefined;
    const foreground = desktopUse?.foreground;
    if (!foreground) return;
    foreground.screen.reset(); foreground.driver.stop();
    delete desktopUse!.foreground;
  }
  // What was recorded goes with the switch, like the window that was open.
  function stopDesktop(): void {
    userForeground = false; activeMode = undefined; activeFor = undefined;
    stopForeground(); desktopUse?.inbox?.stop(); desktopUse?.desktop.reset(); desktopUse?.driver.stop(); desktopUse = undefined;
    mailbox.length = 0; mailHinted = false; faults.clear('desktop-sign');
  }
  /** The user pressed stop. A step that was cut off says so itself; otherwise the agent hears it with its next result. */
  function halt(): void {
    if (!desktopUse) return;
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
  function setDesktop(on: boolean): string | undefined {
    const before = revision();
    if (!on) { stopDesktop(); faults.clear('desktop'); changed(before); return undefined; }
    if (desktopUse) return undefined;
    if (!windows()) { faults.set('desktop', '桌面控制目前只支持 Windows'); return '桌面控制目前只支持 Windows'; }
    const driver = options.desktopDriver?.(events) ?? createDesktopDriver({ faults, events });
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
    const driver = options.foregroundDriver?.(events) ?? createDesktopDriver({ faults, events, elevated: true });
    try { await driver.start?.(); }
    catch (error) { driver.stop(); return errorText(error); }
    if (!desktopUse) { driver.stop(); return '桌面控制已经关掉了'; }
    desktopUse.foreground = { driver, screen: createScreen({ hands: driver, eyes: desktopUse.driver, companion, signFault, audit: audited }) };
    changed(before);
    return undefined;
  }
  /** The user's own switch: remembered even when the UAC request is refused, in which case background mode stays on. */
  async function setForeground(on: boolean): Promise<string | undefined> {
    const before = revision();
    if (!on) { userForeground = false; stopForeground(); changed(before); return undefined; }
    const why = await startForeground();
    userForeground = !why;
    return why;
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
      if (activeMode === 'foreground' && !userForeground && decided !== 'foreground') stopForeground();
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
      const why = await startForeground();
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
    if (mode === 'off') { setDesktop(false); faults.clear('foreground-mode'); return undefined; }
    const why = setDesktop(true);
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
    if (!was) setDesktop(true);
    try {
      return await runInit({
        dataDir: options.dataDir, browser, ...(desktopUse ? { desktop: desktopUse.desktop } : {}),
        full: opts.full ?? true, selftest: opts.selftest ?? true, allowNetwork: opts.allowNetwork, report: 'init', log: options.log,
      });
    } finally {
      if (!was) setDesktop(false);
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
        full: first, selftest: first, allowNetwork: false, report: 'startup', log: options.log,
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
    /** The tools as they stand now; the list changes only with the user's switches. */
    tools,
    /** Runs one tool by name. A failure rejects with the reason the agent should read. */
    async call(name: string, args: unknown, signal: AbortSignal = new AbortController().signal): Promise<ToolResult> {
      const tool = tools().find(entry => entry.name === name);
      if (!tool) throw new Error(`没有 ${name} 这个工具${name === 'desktop' ? '：桌面控制没有打开，要请用户打开' : ''}`);
      const asked = (args ?? {}) as Record<string, unknown>;
      let result: ToolResult;
      try { result = await tool.execute(args as Record<string, unknown>, { signal }); }
      catch (error) { auditedTool(name, asked, false, errorText(error)); throw new Error(errorText(error) + asides(), { cause: error }); }
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
    stop: () => { browser.stop(); stopDesktop(); library.clearFaults(); faults.clear('computer', 'desktop', 'foreground-mode'); },
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
