import assert from 'node:assert/strict';
import test from 'node:test';
import { createArbiter, withCall } from '../src/desktop/arbiter.ts';
import { createPage, type PageDeps, type PageGeometryProvider } from '../src/browser/page.ts';
import type { Cdp } from '../src/browser/cdp.ts';
import type { ActionEvent, PhysicalPoint, TrustedCallerContext } from '../src/tool.ts';

// A real run uses the broker over a named pipe; in tests the gate lives in this process.
process.env.EVOLUTION_CU_ARBITER = 'inproc';

const PUBLISH = 'Runtime.evaluate';

interface Sent { method: string; params: Record<string, unknown> }

const caller = (agentId = 'agent-a'): TrustedCallerContext => ({
  identity: 'trusted', agentId, rootAgentId: 'lead', depth: 1, lifetime: 1, callId: `call-${agentId}`,
});

function answer(method: string, params: Record<string, unknown>): unknown {
  if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, visualViewport: { scale: 1 } };
  if (method !== PUBLISH) return {};
  const expression = typeof params.expression === 'string' ? params.expression : '';
  if (expression.includes('__evolutionCU.point')) return { result: { value: { x: 42, y: 24 } } };
  if (expression.includes('__evolutionCU.focus')) return { result: { value: 'ok' } };
  // Reading the page is a page-structure read, not a pointer one: answer it with a real (empty) structure.
  if (expression.includes('__evolutionCU.snapshot')) return { result: { value: { url: 'about:blank', title: 'page', controls: [], text: '' } } };
  if (expression.includes('innerWidth / 2')) return { result: { value: { x: 400, y: 300 } } };
  return { result: { value: null } };
}

function fakeCdp() {
  const sent: Sent[] = [];
  const cdp: Cdp = {
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      sent.push({ method, params });
      return answer(method, params) as T;
    },
    on() { return () => {}; },
    close() {},
    get closed() { return false; },
  };
  return { cdp, sent };
}

/** Runs one step inside the trusted chain and returns everything it reported. */
async function audit(
  run: (page: ReturnType<typeof createPage>) => Promise<unknown>,
  geometry?: PageGeometryProvider,
  timers?: PageDeps['timers'],
) {
  const fake = fakeCdp();
  const page = createPage(fake.cdp, { ...(geometry ? { targetId: 'tab-1', geometry } : {}), ...(timers ? { timers } : {}) });
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });
  await withCall(caller(), undefined, () => run(page), arbiter);
  return { events, sent: fake.sent, arbiter };
}

const spaces = (events: ActionEvent[]): string[] => [...new Set(events.map(event => event.space))];
const withPlace = (events: ActionEvent[]): ActionEvent[] => events.filter(event => event.to !== undefined);

test('a measured mapping puts the real screen point in the audit', async () => {
  // 1.25 physical pixels per CSS pixel, content area starting at (100, 50): CSS (42, 24) is screen (152.5, 80) → (153, 80).
  const geometry: PageGeometryProvider = async () => css => ({ x: 100 + css.x * 1.25, y: 50 + css.y * 1.25 });
  const { events } = await audit(page => page.click({ ref: 1 }), geometry);

  // The turn is announced first, and a place is only known once the step holds the input: queued, granted and the
  // closing line carry no position at all.
  assert.deepEqual(spaces(events), ['window', 'physical']);
  for (const phase of ['queued', 'granted', 'succeeded']) {
    const line = events.find(event => event.phase === phase)!;
    assert.equal(line.space, 'window');
    assert.equal(line.to, undefined);
  }
  const placed = withPlace(events);
  assert.ok(placed.length >= 2, 'the approach and the press both name the point');
  for (const event of placed) { assert.equal(event.space, 'physical'); assert.deepEqual(event.to, { x: 153, y: 80 }); }
  // The page's own CSS numbers are never handed out as a screen position.
  assert.ok(!events.some(event => event.to?.x === 42 || event.to?.y === 24), 'CSS coordinates are not a screen position');
  assert.equal(events.at(-1)!.phase, 'succeeded');
});

test('no measurement means no position, but still an audit line', async () => {
  const { events } = await audit(page => page.click({ ref: 1 }), async () => null);

  assert.equal(events.length > 0, true, 'an action without a position is still reported');
  assert.deepEqual(spaces(events), ['window']);
  assert.equal(withPlace(events).length, 0);
  assert.equal(events.some(event => event.from !== undefined || event.path !== undefined), false);
  assert.equal(events.at(-1)!.phase, 'succeeded');
});

test('a mapping that cannot be computed is treated as no measurement', async () => {
  for (const answer of [
    () => null,
    () => ({ x: Number.NaN, y: 10 }),
    () => ({ x: 10, y: Number.POSITIVE_INFINITY }),
    () => { throw new Error('measurement broke'); },
    () => ({ x: '10', y: '20' }) as unknown as PhysicalPoint,
  ]) {
    const { events } = await audit(page => page.click({ ref: 1 }), async () => answer as never);
    assert.deepEqual(spaces(events), ['window'], 'an unusable answer reports no position');
    assert.equal(withPlace(events).length, 0);
  }
});

test('a measurement that never answers does not hold the input', async () => {
  const geometry: PageGeometryProvider = async () => await new Promise<never>(() => {});
  // The measurement is given a little time and no more; the test's clock runs out at once instead of after three seconds.
  const timers = { set: (fn: () => void) => setTimeout(fn, 0), clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };
  const { events, sent } = await audit(page => page.click({ ref: 1 }), geometry, timers);

  assert.deepEqual(spaces(events), ['window']);
  assert.deepEqual(sent.filter(one => one.method === 'Input.dispatchMouseEvent').map(one => one.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(events.at(-1)!.phase, 'succeeded');
});

test('negative screen coordinates are a real place, not an error', async () => {
  // A second monitor to the left of the primary one: CSS (0,0) sits at x = -1920.
  const geometry: PageGeometryProvider = async () => css => ({ x: -1920 + css.x, y: css.y });
  const { events } = await audit(page => page.click({ ref: 1 }), geometry);

  assert.deepEqual(spaces(events), ['window', 'physical']);
  for (const event of withPlace(events)) { assert.equal(event.space, 'physical'); assert.deepEqual(event.to, { x: -1878, y: 24 }); }
});

test('the measurement is taken once per action and never kept for the next', async () => {
  const asked: string[] = [];
  const geometry: PageGeometryProvider = async targetId => {
    asked.push(targetId);
    return css => ({ x: css.x, y: css.y });
  };
  await audit(async page => { await page.click({ ref: 1 }); await page.click({ ref: 1 }); }, geometry);
  assert.deepEqual(asked, ['tab-1', 'tab-1'], 'one measurement per input, not one per step');

  const once: string[] = [];
  await audit(async page => {
    await page.click({ ref: 1 });
    await page.read();
  }, async targetId => { once.push(targetId); return css => ({ x: css.x, y: css.y }); });
  assert.deepEqual(once, ['tab-1'], 'reading the page measures nothing');
});

test('typing and keys report no position even when the page can be located', async () => {
  const geometry: PageGeometryProvider = async () => css => ({ x: css.x, y: css.y });
  const typed = await audit(page => page.type({ ref: 1 }, 'hi'), geometry);
  assert.deepEqual(spaces(typed.events), ['window']);
  assert.equal(withPlace(typed.events).length, 0);

  const pressed = await audit(page => page.press('Enter'), geometry);
  assert.deepEqual(spaces(pressed.events), ['window']);
  assert.equal(withPlace(pressed.events).length, 0);
});

test('a scroll names the wheel point, the middle of the page when nothing is named', async () => {
  const geometry: PageGeometryProvider = async () => css => ({ x: 10 + css.x, y: 20 + css.y });
  const onTarget = await audit(page => page.scroll('down', { ref: 1 }), geometry);
  assert.deepEqual(spaces(onTarget.events), ['window', 'physical']);
  for (const event of withPlace(onTarget.events)) { assert.equal(event.space, 'physical'); assert.deepEqual(event.to, { x: 52, y: 44 }); }

  const inMiddle = await audit(page => page.scroll('up'), geometry);
  for (const event of withPlace(inMiddle.events)) assert.deepEqual(event.to, { x: 410, y: 320 });
});

test('the layout divisor is read from the browser, not from the page', async () => {
  let seen: unknown;
  const geometry: PageGeometryProvider = async (_targetId, layout) => { seen = await layout(); return css => ({ x: css.x, y: css.y }); };
  const { sent } = await audit(page => page.click({ ref: 1 }), geometry);

  assert.deepEqual(seen, { cssWidth: 800, cssHeight: 600, pageZoom: 1 });
  const reads = sent.filter(one => one.method === 'Page.getLayoutMetrics');
  assert.equal(reads.length, 1);
  // And the page was never asked how wide it thinks it is.
  assert.equal(sent.some(one => typeof one.params.expression === 'string' && one.params.expression.includes('innerWidth / 2')), false);
});

test('an unreadable layout is no measurement', async () => {
  const fake = fakeCdp();
  const broken: Cdp = { ...fake.cdp, async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'Page.getLayoutMetrics') throw new Error('浏览器连接已断开');
    return answer(method, params) as T;
  } };
  const page = createPage(broken, { targetId: 'tab-1', geometry: async (_id, layout) => { const metrics = await layout(); assert.equal(metrics, null); return css => ({ x: css.x, y: css.y }); } });
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });
  await withCall(caller(), undefined, () => page.click({ ref: 1 }), arbiter);

  assert.deepEqual(spaces(events), ['window']);
  assert.equal(withPlace(events).length, 0);
});
