// tests/desktopDriver.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { Faults } from '../src/shared/faults.ts';
import { createDesktopDriver } from '../src/desktop/driver.ts';
import { createArbiter, UncertainError, withCall } from '../src/desktop/arbiter.ts';

// 真机上一个进程只有一个跨进程 broker；这些假助手单测各自用进程内的本地仲裁实例，不跨文件串行，也不拉起任何子进程。
process.env.EVOLUTION_CU_ARBITER = 'inproc';

const fixture = (name: string) => [process.execPath, fileURLToPath(new URL(`./fixtures/desktop/${name}.mjs`, import.meta.url))];

test('calls go to the helper started on first use and come back with its answer', async t => {
  const faults = new Faults();
  const arbiter = createArbiter();
  const driver = createDesktopDriver({ faults, command: fixture('echo'), arbiter });
  t.after(async () => { await driver.stop(); arbiter.dispose(); });
  assert.equal(driver.running(), false, 'nothing starts before she uses the desktop');
  const answer = await driver.call('click', { hwnd: 7, x: 1, y: 2 });
  assert.equal(answer.op, 'click');
  // 输入调用会多带一个取消标志文件的路径：它是这次输入在飞时给助手看的临时文件，不是调用本身的一部分。
  const { cancelFile, ...asked } = answer.args as Record<string, unknown>;
  assert.deepEqual(asked, { hwnd: 7, x: 1, y: 2 });
  assert.equal(typeof cancelFile, 'string', 'an input in flight carries the cancel flag its helper watches');
  assert.equal(dirname(cancelFile as string), tmpdir(), 'the flag is a temp file');
  assert.match(basename(cancelFile as string), /^evolution-cu-cancel-[0-9a-f]{16}\.flag$/);
  assert.equal(existsSync(cancelFile as string), false, 'the flag is removed once the call is over');
  assert.equal(driver.running(), true);
  await assert.rejects(driver.call('refuse'), /window 7 is gone/, 'a refusal carries the reason');
  assert.deepEqual(await driver.call('windows'), { op: 'windows', args: {} }, 'a look carries no cancel flag');
  assert.deepEqual(faults.list(), []);
});

test('a crash fails what is pending and is a fault; the next call starts it again', async t => {
  const faults = new Faults();
  const driver = createDesktopDriver({ faults, command: fixture('echo') });
  // 这条查的是助手本身的重启：每次裸调用用它自己的本地仲裁实例，上一次崩溃留下的“结果不明”才不会挡住下一次。
  // 这不是“生产里 poisoned 实例可以重试”的证明：生产同一个实例会拒绝后续输入，那由下面的 poison 用例和真 broker 用例覆盖。
  const call = async (op: string): Promise<Record<string, unknown>> => {
    const arbiter = createArbiter();
    try { return await withCall(undefined, undefined, () => driver.call(op), arbiter); } finally { arbiter.dispose(); }
  };
  t.after(async () => { await driver.stop(); });
  await call('windows');
  await assert.rejects(call('crash'), /助手退出了/);
  assert.match(faults.list().join(), /桌面控制的助手退出了/);
  assert.deepEqual(await call('windows'), { op: 'windows', args: {} }, 'the next call starts a fresh helper');
  assert.deepEqual(faults.list(), [], 'a working call clears it');
});

test('a poisoned arbiter refuses the next call instead of letting the driver retry', async t => {
  const faults = new Faults();
  const driver = createDesktopDriver({ faults, command: fixture('echo') });
  const arbiter = createArbiter();
  t.after(async () => { await driver.stop(); arbiter.dispose(); });
  await assert.rejects(withCall(undefined, undefined, () => driver.call('crash'), arbiter), /助手退出了/);
  assert.match(String(arbiter.poisonedReason()), /桌面控制的助手退出了：退出码 3/);
  // 生产里同一个 lifetime 只有一个仲裁实例：结果不明之后它一直按着这一步，后面的输入直接被拒绝，不会重发。
  await assert.rejects(withCall(undefined, undefined, () => driver.call('windows'), arbiter), /桌面控制的助手退出了：退出码 3/);
});

test('a helper that dies before answering is tried twice, then says why and stays down until stopped', async t => {
  const faults = new Faults();
  const driver = createDesktopDriver({ faults, command: fixture('dies') });
  // 同上：每次裸调用一个本地仲裁实例，只看驱动自己的启动次数，不让上一次的“结果不明”提前把下一次挡住。
  const call = async (op: string): Promise<Record<string, unknown>> => {
    const arbiter = createArbiter();
    try { return await withCall(undefined, undefined, () => driver.call(op), arbiter); } finally { arbiter.dispose(); }
  };
  t.after(async () => { await driver.stop(); });
  await assert.rejects(call('windows'), /无法编译/);
  await assert.rejects(call('windows'), /无法编译/);
  // 第三次在起助手之前就被拦下：这是一个普通的 Error（起不来），不是“结果不明”的 UncertainError。
  await assert.rejects(call('windows'), (error: Error) => {
    assert.ok(!(error instanceof UncertainError), 'the third start is refused before a helper runs');
    assert.match(error.message, /^桌面控制的助手起不来：Add-Type : 无法编译/);
    return true;
  });
  assert.equal(driver.running(), false, 'not relaunched on every step');
  await driver.stop();
  assert.deepEqual(faults.list(), []);
});

test('a call that hangs times out with an unknown outcome and the helper is replaced', async t => {
  const faults = new Faults();
  const arbiter = createArbiter();
  const driver = createDesktopDriver({ faults, command: fixture('hangs'), callMs: 200, arbiter });
  t.after(async () => { await driver.stop(); arbiter.dispose(); });
  await assert.rejects(driver.call('click'), /没有回应，结果不明/);
  assert.equal(driver.running(), false);
  assert.match(faults.list().join(), /卡住/);
});

test('turning it off fails what is pending', async t => {
  const arbiter = createArbiter();
  const driver = createDesktopDriver({ faults: new Faults(), command: fixture('hangs'), arbiter });
  t.after(async () => { await driver.stop(); arbiter.dispose(); });
  const call = driver.call('click');
  // 先等助手真的拿到这次调用：lease 是异步进入驱动的，太早 stop() 会找不到在途的调用，测试就会挂到超时。
  const started = Date.now();
  while (!driver.running() && Date.now() - started < 2_000) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(driver.running(), true, 'the helper has the call before the switch is turned off');
  const failed = assert.rejects(call, /桌面控制关掉了/);
  await driver.stop();
  await failed;
  assert.equal(driver.running(), false);
});
