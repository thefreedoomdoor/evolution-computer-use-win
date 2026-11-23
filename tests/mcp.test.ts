import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { serveMcp, toContent, type McpTools } from '../src/mcp/server.ts';
import type { ToolResult } from '../src/tool.ts';

/** A client on the other end of a pipe: sends lines, reads answers by id. */
function client(output: NodeJS.ReadableStream, input: NodeJS.WritableStream) {
  const waiting = new Map<number | string, (message: Record<string, unknown>) => void>(), notes: Record<string, unknown>[] = [];
  createInterface({ input: output }).on('line', line => {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.id !== undefined && message.id !== null && waiting.has(message.id as number)) { waiting.get(message.id as number)!(message); waiting.delete(message.id as number); }
    else notes.push(message);
  });
  let next = 1;
  return {
    notes,
    request(method: string, params?: unknown): Promise<Record<string, unknown>> {
      const id = next++;
      return new Promise(resolve => { waiting.set(id, resolve); input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`); });
    },
    notify(method: string, params?: unknown): void { input.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`); },
    raw(line: string): void { input.write(`${line}\n`); },
  };
}

function inProcess(tools: McpTools) {
  const input = new PassThrough(), output = new PassThrough();
  const server = serveMcp(tools, { input, output }, { name: 'test', version: '0.0.0', instructions: '说明' });
  return { server, client: client(output, input), input };
}
const echo: McpTools = {
  tools: () => [{ name: 'echo', description: 'd', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => ({ text: '' }) }],
  async call(name, args, signal) {
    if (name === 'slow') return new Promise<ToolResult>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    if (name !== 'echo') throw new Error(`没有 ${name} 这个工具`);
    return { text: JSON.stringify(args), images: [{ data: Buffer.from('png'), mediaType: 'image/png', caption: '截图' }] };
  },
};

test('initialize agrees on a protocol version and hands over the instructions', async t => {
  const { client: c, input } = inProcess(echo); t.after(() => input.end());
  const init = await c.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } });
  assert.deepEqual(init.result, { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'test', version: '0.0.0' }, instructions: '说明' });
  const future = await c.request('initialize', { protocolVersion: '2099-01-01' });
  assert.equal((future.result as { protocolVersion: string }).protocolVersion, '2025-06-18', 'an unknown version gets the newest');
  assert.deepEqual((await c.request('ping')).result, {});
  assert.equal(((await c.request('resources/list')).error as { code: number }).code, -32601);
});

test('tools are listed with their schemas and called; text, captions and images come back as MCP content', async t => {
  const { client: c, input } = inProcess(echo); t.after(() => input.end());
  const listed = await c.request('tools/list');
  assert.deepEqual(listed.result, { tools: [{ name: 'echo', description: 'd', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] });
  const called = await c.request('tools/call', { name: 'echo', arguments: { a: 1 } });
  assert.deepEqual(called.result, { content: [{ type: 'text', text: '{"a":1}' }, { type: 'text', text: '截图' }, { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }] });
  const failed = await c.request('tools/call', { name: 'nope', arguments: {} });
  assert.deepEqual(failed.result, { content: [{ type: 'text', text: '没有 nope 这个工具' }], isError: true }, 'a failure is the agent\'s to read');
});

test('a cancelled call gets no answer, and the tool sees its signal abort', async t => {
  const { client: c, input } = inProcess(echo); t.after(() => input.end());
  let answered = false;
  void c.request('tools/call', { name: 'slow', arguments: {} }).then(() => { answered = true; });
  c.notify('notifications/cancelled', { requestId: 1 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(answered, false);
  assert.deepEqual((await c.request('ping')).result, {}, 'the server goes on');
});

test('the tool list change is told only after the client initialized; bad lines are answered with parse errors', async t => {
  const { server, client: c, input } = inProcess(echo); t.after(() => input.end());
  server.toolsChanged();
  c.raw('{not json');
  await c.request('initialize', {});
  c.notify('notifications/initialized');
  await c.request('ping');
  server.toolsChanged();
  await c.request('ping');
  assert.deepEqual(c.notes.map(note => (note as { method?: string; error?: { code: number } }).method ?? (note as { error: { code: number } }).error.code), [-32700, 'notifications/tools/list_changed']);
});

test('toContent leaves out captions that are not there', () => {
  assert.deepEqual(toContent({ text: 'a', images: [{ data: Buffer.from('x'), mediaType: 'image/jpeg' }] }), [{ type: 'text', text: 'a' }, { type: 'image', data: 'eA==', mimeType: 'image/jpeg' }]);
});

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const node = (args: string[]) => spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
function run(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const child = node(args); let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.on('exit', code => resolve({ code, out }));
  });
}

test('the CLI serves MCP over stdio: an agent learns a procedure, finds it again, and a second agent on the same data finds it too', async t => {
  const data = mkdtempSync(join(tmpdir(), 'ecu-cli-')); t.after(() => rmSync(data, { recursive: true, force: true }));
  const serve = () => { const child = node(['--data', data]); t.after(() => child.kill()); return { child, c: client(child.stdout, child.stdin) }; };
  const one = serve();
  const init = await one.c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.match((init.result as { instructions: string }).instructions, /computer_use/);
  one.c.notify('notifications/initialized');
  const names = ((await one.c.request('tools/list')).result as { tools: { name: string }[] }).tools.map(tool => tool.name);
  assert.deepEqual(names, ['page_open', 'page_read', 'page_click', 'page_type', 'page_press', 'page_scroll', 'page_wait', 'page_shot', 'page_eval', 'computer_use', 'procedure_run', 'procedure_save', 'procedure_note', 'procedure_routines', 'desktop_mode'], 'no desktop action unless the user turns it on; desktop_mode is listed so the agent can turn it on');
  const text = async (c: ReturnType<typeof client>, name: string, args: object) => ((await c.request('tools/call', { name, arguments: args })).result as { content: { text: string }[] }).content[0]!.text;
  assert.match(await text(one.c, 'procedure_save', { json: JSON.stringify({ name: '看首页', category: 'example', description: '打开首页', params: {}, steps: [{ open: 'https://example.com/' }, { check: { text: 'Example' } }] }) }), /^已保存 example\/看首页（第 1 版）/);
  assert.match(await text(one.c, 'procedure_note', { category: 'example', text: '网站：example.com（示例站）' }), /已写好 example 的说明/);
  one.child.stdin.end();
  const two = serve();
  await two.c.request('initialize', {});
  assert.match(await text(two.c, 'computer_use', { target: '示例站' }), /^example\n网站：example\.com（示例站）\n操作：看首页/);
  const status = await run(['status', '--data', data]);
  assert.equal(status.code, 0);
  assert.match(status.out, /example：看首页/);
});

test('resume removes the stop the user pressed, and says so when there is none', async t => {
  const data = mkdtempSync(join(tmpdir(), 'ecu-cli-')); t.after(() => rmSync(data, { recursive: true, force: true }));
  assert.match((await run(['resume', '--data', data])).out, /现在没有停下/);
  writeFileSync(join(data, 'desktop-stopped'), 'x');
  assert.match((await run(['resume', '--data', data])).out, /已解除停下/);
  assert.equal(existsSync(join(data, 'desktop-stopped')), false);
  const bad = await run(['nonsense']);
  assert.equal(bad.code, 1);
});
