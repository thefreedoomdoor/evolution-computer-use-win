import assert from 'node:assert/strict';
import test from 'node:test';
import { Faults } from '../src/shared/faults.ts';
import { UncertainError, createArbiter, withCall } from '../src/desktop/arbiter.ts';
import { createBrowser } from '../src/browser/browser.ts';
import type { Cdp, Target } from '../src/browser/cdp.ts';
import type { PageGeometryProvider } from '../src/browser/page.ts';
import type { ActionEvent, TrustedCallerContext } from '../src/tool.ts';

// A real run uses the broker over a named pipe; in tests the gate lives in this process.
process.env.EVOLUTION_CU_ARBITER = 'inproc';

const PUBLISH = 'Runtime.evaluate';
const SCRIPT = 'Promise.race([';

interface Sent { name: string; method: string; params: Record<string, unknown> }
type Hang = (name: string, method: string, params: Record<string, unknown>) => boolean;

const caller = (agentId: string): TrustedCallerContext => ({
  identity: 'trusted', agentId, rootAgentId: 'lead', depth: 1, lifetime: 1, callId: `call-${agentId}`,
});

const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 5); });

const tab = (id: string): Target => ({ id, type: 'page', url: 'about:blank', title: '', webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/${id}` });

function answer(method: string, params: Record<string, unknown>, point?: () => { x: number; y: number }): unknown {
  if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, visualViewport: { scale: 1 } };
  if (method !== PUBLISH) return {};
  const expression = typeof params.expression === 'string' ? params.expression : '';
  if (expression.includes('__evolutionCU.point')) return { result: { value: point ? point() : { x: 42, y: 24 } } };
  if (expression.includes('__evolutionCU.focus')) return { result: { value: 'ok' } };
  if (expression.includes('__evolutionCU.snapshot')) {
    return { result: { value: { url: 'about:blank', title: 'page', controls: [{ ref: 1, role: 'button', name: 'Go', view: true, value: '' }], text: '' } } };
  }
  if (expression.includes('__evolutionCU.has')) return { result: { value: true } };
  if (expression.includes(SCRIPT)) return { result: { value: 7 } };
  return { result: { value: null } };
}

/** One browser whose tabs are all fake connections, with every method in one log so the order can be checked. */
function harness(options: { hang?: Hang; timeoutMs?: number; geometry?: PageGeometryProvider; point?: () => { x: number; y: number } } = {}) {
  const log: string[] = [];
  const sent: Sent[] = [];
  let connects = 0;
  const open = (name: string): Cdp => {
    let closed = false;
    const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
    return {
      async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        sent.push({ name, method, params });
        log.push(`${name}:${method}:${String(params.type ?? '')}`);
        if (options.hang?.(name, method, params)) return await new Promise<never>(() => {});
        return answer(method, params, options.point) as T;
      },
      on(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      close() { closed = true; log.push(`${name}:close`); },
      get closed() { return closed; },
    };
  };
  const browser = createBrowser({
    profileDir: 'profile-a',
    faults: new Faults(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.geometry ? { geometry: options.geometry } : {}),
    find: () => 'C:/browser/msedge.exe',
    running: async () => 9333,
    launch: async () => 9333,
    targets: async () => [tab('main')],
    open: async () => tab('scratch'),
    close: async () => {},
    connect: async url => { connects += 1; return open(url.split('/').pop()!); },
  });
  return { browser, log, sent, connects: () => connects };
}

const mouseTypes = (sent: Sent[]): unknown[] => sent.filter(one => one.method === 'Input.dispatchMouseEvent').map(one => one.params.type);

test('two callers waiting in one queue never trade places', async () => {
  const fake = harness();
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });

  const first = withCall(caller('agent-a'), undefined, () => fake.browser.run(page => page.click({ ref: 1 })), arbiter);
  const second = withCall(caller('agent-b'), undefined, () => fake.browser.run(page => page.click({ ref: 1 })), arbiter);
  await Promise.all([first, second]);

  const requests = [...new Set(events.map(event => event.requestId))];
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const group = events.filter(event => event.requestId === request);
    assert.equal(new Set(group.map(event => event.actor.agentId)).size, 1, 'one request belongs to one agent');
    assert.equal(new Set(group.map(event => event.actor.lifetime)).size, 1);
  }
  // Queued in arrival order, served in arrival order: the first request is agent-a's.
  assert.equal(events.find(event => event.requestId === requests[0])!.actor.agentId, 'agent-a');
  assert.equal(events.find(event => event.requestId === requests[1])!.actor.agentId, 'agent-b');
  // And the input itself never interleaves: one whole click, then the other.
  assert.deepEqual(mouseTypes(fake.sent), ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(fake.connects(), 1);
});

test('a stop lets the button go before the connection drops', async () => {
  const fake = harness({ hang: (name, method, params) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' });
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });

  const started = withCall(caller('agent-a'), undefined, () => fake.browser.run(page => page.click({ ref: 1 })), arbiter);
  await tick();
  fake.browser.stop();

  await assert.rejects(started, /已停止/);
  const order = fake.log.filter(entry => entry.includes('mousePressed') || entry.includes('mouseReleased') || entry.endsWith(':close'));
  assert.ok(order.length >= 3, `expected press, release and close, got ${order.join(' | ')}`);
  assert.match(order[0]!, /mousePressed/);
  assert.match(order[1]!, /mouseReleased/);
  assert.ok(order.findIndex(entry => entry.endsWith(':close')) > order.findIndex(entry => entry.includes('mouseReleased')), 'the release goes out before the socket closes');
  assert.equal(events.at(-1)!.phase, 'cancelled');
  assert.equal(arbiter.poisonedReason(), undefined);
});

test('a timeout is an unknown outcome, not a clean stop', async () => {
  const fake = harness({ timeoutMs: 25, hang: (_name, method) => method === 'Input.insertText' });
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });

  await assert.rejects(
    withCall(caller('agent-a'), undefined, () => fake.browser.run(page => page.type({ ref: 1 }, 'hello')), arbiter),
    error => error instanceof UncertainError && /超时/.test(String(error.message)),
  );
  assert.equal(events.at(-1)!.phase, 'uncertain');
  assert.ok(arbiter.poisonedReason(), 'text that may have gone out keeps the gate shut');
  assert.ok(fake.log.some(entry => entry.endsWith(':close')), 'the connection is dropped once the step cannot be proven finished');
});

test('two clicks inside one step are two actions', async () => {
  const fake = harness();
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });

  await withCall(caller('agent-a'), undefined, () => fake.browser.run(async page => {
    await page.click({ ref: 1 });
    await page.click({ ref: 1 });
  }), arbiter);

  const requests = [...new Set(events.map(event => event.requestId))];
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(events.filter(event => event.requestId === request).map(event => event.seq), [1, 2, 3, 4, 5, 6]);
  }
  assert.deepEqual(mouseTypes(fake.sent), ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('the measurement is asked for the tab the input goes to', async () => {
  const seen: string[] = [];
  const fake = harness({
    geometry: async (targetId, layout) => {
      seen.push(targetId);
      const metrics = await layout();
      assert.equal(metrics?.cssWidth, 800, 'the scale divisor comes from the browser, not from the page');
      return css => ({ x: css.x, y: css.y });
    },
  });
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });

  await withCall(caller('agent-a'), undefined, () => fake.browser.run(page => page.click({ ref: 1 })), arbiter);
  await withCall(caller('agent-b'), undefined, () => fake.browser.scratch(page => page.click({ ref: 1 })), arbiter);

  assert.deepEqual(seen, ['main', 'scratch']);
  const layouts = fake.sent.filter(entry => entry.method === 'Page.getLayoutMetrics');
  assert.deepEqual(layouts.map(entry => entry.name), ['main', 'scratch']);
  // Announced without a position, then the input names one: the step is measured in its own turn, per tab.
  assert.deepEqual([...new Set(events.map(event => event.space))].sort(), ['physical', 'window']);
  assert.equal(events[0]!.space, 'window');
  assert.ok(events.some(event => event.space === 'physical' && event.to !== undefined));
});

test('the position is measured after the point is found, never before it', async () => {
  // Finding a point can scroll the element into view, and the tab's content area moves with that scroll. A measurement
  // taken before the point was found would name a place the input no longer goes to, so the point comes first and the
  // measurement follows it — both inside the same turn, before any input.
  const steps: string[] = [];
  let origin = 100;
  const fake = harness({
    point: () => { steps.push('point'); origin = 500; return { x: 42, y: 24 }; },
    geometry: async (_targetId, layout) => {
      await layout();
      steps.push('measure');
      const base = origin;
      return css => ({ x: base + css.x, y: base + css.y });
    },
  });
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });

  await withCall(caller('agent-a'), undefined, () => fake.browser.run(page => page.click({ ref: 1 })), arbiter);

  assert.deepEqual(steps, ['point', 'measure'], 'the point is found first, the place is measured second');
  const placed = events.filter(event => event.to !== undefined);
  assert.ok(placed.length >= 2, 'the approach and the press name the place the input reached');
  for (const event of placed) assert.deepEqual(event.to, { x: 542, y: 524 }, 'only the post-scroll content area is used');
  const chase = fake.sent.filter(entry => entry.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(chase.map(entry => entry.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  for (const entry of chase) {
    assert.deepEqual([entry.params.x, entry.params.y], [42, 24], 'the input itself still speaks CSS pixels');
  }
});

test('stopping an idle browser closes it and refuses the next step', async () => {
  const fake = harness();
  const arbiter = createArbiter({ sink: () => {} });

  await withCall(caller('agent-a'), undefined, () => fake.browser.run(page => page.bringToFront()), arbiter);
  fake.browser.stop();
  assert.ok(fake.log.some(entry => entry === 'main:close'));
  assert.equal(fake.browser.status().state, 'stopped');
  await assert.rejects(withCall(caller('agent-a'), undefined, () => fake.browser.run(page => page.bringToFront()), arbiter), /已停止/);
});

test('a queued step is measured after it holds the input, never while it waits', async () => {
  const steps: string[] = [];
  let origin = 100;
  const measured: number[] = [];
  const geometry: PageGeometryProvider = async (_targetId, readLayout) => {
    const layout = await readLayout();
    if (!layout) return null;
    measured.push(origin);
    steps.push('measure');
    return css => ({ x: origin + css.x, y: 140 + css.y });
  };
  const fake = harness({ geometry });
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); steps.push(`${event.phase}:${event.action.kind}`); } });

  let letGo!: () => void;
  const held = new Promise<void>(resolve => { letGo = resolve; });
  const holder = withCall(caller('agent-z'), undefined,
    () => arbiter.runAction({ kind: 'wait', label: 'hold the input' }, () => held), arbiter);
  await tick();

  const click = withCall(caller('agent-a'), undefined, () => fake.browser.run(page => page.click({ ref: 1 })), arbiter);
  await tick();
  await tick();
  assert.deepEqual(measured, [], 'nothing is measured while the step is still queued');
  origin = 900; // the window moved while the step waited for its turn
  letGo();
  await Promise.all([holder, click]);

  assert.deepEqual(measured, [900], 'the one measurement of this step is taken inside its own turn');
  const order = steps.join(' ');
  assert.ok(order.indexOf('measure') > order.indexOf('granted:click'), `expected grant before measure, got ${order}`);

  const mine = [...new Set(events.map(event => event.requestId))]
    .find(id => events.some(event => event.requestId === id && event.action.kind === 'click'))!;
  const group = events.filter(event => event.requestId === mine);
  for (const phase of ['queued', 'granted', 'succeeded']) {
    const event = group.find(one => one.phase === phase);
    assert.ok(event, `expected a ${phase} event`);
    assert.equal(event.space, 'window');
    assert.equal(event.to, undefined);
  }
  const points = group.filter(event => event.to !== undefined);
  assert.ok(points.length >= 2, 'the approach and the press name the place the step actually reached');
  for (const event of points) {
    assert.equal(event.space, 'physical');
    assert.deepEqual(event.to, { x: 942, y: 164 });
  }
  assert.ok(!events.some(event => event.to?.x === 142), 'the position taken before the wait never reaches the audit');
});

test('a step cancelled while it waits is never measured and sends nothing', async () => {
  const measured: string[] = [];
  const geometry: PageGeometryProvider = async (targetId, readLayout) => {
    await readLayout();
    measured.push(targetId);
    return css => ({ x: css.x, y: css.y });
  };
  const fake = harness({ geometry });
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });

  let letGo!: () => void;
  const held = new Promise<void>(resolve => { letGo = resolve; });
  const holder = withCall(caller('agent-z'), undefined,
    () => arbiter.runAction({ kind: 'wait', label: 'hold the input' }, () => held), arbiter);
  await tick();

  const controller = new AbortController();
  const click = withCall(caller('agent-a'), controller.signal, () => fake.browser.run(page => page.click({ ref: 1 })), arbiter);
  await tick();
  controller.abort();
  await assert.rejects(click, /取消/);
  letGo();
  await holder;

  assert.deepEqual(measured, [], 'a cancelled step gets nothing measured on its behalf');
  assert.deepEqual(mouseTypes(fake.sent), [], 'and no input goes out');
  // The last event overall is the holder finishing its own turn, not this click: check the click's own record, which must
  // be recorded as waiting and then cancelled, without ever being granted or reported as done.
  const mine = [...new Set(events.map(event => event.requestId))]
    .find(id => events.some(event => event.requestId === id && event.action.kind === 'click'))!;
  const phases = events.filter(event => event.requestId === mine).map(event => event.phase);
  assert.equal(phases.at(-1), 'cancelled', `expected the click to end cancelled, got ${phases.join(' ')}`);
  assert.ok(phases.includes('queued'), 'the click was recorded as waiting its turn');
  assert.ok(!phases.includes('granted') && !phases.includes('succeeded'), 'a cancelled step never held the input nor finished');
});

test('a measurement that arrives after the step was cancelled is never used', async () => {
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const geometry: PageGeometryProvider = async (_targetId, readLayout) => {
    await readLayout();
    await slow;
    return css => ({ x: 500 + css.x, y: css.y });
  };
  const fake = harness({ geometry });
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });

  const controller = new AbortController();
  const click = withCall(caller('agent-a'), controller.signal, () => fake.browser.run(page => page.click({ ref: 1 })), arbiter);
  await tick();
  await tick();
  controller.abort();
  release();

  await assert.rejects(click, /取消/);
  assert.deepEqual(mouseTypes(fake.sent), [], 'no input follows a cancel that arrived during the measurement');
  assert.equal(events.filter(event => event.to !== undefined).length, 0, 'a late measurement never becomes a position');
  assert.equal(events.at(-1)!.phase, 'cancelled');
});
