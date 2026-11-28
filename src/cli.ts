#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createComputerUse } from './computer.ts';
import type { DesktopMode } from './desktop/mode.ts';
import { STOPPED } from './desktop/turns.ts';
import { INSTRUCTIONS } from './instructions.ts';
import { serveMcp } from './mcp/server.ts';
import { startThoughtOverlay } from './desktop/overlay.ts';
import { errorText, Faults } from './shared/faults.ts';

const HELP = `evolution-computer-use-win：会自己进化的电脑操作插件（MCP 服务器）

用法：
  evolution-computer-use-win [serve] [选项]   以 MCP（stdio）方式运行，给 Agent 用
  evolution-computer-use-win resume [选项]    用户按了「停下」之后，解除停下
  evolution-computer-use-win routines [选项]  跑一遍例行操作（onAlarm），打印结果，给定时任务用
  evolution-computer-use-win status [选项]    列出学会的操作
  evolution-computer-use-win init [选项]      扫描软件位置、自测电脑操作，写一份报告

选项：
  --data <目录>         数据目录，默认 ~/.evolution-computer-use
  --procedures <目录>   操作目录，默认 <数据目录>/procedures（几个 Agent 共用学会的操作就指向同一处）
  --profile <目录>      浏览器配置目录，默认 <数据目录>/browser（含登录态）
  --desktop <模式>      off（默认）｜background（后台：投递输入，不动鼠标）｜foreground（前台：真鼠标键盘，启动时要确认管理员权限）
  --name <名字>         操作时屏幕顶上提示里的名字，默认 AI
  --inbox-ignore <名单> 信箱不报的程序，逗号分隔（比如已经有自己通道的微信）
  --no-inbox            桌面控制开着时也不看任务栏
  --no-messages         操作读到的消息不记进 <数据目录>/messages.jsonl
  --no-overlay          不启动右上角的思考/步骤浮窗（默认开，随 DSH 插件设置）
  --skip-selftest       init 时只扫描，不跑自测
  --network             init 自测允许访问外网（默认只用本地测试页）
  --json                init 结果以 JSON 打印
  -h, --help            显示这段说明`;

const STOP_FILE = 'desktop-stopped';
type Options = { data: string; procedures?: string; profile?: string; desktop: string; name?: string; inbox: boolean; ignore: string[]; messages: boolean; overlay: boolean; selftest: boolean; network: boolean; json: boolean };

function parse(argv: string[]): { command: string; options: Options } {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      data: { type: 'string' }, procedures: { type: 'string' }, profile: { type: 'string' }, desktop: { type: 'string' }, name: { type: 'string' },
      'inbox-ignore': { type: 'string' }, 'no-inbox': { type: 'boolean' }, 'no-messages': { type: 'boolean' },
      'no-overlay': { type: 'boolean' }, 'skip-selftest': { type: 'boolean' },
      network: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) { process.stdout.write(`${HELP}\n`); process.exit(0); }
  const command = positionals[0] ?? 'serve';
  if (!['serve', 'resume', 'routines', 'status', 'init'].includes(command) || positionals.length > 1) throw new Error(`不认识的命令：${positionals.join(' ')}`);
  const desktop = values.desktop ?? 'off';
  if (!['off', 'background', 'foreground'].includes(desktop)) throw new Error('--desktop 只能是 off、background 或 foreground');
  return {
    command,
    options: {
      data: resolve(values.data ?? join(homedir(), '.evolution-computer-use')),
      ...(values.procedures ? { procedures: resolve(values.procedures) } : {}), ...(values.profile ? { profile: resolve(values.profile) } : {}),
      desktop, ...(values.name ? { name: values.name } : {}), inbox: !values['no-inbox'], messages: !values['no-messages'],
      overlay: !values['no-overlay'],
      selftest: !values['skip-selftest'], network: Boolean(values.network), json: Boolean(values.json),
      ignore: (values['inbox-ignore'] ?? '').split(/[,，]/).map(name => name.trim()).filter(Boolean),
    },
  };
}

const log = (text: string) => { process.stderr.write(`[evolution-computer-use-win] ${text}\n`); };
const version = () => (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/**
 * The one way this process ends: stop the mode poll and the overlay, wait until the computer has really finished the
 * step in flight, then exit — the host asked the process to end, so it must not leave a button held down. The first
 * caller starts the work; every later caller (a second signal, or the server closing meanwhile) gets the same promise,
 * so it runs once and no caller can exit ahead of it. Each cleanup step is guarded on its own: one that throws is
 * reported and makes the exit non-zero, but it never skips the steps after it. The stop is always awaited before the
 * exit, and a failed or incomplete cleanup must never be presented as a clean one.
 */
export function createShutdown(hooks: {
  clearTimer?: () => void;
  stopOverlay?: () => void;
  stopComputer: () => void | Promise<void>;
  exit: (code: number) => void;
}): (code?: number) => Promise<void> {
  let once: Promise<void> | undefined;
  return (code = 0) => (once ??= (async () => {
    // Guarded per step: a timer or overlay that is already gone is logged and remembered as an incomplete cleanup, but
    // the hooks after it still run and the stop is still awaited — nothing may keep us from putting back a held button.
    let status = code;
    const guarded = (what: string, run: () => void) => {
      try { run(); } catch (error) { log(`停止时出错（${what}）：${errorText(error)}`); if (status === 0) status = 1; }
    };
    guarded('模式轮询', () => hooks.clearTimer?.());
    guarded('浮窗', () => hooks.stopOverlay?.());
    try {
      await hooks.stopComputer();
    } catch (error) {
      log(`停止时出错：${errorText(error)}`);
      if (status === 0) status = 1;
    }
    hooks.exit(status);
  })());
}

/** True only when Node was asked to run this file, so a test can import `createShutdown` without starting the server. */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const canonical = (path: string) => { try { return realpathSync.native(path); } catch { return resolve(path); } };
  const here = canonical(fileURLToPath(import.meta.url));
  const there = canonical(invoked);
  return process.platform === 'win32' ? here.toLowerCase() === there.toLowerCase() : here === there;
}

function open(options: Options, hooks: { onToolsChanged?(): void; onHalt?(): void } = {}) {
  mkdirSync(options.data, { recursive: true });
  return createComputerUse({
    dataDir: options.data, ...(options.procedures ? { proceduresDir: options.procedures } : {}), ...(options.profile ? { profileDir: options.profile } : {}),
    ...(options.name ? { name: options.name } : {}), ...(options.messages ? {} : { messages: false as const }),
    inbox: options.inbox ? { ignore: options.ignore } : false,
    faults: new Faults((key, text) => log(text === undefined ? `已恢复：${key}` : `故障（${key}）：${text}`)),
    ...hooks,
  });
}

/**
 * The MCP server. The user's stop is a file in the data folder, so it outlasts a restart of the agent that was
 * stopped; `resume` deletes it, and the next call finds it gone and lets the agent use the computer again.
 */
async function serve(options: Options): Promise<void> {
  const stopFile = join(options.data, STOP_FILE);
  const resumeHint = `（解除：用户在终端运行 npx -y evolution-computer-use-win resume${options.data === resolve(join(homedir(), '.evolution-computer-use')) ? '' : ` --data "${options.data}"`}）`;
  let server: ReturnType<typeof serveMcp> | undefined;
  const computer = open(options, {
    onToolsChanged: () => server?.toolsChanged(),
    onHalt: () => { try { writeFileSync(stopFile, new Date().toISOString()); } catch (error) { log(`没能记下停下：${errorText(error)}`); } },
  });
  server = serveMcp({
    tools: computer.tools,
    async call(name, args, signal) {
      if (computer.halted() && !existsSync(stopFile)) computer.release();
      try { return await computer.call(name, args, signal); }
      catch (error) { throw new Error(errorText(error).includes(STOPPED) ? `${errorText(error)}${resumeHint}` : errorText(error), { cause: error }); }
    },
  }, { input: process.stdin, output: process.stdout, log }, { name: 'evolution-computer-use-win', version: version(), instructions: INSTRUCTIONS });

  const mode = options.desktop as DesktopMode;
  if (mode !== 'off') {
    if (mode === 'foreground') log('前台模式：正在请求管理员权限（Windows 会弹出确认）');
    const stopped = existsSync(stopFile);
    void computer.setDesktopMode(mode).then(why => {
      if (why) { log(why); return; }
      if (stopped) computer.halt();
      else if (mode === 'foreground') log('前台模式已打开');
    });
  }
  // 每次 DSH 启动都做一次增量扫描；第一次（还没有 init 报告）顺带完整扫描和自测。
  // EVOLUTION_CU_NO_AUTO_INIT=1 可以关掉，排查问题时有用。
  if (process.env.EVOLUTION_CU_NO_AUTO_INIT !== '1') {
    void computer.autoInit().then(report => {
      if (!report) return;
      log(`启动检查：${report.scan.apps} 个程序${report.selftest ? `，自测${report.selftest.ok ? '通过' : '有失败项'}` : ''}`);
    }).catch(error => log(`启动检查失败：${errorText(error)}`));
  }
  // 用户在 DSH 设置界面里选的前台/后台模式写在这个共享文件里，这里轮询让它即时生效，不用重启。
  const modeFile = join(homedir(), '.evolution-computer-use', 'desktop-mode.json');
  const modeTimer = setInterval(() => {
    let wanted: string | undefined;
    try { wanted = (JSON.parse(readFileSync(modeFile, 'utf8').replace(/^\uFEFF/, '')) as { desktopMode?: string }).desktopMode; } catch { return; }
    if (wanted !== 'off' && wanted !== 'background' && wanted !== 'foreground') return;
    if (wanted === computer.desktopMode()) return;
    void computer.setDesktopMode(wanted).then(why => { log(why ?? `桌面模式已切换为 ${wanted}（来自设置）`); });
  }, 800);
  modeTimer.unref();

  // 右上角思考/步骤浮窗：DSH 插件把活动写进 activity.json，这里转发给 PowerShell 助手画出来。
  // --no-overlay 是硬关（不启动助手进程）；软开关在 activity.json 的 overlayEnabled，由 overlay 自己判断。
  const overlay = options.overlay
    ? startThoughtOverlay({ activityFile: join(options.data, 'activity.json'), log })
    : undefined;

  // Every way out — a signal, or the client closing the pipe — goes through this one promise: the mode poll and the
  // overlay stop, the computer finishes the step in flight, and only then does the process exit. `on` (not `once`) so a
  // second Ctrl-C cannot fall through to Node's default kill and cut a stop short — it just waits on the same promise.
  const end = createShutdown({
    clearTimer: () => clearInterval(modeTimer),
    stopOverlay: () => overlay?.stop(),
    stopComputer: () => computer.stop(),
    exit: code => process.exit(code),
  });
  process.on('SIGINT', () => { void end(); });
  process.on('SIGTERM', () => { void end(); });
  await server.closed;
  await end();
}

async function main(): Promise<void> {
  const { command, options } = parse(process.argv.slice(2));
  if (command === 'serve') return serve(options);
  if (command === 'init') {
    const computer = open(options);
    let code = 0;
    try {
      const report = await computer.init({ full: true, selftest: options.selftest, allowNetwork: options.network });
      if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(readFileSync(report.reportMarkdown ?? report.reportJson!, 'utf8'));
      if (!report.ok) code = 1;
    } finally { await computer.stop(); }
    // 桌面控制会起一个助手进程，stop 之后事件循环里还留着句柄；init 是一次性命令，直接退出。
    process.exit(code);
  }
  if (command === 'resume') {
    const file = join(options.data, STOP_FILE);
    if (!existsSync(file)) { process.stdout.write('现在没有停下，不用解除。\n'); return; }
    rmSync(file, { force: true });
    process.stdout.write('已解除停下：Agent 下一次操作时就能再用电脑了。\n');
    return;
  }
  const computer = open(options);
  try {
    if (command === 'routines') { process.stdout.write(`${(await computer.routines()) ?? '没有例行操作（onAlarm）。'}\n`); return; }
    const { dir, categories, faults } = computer.status();
    const lines = [`操作目录：${dir}`, ...categories.map(category => `${category.name}${category.guide ? '' : '（没有说明）'}：${category.operations.map(op => `${op.name}${op.onAlarm ? '（例行）' : ''}`).join('、') || '（没有操作）'}`)];
    if (!categories.length) lines.push('还没有学会的操作。');
    if (faults.length) lines.push('有问题的：', ...faults.map(line => `- ${line}`));
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally { await computer.stop(); }
}

if (isEntryPoint()) main().catch(error => { log(errorText(error)); process.exit(1); });
