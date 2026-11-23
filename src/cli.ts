#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createComputerUse } from './computer.ts';
import type { DesktopMode } from './desktop/mode.ts';
import { STOPPED } from './desktop/turns.ts';
import { INSTRUCTIONS } from './instructions.ts';
import { serveMcp } from './mcp/server.ts';
import { errorText, Faults } from './shared/faults.ts';

const HELP = `evolution-computer-use：会自己进化的电脑操作插件（MCP 服务器）

用法：
  evolution-computer-use [serve] [选项]   以 MCP（stdio）方式运行，给 Agent 用
  evolution-computer-use resume [选项]    用户按了「停下」之后，解除停下
  evolution-computer-use routines [选项]  跑一遍例行操作（onAlarm），打印结果，给定时任务用
  evolution-computer-use status [选项]    列出学会的操作

选项：
  --data <目录>         数据目录，默认 ~/.evolution-computer-use
  --procedures <目录>   操作目录，默认 <数据目录>/procedures（几个 Agent 共用学会的操作就指向同一处）
  --profile <目录>      浏览器配置目录，默认 <数据目录>/browser（含登录态）
  --desktop <模式>      off（默认）｜background（后台：投递输入，不动鼠标）｜foreground（前台：真鼠标键盘，启动时要确认管理员权限）
  --name <名字>         操作时屏幕顶上提示里的名字，默认 AI
  --inbox-ignore <名单> 信箱不报的程序，逗号分隔（比如已经有自己通道的微信）
  --no-inbox            桌面控制开着时也不看任务栏
  --no-messages         操作读到的消息不记进 <数据目录>/messages.jsonl
  -h, --help            显示这段说明`;

const STOP_FILE = 'desktop-stopped';
type Options = { data: string; procedures?: string; profile?: string; desktop: string; name?: string; inbox: boolean; ignore: string[]; messages: boolean };

function parse(argv: string[]): { command: string; options: Options } {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      data: { type: 'string' }, procedures: { type: 'string' }, profile: { type: 'string' }, desktop: { type: 'string' }, name: { type: 'string' },
      'inbox-ignore': { type: 'string' }, 'no-inbox': { type: 'boolean' }, 'no-messages': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) { process.stdout.write(`${HELP}\n`); process.exit(0); }
  const command = positionals[0] ?? 'serve';
  if (!['serve', 'resume', 'routines', 'status'].includes(command) || positionals.length > 1) throw new Error(`不认识的命令：${positionals.join(' ')}`);
  const desktop = values.desktop ?? 'off';
  if (!['off', 'background', 'foreground'].includes(desktop)) throw new Error('--desktop 只能是 off、background 或 foreground');
  return {
    command,
    options: {
      data: resolve(values.data ?? join(homedir(), '.evolution-computer-use')),
      ...(values.procedures ? { procedures: resolve(values.procedures) } : {}), ...(values.profile ? { profile: resolve(values.profile) } : {}),
      desktop, ...(values.name ? { name: values.name } : {}), inbox: !values['no-inbox'], messages: !values['no-messages'],
      ignore: (values['inbox-ignore'] ?? '').split(/[,，]/).map(name => name.trim()).filter(Boolean),
    },
  };
}

const log = (text: string) => { process.stderr.write(`[evolution-computer-use] ${text}\n`); };
const version = () => (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

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
  const resumeHint = `（解除：用户在终端运行 npx -y evolution-computer-use resume${options.data === resolve(join(homedir(), '.evolution-computer-use')) ? '' : ` --data "${options.data}"`}）`;
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
  }, { input: process.stdin, output: process.stdout, log }, { name: 'evolution-computer-use', version: version(), instructions: INSTRUCTIONS });

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

  const end = () => { clearInterval(modeTimer); computer.stop(); process.exit(0); };
  process.once('SIGINT', end); process.once('SIGTERM', end);
  await server.closed;
  end();
}

async function main(): Promise<void> {
  const { command, options } = parse(process.argv.slice(2));
  if (command === 'serve') return serve(options);
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
  } finally { computer.stop(); }
}

main().catch(error => { log(errorText(error)); process.exit(1); });
