/**
 * The CLI's one way out. A stop is asynchronous now (ComputerUse.stop waits for the helper to really exit, so a button
 * the agent left down is released first), so an exit that fires immediately — SIGINT/SIGTERM/end, or the `finally` of a
 * one-time command — would race it and kill the parent before the stop is confirmed. These tests drive the production
 * `createShutdown` from src/cli.ts with a controlled stop: the exact control flow the CLI uses, no browser and no input.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createShutdown } from '../src/cli.ts';

// A stop the helper has not confirmed yet: the process must stay alive, or the host loses the only thing that could
// release a button the agent was holding when it was asked to end.
test('a stop that has not finished keeps the process alive, and finishing it exits once', async () => {
  let release: () => void = () => {};
  const stop = new Promise<void>(resolve => { release = () => resolve(); });
  const exits: number[] = [];
  const shutdown = createShutdown({ stopComputer: () => stop, exit: code => exits.push(code) });
  const done = shutdown(0);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(exits, [], 'exited while the stop was still pending');
  release();
  await done;
  assert.deepEqual(exits, [0], 'exits once, with the asked code, only after the stop finished');
});

// Two Ctrl-C, or a signal plus the client closing the pipe: the second must not start a second stop, and it must not
// reach Node's default kill (that is why the CLI registers `on` instead of `once`).
test('a second exit shares the first shutdown: the work runs once and nothing exits early', async () => {
  let release: () => void = () => {};
  const stop = new Promise<void>(resolve => { release = () => resolve(); });
  const order: string[] = [];
  let stops = 0;
  const exits: number[] = [];
  const shutdown = createShutdown({
    clearTimer: () => order.push('timer'),
    stopOverlay: () => order.push('overlay'),
    stopComputer: () => { stops += 1; order.push('stop'); return stop; },
    exit: code => exits.push(code),
  });
  const first = shutdown(0);
  const again = shutdown(0);
  const third = shutdown(1);
  assert.equal(first, again, 'a later call gets the same promise, not a second run');
  assert.equal(again, third, 'even when it asks for another code');
  assert.equal(stops, 1, 'the stop was started once');
  assert.deepEqual(order, ['timer', 'overlay', 'stop'], 'the timer and overlay stop before the computer, once');
  assert.deepEqual(exits, [], 'nothing has exited while the shared stop is pending');
  release();
  await Promise.all([first, again, third]);
  assert.deepEqual(exits, [0], "one exit, with the first caller's code — a repeat cannot exit early or twice");
});

// A stop that fails still ends the process (the host asked it to end), but with a failure code and the reason on
// stderr — a failed stop must never be presented as a clean one.
test('a stop that fails is reported and exits non-zero, never as a clean exit', async () => {
  const exits: number[] = [];
  const written: string[] = [];
  const stderr = process.stderr as unknown as { write: (chunk: string) => boolean };
  const original = stderr.write;
  stderr.write = chunk => { written.push(chunk); return true; };
  try {
    const shutdown = createShutdown({ stopComputer: () => Promise.reject(new Error('helper did not exit')), exit: code => exits.push(code) });
    await shutdown(0);
  } finally {
    stderr.write = original;
  }
  assert.deepEqual(exits, [1], 'a failed stop exits non-zero instead of looking like a clean exit');
  assert.ok(written.join('').includes('helper did not exit'), 'the failure reason is reported: ' + JSON.stringify(written));
});

// The wiring the tests above cannot reach without a real server: every exit path in the CLI goes through the one
// shutdown, the pipe closing waits it, and one-time commands wait the stop in their `finally`.
test('the CLI routes every exit through the one shutdown and waits for the computer', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'utf8');
  assert.match(source, /const end = createShutdown\(\{/, 'the serve path builds the shared shutdown');
  assert.match(source, /process\.on\('SIGINT', \(\) => \{ void end\(\); \}\)/, 'SIGINT shares the shutdown');
  assert.match(source, /process\.on\('SIGTERM', \(\) => \{ void end\(\); \}\)/, 'SIGTERM shares the shutdown');
  assert.doesNotMatch(source, /process\.once\('SIG(INT|TERM)'/, 'a repeated signal must not fall through to the default kill');
  assert.match(source, /await server\.closed;\s*\n\s*await end\(\);/, 'the closed pipe waits the same shutdown before exiting');
  assert.equal((source.match(/finally \{ await computer\.stop\(\); \}/g) ?? []).length, 2, 'init and the routines/status path both await the stop');
});

// A cleanup step that is already gone when shutdown starts (the mode timer, say) must not take the rest of the shutdown
// with it: the overlay still stops, the stop is still awaited, and the exit becomes non-zero because the cleanup was
// incomplete — but only after the stop, never before it.
test('a throwing timer hook still stops the overlay and waits for the stop before exiting non-zero', async () => {
  let release: () => void = () => {};
  const stop = new Promise<void>(resolve => { release = () => resolve(); });
  const order: string[] = [];
  const exits: number[] = [];
  const written: string[] = [];
  const stderr = process.stderr as unknown as { write: (chunk: string) => boolean };
  const original = stderr.write;
  stderr.write = chunk => { written.push(chunk); return true; };
  try {
    const shutdown = createShutdown({
      clearTimer: () => { order.push('timer'); throw new Error('timer handle already gone'); },
      stopOverlay: () => order.push('overlay'),
      stopComputer: () => { order.push('stop'); return stop; },
      exit: code => exits.push(code),
    });
    const done = shutdown(0);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(order, ['timer', 'overlay', 'stop'], 'the later hooks still ran after the timer hook threw');
    assert.deepEqual(exits, [], 'did not exit while the stop was still pending');
    release();
    await done;
  } finally {
    stderr.write = original;
  }
  assert.deepEqual(exits, [1], 'an incomplete cleanup exits non-zero');
  assert.ok(written.join('').includes('timer handle already gone'), 'the hook failure is reported: ' + JSON.stringify(written));
});

// The overlay hook throwing must not skip the stop either: the stop is still awaited, and the exit stays non-zero.
test('a throwing overlay hook still waits for the stop, then exits non-zero with the reason logged', async () => {
  let release: () => void = () => {};
  const stop = new Promise<void>(resolve => { release = () => resolve(); });
  const order: string[] = [];
  const exits: number[] = [];
  const written: string[] = [];
  const stderr = process.stderr as unknown as { write: (chunk: string) => boolean };
  const original = stderr.write;
  stderr.write = chunk => { written.push(chunk); return true; };
  try {
    const shutdown = createShutdown({
      clearTimer: () => order.push('timer'),
      stopOverlay: () => { order.push('overlay'); throw new Error('overlay helper already gone'); },
      stopComputer: () => { order.push('stop'); return stop; },
      exit: code => exits.push(code),
    });
    const done = shutdown(0);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(order, ['timer', 'overlay', 'stop'], 'the stop still ran after the overlay hook threw');
    assert.deepEqual(exits, [], 'did not exit while the stop was still pending');
    release();
    await done;
  } finally {
    stderr.write = original;
  }
  assert.deepEqual(exits, [1], 'an incomplete cleanup exits non-zero');
  assert.ok(written.join('').includes('overlay helper already gone'), 'the hook failure is reported: ' + JSON.stringify(written));
});
