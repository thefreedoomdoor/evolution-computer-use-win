/**
 * 思考浮窗的辅助脚本（从 dsh-computer-use-win 移植，MIT）。
 *
 * evolution-computer-use-win 是标准 MCP stdio 服务器，拿不到 DSH 的
 * `agent/assistant-stream` 事件，所以采用共享文件方案：
 *   - DSH 插件（dsh-evolution-desktop-mode）订阅 assistant-stream 与工具执行，
 *     把「正在思考 / 正在执行 / 步骤 / 回复」写进 ~/.evolution-computer-use/activity.json
 *   - 本模块每 1 秒把该文件转发给 windows-takeover.ps1 的 progress 命令，
 *     PowerShell 助手用 WinForms 在右上角画出浮窗。
 *
 * 同一台机器上常常同时跑好几个 MCP 服务器（同一个 DSH 里挂两个连接就是如此），
 * 而 activity.json 是共享的，所以浮窗只能有一块：谁先认领 `<数据目录>/overlay.lock`
 * 谁画，其余进程待命，每轮再看一次——持有者崩了或退出了，待命的那个接管。
 *
 * 环境变量：EVOCU_ACTIVITY_FILE（默认 ~/.evolution-computer-use/activity.json）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { helperStrings } from './overlay-strings.ts';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, '..', '..', 'scripts', 'windows-takeover.ps1');
const DEFAULT_ACTIVITY = join(homedir(), '.evolution-computer-use', 'activity.json');
const POLL_MS = 1000;
/** 锁文件超过这么久没被持有者刷新，就算它已经不在了。 */
const LOCK_STALE_MS = 5000;
/** 助手反复起不来时最多重试几次，免得无限刷进程。 */
const MAX_SPAWNS = 3;

/** activity.json 的读取视图：写侧是 DSH 插件，字段都可能缺失。 */
type Activity = {
  active?: boolean;
  sessionId?: string;
  turn?: number | string;
  locale?: string;
  overlayEnabled?: boolean;
  position?: string;
  width?: number;
  height?: number;
  opacity?: number;
  locked?: boolean;
  progress?: {
    status?: string;
    step?: number;
    startedAt?: number;
    endedAt?: number;
    action?: string;
    reasoning?: string;
    reply?: string;
    steps?: unknown[];
  };
};

const readJson = (file: string): Activity | undefined => {
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return undefined;
    return JSON.parse(raw) as Activity;
  } catch {
    return undefined;
  }
};

/** 进程还在不在。signal 0 只用来探测存在，Windows 上 EPERM 也算在。 */
const pidAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

export type OverlayClaim = 'claimed' | 'held';

/**
 * 认领浮窗锁：拿到返回 'claimed'，别人正拿着返回 'held'。
 * 只信「刷新得勤 + 进程还在」的持有者；过期的先原子改名抢下来，改名输了就是别人先动了。
 */
export function tryClaimOverlayLock(lockFile: string, pid = process.pid, now = Date.now()): OverlayClaim {
  const create = (): OverlayClaim => {
    try { mkdirSync(dirname(lockFile), { recursive: true }); } catch { /* 已存在 */ }
    try {
      const fd = openSync(lockFile, 'wx');
      writeSync(fd, String(pid));
      closeSync(fd);
      return 'claimed';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'held';
    }
    let raw = '';
    try { raw = readFileSync(lockFile, 'utf8').trim(); } catch { /* 读不到就按过期处理 */ }
    const holder = parseInt(raw, 10);
    let fresh = false;
    let age = Number.POSITIVE_INFINITY;
    try { age = now - statSync(lockFile).mtimeMs; fresh = age < LOCK_STALE_MS; } catch { fresh = false; }
    if (fresh && holder === pid) return 'claimed';   // 已经是自己的，重复认领算成功
    if (fresh && pidAlive(holder)) return 'held';
    // 文件刚创建、内容还没落盘（读到空串）时不要抢：那多半是别的进程正在创建，下一轮再看。
    if (!raw && age < 200) return 'held';
    const stale = lockFile + '.' + Math.random().toString(16).slice(2) + '.stale';
    try { renameSync(lockFile, stale); } catch { return 'held'; }
    // 改名只是让抢占原子化；抢下来的过期锁是垃圾，立刻删掉，别在数据目录里越攒越多。
    try { unlinkSync(stale); } catch { /* 删不掉就算了 */ }
    return create();
  };
  return create();
}

/**
 * 持有者刷新锁：只把 mtime 推新，绝不重写内容。
 *
 * 早先用 writeFileSync 重写 pid，而它会先把文件截断成 0 字节再写；并发的另一个进程
 * 正好在这瞬间读到空串 → 解析成 NaN → 当成「持锁者已死」→ 改名抢占。两块浮窗就是这样
 * 每隔一两分钟来回倒手。改成 utimesSync 只 touch 时间后，内容始终是完整的 pid。
 */
export function refreshOverlayLock(lockFile: string, pid = process.pid, now = Date.now()): boolean {
  let raw = '';
  try { raw = readFileSync(lockFile, 'utf8').trim(); } catch { return false; }
  const holder = parseInt(raw, 10);
  if (holder === pid) {
    try { utimesSync(lockFile, now / 1000, now / 1000); } catch { /* touch 不了就等下一轮 */ }
    return true;
  }
  // 读到空串只可能是别的进程（旧代码）正在重写它：不当成自己丢了锁，
  // 否则会让出窗口又马上抢回来，来回抖。下一轮读到完整内容再判断。
  if (!raw || !Number.isSafeInteger(holder) || holder <= 0) return true;
  return false;
}

/** 退出时放锁，只放自己那份。 */
export function releaseOverlayLock(lockFile: string, pid = process.pid): void {
  try {
    if (parseInt(readFileSync(lockFile, 'utf8').trim(), 10) !== pid) return;
    unlinkSync(lockFile);
  } catch { /* 没了就算放了 */ }
}

export type ThoughtOverlayOptions = {
  activityFile?: string;
  /** 单实例锁文件，默认 `<activity.json 同目录>/overlay.lock`。 */
  lockFile?: string;
  /** 浮窗界面语言（BCP 47）；默认跟随 activity.json 里的 locale，再默认系统语言。 */
  locale?: string;
  log?(text: string): void;
  /** 硬开关：返回 false 时隐藏浮窗（activity.json 里的软开关另行判断）。 */
  enabled?(): boolean;
};

/**
 * 启动浮窗助手并把 activity.json 的内容持续转发。
 * 没认领到锁时不启动助手，只待命（`child` 为 undefined）；持有者退出后自动接管。
 */
export function startThoughtOverlay(options: ThoughtOverlayOptions = {}) {
  const activityFile = options.activityFile ?? process.env.EVOCU_ACTIVITY_FILE ?? DEFAULT_ACTIVITY;
  const lockFile = options.lockFile ?? join(dirname(activityFile), 'overlay.lock');
  const log = options.log ?? (() => { });
  const enabled = options.enabled ?? (() => true);

  let child: ChildProcess | undefined;
  let stderr = '';
  let failures = 0;
  let owner = false;
  let saidWaiting = false;
  let givingUp = false;
  let stopping = false;
  /** 是我们主动关掉的助手进程：它们的 exit 事件不用当成「意外退出」。 */
  const retired = new WeakSet<ChildProcess>();

  const spawnHelper = () => {
    const eventName = 'Local\\EVO-CU-OVERLAY-' + Math.random().toString(16).slice(2);
    const proc = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', HELPER, '-CancelEvent', eventName,
    ], { cwd: dirname(HELPER), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (error) => log('[thought-overlay] 助手启动失败：' + error.message));
    proc.on('exit', () => {
      if (stopping || retired.has(proc)) return;
      child = undefined;
      helper = undefined;
      last = '';
      if (++failures >= MAX_SPAWNS) {
        givingUp = true;
        owner = false;
        releaseOverlayLock(lockFile);
        log('[thought-overlay] 助手起不来，浮窗这次不显示了（重启服务器会再试）');
        return;
      }
      // 早先这里 owner 还是 true，下一轮 tick 走 refresh 分支、helper 是空的，
      // 于是「重开」永远不会发生，浮窗静默消失。这里把 owner 归零，下一轮会重新认领并 spawn。
      owner = false;
      log('[thought-overlay] 助手退出了，下一轮重开');
    });

    let nextId = 0;
    const pending = new Map<number, () => void>();
    proc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        let reply: { id?: number };
        try { reply = JSON.parse(line); } catch { continue; }
        if (reply.id !== undefined && pending.has(reply.id)) {
          pending.get(reply.id)!();
          pending.delete(reply.id);
          failures = 0;   // 助手能应答就说明它活着，连续失败清零
        }
      }
    });
    const command = (name: string, params: Record<string, unknown> = {}) => new Promise<void>((resolve) => {
      const stdin = proc.stdin;
      if (!stdin || !stdin.writable) { resolve(); return; }
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); resolve(); }, 4000);
      pending.set(id, () => { clearTimeout(timer); resolve(); });
      stdin.write(JSON.stringify({ ...params, id, command: name }) + '\n');
    });
    return { proc, command };
  };

  let helper: ReturnType<typeof spawnHelper> | undefined;
  let last = '';

  /**
   * 关掉手上的助手：先关 stdin 让它读到 EOF 自己退出，2 秒还没走就强杀。
   *
   * 早先丢锁时只把 JS 引用丢掉（helper=undefined），stdio 管道还开着，助手等不到 EOF，
   * 窗口就一直画着最后一次的内容留在屏幕上；两边锁一倒手就攒出好几块「悬浮窗」。
   */
  const retireHelper = (why: string) => {
    const running = helper;
    helper = undefined;
    child = undefined;
    last = '';
    if (!running) return;
    retired.add(running.proc);
    log('[thought-overlay] ' + why);
    try { running.proc.stdin?.end(); } catch { /* 已经关了 */ }
    const timer = setTimeout(() => { try { running.proc.kill(); } catch { /* 早就退了 */ } }, 2000);
    timer.unref();
  };

  const tick = () => {
    if (givingUp) return;
    if (!owner) {
      if (tryClaimOverlayLock(lockFile) !== 'claimed') {
        if (!saidWaiting) { saidWaiting = true; log('[thought-overlay] 浮窗已由另一个 evolution-computer-use-win 进程显示，本进程待命'); }
        return;
      }
      owner = true;
      saidWaiting = false;
      helper = spawnHelper();
      child = helper.proc;
      last = '';
    } else if (!refreshOverlayLock(lockFile)) {
      // 锁被别人拿走了：让位，并且必须关掉自己的助手，不能只丢引用。
      owner = false;
      retireHelper('浮窗已由另一个进程接管，关掉本进程的助手');
      return;
    }

    if (!enabled()) { void helper?.command('progress', { enabled: false, progress: {} }); return; }
    const activity = readJson(activityFile);
    // DSH 插件设置里的总开关：overlayEnabled 为 false 时浮窗隐藏（助手留着，随时可再开）。
    if (!activity || activity.overlayEnabled === false) { void helper?.command('progress', { enabled: false, progress: {} }); return; }
    const payload = {
      enabled: activity.active !== false,
      turnKey: (activity.sessionId ?? '') + ':' + (activity.turn ?? ''),
      settings: {
        progressOverlayEnabled: true,
        progressOverlayPosition: activity.position ?? 'top-right',
        progressOverlayWidth: activity.width ?? 360,
        progressOverlayHeight: activity.height ?? 240,
        progressOverlayOpacity: activity.opacity ?? 60,
        progressOverlayLocked: activity.locked ?? true,
      },
      progress: {
        status: activity.progress?.status ?? 'waiting',
        step: activity.progress?.step ?? 0,
        startedAt: activity.progress?.startedAt,
        endedAt: activity.progress?.endedAt,
        action: activity.progress?.action ?? '',
        reasoning: activity.progress?.reasoning ?? '',
        reply: activity.progress?.reply ?? '',
        steps: activity.progress?.steps ?? [],
      },
    };
    // 界面语言跟随写侧（activity.json 的 locale）；语言变化时因 key 变化而重发。
    const sent = { ...payload, strings: helperStrings(activity.locale ?? options.locale) };
    const key = JSON.stringify(sent);
    if (key !== last) {
      last = key;
      void helper?.command('configure', { remoteIndicatorVisible: false, cursorIndicatorEnabled: false });
      void helper?.command('progress', sent);
    }
  };

  const timer = setInterval(tick, POLL_MS);
  timer.unref();
  setTimeout(tick, 500).unref();

  const stop = () => {
    stopping = true;
    clearInterval(timer);
    const running = helper;
    helper = undefined;
    child = undefined;
    owner = false;
    releaseOverlayLock(lockFile);
    if (!running) return;
    void running.command('close').then(() => { try { running.proc.kill(); } catch { /* 已经没了 */ } });
  };

  return {
    get child() { return child; },
    get owning() { return owner; },
    activityFile,
    lockFile,
    stop,
    getStderr: () => stderr,
  };
}
