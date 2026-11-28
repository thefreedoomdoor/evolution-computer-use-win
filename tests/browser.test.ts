import assert from 'node:assert/strict';
import test from 'node:test';
import { Faults } from '../src/shared/faults.ts';
import { createArbiter, withCall } from '../src/desktop/arbiter.ts';
import { createBrowser } from '../src/browser/browser.ts';
import type { Cdp, Target } from '../src/browser/cdp.ts';
import type { PageGeometryProvider } from '../src/browser/page.ts';
import type { TrustedCallerContext } from '../src/tool.ts';

// A real run uses the broker over a named pipe; in tests the gate lives in this process.
process.env.EVOLUTION_CU_ARBITER = 'inproc';

const caller = (agentId = 'agent-a'): TrustedCallerContext => ({
  identity: 'trusted', agentId, rootAgentId: 'lead', depth: 1, lifetime: 1, callId: `call-${agentId}`,
});

const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 5); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tab = (id: string): Target => ({ id, type: 'page', url: 'about:blank', title: '', webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/${id}` });

function answer(method: string, params: Record<string, unknown>): unknown {
  if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, visualViewport: { scale: 1 } };
  if (method !== 'Runtime.evaluate') return {};
  const expression = typeof params.expression === 'string' ? params.expression : '';
  if (expression.includes('__evolutionCU.point')) return { result: { value: { x: 42, y: 24 } } };
  if (expression.includes('__evolutionCU.focus')) return { result: { value: 'ok' } };
  return { result: { value: null } };
}

/** One browser over fake connections; every method of every tab lands in one log so the order is visible. */
function harness(options: { geometry?: PageGeometryProvider; find?: () => string | undefined } = {}) {
  const log: string[] = [];
  let connects = 0;
  let crashed = false;
  const open = (name: string): Cdp => {
    let closed = false;
    return {
      async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        log.push(`${name}:${method}`);
        return answer(method, params) as T;
      },
      on() { return () => {}; },
      close() { closed = true; log.push(`${name}:close`); },
      get closed() { return closed || (name === 'main' && crashed); },
    };
  };
  const browser = createBrowser({
    profileDir: 'profile-a',
    faults: new Faults(),
    ...(options.geometry ? { geometry: options.geometry } : {}),
    ...(options.find ? { find: options.find } : { find: () => 'C:/browser/msedge.exe' }),
    running: async () => 9333,
    launch: async () => 9333,
    targets: async () => [tab('main')],
    open: async () => tab('scratch'),
    close: async (_port, id) => { log.push(`closed:${id}`); },
    connect: async url => { connects += 1; return open(url.split('/').pop()!); },
  });
  return { browser, log, connects: () => connects, crash: () => { crashed = true; } };
}

test('steps take their turn in the order they were asked for', async () => {
  const fake = harness();
  const order: string[] = [];
  const first = fake.browser.run(async page => { order.push('a-start'); await page.bringToFront(); order.push('a-end'); });
  const second = fake.browser.scratch(async page => { order.push('b-start'); await page.bringToFront(); order.push('b-end'); });
  const third = fake.browser.run(async page => { order.push('c-start'); await page.bringToFront(); order.push('c-end'); });
  await Promise.all([first, second, third]);

  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end']);
  // The tab of its own is gone again before the next step starts, so nothing it left behind can be seen by that step.
  assert.deepEqual(fake.log, [
    'main:Page.bringToFront',
    'scratch:Page.bringToFront',
    'scratch:close',
    'closed:scratch',
    'main:Page.bringToFront',
  ]);
});

test('each tab reports its own identity to the measurement', async () => {
  const seen: string[] = [];
  const fake = harness({ geometry: async targetId => { seen.push(targetId); return css => ({ x: css.x, y: css.y }); } });
  const arbiter = createArbiter({ sink: () => {} });

  await withCall(caller(), undefined, () => fake.browser.run(page => page.click({ ref: 1 })), arbiter);
  await withCall(caller(), undefined, () => fake.browser.scratch(page => page.click({ ref: 1 })), arbiter);

  assert.deepEqual(seen, ['main', 'scratch']);
});

test('a caller that gave up while waiting opens no tab', async () => {
  const fake = harness();
  const gate = deferred<void>();
  const first = fake.browser.run(async page => { await gate.promise; await page.bringToFront(); });
  const stop = new AbortController();
  const second = fake.browser.scratch(page => page.bringToFront(), stop.signal);
  stop.abort();
  gate.resolve();
  await first;

  await assert.rejects(second, (error: unknown) => (error as Error).name === 'AbortError');
  assert.equal(fake.log.some(entry => entry.startsWith('closed:')), false, 'no tab is opened for a caller that left');
  assert.equal(fake.connects(), 1);
});

test('a step is told to stop through its own signal', async () => {
  const fake = harness();
  let aborted = false;
  const running = fake.browser.run((_page, signal) => new Promise<void>(resolve => {
    signal.addEventListener('abort', () => { aborted = signal.aborted; resolve(); }, { once: true });
  }));
  await tick();
  fake.browser.stop();
  await assert.rejects(running, /已停止/);

  assert.equal(aborted, true);
  assert.ok(fake.log.includes('main:close'), 'the connection is dropped once the step has let go');
});

test('a connection that died is replaced on the next step', async () => {
  const fake = harness();
  await fake.browser.run(page => page.bringToFront());
  assert.equal(fake.connects(), 1);

  fake.crash();
  await fake.browser.run(page => page.bringToFront());
  assert.equal(fake.connects(), 2);
  assert.equal(fake.log.filter(entry => entry === 'main:Page.bringToFront').length, 2);
});

test('a step that fails does not take the next one down', async () => {
  const fake = harness();
  await assert.rejects(fake.browser.run(() => { throw new Error('点不到'); }), /点不到/);
  await fake.browser.run(page => page.bringToFront());
  assert.equal(fake.log.filter(entry => entry === 'main:Page.bringToFront').length, 1);
  assert.equal(fake.connects(), 1);
});

test('status tells a missing browser from an idle one', async () => {
  assert.equal(harness({ find: () => undefined }).browser.status().state, 'missing');
  const fake = harness();
  assert.equal(fake.browser.status().state, 'stopped');
  await fake.browser.run(page => page.bringToFront());
  assert.equal(fake.browser.status().state, 'running');
});
