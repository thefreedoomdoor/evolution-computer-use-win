import assert from 'node:assert/strict';
import test from 'node:test';
import { CancelledError, UncertainError, createArbiter, runAction, withCall } from '../src/desktop/arbiter.ts';
import { createPage } from '../src/browser/page.ts';
import type { Cdp } from '../src/browser/cdp.ts';
import type { ActionEvent, TrustedCallerContext } from '../src/tool.ts';
import type { Timers } from '../src/shared/timers.ts';

// The arbiter's process-wide gate reads this when it is first used; a real run uses the broker over a named pipe.
process.env.EVOLUTION_CU_ARBITER = 'inproc';

const PUBLISH = 'Runtime.evaluate';
const SCRIPT = 'Promise.race([';

interface Sent { method: string; params: Record<string, unknown> }

/** A browser connection that answers the few reads a page needs and records everything that was sent. */
function fakeCdp(options: { hang?: (method: string, params: Record<string, unknown>) => boolean } = {}) {
  const sent: Sent[] = [];
  let closed = false;
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  const cdp: Cdp = {
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      sent.push({ method, params });
      if (options.hang?.(method, params)) return await new Promise<never>(() => {});
      return answer(method, params) as T;
    },
    on(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { closed = true; },
    get closed() { return closed; },
  };
  return { cdp, sent };
}

function answer(method: string, params: Record<string, unknown>): unknown {
  if (method !== PUBLISH) return {};
  const expression = typeof params.expression === 'string' ? params.expression : '';
  if (expression.includes('__evolutionCU.point')) return { result: { value: { x: 42, y: 24 } } };
  if (expression.includes('__evolutionCU.focus')) return { result: { value: 'ok' } };
  if (expression.includes('__evolutionCU.snapshot')) {
    return { result: { value: { url: 'about:blank', title: 'page', controls: [{ ref: 1, role: 'button', name: 'Go', view: true, value: '' }], text: '' } } };
  }
  if (expression.includes('__evolutionCU.has')) return { result: { value: true } };
  if (expression.includes(SCRIPT)) return { result: { value: 7 } };
  return { result: { value: null } };
}

const caller = (agentId: string): TrustedCallerContext => ({
  identity: 'trusted', agentId, rootAgentId: 'lead', depth: 1, lifetime: 1, callId: `call-${agentId}`,
});

const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 5); });

/** Timers a test fires itself, so a half-second release bound costs no real time. */
function handTimers(): { timers: Timers; fire: () => void; pending: () => number } {
  const waiting = new Map<number, () => void>();
  let next = 1;
  return {
    timers: {
      set(work: () => void) { const id = next++; waiting.set(id, work); return id; },
      clear(handle: unknown) { waiting.delete(handle as number); },
    },
    fire() { const due = [...waiting.values()]; waiting.clear(); for (const work of due) work(); },
    pending() { return waiting.size; },
  };
}

const mouseTypes = (sent: Sent[]): unknown[] => sent.filter(one => one.method === 'Input.dispatchMouseEvent').map(one => one.params.type);
const keyTypes = (sent: Sent[]): unknown[] => sent.filter(one => one.method === 'Input.dispatchKeyEvent').map(one => one.params.type);
const phases = (events: ActionEvent[]): string[] => events.map(event => event.phase);

test('a click sent from a tool call is one audited action', async () => {
  const fake = fakeCdp();
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });
  const page = createPage(fake.cdp);

  await withCall(caller('agent-a'), undefined, async () => { await page.click({ ref: 1 }); }, arbiter);

  assert.deepEqual(mouseTypes(fake.sent), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  for (const one of fake.sent.filter(entry => entry.method === 'Input.dispatchMouseEvent')) {
    assert.equal(one.params.x, 42);
    assert.equal(one.params.y, 24);
  }
  assert.deepEqual(phases(events), ['queued', 'granted', 'approaching', 'executing', 'progress', 'succeeded']);
  assert.deepEqual(events.map(event => event.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(events.map(event => event.requestId)).size, 1);
  assert.equal(events[0]!.requestId, 'call-agent-a:1');
  assert.equal(events[0]!.action.kind, 'click');
  assert.equal(events[0]!.action.label, '点击 编号 1');
  assert.deepEqual(events[0]!.actor, { trust: 'trusted', agentId: 'agent-a', rootAgentId: 'lead', depth: 1, lifetime: 1 });
  // No measurement was injected, so nothing here may claim a place on the screen.
  for (const event of events) {
    assert.equal(event.space, 'window');
    assert.equal(event.from, undefined);
    assert.equal(event.to, undefined);
    assert.equal(event.path, undefined);
  }
  assert.equal(arbiter.poisonedReason(), undefined);
});

test('two calls are two actions, each with its own request and its own agent', async () => {
  const fake = fakeCdp();
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });
  const page = createPage(fake.cdp);

  await withCall(caller('agent-a'), undefined, async () => { await page.click({ ref: 1 }); }, arbiter);
  await withCall(caller('agent-b'), undefined, async () => { await page.type({ ref: 1 }, 'hello'); }, arbiter);

  const requests = [...new Set(events.map(event => event.requestId))];
  assert.equal(requests.length, 2);
  const first = events.filter(event => event.requestId === requests[0]);
  const second = events.filter(event => event.requestId === requests[1]);
  assert.deepEqual(first.map(event => event.actor.agentId), Array(first.length).fill('agent-a'));
  assert.deepEqual(second.map(event => event.actor.agentId), Array(second.length).fill('agent-b'));
  assert.deepEqual(first.map(event => event.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(second.map(event => event.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(phases(second), ['queued', 'granted', 'executing', 'progress', 'succeeded']);
  assert.deepEqual(fake.sent.filter(one => one.method === 'Input.insertText'), [{ method: 'Input.insertText', params: { text: 'hello' } }]);
});

test('a step queued inside one request keeps that request and its seq', async () => {
  const fake = fakeCdp();
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });
  const page = createPage(fake.cdp);

  await withCall(caller('agent-a'), undefined, async () => {
    await runAction({ kind: 'other', label: '一次过程' }, async () => { await page.click({ ref: 1 }); }, { space: 'window' });
  }, arbiter);

  assert.equal(new Set(events.map(event => event.requestId)).size, 1);
  assert.deepEqual(phases(events), ['queued', 'granted', 'approaching', 'executing', 'progress', 'succeeded']);
  assert.deepEqual(events.map(event => event.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(mouseTypes(fake.sent), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('a page used on its own sends the same input and reports nothing', async () => {
  const fake = fakeCdp();
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });
  const page = createPage(fake.cdp);

  await page.click({ ref: 1 });

  assert.deepEqual(mouseTypes(fake.sent), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.deepEqual(events, []);
});

test('a stop while the button is down lets it go before the call fails', async () => {
  const fake = fakeCdp({ hang: (method, params) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' });
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });
  const page = createPage(fake.cdp);
  const controller = new AbortController();

  const started = withCall(caller('agent-a'), controller.signal, async () => { await page.click({ ref: 1 }); }, arbiter);
  await tick();
  controller.abort();

  await assert.rejects(started, error => error instanceof CancelledError);
  const pressed = fake.sent.filter(entry => entry.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(pressed.map(entry => entry.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(pressed[2]!.params.x, 42);
  assert.equal(pressed[2]!.params.y, 24);
  assert.equal(events.at(-1)!.phase, 'cancelled');
  // Put back is not the same as unknown: a confirmed release must not shut the gate.
  assert.equal(arbiter.poisonedReason(), undefined);
});

test('a release that cannot be confirmed leaves the input engine shut', async () => {
  const fake = fakeCdp({ hang: (method, params) => method === 'Input.dispatchMouseEvent' && (params.type === 'mousePressed' || params.type === 'mouseReleased') });
  const clock = handTimers();
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });
  const page = createPage(fake.cdp, { timers: clock.timers });
  const controller = new AbortController();

  const started = withCall(caller('agent-a'), controller.signal, async () => { await page.click({ ref: 1 }); }, arbiter);
  await tick();
  controller.abort();
  await tick();
  assert.equal(clock.pending(), 1);
  clock.fire();

  await assert.rejects(started, error => error instanceof UncertainError && /没能确认松开/.test(String(error.message)));
  assert.match(String(arbiter.poisonedReason()), /没能确认松开/);
  assert.equal(events.at(-1)!.phase, 'uncertain');

  const before = fake.sent.filter(entry => entry.method.startsWith('Input.')).length;
  await assert.rejects(
    withCall(caller('agent-a'), undefined, async () => { await page.click({ ref: 1 }); }, arbiter),
    error => error instanceof UncertainError,
  );
  assert.equal(fake.sent.filter(entry => entry.method.startsWith('Input.')).length, before);
});

test('a key this page does not know is refused before anything is sent', async () => {
  const fake = fakeCdp();
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });
  const page = createPage(fake.cdp);

  await assert.rejects(withCall(caller('agent-a'), undefined, async () => { await page.press('Nope'); }, arbiter), /不认识按键 Nope/);
  assert.deepEqual(keyTypes(fake.sent), []);
  assert.deepEqual(events, []);
});

test('a key whose release cannot be confirmed is uncertain, not finished', async () => {
  const fake = fakeCdp({ hang: (method, params) => method === 'Input.dispatchKeyEvent' && params.type === 'keyUp' });
  const clock = handTimers();
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });
  const page = createPage(fake.cdp, { timers: clock.timers });
  const controller = new AbortController();

  const started = withCall(caller('agent-a'), controller.signal, async () => { await page.press('Enter'); }, arbiter);
  await tick();
  controller.abort();
  await tick();
  clock.fire();

  await assert.rejects(started, error => error instanceof UncertainError && /按了 Enter 以后没能确认松开/.test(String(error.message)));
  assert.equal(events.at(-1)!.phase, 'uncertain');
  assert.equal(events.at(-1)!.action.kind, 'key');
  assert.ok(arbiter.poisonedReason());
});

test('a page script still running when the call stops is an unknown outcome', async () => {
  const fake = fakeCdp({ hang: (method, params) => method === PUBLISH && String(params.expression).includes(SCRIPT) });
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });
  const page = createPage(fake.cdp);
  const controller = new AbortController();

  const started = withCall(caller('agent-a'), controller.signal, async () => { await page.evaluate('while (true) {}', {}); }, arbiter);
  await tick();
  controller.abort();

  await assert.rejects(started, error => error instanceof UncertainError && /页面脚本可能还在跑/.test(String(error.message)));
  assert.equal(events.at(-1)!.phase, 'uncertain');
  assert.ok(arbiter.poisonedReason());
});

test('a page script that finishes is reported and its value comes back', async () => {
  const fake = fakeCdp();
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });
  const page = createPage(fake.cdp);

  const value = await withCall(caller('agent-a'), undefined, async () => await page.evaluate('return 7', {}), arbiter);

  assert.equal(value, 7);
  assert.deepEqual(phases(events), ['queued', 'granted', 'executing', 'progress', 'succeeded']);
  assert.equal(arbiter.poisonedReason(), undefined);
});
