import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { runSelftest } from '../src/selftest.ts';
import type { SelftestReport } from '../src/selftest.ts';
import type { Browser } from '../src/browser/browser.ts';

interface FakeState {
  value: string;
  out: string;
  opened: string[];
  calls: string[];
}

interface FakeOptions {
  /** evaluate 返回这个值（默认返回模拟出来的 #out 文本）。 */
  evaluateResult?: unknown;
  /** open 永不返回，用来模拟挂死。 */
  hangOpen?: boolean;
  /** open 抛错。 */
  openError?: string;
  /** status() 返回的浏览器状态。 */
  browserState?: 'missing' | 'stopped' | 'running';
}

function fakeBrowser(options: FakeOptions = {}): { browser: Browser; state: FakeState } {
  const state: FakeState = { value: '', out: '', opened: [], calls: [] };
  const page = {
    async open(url: string): Promise<void> {
      if (options.hangOpen) return new Promise<void>(() => {});
      if (options.openError) throw new Error(options.openError);
      const response = await fetch(url);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.ok(html.includes('id="q"'), '本地页面应该有 input#q');
      assert.ok(html.includes('id="go"'), '本地页面应该有 button#go');
      state.opened.push(url);
      state.calls.push('open');
    },
    async type(_target: unknown, text: string): Promise<void> {
      state.value = text;
      state.calls.push('type');
    },
    async click(): Promise<void> {
      state.out = state.value.toUpperCase();
      state.calls.push('click');
    },
    async evaluate(): Promise<unknown> {
      return options.evaluateResult !== undefined ? options.evaluateResult : state.out;
    },
    async shot(): Promise<Buffer> {
      return Buffer.from('fake-png-bytes');
    },
    async wait(): Promise<void> {},
    async read(): Promise<string> { return ''; },
    async brief(): Promise<string> { return ''; },
    async press(): Promise<void> {},
    async scroll(): Promise<void> {},
    async has(): Promise<boolean> { return true; },
    async extract(): Promise<never[]> { return []; },
    async bringToFront(): Promise<void> {},
  };

  const browser = {
    async run<T>(work: (p: unknown, signal: AbortSignal) => Promise<T>): Promise<T> {
      return work(page, new AbortController().signal);
    },
    async scratch<T>(work: (p: unknown, signal: AbortSignal) => Promise<T>): Promise<T> {
      return work(page, new AbortController().signal);
    },
    show(): void {},
    status(): { state: 'missing' | 'stopped' | 'running'; binary: string | null } {
      return { state: options.browserState ?? 'running', binary: null };
    },
    stop(): void {},
  } as unknown as Browser;

  return { browser, state };
}

function makeDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'cu-selftest-test-'));
}

function byId(report: SelftestReport, id: string) {
  const item = report.items.find(entry => entry.id === id);
  assert.ok(item, `报告里应该有 ${id} 项`);
  return item;
}

test('报告结构完整，离线项按预期 passed/skipped', async () => {
  const dataDir = makeDataDir();
  try {
    const { browser, state } = fakeBrowser();
    const lines: string[] = [];
    const report = await runSelftest({ dataDir, browser, allowNetwork: false, log: line => lines.push(line) });

    assert.equal(typeof report.startedAt, 'string');
    assert.equal(typeof report.finishedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(report.startedAt)));
    assert.ok(!Number.isNaN(Date.parse(report.finishedAt)));
    assert.equal(typeof report.ok, 'boolean');

    assert.deepEqual(report.items.map(item => item.id), ['environment', 'browser-local', 'desktop-window', 'web-demo', 'cleanup']);
    for (const item of report.items) {
      assert.equal(typeof item.name, 'string');
      assert.ok(['passed', 'failed', 'skipped'].includes(item.status));
      assert.equal(typeof item.detail, 'string');
      assert.equal(typeof item.ms, 'number');
      assert.ok(item.ms >= 0);
    }

    assert.equal(byId(report, 'environment').status, 'passed');
    assert.equal(byId(report, 'browser-local').status, 'passed');
    assert.equal(byId(report, 'desktop-window').status, 'skipped');
    assert.match(byId(report, 'desktop-window').detail, /desktop/);
    assert.equal(byId(report, 'web-demo').status, 'skipped');
    assert.match(byId(report, 'web-demo').detail, /allowNetwork/);
    assert.equal(byId(report, 'cleanup').status, 'passed');
    assert.equal(report.ok, true);

    // 真的起了本地 HTTP server：fake page.open 用 fetch 读到了页面。
    assert.equal(state.opened.length, 1);
    assert.match(state.opened[0]!, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.deepEqual(state.calls, ['open', 'type', 'click']);

    const shots = byId(report, 'browser-local').screenshots;
    assert.ok(shots && shots.length === 1);
    assert.ok(isAbsolute(shots[0]!));
    assert.equal(dirname(shots[0]!), join(dataDir, 'selftest'));
    assert.match(basename(shots[0]!), /^\d{8}-\d{6}-browser-local\.png$/);
    assert.ok(existsSync(shots[0]!));
    assert.deepEqual(readFileSync(shots[0]!), Buffer.from('fake-png-bytes'));
    assert.ok(lines.some(line => line.includes('browser-local')));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('browser-local 断言错误时转成 failed，runSelftest 不 reject', async () => {
  const dataDir = makeDataDir();
  try {
    const { browser } = fakeBrowser({ evaluateResult: 'WRONG OUTPUT' });
    const report = await runSelftest({ dataDir, browser, allowNetwork: false });
    const item = byId(report, 'browser-local');
    assert.equal(item.status, 'failed');
    assert.match(item.detail, /WRONG OUTPUT/);
    assert.equal(report.ok, false);
    assert.equal(byId(report, 'cleanup').status, 'passed');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('browser-local 超时不会挂死，超时项记 failed', async () => {
  const dataDir = makeDataDir();
  try {
    const { browser } = fakeBrowser({ hangOpen: true });
    const started = Date.now();
    const report = await runSelftest({ dataDir, browser, allowNetwork: false, timeouts: { browserLocal: 300 } });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 10_000, `应该在超时后很快返回，实际 ${elapsed}ms`);
    const item = byId(report, 'browser-local');
    assert.equal(item.status, 'failed');
    assert.match(item.detail, /超时/);
    assert.equal(report.ok, false);
    // cleanup 仍然能关掉 browser-local 留下的 server
    assert.equal(byId(report, 'cleanup').status, 'passed');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('浏览器缺失时 browser-local 记 skipped 而不是 failed', async () => {
  const dataDir = makeDataDir();
  try {
    const { browser } = fakeBrowser({ browserState: 'missing' });
    const report = await runSelftest({ dataDir, browser, allowNetwork: false });
    const item = byId(report, 'browser-local');
    assert.equal(item.status, 'skipped');
    assert.match(item.detail, /Edge\/Chrome|missing/);
    assert.equal(report.ok, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
