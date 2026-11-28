/**
 * DSH 插件入口的静态约定：包入口能读到 name / inject，MCP 桥指向本包自带的 CLI。
 * 不启动 DSH，也不真正加载 @deepseek-ai/dsh-mcp-client。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { apply, bridgeConfig, inject, name } from '../src/index.ts';

test('exposes the DSH plugin identity', () => {
  assert.equal(name, 'evolution-computer-use');
  assert.deepEqual(inject, ['tools']);
});

test('the public entry mounts only the native identity probe in native-probe mode', async () => {
  const mounts: { name: string; inject: string[]; apply: unknown }[] = [];
  await apply({
    plugin(probe: (typeof mounts)[number], ...args: unknown[]) {
      assert.deepEqual(args, []);
      mounts.push(probe);
    },
  }, { toolTransport: 'native-probe' });
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].name, 'desktop-agent-identity-probe');
  assert.deepEqual(mounts[0].inject, ['tools', 'agents', 'subagents']);
  assert.equal(typeof mounts[0].apply, 'function');
});

test('unknown transport fails before mounting a plugin', async () => {
  let mounted = false;
  // @ts-expect-error YAML or untyped callers can still supply invalid values at runtime.
  await assert.rejects(apply({ plugin() { mounted = true; } }, { toolTransport: 'typo' }), /toolTransport/);
  assert.equal(mounted, false);
});

test('bridgeConfig wires the bundled CLI as an MCP stdio server', () => {
  const config = bridgeConfig();
  assert.equal(config.serverName, 'evolution-computer-use');
  assert.equal(config.transport, 'stdio');
  assert.equal(config.command, process.execPath);
  assert.equal(config.args.at(-1), 'serve');
  assert.equal(config.args.length, 2, '默认不带 --desktop，交给 CLI 读设置文件/默认 off');
  assert.match(config.args[0] ?? '', /[\\/]cli\.js$/);
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(config.env.EVOLUTION_DESKTOP_MODE, undefined);
  assert.equal(config.toolCallTimeoutMs, 90_000);
  assert.equal(config.failOnStartupError, false);
});

test('bridgeConfig passes desktopMode through to the MCP server', () => {
  const config = bridgeConfig({ desktopMode: 'foreground' });
  // CLI 只认 --desktop 参数；env 也保留作为额外透传。
  assert.deepEqual(config.args.slice(-3), ['serve', '--desktop', 'foreground']);
  assert.equal(config.env.EVOLUTION_DESKTOP_MODE, 'foreground');

  const background = bridgeConfig({ desktopMode: 'background' });
  assert.deepEqual(background.args.slice(-3), ['serve', '--desktop', 'background']);
});

/** Read a repository file from this test's location. */
const text = (relative: string): string => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

interface InsertRow {
  id: string;
  name: string;
  config: Record<string, string>;
}

/**
 * 读取 bundle patch 里唯一一个 insert 列表的行。
 * 只解析这个文件用到的 YAML 形状（id / name / config 下的标量），找不到就断言失败。
 */
function insertRows(yaml: string): InsertRow[] {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === '- insert:');
  assert.ok(start >= 0, 'bundle patch must insert its plugin rows');
  const value = (line: string): string => {
    const raw = line.slice(line.indexOf(':') + 1).trim();
    return raw.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  };
  const rows: InsertRow[] = [];
  let row: InsertRow | undefined;
  let inConfig = false;
  for (const line of lines.slice(start + 1)) {
    if (/^- /.test(line)) break;
    if (/^    - id:/.test(line)) {
      row = { id: value(line), name: '', config: {} };
      rows.push(row);
      inConfig = false;
      continue;
    }
    if (!row) continue;
    if (/^      name:/.test(line)) {
      row.name = value(line);
      inConfig = false;
      continue;
    }
    if (/^      config:\s*$/.test(line)) {
      inConfig = true;
      continue;
    }
    if (inConfig && /^        [\w-]+:/.test(line)) {
      const key = line.trim().slice(0, line.trim().indexOf(':'));
      row.config[key] = value(line);
    }
  }
  return rows;
}

test('the shipped bundle patch mounts the multi-pointer writer and keeps the two original plugins', () => {
  const pkg = JSON.parse(text('package.json')) as { name: string };
  const rows = insertRows(text('plugin/cordis.patch.yml'));
  assert.deepEqual(rows.map(row => row.id), [
    'evolution-desktop-mode',
    'evolution-computer-use',
    'evolution-multi-pointer',
  ]);
  assert.equal(rows[0].name, 'evolution-computer-use-win/plugin');
  assert.equal(rows[1].name, 'evolution-computer-use-win');
  const pointer = rows[2];
  assert.equal(pointer.name, `${pkg.name}/multi-pointer`);
  // 只挂载 writer/渲染；多鼠标会话模式仍由运行时默认关闭，patch 不得顺手打开它。
  assert.deepEqual(pointer.config, { enabled: 'true' });
  assert.equal('mode' in pointer.config, false);
});

test('the multi-pointer row points at the package export and ships the probe script', () => {
  const pkg = JSON.parse(text('package.json')) as {
    name: string;
    exports: Record<string, unknown>;
    files: string[];
  };
  const pointer = insertRows(text('plugin/cordis.patch.yml'))[2];
  assert.equal(pointer.name, `${pkg.name}/multi-pointer`);
  const exported = pkg.exports['./multi-pointer'];
  assert.equal(typeof exported, 'string', 'the row must resolve through an existing package export');
  const probePath = String(exported).replace(/^\.\//, '');
  assert.ok(pkg.files.includes(probePath), 'the published bundle must ship the probe module');
  const probe = text(probePath);
  // 探针自己的名字是 desktop-multi-pointer，包的导出名是 multi-pointer：两者不同是允许的。
  assert.match(probe, /export const name = 'desktop-multi-pointer'/);
  assert.match(probe, /export const inject = \['agents', 'subagents'\]/);
});

test('the multi-mouse session mode stays off until a root turns it on', async () => {
  const specifier = new URL('../plugin/lib/multi-mouse-runtime.mjs', import.meta.url).href;
  const runtime = (await import(specifier)) as {
    getMultiMouseRuntime: () => { getMode: (rootId: string) => { enabled: boolean } };
  };
  const mode = runtime.getMultiMouseRuntime().getMode('a-root-that-never-enabled-it');
  assert.equal(mode.enabled, false);
});
