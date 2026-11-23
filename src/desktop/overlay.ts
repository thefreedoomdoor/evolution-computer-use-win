/**
 * 思考浮窗的辅助脚本（从 dsh-computer-use-win 移植，MIT）。
 *
 * evolution-computer-use 是标准 MCP stdio 服务器，拿不到 DSH 的
 * `agent/assistant-stream` 事件，所以采用共享文件方案：
 *   - DSH 插件（dsh-evolution-thought-overlay）订阅 assistant-stream 与工具执行，
 *     把「正在思考 / 正在执行 / 步骤 / 回复」写进 ~/.evolution-computer-use/activity.json
 *   - 本模块每 1 秒把该文件转发给 windows-takeover.ps1 的 progress 命令，
 *     PowerShell 助手用 WinForms 在右上角画出浮窗。
 *
 * 环境变量：EVOCU_ACTIVITY_FILE（默认 ~/.evolution-computer-use/activity.json）
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { helperStrings } from './overlay-strings.ts';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, '..', '..', 'scripts', 'windows-takeover.ps1');
const DEFAULT_ACTIVITY = join(homedir(), '.evolution-computer-use', 'activity.json');
const POLL_MS = 1000;

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

export type ThoughtOverlayOptions = {
  activityFile?: string;
  /** 浮窗界面语言（BCP 47）；默认读系统语言。 */
  locale?: string;
  log?(text: string): void;
  /** 硬开关：返回 false 时隐藏浮窗（activity.json 里的软开关另行判断）。 */
  enabled?(): boolean;
};

/**
 * 启动浮窗助手并把 activity.json 的内容持续转发。
 */
export function startThoughtOverlay(options: ThoughtOverlayOptions = {}) {
  const activityFile = options.activityFile ?? process.env.EVOCU_ACTIVITY_FILE ?? DEFAULT_ACTIVITY;
  const log = options.log ?? (() => {});
  const enabled = options.enabled ?? (() => true);
  const eventName = 'Local\\EVO-CU-OVERLAY-' + Math.random().toString(16).slice(2);
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
    '-File', HELPER, '-CancelEvent', eventName,
  ], { cwd: dirname(HELPER), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => log(`[thought-overlay] 助手启动失败：${error.message}`));

  let nextId = 0;
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      let reply;
      try { reply = JSON.parse(line); } catch { continue; }
      if (reply.id !== undefined && pending.has(reply.id)) {
        pending.get(reply.id)();
        pending.delete(reply.id);
      }
    }
  });
  const command = (name: string, params: Record<string, unknown> = {}) => new Promise<void>((resolve) => {
    if (!child.stdin.writable) { resolve(); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); resolve(); }, 4000);
    pending.set(id, () => { clearTimeout(timer); resolve(); });
    child.stdin.write(`${JSON.stringify({ ...params, id, command: name })}\n`);
  });

  let last = '';
  const tick = () => {
    if (!enabled()) { void command('progress', { enabled: false, progress: {} }); return; }
    const activity = readJson(activityFile);
    // DSH 插件设置里的总开关：overlayEnabled 为 false 时浮窗隐藏（助手进程留着，随时可再开）。
    if (!activity || activity.overlayEnabled === false) { void command('progress', { enabled: false, progress: {} }); return; }
    const payload = {
      enabled: activity.active !== false,
      turnKey: `${activity.sessionId ?? ''}:${activity.turn ?? ''}`,
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
    // 界面语言跟随写侧（activity.json 的 locale），语言变化时因 key 变化而重发。
    const sent = { ...payload, strings: helperStrings(activity.locale) };
    const key = JSON.stringify(sent);
    if (key !== last) {
      last = key;
      void command('configure', { remoteIndicatorVisible: false, cursorIndicatorEnabled: false });
      void command('progress', sent);
    }
  };

  const timer = setInterval(tick, POLL_MS);
  timer.unref();
  setTimeout(tick, 500).unref();
  const stop = () => {
    clearInterval(timer);
    void command('close').then(() => { try { child.kill(); } catch {} });
  };
  return { stop, child, activityFile, getStderr: () => stderr };
}
