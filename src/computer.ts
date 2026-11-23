import { join } from 'node:path';
import { Faults, errorText } from './shared/faults.ts';
import { createBrowser, type Browser } from './browser/browser.ts';
import { createProcedureLibrary } from './procedures/library.ts';
import { createJsonlSink, type MessageSink } from './procedures/messages.ts';
import { createRoutines } from './procedures/routines.ts';
import { computerTools } from './tools.ts';
import type { ToolResult, ToolSpec } from './tool.ts';
import { createDesktop, type Desktop } from './desktop/desktop.ts';
import { createDesktopDriver, type DesktopDriver } from './desktop/driver.ts';
import { createScreen, type Screen } from './desktop/screen.ts';
import type { DesktopMode } from './desktop/mode.ts';
import { createInbox } from './inbox/inbox.ts';

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
  const companion = () => options.name?.trim() || 'AI';
  /** Said with the agent's next result: the user stopped it between steps. */
  const notices: string[] = [];
  /** Inbox words not read yet, and whether the agent has been told there are some. */
  const mailbox: string[] = [];
  let mailHinted = false;
  let desktopUse: { driver: Hands; desktop: Desktop; inbox?: Inbox; foreground?: { driver: Hands; screen: Screen } } | undefined;
  let cached: { revision: string; tools: ToolSpec[] } | undefined;

  const signFault = (text: string | undefined) => { if (text) faults.set('desktop-sign', text); else faults.clear('desktop-sign'); };
  const revision = () => `${desktopUse ? 'desktop' : ''}|${desktopUse?.foreground ? 'foreground' : ''}|${desktopUse?.inbox ? 'inbox' : ''}`;
  function changed(before: string): void { if (revision() !== before) options.onToolsChanged?.(); }

  function stopForeground(): void {
    const foreground = desktopUse?.foreground;
    if (!foreground) return;
    foreground.screen.reset(); foreground.driver.stop();
    delete desktopUse!.foreground;
  }
  // What was recorded goes with the switch, like the window that was open.
  function stopDesktop(): void {
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
      mode: desktopMode, setMode: setDesktopMode,
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
    if (desktopUse?.foreground) return 'foreground';
    return desktopUse ? 'background' : 'off';
  }
  /** Desktop control, on or off; the helper itself starts only when the agent first acts. Returns why it could not, or nothing. */
  function setDesktop(on: boolean): string | undefined {
    const before = revision();
    if (!on) { stopDesktop(); faults.clear('desktop'); changed(before); return undefined; }
    if (desktopUse) return undefined;
    if (!windows()) { faults.set('desktop', '桌面控制目前只支持 Windows'); return '桌面控制目前只支持 Windows'; }
    const driver = options.desktopDriver?.(events) ?? createDesktopDriver({ faults, events });
    const desktop = createDesktop({ driver, companion, signFault });
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
  async function setForeground(on: boolean): Promise<string | undefined> {
    const before = revision();
    if (!on) { stopForeground(); changed(before); return undefined; }
    if (!desktopUse) return '先打开桌面控制';
    if (desktopUse.foreground) return undefined;
    const driver = options.foregroundDriver?.(events) ?? createDesktopDriver({ faults, events, elevated: true });
    try { await driver.start?.(); }
    catch (error) { driver.stop(); return errorText(error); }
    if (!desktopUse) { driver.stop(); return '桌面控制已经关掉了'; }
    desktopUse.foreground = { driver, screen: createScreen({ hands: driver, eyes: desktopUse.driver, companion, signFault }) };
    changed(before);
    return undefined;
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

  return {
    faults, library,
    /** The tools as they stand now; the list changes only with the user's switches. */
    tools,
    /** Runs one tool by name. A failure rejects with the reason the agent should read. */
    async call(name: string, args: unknown, signal: AbortSignal = new AbortController().signal): Promise<ToolResult> {
      const tool = tools().find(entry => entry.name === name);
      if (!tool) throw new Error(`没有 ${name} 这个工具${name === 'desktop' ? '：桌面控制没有打开，要请用户打开' : ''}`);
      let result: ToolResult;
      try { result = await tool.execute(args as Record<string, unknown>, { signal }); }
      catch (error) { throw new Error(errorText(error) + asides(), { cause: error }); }
      return { ...result, text: result.text + asides() };
    },
    desktopOn: () => desktopUse !== undefined,
    foregroundOn: () => desktopUse?.foreground !== undefined,
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
      desktop: desktopUse ? { running: desktopUse.driver.running(), mode: desktopMode(), foreground: desktopUse.foreground !== undefined, halted: desktopUse.desktop.halted(), recent: (desktopUse.foreground?.screen ?? desktopUse.desktop).recent().slice(0, 5) } : null,
      inbox: desktopUse?.inbox ? { ...desktopUse.inbox.status(), unread: mailbox.length } : null,
      faults: faults.list(),
    }),
    /** Brings the agent's browser window forward, for the user to log in or watch. */
    show: () => browser.show(),
    stop: () => { browser.stop(); stopDesktop(); library.clearFaults(); faults.clear('computer', 'desktop', 'foreground-mode'); },
  };
}
export type ComputerUse = ReturnType<typeof createComputerUse>;
