/**
 * DSH 插件入口：把本包自带的 MCP 服务器（lib/cli.js serve）桥接进 DeepSeek Harness。
 *
 * 安装本包后，bundle patch（plugin/cordis.patch.yml）会插入两行：
 *   - id: evolution-computer-use      name: evolution-computer-use-win        -> 本模块（main = lib/index.js 重导出）
 *   - id: evolution-desktop-mode      name: evolution-computer-use-win/plugin -> plugin/lib/index.js（设置页后端）
 *
 * 本模块只负责 MCP 桥和启动后的后台增量扫描；设置页由 plugin/ 目录里的原独立插件提供。
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
 * DSH 插件生命周期入口：动态加载宿主提供的 @deepseek-ai/dsh-mcp-client，并注册 MCP 服务器。
 * 用变量 specifier 是为了：1) 仓库自身不依赖该包（只在 DSH 宿主内可用）；2) 缺失时给出清晰错误而不是顶层 import 失败。
 */
export async function apply(ctx: any, config: PluginConfig = {}): Promise<void> {
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
