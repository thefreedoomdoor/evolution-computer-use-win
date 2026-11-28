import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { errorText, type Faults } from '../shared/faults.ts';
import { CancelledError, UncertainError, currentAction, currentSignal, emitFor, withGlobalLease, type ActionScope, type Arbiter } from './arbiter.ts';

export type DesktopDriver = ReturnType<typeof createDesktopDriver>;

/** A call that hangs this long has an unknown outcome; the helper is killed rather than trusted again. */
const CALL_MS = 30_000;
/** How long the user has to answer the UAC prompt that starts foreground mode's helper. */
const ELEVATE_MS = 120_000;
/** Starts that end before any reply, in a row, after which it stays down until the switch is turned off and on. */
const MAX_FAILED_STARTS = 2;
/** After a hung call the next one waits this long for the old helper's exit; past it, new input is refused rather than sent alongside a possibly live one. */
const RETIRE_MS = 5_000;
// Shipped as source (package.json `files`), so the same path holds from `src/` and from the built `lib/`.
export const HELPER_SCRIPT = fileURLToPath(new URL('../../src/desktop/win32.ps1', import.meta.url));
const POWERSHELL = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_SCRIPT];
/** Words the elevated helper's launcher says when the user declines the UAC prompt (English and Chinese Windows). */
const DECLINED = /canceled by the user|cancelled by the user|已被用户取消|操作已取消/i;

interface Pending { resolve(data: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
/** One running helper as the driver sees it: lines go in, lines come out, and it says once when it is gone. */
interface Link { write(line: string): void; end(): void; /** Closes input so the helper finishes the current call and exits on its own; may be absent. */ soft?(): void }

/**
 * The Windows helper (`win32.ps1`) in a child process, started on first use and ended with the module. A crash or a
 * hung call fails what is pending, is a fault, and the next call starts it again; starts that keep dying stop there,
 * so a broken machine is said once instead of relaunched on every step. The agent's inbox runs a helper of its own (`as`), so
 * a slow step of the agent's and a look at the notifications never wait on each other.
 *
 * `elevated` is foreground mode's helper: started as administrator, so the user approves it once through UAC. A UAC
 * prompt cannot share stdin and stdout, so it dials back to a pipe opened here and proves itself with a one-time key.
 * It is never restarted behind the user's back: once it is gone, foreground mode is over until it is turned on again.
 */
export function createDesktopDriver(deps: { faults: Faults; command?: string[]; callMs?: number; retireMs?: number; as?: { fault: string; name: string; stopped: string }; events?(name: string, data?: Record<string, unknown>): void; elevated?: boolean; elevateMs?: number; arbiter?: Arbiter }) {
  const [program, ...programArgs] = deps.command ?? POWERSHELL, callMs = deps.callMs ?? CALL_MS;
  const { fault: FAULT, name, stopped } = deps.as ?? (deps.elevated
    ? { fault: 'computer-foreground', name: '前台模式的助手', stopped: '前台模式关掉了' }
    : { fault: 'computer-desktop', name: '桌面控制的助手', stopped: '桌面控制关掉了' });
  const pending = new Map<number, Pending>();
  let link: Link | undefined, starting: Promise<Link> | undefined, nextId = 1, failedStarts = 0, answered = false, halted: string | undefined;
  // A helper that timed out is being ended: its own exit line, not the kill request, is what lets another one start.
  let retiring: Promise<void> | undefined, childExit: Promise<void> | undefined, markExited: (() => void) | undefined;
  // The scope a live drag streams into: its progress lines arrive on the helper's readline callbacks, outside the action's async context.
  let streaming: ActionScope | undefined;
  // The cancel flag of the input in flight: stop() raises it before ending the helper so a held button/key is let go first.
  let cancelFile: string | undefined;
  // An intentional stop: its exit is expected, not a lost helper, and calls wait for it before handing the lease back.
  let stopping: Link | undefined;
  let stopWait: Promise<boolean> | undefined;
  // A start in flight (UAC can take minutes): stop() invalidates it, so a helper that arrives after the switch was
  // turned off ends itself instead of becoming a second injector behind the next start.
  let startSeq = 0;
  const lease = <T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => deps.arbiter ? deps.arbiter.withGlobalLease(fn, signal) : withGlobalLease(fn, signal);

  function failAll(why: string, uncertain = false, cancelled = false): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(uncertain ? new UncertainError(why) : cancelled ? new CancelledError(why) : new Error(why));
      pending.delete(id);
    }
  }
  function lost(gone: Link, why: string): void {
    // stop() has already forgotten the link, so the expected exit is recognised by its own marker first.
    if (stopping === gone) {
      if (link === gone) link = undefined;
      stopping = undefined;
      markExited?.();
      markExited = undefined;
      if (childExit !== undefined) childExit = undefined;
      return;
    }
    if (link !== gone) return;
    link = undefined;
    if (deps.elevated) halted = `${name}退出了：${why}。要再用前台模式，请用户把它关掉再打开（会再确认一次管理员权限）`;
    else if (!answered && ++failedStarts >= MAX_FAILED_STARTS) halted = `${name}起不来：${why}`;
    deps.faults.set(FAULT, halted ?? `${name}退出了：${why}，下一次用时重新启动`);
    failAll(`${name}退出了：${why}`, true);
  }
  function settle(line: string): void {
    let message: { id?: number; data?: Record<string, unknown>; error?: string; event?: string; sx?: number; sy?: number };
    try { message = JSON.parse(line) as typeof message; } catch { return; }
    // Not an answer: something the helper saw happen, such as the user stopping it or a drag passing through a point.
    if (typeof message.event === 'string') {
      if (message.event === 'progress' && streaming) {
        const x = Number(message.sx), y = Number(message.sy);
        if (Number.isFinite(x) && Number.isFinite(y)) emitFor(streaming, 'progress', { space: 'physical', sampleMs: Date.now(), to: { x, y }, sampleSource: 'client-to-screen' });
        return;
      }
      deps.events?.(message.event, message as Record<string, unknown>); return;
    }
    const entry = message.id === undefined ? undefined : pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id!); clearTimeout(entry.timer);
    answered = true; failedStarts = 0; deps.faults.clear(FAULT);
    if (message.error !== undefined) entry.reject(new Error(message.error)); else entry.resolve(message.data ?? {});
  }

  function startChild(): Link {
    answered = false;
    const started: ChildProcess = spawn(program!, programArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    const made: Link = { write: line => started.stdin!.write(line), end: () => { started.stdin?.end(); started.kill(); }, soft: () => { try { started.stdin?.end(); } catch { /* already gone */ } } };
    started.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-500); });
    createInterface({ input: started.stdout! }).on('line', settle);
    started.stdin!.on('error', () => { /* the exit handler says why it went away */ });
    childExit = new Promise<void>(resolve => { markExited = resolve; });
    const gone = (why: string) => { lost(made, why); markExited?.(); markExited = undefined; childExit = undefined; };
    started.on('error', error => gone(errorText(error)));
    started.on('exit', (code, signal) => gone(stderr.trim().split('\n').at(-1)?.trim() || `退出码 ${code ?? signal}`));
    return made;
  }
  /** Opens a pipe only this run knows, starts the helper through UAC, and takes the first connection that says the key. */
  function startElevated(): Promise<Link> {
    answered = false;
    const pipe = `evolution-cu-${randomBytes(16).toString('hex')}`, key = randomBytes(24).toString('hex');
    const elevateMs = deps.elevateMs ?? ELEVATE_MS;
    return new Promise<Link>((resolve, reject) => {
      let settled = false;
      const server: Server = createServer((socket: Socket) => {
        if (settled) { socket.destroy(); return; }
        let proven = false;
        createInterface({ input: socket }).on('line', line => {
          if (proven) { settle(line); return; }
          let hello: unknown;
          try { hello = (JSON.parse(line) as { hello?: unknown }).hello; } catch { /* not the helper */ }
          // Anything else that found the pipe is not the helper this run started.
          if (hello !== key || settled) { socket.destroy(); return; }
          proven = true; settled = true; clearTimeout(timer); server.close();
          const made: Link = { write: text => socket.write(text), end: () => socket.destroy(), soft: () => { try { socket.end(); } catch { /* already gone */ } } };
          childExit = new Promise<void>(resolve => { markExited = resolve; });
          const gone = () => { lost(made, '和插件的连接断了'); markExited?.(); markExited = undefined; childExit = undefined; };
          socket.on('close', gone);
          socket.on('error', () => { /* close follows */ });
          resolve(made);
        });
      });
      const fail = (why: string) => { if (settled) return; settled = true; clearTimeout(timer); server.close(); reject(new Error(why)); };
      const timer = setTimeout(() => fail(`${Math.round(elevateMs / 1000)} 秒内没有确认管理员权限`), elevateMs);
      server.on('error', error => fail(errorText(error)));
      server.listen(`\\\\.\\pipe\\${pipe}`, () => {
        // The launcher only asks Windows to start the helper as administrator; the helper itself dials the pipe.
        const quoted = (text: string) => `'${text.replace(/'/g, "''")}'`;
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `"${HELPER_SCRIPT}"`, '-Pipe', pipe, '-Key', key];
        const launcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList ${args.map(quoted).join(',')}`], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        let said = '';
        launcher.stderr!.on('data', (chunk: Buffer) => { said += chunk.toString('utf8'); });
        launcher.on('error', error => fail(errorText(error)));
        launcher.on('exit', code => { if (code) fail(DECLINED.test(said) ? '用户没有同意管理员权限' : said.trim().split('\n').find(Boolean)?.trim() || `启动失败（退出码 ${code}）`); });
      });
    });
  }
  function send(target: Link, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const said = `助手 ${callMs / 1000} 秒没有回应，结果不明：先 desktop shot 看看现在的样子`;
        const ended = link === target ? childExit : undefined;
        if (link === target) { target.end(); lost(target, '一次调用卡住了'); if (ended) retiring = ended; }
        // The outcome is unknown either way; wait for the real exit (bounded) before saying so, never for a kill request.
        if (ended) {
          const retireMs = deps.retireMs ?? RETIRE_MS;
          void Promise.race([ended, new Promise<void>(done => setTimeout(done, retireMs))]).finally(() => reject(new UncertainError(said)));
          return;
        }
        reject(new UncertainError(said));
      }, callMs);
      pending.set(id, { resolve, reject, timer });
      target.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }
  /** Holds a new call until the timed-out helper is confirmed gone; refuses if that never comes instead of sending input beside it. */
  async function acquire(): Promise<Link> {
    const waited = retiring;
    if (waited) {
      const retireMs = deps.retireMs ?? RETIRE_MS;
      const ended = await new Promise<boolean>(res => { const timer = setTimeout(() => res(false), retireMs); waited.then(() => { clearTimeout(timer); res(true); }); });
      // The old helper may still be alive: that is an unknown state, so poison rather than send beside it.
      if (!ended) throw new UncertainError(`${name}还没有确认退出，暂不发送新的输入`);
      if (retiring === waited) retiring = undefined;
    }
    if (halted) throw new Error(halted);
    return ready();
  }
  function ready(): Promise<Link> {
    if (halted) return Promise.reject(new Error(halted));
    if (link) return Promise.resolve(link);
    if (!deps.elevated) return Promise.resolve(link = startChild());
    if (starting) return starting;
    const seq = ++startSeq;
    const attempt = startElevated().then(made => {
      // The switch was turned off while the UAC prompt was up: this helper must not outlive it.
      if (seq !== startSeq) { made.end(); throw new Error(`${name}已经关掉了`); }
      link = made; deps.faults.clear(FAULT); return made;
    }, (error: unknown) => {
      halted = `前台模式没有打开：${errorText(error)}`;
      deps.faults.set(FAULT, halted);
      throw new Error(halted);
    });
    starting = attempt;
    const clear = () => { if (starting === attempt) starting = undefined; };
    attempt.then(clear, clear);
    return attempt;
  }

  const INPUT_OPS = new Set(['click', 'drag', 'move', 'scroll', 'type', 'key', 'rclick', 'rdrag', 'rmove', 'rscroll', 'rtype', 'rkey']);
  // Within one action, if the user stops, a flag file tells the helper to release held buttons/keys and stop early.
  function armCancel(op: string, args: Record<string, unknown>): { args: Record<string, unknown>; done(): void } {
    const signal = currentSignal();
    if (!signal || !INPUT_OPS.has(op)) return { args, done() {} };
    const file = join(tmpdir(), `evolution-cu-cancel-${randomBytes(8).toString('hex')}.flag`);
    const raise = () => { try { writeFileSync(file, '1'); } catch { /* best effort */ } };
    const onAbort = () => raise();
    if (signal.aborted) raise(); else signal.addEventListener('abort', onAbort, { once: true });
    cancelFile = file;
    return {
      args: { ...args, cancelFile: file },
      done: () => {
        try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
        if (cancelFile === file) cancelFile = undefined;
        try { rmSync(file, { force: true }); } catch { /* ignore */ }
      },
    };
  }
  // One helper operation, always inside the machine-wide lease: a whole action shares one lease, a bare call takes its own.
  function dispatch(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!retiring) {
      if (!link && !deps.elevated && !halted) link = startChild();
      if (link) return send(link, op, args);
    }
    return acquire().then(target => send(target, op, args));
  }

  return {
    /** One helper operation by name, e.g. `windows` or `click`; a refusal rejects with the helper's reason. */
    call(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      return lease(async () => {
        const armed = armCancel(op, args);
        const scope = INPUT_OPS.has(op) ? currentAction() : undefined;
        if (scope) streaming = scope;
        try {
          const data = await dispatch(op, armed.args);
          // If a stop is in progress, do not hand the lease back before the helper has actually exited.
          if (stopWait) {
            const gone = await stopWait;
            if (!gone) throw new UncertainError(`${name}没有确认退出，上一步的结果不明。`);
          }
          if (data && data.cancelled === true) throw new CancelledError('用户取消了这一步，已经收尾。');
          return data;
        } finally { if (streaming === scope) streaming = undefined; armed.done(); }
      }, currentSignal());
    },
    /** Starts it now rather than on first use: foreground mode asks for administrator rights when it is turned on. */
    start: async (): Promise<void> => { await ready(); },
    running: () => link !== undefined,
    /**
     * Ends the helper and forgets a halted start, so turning the switch on again tries afresh. A held button or key is let
     * go first (the cancel flag), and the promise settles only once the helper has actually exited: a stop that returns
     * before then could release the machine lease while the old helper is still injecting.
     */
    async stop(): Promise<void> {
      const ending = link;
      const exit = childExit;
      // Mark the exit as intentional before dropping the link: a close arriving in between must still resolve childExit.
      if (ending) stopping = ending;
      link = undefined; halted = undefined; failedStarts = 0;
      if (cancelFile) { try { writeFileSync(cancelFile, '1'); } catch { /* best effort */ } }
      const retireMs = deps.retireMs ?? RETIRE_MS;
      if (!ending) {
        // No helper is connected yet, but a start may still be waiting for UAC: invalidate it so it closes on arrival.
        if (starting) { startSeq++; starting = undefined; }
        // A timed-out helper may still be retiring: its exit must be confirmed before anything else is sent.
        if (retiring) {
          const back = retiring;
          const gone = await Promise.race([back.then(() => true), new Promise<boolean>(res => setTimeout(() => res(false), retireMs))]);
          if (!gone) {
            failAll(stopped, true);
            halted = `${name}没有确认退出，之后的状态不明：关掉再打开桌面控制`;
            deps.faults.set(FAULT, halted);
            deps.arbiter?.poison(`${name}没有确认退出，上一步的结果不明。`);
            return;
          }
          retiring = undefined;
        }
        failAll(stopped, false, true); deps.faults.clear(FAULT); return;
      }
      // Let the helper finish the call it is in: the cancel flag makes a held button/key let go, then EOF ends its loop.
      // Killing at once could leave a real button down, so a hard end is only the fallback after the soft close times out.
      (ending.soft ?? ending.end).call(ending);
      const wait = (): Promise<boolean> => exit ? Promise.race([exit.then(() => true), new Promise<boolean>(res => setTimeout(() => res(false), retireMs))]) : Promise.resolve(false);
      // Calls in flight await this too, so the machine lease is not handed back while the old helper may still inject.
      stopWait = (async () => { let gone = await wait(); if (!gone) { ending.end(); gone = await wait(); } return gone; })();
      const gone = await stopWait;
      if (!gone) {
        // It would not confirm its exit: whatever it was doing is unknown, so poison until turning the switch on again.
        failAll(stopped, true);
        halted = `${name}没有确认退出，之后的状态不明：关掉再打开桌面控制`;
        deps.faults.set(FAULT, halted);
        deps.arbiter?.poison(`${name}没有确认退出，上一步的结果不明。`);
        stopWait = undefined;
        return;
      }
      failAll(stopped, false, true);
      stopWait = undefined;
      deps.faults.clear(FAULT);
    },
  };
}
