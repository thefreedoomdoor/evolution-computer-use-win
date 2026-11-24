/**
 * DSH 插件入口的静态约定：包入口能读到 name / inject，MCP 桥指向本包自带的 CLI。
 * 不启动 DSH，也不真正加载 @deepseek-ai/dsh-mcp-client。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { bridgeConfig, inject, name } from '../src/plugin.ts';

test('exposes the DSH plugin identity', () => {
  assert.equal(name, 'evolution-computer-use');
  assert.deepEqual(inject, ['tools']);
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
