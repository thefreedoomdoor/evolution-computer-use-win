// tests/desktopDriverRetirement.test.ts
// The real driver, but its helpers are in-memory streams whose exit is controlled by the test: no process is spawned.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { Faults } from '../src/shared/faults.ts';
import { createDesktopDriver } from '../src/desktop/driver.ts';
import { createArbiter, withCall } from '../src/desktop/arbiter.ts';

// 真机上的仲裁走跨进程 broker；这些用例只跑进程内的假助手，用本地闸门就够，
// 也因此下面的 spawn 替身不会拦到 broker 的启动（否则要白等它重连）。
process.env.EVOLUTION_CU_ARBITER = 'inproc';

const command = 'fixture:driver-retirement';

interface Fake extends EventEmitter { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(): boolean; exit(): void }

function fakeChildren(events: string[], replyFrom: (n: number) => boolean) {
  const children: Fake[] = [];
  const spawned = mock.method(childProcess, 'spawn', (program: string) => {
    assert.equal(program, command, 'no real process may be started');
    const n = children.length + 1;
    const child: Fake = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { events.push(`terminate ${n}`); return true; }, // delivery of the kill is not an exit
      exit() { events.push(`exit ${n}`); child.emit('exit', 0, null); child.stdin.destroy(); child.stdout.end(); child.stderr.destroy(); },
    }) as unknown as Fake;
    children.push(child); events.push(`spawn ${n}`);
    createInterface({ input: child.stdin }).on('line', line => {
      const { id, op } = JSON.parse(line);
      events.push(`received ${n} ${op}`);
      if (replyFrom(n)) child.stdout.write(JSON.stringify({ id, data: { op } }) + '\n');
    });
    return child;
  });
  syncBuiltinESMExports();
  return { children, restore: () => { spawned.mock.restore(); syncBuiltinESMExports(); } };
}

test('a timed-out helper is replaced only after its exit is observed', async t => {
  const events: string[] = [];
  const { children, restore } = fakeChildren(events, n => n !== 1); // only the replacement answers
  t.after(restore);
  const driver = createDesktopDriver({ faults: new Faults(), command: [command], callMs: 60, retireMs: 2_000 });
  // 收尾时先把还活着的假助手退出，再等 stop：stop 只在助手真的退出后才返回。
  t.after(async () => { children[1]?.exit(); await driver.stop(); });

  // 这两例查的是助手交接的顺序，不是跨 Agent 仲裁：每次裸调用用它自己的本地仲裁实例，
  // 上一次调用留下的“结果不明”就不会把下一次挡在门外（生产里同一个实例会拒绝后续输入），交接守卫才观察得到。
  // 这不是“生产里 poisoned 实例可以重试”的证明：生产同一个 lifetime 复用同一个实例，会一直拒绝后续输入，那由真 broker 的用例覆盖。
  const call = async (op: string) => {
    const arbiter = createArbiter();
    try { return await withCall(undefined, undefined, () => driver.call(op), arbiter); }
    finally { arbiter.dispose(); }
  };

  await assert.rejects(call('slow'), /没有回应，结果不明/);
  assert.equal(children.length, 1);

  const next = call('after');
  // Retirement is unresolved, so no second helper can have started yet, even one microtask later.
  assert.equal(children.length, 1, 'no replacement while the old helper has not exited');
  assert.ok(!events.includes('received 2 after'));

  children[0].exit();
  assert.deepEqual(await next, { op: 'after' });
  assert.equal(children.length, 2);
  assert.ok(events.indexOf('exit 1') < events.indexOf('received 2 after'), 'the replacement is used only after the old exit');
});

test('when the old helper never confirms its exit, new input is refused instead of sent beside it', async t => {
  const events: string[] = [];
  const { children, restore } = fakeChildren(events, () => false);
  t.after(restore);
  const driver = createDesktopDriver({ faults: new Faults(), command: [command], callMs: 40, retireMs: 80 });
  // 收尾等 stop 返回（这一例的助手由用例自己在最后退出）。
  t.after(async () => { await driver.stop(); });

  // 这两例查的是助手交接的顺序，不是跨 Agent 仲裁：每次裸调用用它自己的本地仲裁实例，
  // 上一次调用留下的“结果不明”就不会把下一次挡在门外（生产里同一个实例会拒绝后续输入），交接守卫才观察得到。
  // 这不是“生产里 poisoned 实例可以重试”的证明：生产同一个 lifetime 复用同一个实例，会一直拒绝后续输入，那由真 broker 的用例覆盖。
  const call = async (op: string) => {
    const arbiter = createArbiter();
    try { return await withCall(undefined, undefined, () => driver.call(op), arbiter); }
    finally { arbiter.dispose(); }
  };

  await assert.rejects(call('slow'), /没有回应，结果不明/);
  await assert.rejects(call('after'), /还没有确认退出，暂不发送新的输入/);
  assert.equal(children.length, 1, 'a helper that never exited is never replaced');
  assert.ok(!events.includes('received 2 after'));
  driver.stop();
  children[0].exit(); // let the pending retirement settle before the process ends
});
