/**
 * DSH 插件入口：原生可信传输（每 Agent 一套工具与浏览器 profile）、原生只读验收探针，以及既有 MCP 兼容模式。
 *
 * 安装本包后，bundle patch（plugin/cordis.patch.yml）会插入三行：
 *   - id: evolution-computer-use      name: evolution-computer-use-win        -> 本模块（main = lib/index.js 重导出）
 *   - id: evolution-desktop-mode      name: evolution-computer-use-win/plugin -> plugin/lib/index.js（设置页后端）
 *   - id: evolution-multi-pointer     name: evolution-computer-use-win/multi-pointer -> probes/desktop-multi-pointer/index.mjs（多指针浮层，只写状态与渲染，会话模式默认关闭）
 *
 * toolTransport='native'（生产）按 Agent 注册工具，不需要 MCP 桥；'native-probe' 只加载只读身份探针；
 * 不写 toolTransport 时仍走 MCP。设置页由独立入口提供，桌面模式开关仍由 desktop-mode.json 决定。
 */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 加载宿主提供的模块。
 *
 * 正常安装（包在 profile 的 node_modules 里）直接解析；本地目录安装是 `link:` 软链，Node 会以仓库真实路径为起点，
 * 看不到 profile 里的宿主依赖，所以再以 profile 的 package.json 为锚点解析一次。
 */
async function importFromHost(specifier: string): Promise<any> {
  try {
    return await import(specifier);
  } catch (first) {
    const profile = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop');
    try {
      const hostRequire = createRequire(join(profile, 'package.json'));
      return await import(pathToFileURL(hostRequire.resolve(specifier)).href);
    } catch {
      throw first;
    }
  }
}

/** 插件名（DSH / Cordis 插件标识，与 MCP serverName 保持一致）。 */
export const name = 'evolution-computer-use';

/** DSH MCP 桥需要宿主的工具注册表。 */
export const inject = ['tools'];

export interface PluginConfig {
  /**
   * Which transport carries the computer-use tools.
   *
   * - `native`（本仓库新增加的生产传输，验收后才会成为默认）: registers the tools in the host's own tool service,
   *   once per live agent, and proves the calling agent from the execution context. Keeps per-agent identity,
   *   browser profile, images and cancellation; the gateway itself also polls the shared desktop-mode.json and the
   *   desktop-stopped stop sign instead of the MCP server.
   * - `mcp`（历史默认，不写 toolTransport 时走这条）: starts `lib/cli.js serve` as an MCP server. The MCP protocol has
   *   no agent identity, so every caller shares one runtime.
   * - `native-probe`: mounts the read-only identity probe (acceptance evidence only).
   */
  toolTransport?: 'native' | 'native-probe' | 'mcp';
  /** 原生传输的数据根目录（默认 ~/.evolution-computer-use，与 MCP 服务器一致）。 */
  dataDir?: string;
  /** 原生传输的程序库目录；传 false 表示每个 Agent 不带程序库。 */
  proceduresDir?: string | false;
  /** 原生传输是否写 messages.jsonl；false 关闭。 */
  messages?: boolean;
  /** 原生传输是否在启动时做一次增量扫描（与 MCP 服务器的 autoInit 一致，默认 true）。 */
  autoInit?: boolean;
  /**
   * 桌面模式文件（只读轮询）；false 关闭。默认与 MCP 服务器同一个文件
   * （~/.evolution-computer-use/desktop-mode.json），所以设置页切换的模式对两种传输都生效。
   */
  modeFile?: string | false;
  /** 用户「停下」标记文件；默认 <dataDir>/desktop-stopped。false 关闭（仅测试用）。 */
  stopFile?: string | false;
  /** 关闭叠加层的指针联动（不加载 plugin/lib/multi-mouse-runtime.mjs，也就没有 multi_mouse 工具）。 */
  multiMouse?: false;
  desktopMode?: 'off' | 'background' | 'foreground';
  overlayEnabled?: boolean;
  [key: string]: unknown;
}

/**
 * @deepseek-ai/dsh-mcp-client 的 stdio 配置。
 *
 * 注意：本文件编译后位于 lib/plugin.js，所以 './cli.js' 解析到同目录的 lib/cli.js（即本包的 MCP 服务器）。
 * 上游 dsh-computer-use-win 用的是同样的写法（fileURLToPath(new URL('./server.mjs', import.meta.url))）。
 */
export function bridgeConfig(config: PluginConfig = {}, runtime: Record<string, unknown> = {}) {
  // runtime 预留给宿主注入（如 dataDir/logger）；目前只按 config 生成配置。
  void runtime;
  return {
    serverName: 'evolution-computer-use',
    transport: 'stdio' as const,
    command: process.execPath,
    // CLI 只认 `--desktop off|background|foreground`（不读 EVOLUTION_DESKTOP_MODE），所以模式必须走参数。
    args: [
      fileURLToPath(new URL('./cli.js', import.meta.url)),
      'serve',
      ...(config.desktopMode ? ['--desktop', config.desktopMode] : []),
    ],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ...(config.desktopMode ? { EVOLUTION_DESKTOP_MODE: config.desktopMode } : {}),
    },
    toolCallTimeoutMs: 90000,
    failOnStartupError: false,
  };
}

/**
 * DSH 插件生命周期入口。原生探针作为子插件声明其宿主服务依赖，兼容模式不受影响。
 * 用变量 specifier 是为了：1) 仓库自身不依赖该包（只在 DSH 宿主内可用）；2) 缺失时给出清晰错误而不是顶层 import 失败。
 */
export async function apply(ctx: any, config: PluginConfig = {}): Promise<void> {
  if (config.toolTransport === 'native') {
    const { installNativeGateway } = await import('./native-tools.ts');
    const gateway = installNativeGateway(ctx, {
      ...(typeof config.dataDir === 'string' ? { dataRoot: config.dataDir } : {}),
      ...(config.proceduresDir === false
        ? { proceduresDir: false }
        : typeof config.proceduresDir === 'string'
          ? { proceduresDir: config.proceduresDir }
          : {}),
      ...(config.desktopMode ? { desktopMode: config.desktopMode } : {}),
      ...(config.messages === false ? { messages: false } : {}),
      ...(config.modeFile === false ? { modeFile: false } : typeof config.modeFile === 'string' ? { modeFile: config.modeFile } : {}),
      ...(config.stopFile === false ? { stopFile: false } : typeof config.stopFile === 'string' ? { stopFile: config.stopFile } : {}),
      ...(config.multiMouse === false ? { multiMouse: false } : {}),
      autoInit: config.autoInit !== false,
    });
    // The gateway's own registrations, runtimes, file polling and stop sign go with the plugin.
    ctx.effect(() => () => gateway.dispose());
    return;
  }
  if (config.toolTransport === 'native-probe') {
    const probe = await import('../probes/desktop-agent-identity/index.mjs');
    await ctx.plugin(probe);
    return;
  }
  if (config.toolTransport !== undefined && config.toolTransport !== 'mcp') {
    throw new TypeError('[evolution-computer-use] toolTransport must be native, native-probe or mcp');
  }

  const mcpClientSpecifier: string = '@deepseek-ai/dsh-mcp-client';
  let bridge: any;
  try {
    bridge = await importFromHost(mcpClientSpecifier);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      '[evolution-computer-use] 无法加载 @deepseek-ai/dsh-mcp-client：' +
        detail +
        '。该模块由 DeepSeek Harness 提供，请确认本插件运行在 DSH 环境中，或先在宿主里安装 @deepseek-ai/dsh-mcp-client。',
    );
  }
  // 与上游 dsh-computer-use-win 一致：等待 MCP 桥接插件注册完成（failOnStartupError=false，服务器起不来不会让宿主启动失败）。
  const connection = ctx.plugin(bridge, bridgeConfig(config));
  await connection;
  // 每次 DSH 启动的增量扫描由 MCP 服务器自己（lib/cli.js serve 的 autoInit）完成：
  // 它和这本插件用同一个数据目录，扫描和首次自测都在那边做，这里不再重复扫一遍。
}
