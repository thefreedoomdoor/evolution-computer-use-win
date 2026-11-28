/**
 * The input arbiter without a desktop: one action's phases get strictly increasing sequence numbers under one
 * requestId, a second action waits for the first action's whole lease (screenshot included), poison refuses new
 * work until reset, and two ComputerUse instances never hear each other's actions.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CancelledError, createArbiter, UncertainError, type ActionScope } from '../src/desktop/arbiter.ts';
import type { ActionDescriptor, ActionEvent, TrustedCallerContext } from '../src/tool.ts';

process.env.EVOLUTION_CU_ARBITER = 'inproc';

const caller = (callId: string): TrustedCallerContext => ({
  identity: 'trusted', agentId: 'agent-a', rootAgentId: 'agent-root', depth: 0, lifetime: 1, sessionId: 's1', callId,
});
const move: ActionDescriptor = { kind: 'move' };

test('one request keeps one id and its phases only go up', async () => {
  const seen: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => seen.push(event) });
  await arbiter.withCall(caller('call-1'), undefined, () => arbiter.runAction(move, async () => {
    await Promise.resolve();
    return 'done';
  }));
  assert.deepEqual(seen.map(event => event.phase), ['queued', 'granted', 'succeeded']);
  assert.equal(new Set(seen.map(event => event.requestId)).size, 1);
  const seqs = seen.map(event => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length, 'no two phases share a sequence number');
});

test('a second action waits for the first one to finish, including what it does after the input', async () => {
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const arbiter = createArbiter();
  await arbiter.withCall(caller('call-a'), undefined, async () => {
    const first = arbiter.runAction({ kind: 'click' }, async () => { order.push('a-start'); await held; order.push('a-end'); });
    const second = arbiter.runAction({ kind: 'click' }, async () => { order.push('b-start'); });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(order, ['a-start'], 'the second action has not started while the first holds the lease');
    release();
    await Promise.all([first, second]);
  });
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start']);
});

test('a poisoned arbiter refuses work until it is reset', async () => {
  const arbiter = createArbiter();
  arbiter.poison('最后一次输入结果不明。');
  await assert.rejects(arbiter.withCall(caller('call-p'), undefined, () => arbiter.runAction(move, async () => undefined)), UncertainError);
  arbiter.reset();
  await arbiter.withCall(caller('call-q'), undefined, () => arbiter.runAction(move, async () => undefined));
});

test('two instances do not share their sinks', async () => {
  const a: ActionEvent[] = [], b: ActionEvent[] = [];
  const one = createArbiter({ sink: event => a.push(event) });
  const two = createArbiter({ sink: event => b.push(event) });
  await one.withCall(caller('call-one'), undefined, () => one.runAction(move, async () => undefined));
  assert.ok(a.length > 0);
  assert.equal(b.length, 0);
  await two.withCall(caller('call-two'), undefined, () => two.runAction(move, async () => undefined));
  assert.ok(b.every(event => event.requestId.startsWith('call-two:')));
});

test('a stop from outside the call aborts the action that is running', async () => {
  // The helper's stop line arrives on a readline callback, outside the caller's async context: cancelCurrent must find
  // the action by the instance's own record, not by AsyncLocalStorage, or a stop would let a held button stay down.
  const seen: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => seen.push(event) });
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  // What the driver does once the helper has let go: it reports the step as cancelled rather than failed.
  const work = arbiter.runAction(move, async scope => {
    started();
    await new Promise<void>((resolve, reject) => {
      const stop = () => reject(new CancelledError('用户取消了这一步，已经收尾。'));
      if (scope.signal?.aborted) { stop(); return; }
      scope.signal?.addEventListener('abort', stop, { once: true });
    });
  });
  await running;
  assert.equal(arbiter.cancelCurrent(), true, 'the stop reached the action that was running');
  await assert.rejects(work, /取消/);
  assert.deepEqual(seen.map(event => event.phase), ['queued', 'granted', 'cancelled']);
  // A cancelled step hands the lease back: the next action is not blocked by the one that was stopped.
  await arbiter.runAction(move, async () => undefined);
});

test('a stop cancels the action that holds the lease, not the one still waiting for it', async () => {
  // Two turns queues (desktop and screen) or an action that is still appearing can leave a newer scope waiting for the
  // lease while an older one is pressing. The stop must reach the action whose input is in flight, otherwise the button
  // stays down until its hold runs out and the user believes the desktop is free.
  const seen: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => seen.push(event) });
  const order: string[] = [];
  let pressing!: ActionScope;
  let arrived!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; });
  const a = arbiter.runAction({ kind: 'click' }, async scope => {
    pressing = scope;
    arrived();
    try {
      await new Promise<void>((resolve, reject) => {
        const stop = () => reject(new CancelledError('用户取消了这一步，已经收尾。'));
        if (scope.signal?.aborted) { stop(); return; }
        scope.signal?.addEventListener('abort', stop, { once: true });
      });
    } finally {
      order.push('a-end');
    }
  });
  await started;
  // B arrives while A is still pressing, so it waits for the lease instead of taking it.
  const b = arbiter.runAction({ kind: 'click' }, async () => { order.push('b-start'); });
  const settledB = b.then(() => 'resolved', (error: unknown) => error);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(order, [] as string[], 'neither action has run to its end yet');

  assert.equal(arbiter.cancelCurrent(), true, 'the stop reached this instance');
  assert.equal(pressing.signal?.aborted, true, 'the action that was pressing saw the stop');
  await assert.rejects(a, /取消/);
  assert.ok((await settledB) instanceof CancelledError, 'the action still waiting for the lease is dropped too');
  assert.deepEqual(order, ['a-end'], 'only the action that was pressing ran its body');

  // The lease is not handed over before the stopped step has finished: C queues behind A, never beside it.
  const c = arbiter.runAction({ kind: 'move' }, async () => { order.push('c-start'); });
  await c;
  assert.deepEqual(order, ['a-end', 'c-start']);
  const phasesOf = (id: string) => seen.filter(event => event.requestId === id).map(event => event.phase);
  assert.deepEqual(phasesOf(pressing.requestId), ['queued', 'granted', 'cancelled']);
});

test('a stop does not hand the lease to the next action before the stopped step has finished', async () => {
  // The helper still has to release a held button: until the step's own work returns, nothing else may inject.
  const arbiter = createArbiter();
  const order: string[] = [];
  let finish!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  const a = arbiter.runAction({ kind: 'drag' }, async () => { order.push('a-start'); await hold; order.push('a-end'); });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(arbiter.cancelCurrent(), true);
  const next = arbiter.runAction({ kind: 'move' }, async () => { order.push('next-start'); });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(order, ['a-start'], 'the waiting action cannot slip in while the stopped step is still holding');
  finish();
  await a;
  await next;
  assert.deepEqual(order, ['a-start', 'a-end', 'next-start']);
});

test('a second instance is not stopped by the first one', async () => {
  const one = createArbiter();
  const two = createArbiter();
  let held!: () => void;
  const running = new Promise<void>(resolve => { held = resolve; });
  const first = one.runAction(move, async () => { held(); await new Promise<void>(resolve => setTimeout(resolve, 20)); });
  await running;
  assert.equal(two.cancelCurrent(), false, 'a stop only reaches the instance it belongs to');
  await first;
});

test('a nested lease inside an action reuses it instead of deadlocking', async () => {
  const arbiter = createArbiter();
  const scope = await arbiter.withCall(caller('call-n'), undefined, () => arbiter.runAction(move, async (inner: ActionScope) => {
    await arbiter.withGlobalLease(async () => undefined);
    return inner.requestId;
  }));
  assert.match(scope, /^call-n:\d+$/);
});
