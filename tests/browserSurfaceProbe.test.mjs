// 离线回归：覆盖探针的关闭判定、阶段预算与清理编排。不启动浏览器、不执行桌面操作。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  openCdp,
  closeCdpQuietly,
  disposeArbiterQuietly,
  classifyClosureObservation,
  waitForBrowserClosed,
  StageRunner,
  restoreWindow,
  readContent,
  restoreReportFromOutcome,
  restoreSummary,
  cleanupSchedule,
  isProbeSuccess,
  probeExitCode,
  runCleanup,
  main,
} from '../scripts/browser-surface-probe.mjs';

const stoppedCode = error => (error && typeof error.code === 'string' ? error.code : null);

test('classifyClosureObservation 只把 TCP refused + 原 PID 消失 + 无 HTTP 应答判为 closed', () => {
  const alive = [
    { http: 'response', tcp: 'open', pidAlive: false },
    { http: 'response', tcp: 'refused', pidAlive: false },
    { http: 'no-response', tcp: 'open', pidAlive: false },
    { http: 'timeout', tcp: 'open', pidAlive: null },
    { http: 'timeout', tcp: 'open', pidAlive: false },
  ];
  for (const obs of alive) assert.equal(classifyClosureObservation(obs), 'alive', JSON.stringify(obs));

  const closed = [
    { http: 'no-response', tcp: 'refused', pidAlive: false },
    { http: 'timeout', tcp: 'refused', pidAlive: false },
  ];
  for (const obs of closed) assert.equal(classifyClosureObservation(obs), 'closed', JSON.stringify(obs));

  const unknown = [
    { http: 'no-response', tcp: 'refused', pidAlive: null },
    { http: 'no-response', tcp: 'refused', pidAlive: true },
    { http: 'no-response', tcp: 'timeout', pidAlive: false },
    { http: 'timeout', tcp: 'error', pidAlive: false },
    { http: 'timeout', tcp: 'error', pidAlive: null },
    { http: 'timeout', tcp: 'refused', pidAlive: true },
    { http: 'no-response', tcp: 'error', pidAlive: null },
  ];
  for (const obs of unknown) assert.equal(classifyClosureObservation(obs), 'unknown', JSON.stringify(obs));

  const malformed = [
    null,
    {},
    { http: 'weird', tcp: 'open', pidAlive: false },
    { http: 'response', tcp: 'bogus', pidAlive: false },
    { http: 'response', tcp: 'open', pidAlive: 'yes' },
  ];
  for (const obs of malformed) assert.throws(() => classifyClosureObservation(obs), error => stoppedCode(error) !== null, JSON.stringify(obs));
});

test('waitForBrowserClosed 需要连续 2 次 closed；alive/unknown 重置连击', async () => {
  const stage = { assertOpen() {} };
  const scripted = async (port, options) => {
    void port;
    void options;
    return { http: 'no-response', tcp: 'refused', pidAlive: false };
  };
  const first = await waitForBrowserClosed({
    port: 1, pid: 2, stage, observe: scripted, sleepFn: async () => {}, totalMs: 5000,
  });
  assert.equal(first.closed, true);
  assert.equal(first.streak, 2);

  let index = 0;
  const sequence = ['closed', 'alive', 'closed', 'closed', 'closed'];
  const observe = async () => {
    const verdict = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    if (verdict === 'closed') return { http: 'no-response', tcp: 'refused', pidAlive: false };
    return { http: 'response', tcp: 'open', pidAlive: true };
  };
  const second = await waitForBrowserClosed({
    port: 1, pid: 2, stage, observe, sleepFn: async () => {}, totalMs: 5000,
  });
  assert.equal(second.closed, true);
  assert.equal(index, 4, '第 4 次观测即应累计到 2 连击');

  index = 0;
  let ticks = 0;
  const flip = async () => {
    ticks += 1;
    return ticks % 2 === 1 ? { http: 'response', tcp: 'open', pidAlive: true } : { http: 'no-response', tcp: 'refused', pidAlive: false };
  };
  const never = await waitForBrowserClosed({
    port: 1, pid: 2, stage, observe: flip, sleepFn: async () => {}, totalMs: 10,
  });
  assert.equal(never.closed, false);
  assert.ok(never.streak <= 1);
});

test('waitForBrowserClosed 在阶段关闭后拒绝继续轮询', async () => {
  let calls = 0;
  const stage = { assertOpen() { calls += 1; if (calls > 1) { const error = new Error('stage closed'); error.code = 'stage-closed'; throw error; } } };
  await assert.rejects(
    waitForBrowserClosed({ port: 1, pid: 2, stage, observe: async () => ({ http: 'response', tcp: 'open', pidAlive: true }), sleepFn: async () => {}, totalMs: 5000 }),
    error => error.code === 'stage-closed',
  );
});

test('StageRunner 超时后拒绝后续发送，迟到的 resolve 不会触发第二笔', async () => {
  const now = Date.now;
  const runner = new StageRunner({ label: 'restore', now, endAt: now() + 30 });
  let sends = 0;
  let release = null;
  const hung = runner.run('setWindowBounds', () => {
    sends += 1;
    return new Promise(resolve => { release = resolve; });
  });
  await assert.rejects(hung, error => stoppedCode(error) === 'stage-timeout');
  await new Promise(resolve => setTimeout(resolve, 15));
  await assert.rejects(runner.run('setWindowBounds', () => { sends += 1; return Promise.resolve(); }), error => stoppedCode(error) === 'stage-budget');
  assert.equal(sends, 1);
  if (release) { release('late'); }
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sends, 1, '迟到的 resolve 不得再发一笔 setWindowBounds');
  assert.equal(runner.closed, false);
});

test('StageRunner.close 后拒绝新发送；正常路径返回值', async () => {
  const runner = new StageRunner({ label: 'close', now: Date.now, endAt: Date.now() + 5000 });
  assert.equal(await runner.run('x', async () => 7), 7);
  runner.close('stage-exit');
  await assert.rejects(runner.run('y', async () => 8), error => stoppedCode(error) === 'stage-closed');
});

test('restoreWindow 逐步容错：helper 抛错只记步骤不抛穿', async () => {
  const calls = [];
  const ctx = {
    stage: { run: async (name, fn) => fn() },
    base: { left: 100, top: 120, width: 800, height: 600 },
    normalizedFrom: null,
    setBounds: async bounds => { calls.push(bounds); },
    readBounds: async () => ({ left: 100, top: 120, width: 800, height: 600, windowState: 'normal' }),
    helperCall: async () => { throw new Error('helper down'); },
    matchedPid: 42,
    intendedHwnd: 77,
    contentBefore: { windows: [{ hwnd: 77, windowRect: { x: 10, y: 20, width: 800, height: 600 } }] },
  };
  const result = await restoreWindow(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.confidence, 'unknown');
  assert.equal(calls.length, 1);
  const native = result.steps.find(entry => entry.name === 'restore-native-rect');
  assert.ok(native && native.ok === false);
  assert.match(native.error, /helper down/);
});

test('restoreWindow 原 state 回读不符时 stateRestored=false 且 confidence=unknown', async () => {
  const ctx = {
    stage: { run: async (name, fn) => fn() },
    base: { left: 0, top: 0, width: 640, height: 480 },
    normalizedFrom: 'maximized',
    setBounds: async () => {},
    readBounds: async () => ({ left: 0, top: 0, width: 640, height: 480, windowState: 'normal' }),
    helperCall: async () => { throw new Error('not used'); },
    matchedPid: 1,
    intendedHwnd: 0,
    contentBefore: null,
  };
  const result = await restoreWindow(ctx);
  assert.equal(result.stateRestored, false);
  assert.equal(result.confidence, 'unknown');
});

test('restoreWindow 完整恢复时 confidence=confirmed 且记录 state 回读', async () => {
  const ctx = {
    stage: { run: async (name, fn) => fn() },
    base: { left: 5, top: 6, width: 700, height: 500 },
    normalizedFrom: 'fullscreen',
    setBounds: async () => {},
    readBounds: async () => ({ left: 5, top: 6, width: 700, height: 500, windowState: 'fullscreen' }),
    helperCall: async () => ({
      units: 'physical-screen-pixels', dpiAwareness: 2, rendererTruncated: false,
      windows: [{ hwnd: 9, pid: 3, className: 'Chrome_WidgetWin_1', title: 'probe', visible: true, minimized: false, cloaked: false, dpi: 96, windowRect: { x: 0, y: 0, width: 700, height: 500 }, frameRect: null, clientRect: { x: 0, y: 0, width: 700, height: 500 } }],
      renderer: [],
    }),
    matchedPid: 3,
    intendedHwnd: 9,
    contentBefore: { windows: [{ hwnd: 9, windowRect: { x: 0, y: 0, width: 700, height: 500 } }] },
  };
  const result = await restoreWindow(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.confidence, 'confirmed');
  assert.equal(result.stateRestored, true);
});

test('runCleanup：restore 抛错仍执行 stop，并把失败记进结果', async () => {
  let stopRan = false;
  const result = await runCleanup({
    now: Date.now,
    totalMs: 60000,
    restore: async () => { throw new Error('restore boom'); },
    reverify: async () => ({ ok: true }),
    close: async () => ({ closed: true }),
    stop: async () => { stopRan = true; },
  });
  assert.equal(stopRan, true);
  assert.equal(result.restore.ok, false);
  assert.match(result.restore.error, /restore boom/);
  assert.equal(result.stop.ok, true);
  assert.equal(result.ok, false, 'restore 失败时整体不得报 ok');
});

test('runCleanup：reverify 未确认时跳过 close，但 stop 照常执行', async () => {
  let closeRan = false;
  const result = await runCleanup({
    now: Date.now,
    totalMs: 60000,
    restore: async () => ({ ok: true }),
    reverify: async () => ({ ok: false, reason: 'ws-mismatch' }),
    close: async () => { closeRan = true; return { closed: true }; },
    stop: async () => {},
  });
  assert.equal(closeRan, false);
  assert.equal(result.close.skipped, true);
  assert.equal(result.close.reason, 'reverify-not-confirmed');
  assert.equal(result.stop.ok, true);
  assert.equal(result.ok, false);
});

test('runCleanup：没有 restore/stop 时标记 skipped，且不误报 ok', async () => {
  const result = await runCleanup({ now: Date.now, totalMs: 60000 });
  assert.equal(result.restore.skipped, true);
  assert.equal(result.reverify.skipped, true);
  assert.equal(result.close.skipped, true);
  assert.equal(result.stop.skipped, true);
  assert.equal(result.ok, false);
});

test('runCleanup：预算耗尽时各阶段 skipped(no-budget) 而不是抛错', async () => {
  const result = await runCleanup({
    now: Date.now,
    totalMs: 0,
    restore: async () => ({ ok: true }),
    reverify: async () => ({ ok: true }),
    close: async () => ({ closed: true }),
    stop: async () => {},
  });
  assert.equal(result.restore.skipped, true);
  assert.equal(result.restore.reason, 'no-budget');
  assert.equal(result.stop.skipped, true);
  assert.equal(result.ok, false);
});

test('cleanupSchedule：totalMs 显式 0 时所有阶段 endAt 都等于 start', () => {
  const schedule = cleanupSchedule(1000, { totalMs: 0 });
  assert.equal(schedule.hardEnd, 1000);
  assert.equal(schedule.restoreEnd, 1000);
  assert.equal(schedule.reverifyEnd, 1000);
  assert.equal(schedule.closeEnd, 1000);
  assert.equal(schedule.stopEnd, 1000);
});

test('cleanupSchedule：显式分阶段 0 不回落默认值，且任何阶段不越过总预算', () => {
  const zeroPhases = cleanupSchedule(1000, { totalMs: 60000, restoreMs: 0, reverifyMs: 0, closeMs: 0, stopMs: 0 });
  // restore 仍保留 CLEANUP_SETTLE_MS=3000 的落点；若 0 被默认值吞掉，restoreEnd 会是 29000。
  assert.equal(zeroPhases.restoreEnd, 4000);
  assert.equal(zeroPhases.reverifyEnd, 4000);
  assert.equal(zeroPhases.closeEnd, 4000);
  assert.equal(zeroPhases.stopEnd, 4000);
  const clamped = cleanupSchedule(1000, { totalMs: 100, restoreMs: 60000, reverifyMs: 60000, closeMs: 60000, stopMs: 60000 });
  assert.equal(clamped.hardEnd, 1100);
  assert.equal(clamped.restoreEnd, 1100);
  assert.equal(clamped.reverifyEnd, 1100);
  assert.equal(clamped.closeEnd, 1100);
  assert.equal(clamped.stopEnd, 1100);
});

test('isProbeSuccess/probeExitCode：cleanup 或关闭未确认必须非 0', () => {
  const good = { verdict: 'windowIdHwndCausalOnly', cleanup: { ok: true, browserClosed: true }, restore: null };
  assert.equal(isProbeSuccess(good), true);
  assert.equal(probeExitCode(good), 0);
  assert.equal(isProbeSuccess({ verdict: 'windowIdHwndCausalOnly', cleanup: { ok: true, browserClosed: true }, restore: { ok: true } }), true);
  const bad = [
    { verdict: 'windowIdHwndCausalOnly', cleanup: { ok: true, browserClosed: false }, restore: null },
    { verdict: 'windowIdHwndCausalOnly', cleanup: { ok: false, browserClosed: true }, restore: null },
    { verdict: 'windowIdHwndCausalOnly', cleanup: { ok: true, browserClosed: true }, restore: { ok: false } },
    { verdict: 'unknown', cleanup: { ok: true, browserClosed: true }, restore: null },
    { verdict: 'windowIdHwndCausalOnly', cleanup: null, restore: null },
    { verdict: 'windowIdHwndCausalOnly', cleanup: {}, restore: null },
  ];
  for (const report of bad) {
    assert.equal(isProbeSuccess(report), false, JSON.stringify(report));
    assert.equal(probeExitCode(report), 2, JSON.stringify(report));
  }
  assert.equal(probeExitCode({ verdict: 'stopped', stopReason: { code: 'stale-build' } }), 3);
  assert.equal(probeExitCode({ verdict: 'unknown', stopReason: { code: 'unexpected' } }), 4);
  assert.equal(probeExitCode(null), 4);
});

test('runCleanup：stop 超时仍返回结果，不抛穿', async () => {
  const result = await runCleanup({
    now: Date.now,
    totalMs: 200,
    stopMs: 25,
    stop: async () => { await new Promise(() => {}); },
  });
  assert.equal(result.stop.skipped, false);
  assert.equal(result.stop.ok, false);
  assert.equal(result.stop.code, 'stage-timeout');
  assert.equal(result.ok, false);
});

test('runCleanup：restore/reverify/close/stop 全部确认时才 ok=true', async () => {
  const result = await runCleanup({
    now: Date.now,
    totalMs: 60000,
    requireRestore: true,
    requireReverify: true,
    requireClose: true,
    restore: async () => ({ ok: true, confidence: 'confirmed' }),
    reverify: async () => ({ ok: true }),
    close: async () => ({ closed: true }),
    stop: async () => {},
  });
  assert.equal(result.restore.ok, true);
  assert.equal(result.reverify.ok, true);
  assert.equal(result.close.ok, true);
  assert.equal(result.stop.ok, true);
  assert.equal(result.ok, true);
});

test('runCleanup：require* 时 skipped 阶段不算成功（防假阳性）', async () => {
  const result = await runCleanup({
    now: Date.now,
    totalMs: 60000,
    requireRestore: true,
    requireReverify: true,
    requireClose: true,
    stop: async () => {},
  });
  assert.equal(result.restore.skipped, true);
  assert.equal(result.reverify.skipped, true);
  assert.equal(result.close.skipped, true);
  assert.equal(result.stop.ok, true);
  assert.equal(result.ok, false);
});

test('openCdp 必须 await 异步 connectCdp 并校验 send/close，绝不把 Promise 当 Cdp', async () => {
  const fake = { send: () => {}, close: () => {}, closed: false };
  let received = null;
  const cdp = await openCdp(async (url, options) => { received = { url, options }; return fake; }, 'ws://example/1', 1234, 'browser');
  assert.equal(cdp, fake);
  assert.deepEqual(received, { url: 'ws://example/1', options: { timeoutMs: 1234 } });
  await assert.rejects(
    openCdp(async () => ({ send: 1, close: () => {} }), 'ws://example/2', 10, 'tab'),
    error => stoppedCode(error) === 'cdp-shape',
  );
  await assert.rejects(
    openCdp(async () => { throw new Error('connect down'); }, 'ws://example/3', 10, 'browser'),
    /connect down/,
  );
});

test('closeCdpQuietly / disposeArbiterQuietly 资源关闭失败只记证据，不抛出掩盖原错误', () => {
  let closed = 0;
  assert.equal(closeCdpQuietly({ close: () => { closed += 1; } }, 'tabCdp', []), true);
  assert.equal(closed, 1);
  const evidence = [];
  assert.equal(closeCdpQuietly({ close: () => { throw new Error('socket close down'); } }, 'browserCdp', evidence), false);
  assert.equal(evidence.length, 1);
  assert.match(evidence[0], /socket close down/);
  assert.equal(closeCdpQuietly(null, 'tabCdp', evidence), false);
  let disposed = 0;
  assert.equal(disposeArbiterQuietly({ dispose: () => { disposed += 1; } }, evidence), true);
  assert.equal(disposed, 1);
  assert.equal(disposeArbiterQuietly({ dispose: () => { throw new Error('broker dispose down'); } }, evidence), false);
  assert.match(evidence[evidence.length - 1], /broker dispose down/);
  assert.equal(disposeArbiterQuietly(null, evidence), false);
});

test('readContent：隐藏/非候选 0 面积合法保留，可见候选与可见 renderer 必须正面积', () => {
  const baseWindow = {
    hwnd: 100, pid: 200, className: 'Chrome_WidgetWin_1', title: 'surface probe',
    visible: true, minimized: false, cloaked: false, dpi: 144,
    windowRect: { x: 10, y: 20, width: 800, height: 600 },
    frameRect: { x: 10, y: 20, width: 800, height: 600 },
    clientRect: { x: 18, y: 60, width: 784, height: 560 },
  };
  const baseRenderer = {
    hwnd: 101, parent: 100, className: 'Chrome_RenderWidgetHostHWND', pid: 200, visible: true,
    clientRect: { x: 18, y: 60, width: 784, height: 560 },
  };
  const contentWith = (windows, renderer) => ({
    units: 'physical-screen-pixels', dpiAwareness: 2, rendererTruncated: false,
    windows, renderer,
  });

  const hiddenZero = Object.assign({}, baseWindow, {
    hwnd: 102, visible: false,
    windowRect: { x: 0, y: 0, width: 0, height: 0 },
    frameRect: null,
    clientRect: { x: 0, y: 0, width: 0, height: 0 },
  });
  const hiddenRenderer = Object.assign({}, baseRenderer, {
    hwnd: 103, visible: false, clientRect: { x: 0, y: 0, width: 0, height: 0 },
  });
  const parsed = readContent(contentWith([baseWindow, hiddenZero], [baseRenderer, hiddenRenderer]), 'test');
  assert.equal(parsed.windows.length, 2);
  assert.equal(parsed.windows[1].eligible, false);
  assert.equal(parsed.windows[1].windowRect.width, 0);
  assert.equal(parsed.renderer[1].clientRect.width, 0);

  assert.throws(
    () => readContent(contentWith([
      Object.assign({}, baseWindow, { windowRect: { x: 0, y: 0, width: 0, height: 0 } }),
    ], [baseRenderer]), 'test'),
    error => stoppedCode(error) === 'content-window-not-drawable' &&
      error.detail.eligible === true &&
      error.detail.windowRect.width === 0 &&
      error.detail.clientRect.width === 784,
  );
  assert.throws(
    () => readContent(contentWith([
      Object.assign({}, baseWindow, { clientRect: null }),
    ], [baseRenderer]), 'test'),
    error => stoppedCode(error) === 'content-window-rect' &&
      error.detail.eligible === true &&
      error.detail.clientRect === null,
  );
  assert.throws(
    () => readContent(contentWith([
      Object.assign({}, baseWindow, { windowRect: { x: 0, y: 0, width: -1, height: 10 } }),
    ], [baseRenderer]), 'test'),
    error => stoppedCode(error) === 'content-window-rect' && error.detail.windowRect.width === -1,
  );
  // 可见候选的 frameRect 若存在必须是正面积（原门禁保留）；隐藏窗口则只要求原始可测。
  assert.throws(
    () => readContent(contentWith([
      Object.assign({}, baseWindow, { frameRect: { x: 10, y: 20, width: 0, height: 600 } }),
    ], [baseRenderer]), 'test'),
    error => stoppedCode(error) === 'content-window-frame-rect' &&
      error.detail.eligible === true &&
      error.detail.frameRect.width === 0,
  );
  assert.throws(
    () => readContent(contentWith([
      Object.assign({}, baseWindow, { frameRect: { x: 10, y: 20, width: Number.NaN, height: 600 } }),
    ], [baseRenderer]), 'test'),
    error => stoppedCode(error) === 'content-window-frame-rect' && error.detail.eligible === true,
  );
  assert.doesNotThrow(() => readContent(contentWith([
    Object.assign({}, baseWindow, { visible: false, frameRect: { x: 0, y: 0, width: 0, height: 0 } }),
  ], [baseRenderer]), 'test'));

  assert.throws(
    () => readContent(contentWith([baseWindow], [
      Object.assign({}, baseRenderer, { clientRect: { x: 0, y: 0, width: 0, height: 0 } }),
    ]), 'test'),
    error => stoppedCode(error) === 'content-renderer-not-drawable' &&
      error.detail.visible === true &&
      error.detail.clientRect.width === 0,
  );
});

test('主报告消费：moved=false 的 restore not-needed 映射为 notNeeded，且成功判据不误报 NOT-CONFIRMED', () => {
  const notNeeded = restoreReportFromOutcome({ name: 'restore', skipped: true, ok: false, reason: 'not-needed' }, false);
  assert.deepEqual(notNeeded, { notNeeded: true, reason: 'not-needed' });
  assert.equal(restoreSummary({ restore: notNeeded }), 'not-needed');
  const goodReport = {
    verdict: 'windowIdHwndCausalOnly',
    cleanup: { ok: true, browserClosed: true },
    restore: notNeeded,
  };
  assert.equal(isProbeSuccess(goodReport), true);
  assert.equal(probeExitCode(goodReport), 0);

  assert.equal(restoreReportFromOutcome(null, false), null);
  const movedWithoutOutcome = restoreReportFromOutcome(null, true);
  assert.equal(movedWithoutOutcome.ok, false);
  assert.equal(restoreSummary({ restore: movedWithoutOutcome }), 'NOT-CONFIRMED');
  const noBudget = restoreReportFromOutcome({ name: 'restore', skipped: true, ok: false, reason: 'no-budget' }, true);
  assert.equal(restoreSummary({ restore: noBudget }), 'NOT-CONFIRMED');
  assert.equal(isProbeSuccess(Object.assign({}, goodReport, { restore: noBudget })), false);
  const failed = restoreReportFromOutcome({ ok: false, error: 'helper down' }, true);
  assert.equal(restoreSummary({ restore: failed }), 'NOT-CONFIRMED');

  // not-needed 只替代“恢复”这一项，不能把 unknown / 未证绑定 / cleanup 未确认变成通过。
  const contradictory = restoreReportFromOutcome({ name: 'restore', skipped: true, ok: false, reason: 'not-needed' }, true);
  assert.equal(restoreSummary({ restore: contradictory }), 'NOT-CONFIRMED');
  assert.equal(isProbeSuccess(Object.assign({}, goodReport, { restore: contradictory })), false);
  assert.equal(isProbeSuccess(Object.assign({}, goodReport, { verdict: 'unknown' })), false);
  assert.equal(isProbeSuccess(Object.assign({}, goodReport, { cleanup: { ok: true, browserClosed: false } })), false);
  assert.equal(isProbeSuccess(Object.assign({}, goodReport, { cleanup: { ok: false, browserClosed: true } })), false);
  assert.equal(probeExitCode(Object.assign({}, goodReport, { verdict: 'unknown' })), 2);
});

test('探针模块导出供离线测试使用的纯函数，且导入时不会启动浏览器', () => {
  assert.equal(typeof openCdp, 'function');
  assert.equal(typeof closeCdpQuietly, 'function');
  assert.equal(typeof disposeArbiterQuietly, 'function');
  assert.equal(typeof main, 'function');
  assert.equal(typeof classifyClosureObservation, 'function');
  assert.equal(typeof waitForBrowserClosed, 'function');
  assert.equal(typeof restoreWindow, 'function');
  assert.equal(typeof cleanupSchedule, 'function');
  assert.equal(typeof isProbeSuccess, 'function');
  assert.equal(typeof probeExitCode, 'function');
  assert.equal(typeof runCleanup, 'function');
  assert.equal(typeof StageRunner, 'function');
  assert.equal(typeof readContent, 'function');
  assert.equal(typeof restoreReportFromOutcome, 'function');
  assert.equal(typeof restoreSummary, 'function');
});
