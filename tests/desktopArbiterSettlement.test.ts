/**
 * Arbiter.settled: the bounded, observational wait a shutdown uses before it retires the input arbiter.
 *
 * The failure it exists for: Computer.stop used to retire the arbiter at once, and dispose() sets `retired`, which makes
 * a lease that is still unwinding skip its release (`if (!hold && !retired) await theGate().release(...)` in
 * src/desktop/arbiter.ts). The broker then kept a marker for a step that never sent input, and the next agent waited on
 * it. Waiting for the instance's own calls to finish before retiring is what lets that release happen.
 *
 * What is pinned here, all through the public Arbiter API and a controlled `work` (no production pipe, no broker):
 *   · idle — true at once, with any budget, and no poison or grant rule touched;
 *   · in flight — false when the budget runs out, true only after the work really finished;
 *   · several waiters hear the same settlement, and one that timed out is not woken twice;
 *   · a lease taken without an action (a raw driver call) is counted the same way;
 *   · a step cancelled while still queued for the lease, and a queued acquire that fails, both count themselves out;
 *   · an unknown outcome still poisons and still refuses later steps, while its call counts back to zero;
 *   · dispose() and reset() never fake a settlement: what is still unwinding stays counted, and a retired instance does
 *     not get a fresh gate.
 *
 * `true` only means the calls of this instance are over. It is not a broker confirmation, and this file does not claim
 * one: the real lease marker and the next agent's attempt are checked in tests/desktopArbiterShutdown.test.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CancelledError, createArbiter, UncertainError } from '../src/desktop/arbiter.ts';
import type { ActionDescriptor } from '../src/tool.ts';

process.env.EVOLUTION_CU_ARBITER = 'inproc';

const move: ActionDescriptor = { kind: 'move' };

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A promise the test opens when it wants the work to finish, and a promise that says the work already started. */
function latch(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { wait, open };
}
function door(): { wait: Promise<void>; opened: () => void } {
  let opened!: () => void;
  const wait = new Promise<void>(resolve => { opened = resolve; });
  return { wait, opened };
}

/** An unknown outcome, which is what a refused or poisoned step must reach the caller as. */
const refused = (error: unknown): error is UncertainError => error instanceof UncertainError;

test('nothing in flight settles at once, for any budget — including one that is not a positive number', async () => {
  const arbiter = createArbiter();
  assert.equal(await arbiter.settled(4_000), true);
  assert.equal(await arbiter.settled(0), true);
  assert.equal(await arbiter.settled(-5), true);
  assert.equal(await arbiter.settled(Number.NaN), true);
  assert.equal(await arbiter.settled(Number.POSITIVE_INFINITY), true);
  // Observational only: no poison, and the next step is still granted and audited as usual.
  assert.equal(arbiter.poisonedReason(), undefined);
  assert.equal(await arbiter.runAction(move, async () => 'ran'), 'ran');
});

test('a lease in flight is unfinished at the deadline and settled once it really finishes', async () => {
  const arbiter = createArbiter();
  const gate = latch();
  const started = door();
  const action = arbiter.runAction(move, async () => { started.opened(); await gate.wait; return 'ran'; });
  await started.wait;
  const before = Date.now();
  assert.equal(await arbiter.settled(60), false, 'a lease still in flight is not settled');
  assert.ok(Date.now() - before >= 40, 'the budget is waited out instead of answering at once');
  assert.equal(await arbiter.settled(60), false, 'asking again does not invent progress');
  assert.equal(arbiter.poisonedReason(), undefined, 'a budget that ran out leaves the poison alone');
  gate.open();
  assert.equal(await action, 'ran', 'the work was never interrupted by the wait');
  assert.equal(await arbiter.settled(1_000), true, 'counted out after its finally, not before');
});

test('every waiter hears the same settlement, and one that timed out is not woken twice', async () => {
  const arbiter = createArbiter();
  const gate = latch();
  const started = door();
  const action = arbiter.runAction(move, async () => { started.opened(); await gate.wait; return 'ran'; });
  await started.wait;
  const short = arbiter.settled(10);
  const first = arbiter.settled(2_000);
  const second = arbiter.settled(2_000);
  assert.equal(await short, false, 'the waiter with the tiny budget gives up');
  gate.open();
  assert.equal(await action, 'ran');
  assert.deepEqual(await Promise.all([first, second]), [true, true], 'both remaining waiters hear the one settlement');
  assert.equal(await arbiter.settled(200), true, 'nothing stayed counted, and no listener stayed behind');
});

test('a lease taken without an action — a raw driver call — is counted the same way', async () => {
  const arbiter = createArbiter();
  const gate = latch();
  const started = door();
  const bare = arbiter.withGlobalLease(async () => { started.opened(); await gate.wait; return 'sent'; });
  await started.wait;
  assert.equal(await arbiter.settled(40), false, 'the bare lease is in flight');
  gate.open();
  assert.equal(await bare, 'sent');
  assert.equal(await arbiter.settled(1_000), true);
});

test('a step cancelled while it is still queued for the lease counts itself out', async () => {
  const arbiter = createArbiter();
  const gate = latch();
  const started = door();
  const first = arbiter.runAction(move, async () => { started.opened(); await gate.wait; return 'first'; });
  await started.wait;
  const stop = new AbortController();
  const second = arbiter.runAction(move, async () => 'second', { signal: stop.signal });
  const secondError = second.catch((error: unknown) => error);
  await sleep(10);
  stop.abort();
  const cancelled = await secondError;
  assert.ok(cancelled instanceof CancelledError, 'a queued step that is stopped was cancelled, not left unknown');
  assert.equal(await arbiter.settled(40), false, 'the step holding the lease is still in flight');
  gate.open();
  assert.equal(await first, 'first');
  assert.equal(await arbiter.settled(200), true, 'the cancelled waiter left nothing counted');
});

test('a queued acquire that fails counts itself out, and reset does not clear what is still running', async () => {
  const arbiter = createArbiter();
  const gate = latch();
  const started = door();
  const first = arbiter.runAction(move, async () => { started.opened(); await gate.wait; return 'first'; });
  await started.wait;
  const second = arbiter.runAction(move, async () => 'second');
  const secondError = second.catch((error: unknown) => error);
  await sleep(10);
  arbiter.reset();
  const refusedStep = await secondError;
  assert.ok(refusedStep instanceof UncertainError, 'a step queued behind a reset is unknown, and never ran');
  assert.equal(await arbiter.settled(40), false, 'reset does not pretend the running step is settled');
  gate.open();
  assert.equal(await first, 'first');
  assert.equal(await arbiter.settled(200), true, 'the failed acquire counted itself out');
});

test('an unknown outcome keeps poisoning and refusing work, while its call counts back to zero', async () => {
  const arbiter = createArbiter();
  const sentinel = '上一笔点按结果不明（哨兵）';
  // The step that held the lease says it itself, with no diagnosis attached: nothing to append, nothing to explain.
  await assert.rejects(
    arbiter.runAction(move, async () => { throw new UncertainError(sentinel); }),
    (error: unknown) => error instanceof UncertainError && error.message === sentinel && error.base === sentinel,
  );
  assert.equal(arbiter.poisonedReason(), sentinel, 'the poison says more than a shutdown would');
  assert.equal(await arbiter.settled(200), true, 'the call is over, whatever it left behind');
  // A refusal keeps that sentence as its base and appends where the poison came from: a step that held this lease,
  // refused before it started, with no reason of its own to report (so the sentence says 未提供, which is not a code).
  const diagnosis = '（source=poison; phase=refused-before-start; origin=step/lease-held; reason=未提供）';
  let ran = false;
  const secondError: unknown = await arbiter
    .runAction(move, async () => { ran = true; return 'never'; })
    .then(() => undefined, (error: unknown) => error);
  assert.ok(secondError instanceof UncertainError, 'the next step is refused rather than run');
  assert.equal(secondError.base, sentinel, 'the original sentence is kept verbatim on the refusal');
  assert.equal(secondError.message, sentinel + diagnosis, 'the refusal says exactly the sentence plus the diagnosis');
  assert.equal(secondError.detail?.source, 'poison', 'nothing but poison refused this step');
  assert.equal(secondError.detail?.phase, 'refused-before-start', 'it never got as far as taking the lease');
  assert.deepEqual(secondError.detail?.origin, { source: 'step', phase: 'lease-held' },
    'the origin is the step that held the lease, not a guess');
  assert.equal(secondError.detail?.reason, undefined, 'no reason was recorded, so none is invented');
  assert.equal(ran, false, 'the refused step never ran');
  assert.equal(await arbiter.settled(200), true, 'a refused step never counted in the first place');
});

test('dispose leaves running work counted, and a waiter hears the truth only when that work ends', async () => {
  const arbiter = createArbiter();
  const gate = latch();
  const started = door();
  const action = arbiter.runAction(move, async () => { started.opened(); await gate.wait; return 'ran'; });
  await started.wait;
  const waiting = arbiter.settled(2_000);
  arbiter.dispose();
  assert.equal(await arbiter.settled(40), false, 'dispose does not pretend unfinished work is settled');
  await assert.rejects(
    arbiter.runAction(move, async () => 'never'),
    (error: unknown) => refused(error) && error.message.includes('退出了'),
    'a retired instance takes no new step, so no fresh gate is asked for',
  );
  gate.open();
  assert.equal(await action, 'ran', 'the work that was already running finishes');
  assert.equal(await waiting, true, 'the waiter hears the settlement after the retire, not before');
  assert.equal(await arbiter.settled(200), true);
});
