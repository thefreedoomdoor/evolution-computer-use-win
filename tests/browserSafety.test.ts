// What a real page action does when nobody made a tool call for it, and what happens to the input gate when a stop could
// not be finished cleanly. The pages and browsers here are the production ones; only the CDP socket is a fake, so the
// lease, the audit and the release under test are the shipped code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Faults } from '../src/shared/faults.ts';
import { CancelledError, UncertainError, createArbiter, withCall, type Arbiter } from '../src/desktop/arbiter.ts';
import { createBrowser } from '../src/browser/browser.ts';
import { createPage } from '../src/browser/page.ts';
import type { Cdp, Target } from '../src/browser/cdp.ts';
import type { ActionEvent, TrustedCallerContext } from '../src/tool.ts';

// A real run uses the cross-process broker; in tests the one gate of this process is enough, and nothing is spawned.
process.env.EVOLUTION_CU_ARBITER = 'inproc';

interface Sent { name: string; method: string; params: Record<string, unknown> }
type Hang = (method: string, params: Record<string, unknown>) => boolean;

const caller = (agentId: string): TrustedCallerContext => ({
  identity: 'trusted', agentId, rootAgentId: 'lead', depth: 1, lifetime: 1, callId: `call-${agentId}`,
});

const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 5); });

const tab = (id: string): Target => ({ id, type: 'page', url: 'about:blank', title: '', webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/${id}` });

/** Only what the page primitives actually read: the element at a point, and the layout they never need here. */
function answer(method: string, params: Record<string, unknown>): unknown {
  if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, visualViewport: { scale: 1 } };
  if (method !== 'Runtime.evaluate') return {};
  const expression = typeof params.expression === 'string' ? params.expression : '';
  if (expression.includes('__evolutionCU.point')) return { result: { value: { x: 42, y: 24 } } };
  if (expression.includes('__evolutionCU.focus')) return { result: { value: 'ok' } };
  return { result: { value: null } };
}

function fakeCdp(name: string, sent: Sent[], hang?: Hang): { cdp: Cdp; at: (method: string) => number } {
  let closed = false;
  const cdp: Cdp = {
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      sent.push({ name, method, params });
      if (hang?.(method, params)) return await new Promise<never>(() => {});
      return answer(method, params) as T;
    },
    on() { return () => {}; },
    close() { closed = true; },
    get closed() { return closed; },
  };
  return { cdp, at: method => sent.filter(one => one.method === method).length };
}

const mouseTypes = (sent: Sent[]): unknown[] => sent.filter(one => one.method === 'Input.dispatchMouseEvent').map(one => one.params.type);
const phases = (events: ActionEvent[]): string[] => events.map(one => one.phase);

async function until(ready: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error('the test never saw what it waited for');
    await tick();
  }
}

function harness(options: { arbiter?: Arbiter; hang?: Hang; timeoutMs?: number } = {}) {
  const sent: Sent[] = [];
  const names: string[] = [];
  const browser = createBrowser({
    profileDir: 'profile-a',
    faults: new Faults(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.arbiter ? { arbiter: options.arbiter } : {}),
    find: () => 'C:/browser/msedge.exe',
    running: async () => 9333,
    launch: async () => 9333,
    targets: async () => [tab('main')],
    open: async () => tab('scratch'),
    close: async () => {},
    connect: async url => { const name = url.split('/').pop()!; names.push(name); return fakeCdp(name, sent, options.hang).cdp; },
  });
  return { browser, sent, names };
}

test('a page nobody made a call for still takes the machine-wide input lease and says it is legacy', async () => {
  const events: ActionEvent[] = [];
  const mine = createArbiter({ sink: event => events.push(event) });
  const sent: Sent[] = [];
  const page = createPage(fakeCdp('main', sent).cdp, { arbiter: mine });

  await page.click({ ref: 1 });

  assert.deepEqual(mouseTypes(sent), ['mouseMoved', 'mousePressed', 'mouseReleased'], 'the click is real input to the page');
  assert.deepEqual(phases(events), ['queued', 'granted', 'approaching', 'executing', 'progress', 'succeeded']);
  assert.equal(new Set(events.map(one => one.requestId)).size, 1, 'one click is one request');
  for (const event of events) {
    assert.equal(event.actor.trust, 'legacy', 'nobody vouched for this caller, so the record must not claim one did');
    assert.equal(event.actor.agentId, 'legacy');
  }

  await page.click({ ref: 1 });
  assert.equal(new Set(events.map(one => one.requestId)).size, 2, 'the second click is its own request');
});

test('a page without a call waits for the step that holds the lease instead of entering beside it', async () => {
  const events: ActionEvent[] = [];
  const mine = createArbiter({ sink: event => events.push(event) });
  const sent: Sent[] = [];
  const page = createPage(fakeCdp('main', sent).cdp, { arbiter: mine });

  let release!: () => void;
  const holder = withCall(caller('agent-a'), undefined, () => mine.runAction({ kind: 'wait', label: 'hold the input' }, () => new Promise<void>(resolve => { release = resolve; })));
  await tick();
  const clicking = page.click({ ref: 1 });
  await tick();
  assert.deepEqual(mouseTypes(sent), [], 'nothing may be pressed while somebody else holds the input');

  release();
  await clicking;
  await holder;
  assert.deepEqual(mouseTypes(sent), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(events.some(one => one.phase === 'queued' && one.actor.trust === 'legacy'));
  assert.ok(events.some(one => one.phase === 'succeeded' && one.actor.trust === 'trusted'));
});

test('a page whose arbiter is unknown refuses to send anything', async () => {
  const mine = createArbiter();
  const sent: Sent[] = [];
  const page = createPage(fakeCdp('main', sent).cdp, { arbiter: mine });
  mine.poison('上一步结果不明，状态未知。');

  await assert.rejects(page.click({ ref: 1 }), (error: Error) => error instanceof UncertainError && /上一步结果不明/.test(error.message));
  assert.deepEqual(mouseTypes(sent), []);
});

test('the identity a browser was given is kept, and one it was not is never invented', async () => {
  const events: ActionEvent[] = [];
  const mine = createArbiter({ sink: event => events.push(event) });
  const one = harness({ arbiter: mine });

  await withCall(caller('agent-a'), undefined, () => one.browser.run(page => page.click({ ref: 1 })), mine);
  const trusted = events.filter(one => one.phase === 'granted');
  assert.equal(trusted.length, 1);
  assert.equal(trusted[0].actor.trust, 'trusted');
  assert.equal(trusted[0].actor.agentId, 'agent-a');

  await one.browser.run(page => page.click({ ref: 1 }));
  const legacy = events.filter(one => one.phase === 'granted')[1];
  assert.equal(legacy.actor.trust, 'legacy', 'input sent outside a call is recorded as legacy, not dressed up');
  one.browser.stop();
});

test('a stop that cannot put the button back poisons the browser own arbiter, with no call around it', async () => {
  const events: ActionEvent[] = [];
  const mine = createArbiter({ sink: event => events.push(event) });
  // Both the press and the release hang: the press leaves the button down, and nothing can prove it came up again.
  const fake = harness({ arbiter: mine, hang: (method, params) => method === 'Input.dispatchMouseEvent' && (params.type === 'mousePressed' || params.type === 'mouseReleased') });

  const clicking = fake.browser.run(page => page.click({ ref: 1 }));
  clicking.catch(() => {});
  await until(() => fake.sent.some(one => one.params.type === 'mousePressed'));
  await fake.browser.stop();

  await assert.rejects(clicking);
  // The step's own settlement may land a turn after the stop's verdict, so wait for it before reading the audit.
  await until(() => events.some(one => one.phase === 'uncertain'));
  assert.match(mine.poisonedReason() ?? '', /放回去|没能确认松开/, 'the instance that owns this input must know its state is unknown');
  assert.equal(events.at(-1)?.phase, 'uncertain', 'the audit says unknown, not cancelled');

  const sent: Sent[] = [];
  const after = createPage(fakeCdp('after', sent).cdp, { arbiter: mine });
  await assert.rejects(after.click({ ref: 1 }), (error: Error) => error instanceof UncertainError);
  assert.deepEqual(mouseTypes(sent), [], 'a poisoned instance sends nothing else');
});

test('a disposed arbiter cancels what it had queued and keeps its poison', async () => {
  const mine = createArbiter();
  let release!: () => void;
  const holder = mine.runAction({ kind: 'wait', label: 'hold the input' }, () => new Promise<void>(resolve => { release = resolve; }));
  const queued = mine.runAction({ kind: 'click' }, async () => 'ran');
  const settled = queued.then(() => 'ran', (error: Error) => error);
  await tick();
  mine.poison('上一步结果不明，状态未知。');

  mine.dispose();
  const error = await settled;
  assert.ok(error instanceof CancelledError, 'a step that never started is cancelled, not called unknown');
  // Either wording is the same contract — the queued step never started. Which one wins depends on whether the disposed
  // arbiter's gate rejects its waiters before or after the abort reaches them; the message is not the behaviour.
  assert.match((error as Error).message, /还没轮到|已经退出/);

  release();
  await holder;
  assert.equal(mine.poisonedReason(), '上一步结果不明，状态未知。', 'shutting down proves nothing about input that was in flight');
  // The poison is the more specific reason, so it is the one reported; either way the instance refuses.
  await assert.rejects(mine.runAction({ kind: 'click' }, async () => 'late'), (late: Error) => late instanceof UncertainError && /上一步结果不明|已经退出/.test(late.message));
  mine.dispose();
});

test('one browser own arbiter knows nothing about another one', async () => {
  const first: ActionEvent[] = [];
  const second: ActionEvent[] = [];
  const a = createArbiter({ sink: event => first.push(event) });
  const b = createArbiter({ sink: event => second.push(event) });
  const one = harness({ arbiter: a });
  const two = harness({ arbiter: b });

  a.poison('上一步结果不明，状态未知。');
  await assert.rejects(one.browser.run(page => page.click({ ref: 1 })), (error: Error) => error instanceof UncertainError);
  assert.deepEqual(mouseTypes(one.sent), [], 'the poisoned browser sends nothing');
  assert.deepEqual(first, [], 'a refused step is not even queued in its audit');

  await two.browser.run(page => page.click({ ref: 1 }));
  assert.deepEqual(mouseTypes(two.sent), ['mouseMoved', 'mousePressed', 'mouseReleased'], 'the other browser still works');
  assert.equal(b.poisonedReason(), undefined, 'the poison belongs to one instance');
  assert.ok(second.length > 0 && second.every(one_ => one_.actor.trust === 'legacy'));
  await one.browser.stop();
  await two.browser.stop();
});

test('a stop that got the button back leaves the instance ready for the next input', async () => {
  const events: ActionEvent[] = [];
  const mine = createArbiter({ sink: event => events.push(event) });
  // Only the press hangs: letting go of the button is answered, so the stop is clean and proves nothing is unknown.
  const fake = harness({ arbiter: mine, hang: (method, params) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' });

  const clicking = fake.browser.run(page => page.click({ ref: 1 }));
  clicking.catch(() => {});
  await until(() => fake.sent.some(one => one.params.type === 'mousePressed'));
  await fake.browser.stop();

  await assert.rejects(clicking);
  assert.equal(mine.poisonedReason(), undefined, 'a release that was answered does not shut the gate');
  // The lease came back with the release, so the very same instance can take the next input at once.
  assert.equal(await mine.runAction({ kind: 'move' }, async () => 'ran'), 'ran', 'the next input is not left waiting for a lease nobody gave back');
});

test('a page inside a call is shut by the instance that call runs in, not by the browser own one', async () => {
  // The browser makes its own instance (no arbiter passed), while the call runs in a different one: whatever stops the
  // step mid-press must shut the instance that actually holds the lease, and must not hand that lease on.
  const fake = harness({ hang: (method, params) => method === 'Input.dispatchMouseEvent' && (params.type === 'mousePressed' || params.type === 'mouseReleased') });
  const events: ActionEvent[] = [];
  const inCall = createArbiter({ sink: event => events.push(event) });
  const controller = new AbortController();

  const clicking = withCall(caller('agent-a'), controller.signal, () => fake.browser.run(page => page.click({ ref: 1 })), inCall);
  clicking.catch(() => {});
  await until(() => fake.sent.some(one => one.params.type === 'mousePressed'));
  controller.abort();

  await assert.rejects(clicking, (error: Error) => error instanceof UncertainError && /松开|结果不明/.test(error.message));
  assert.match(inCall.poisonedReason() ?? '', /松开|结果不明/, 'the instance that held the lease knows the button may still be down');
  assert.equal(events.at(-1)?.phase, 'uncertain', 'its audit says unknown, not cancelled');
  // The lease was not given back: this instance must refuse the next input rather than let another click through.
  await assert.rejects(inCall.runAction({ kind: 'move' }, async () => 'ran'), (error: Error) => error instanceof UncertainError);
  await fake.browser.stop();
});

test('a timeout shuts this browser own gate, and only this one', async () => {
  // Both the press and the release hang, so the clock cuts the step with nothing proved about the button.
  const one = harness({ timeoutMs: 25, hang: (method, params) => method === 'Input.dispatchMouseEvent' && (params.type === 'mousePressed' || params.type === 'mouseReleased') });
  const two = harness({});

  await assert.rejects(one.browser.run(page => page.click({ ref: 1 })), /超时|结果不明/);
  const sentByThen = mouseTypes(one.sent).length;
  // The same browser may not send more input: its own instance is shut, and that is not something a later step may ignore.
  await assert.rejects(one.browser.run(page => page.click({ ref: 1 })), (error: Error) => error instanceof UncertainError && /结果不明|超时|上一步/.test(error.message));
  assert.equal(mouseTypes(one.sent).length, sentByThen, 'a shut gate sends nothing else');

  await two.browser.run(page => page.click({ ref: 1 }));
  assert.deepEqual(mouseTypes(two.sent), ['mouseMoved', 'mousePressed', 'mouseReleased'], 'the browser that made its own instance is untouched');
  await one.browser.stop();
  await two.browser.stop();
});
