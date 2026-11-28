import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowser } from '../src/browser/browser.ts';
import { WITNESS_WORLD, readTabViewport, type Cdp, type Target } from '../src/browser/cdp.ts';
import type { Page } from '../src/browser/page.ts';
import { browserGeometry } from '../src/computer.ts';
import { createArbiter, withCall } from '../src/desktop/arbiter.ts';
import { Faults } from '../src/shared/faults.ts';
import type { ActionEvent, TrustedCallerContext } from '../src/tool.ts';

// A real run uses the broker over a named pipe; in tests the gate lives in this process.
process.env.EVOLUTION_CU_ARBITER = 'inproc';

const PID = 4200;
const PHYSICAL = 'physical-screen-pixels';

const caller = (agentId = 'agent-a'): TrustedCallerContext => ({
  identity: 'trusted', agentId, rootAgentId: 'lead', depth: 1, lifetime: 1, callId: `call-${agentId}`,
});

interface Sent { method: string; params: Record<string, unknown> }

/** One thing the browser says about contexts on the tab's own connection. */
interface Announce {
  created?: { id?: number; uniqueId?: string | null; name?: string; frameId?: string };
  destroyed?: { id?: number; uniqueId?: string };
  /** The document that announced those worlds is gone, and the browser says so in one event. */
  cleared?: boolean;
}

interface Fake {
  cdp: Cdp;
  /** Who is still listening on this connection; a finished read must leave nobody behind. */
  watching(): number;
  /** Says one more thing about contexts, later than the ones this browser said while enabling runtime. */
  say(one: Announce): void;
}

/** What one tab answers, in the same terms the browser and the desktop helper would answer in. */
interface Scene {
  visibility?: string;
  /** The trusted CSS layout viewport the tab itself reports. */
  inner?: [number, number];
  /** What the root element's client area excludes, i.e. a classic scrollbar. */
  root?: [number, number];
  /** What Page.getLayoutMetrics reports for the layout viewport. */
  layout?: [number, number];
  visual?: { scale?: number; offsetX?: number; offsetY?: number; pageX?: number; pageY?: number; width?: number; height?: number };
  loader?: string;
  loaderAfter?: string;
  /** The isolated world this browser hands out; null means it cannot hand out one at all. */
  world?: { executionContextId?: number } | null;
  /**
   * What this browser announces over the very same socket while the world is being made: null means it says nothing at all,
   * and leaving it out means it announces the one world it just handed out.
   */
  announce?: Announce[] | null;
  realmIntact?: boolean;
  /** The CDP window the tab belongs to; null means the browser will not say. */
  windowId?: number | null;
  content?: { units?: string; truncated?: boolean; pid?: number; windowVisible?: boolean; rendererVisible?: boolean };
  helperThrows?: boolean;
  point?: { x: number; y: number };
  /** Which processes the browser says it has. */
  pids?: number[];
  /**
   * What the desktop helper answers for `browserProfile`: a whole answer, or a function of the request it was given.
   * Leaving it out means the honest, complete answer — every process the port named was started with this agent's
   * profile — so tests that only care about the layers above it keep their meaning.
   */
  profile?: ((expected: string, asked: number[]) => unknown) | Record<string, unknown> | null;
}

/** The desktop helper's `content` answer: one window, one render widget inside it, measured in physical pixels. */
function contentOf(scene: Scene) {
  const inner = scene.inner ?? [800, 560];
  const content = scene.content ?? {};
  const pid = content.pid ?? PID;
  return {
    units: content.units ?? PHYSICAL,
    dpiAwareness: 2,
    windows: [{
      hwnd: 11, pid, className: 'Chrome_WidgetWin_1', title: 'x',
      visible: content.windowVisible ?? true, minimized: false, cloaked: false, dpi: 96,
      windowRect: { x: 100, y: 100, width: 800, height: 600 },
      frameRect: null,
      clientRect: { x: 100, y: 140, width: inner[0], height: inner[1] },
    }],
    renderer: [{
      hwnd: 12, parent: 11, className: 'Chrome_RenderWidgetHostHWND', pid,
      visible: content.rendererVisible ?? true,
      clientRect: { x: 100, y: 140, width: inner[0], height: inner[1] },
    }],
    rendererTruncated: content.truncated ?? false,
  };
}

/**
 * The desktop helper's `browserProfile` answer: which of the processes the port named were really started with this
 * agent's own profile. Leaving it out of a scene means the complete, honest match — the helper read every process and
 * every one of them names the requested profile — which is the ordinary case the higher layers were written against.
 */
function profileOf(scene: Scene, expected: string, asked: number[]) {
  const custom = scene.profile;
  if (custom === undefined) {
    return {
      status: 'matched',
      complete: true,
      incompleteReason: null,
      expected,
      candidates: asked.length,
      matched: [...asked],
      unmatched: [],
      unknown: [],
      evidence: [],
    };
  }
  return typeof custom === 'function' ? custom(expected, asked) : custom;
}

function fakeCdp(scene: Scene, sent: Sent[]): Fake {
  const inner = scene.inner ?? [800, 560];
  const root = scene.root ?? [785, 560];
  const layout = scene.layout ?? [800, 560];
  const visual = {
    scale: scene.visual?.scale ?? 1,
    offsetX: scene.visual?.offsetX ?? 0,
    offsetY: scene.visual?.offsetY ?? 0,
    pageX: scene.visual?.pageX ?? 0,
    pageY: scene.visual?.pageY ?? 0,
    clientWidth: scene.visual?.width ?? inner[0],
    clientHeight: scene.visual?.height ?? inner[1],
  };
  let frames = 0;
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  const emit = (method: string, params: Record<string, unknown>): void => { for (const one of [...listeners]) one(method, params); };
  const handed = scene.world === null ? null : { executionContextId: scene.world?.executionContextId ?? 3 };
  // The default is a browser that names the world it handed out, over the same socket, the way Edge and Chrome do.
  const announcements: Announce[] | null = scene.announce === undefined
    ? (handed ? [{ created: { id: handed.executionContextId, uniqueId: 'u-1' } }] : null)
    : scene.announce;
  const deliver = (one: Announce): void => {
    if (one.cleared) {
      emit('Runtime.executionContextsCleared', {});
      return;
    }
    if (one.created) {
      const id = one.created.id ?? handed?.executionContextId ?? 3;
      const uniqueId = one.created.uniqueId === undefined ? 'u-1' : one.created.uniqueId;
      emit('Runtime.executionContextCreated', { context: {
        id,
        name: one.created.name ?? WITNESS_WORLD,
        origin: '',
        ...(uniqueId ? { uniqueId } : {}),
        auxData: { frameId: one.created.frameId ?? 'F1', isDefault: false, type: 'isolated' },
      } });
    }
    if (one.destroyed) {
      emit('Runtime.executionContextDestroyed', {
        executionContextId: one.destroyed.id ?? null,
        executionContextUniqueId: one.destroyed.uniqueId ?? '',
      });
    }
  };
  const announce = (): void => { for (const one of announcements ?? []) deliver(one); };
  const cdp: Cdp = {
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      sent.push({ method, params });
      if (method === 'Runtime.enable') {
        announce();
        return {} as T;
      }
      if (method === 'Page.getFrameTree') {
        frames += 1;
        const loaderId = frames === 1 ? (scene.loader ?? 'L1') : (scene.loaderAfter ?? scene.loader ?? 'L1');
        return { frameTree: { frame: { id: 'F1', loaderId } } } as T;
      }
      if (method === 'Page.createIsolatedWorld') {
        return (handed ?? {}) as T;
      }
      if (method === 'Runtime.evaluate') {
        const expression = typeof params.expression === 'string' ? params.expression : '';
        if (expression.includes('realmIntact')) {
          return { result: { value: {
            realmIntact: scene.realmIntact ?? true,
            visibility: scene.visibility ?? 'visible',
            innerWidth: inner[0], innerHeight: inner[1],
            rootClientWidth: root[0], rootClientHeight: root[1],
          } } } as T;
        }
        if (expression.includes('__evolutionCU.point')) return { result: { value: scene.point ?? { x: 42, y: 24 } } } as T;
        return { result: { value: null } } as T;
      }
      if (method === 'Browser.getWindowForTarget') {
        const windowId = scene.windowId === undefined ? 7 : scene.windowId;
        return (windowId === null ? {} : { windowId, bounds: { left: 100, top: 100, width: 800, height: 600, windowState: 'normal' } }) as T;
      }
      if (method === 'Page.getLayoutMetrics') {
        // Both boxes are real CDP fields: the layout viewport and, separately, the CSS visual viewport the user sees.
        return {
          cssLayoutViewport: { clientWidth: layout[0], clientHeight: layout[1] },
          visualViewport: { scale: visual.scale },
          cssVisualViewport: visual,
        } as T;
      }
      return {} as T;
    },
    on(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {},
    get closed() { return false; },
  };
  return { cdp, watching: () => listeners.size, say: deliver };
}
const tab = (id: string): Target => ({ id, type: 'page', url: 'about:blank', title: '', webSocketDebuggerUrl: `ws://x/${id}` });

/** A browser wired the way production wires it: the geometry adapter is asked for a tab's place, over that tab's connection. */
function harness(scene: Scene, options: { resolverThrows?: boolean; onPids?: () => void; portPids?: () => unknown } = {}) {
  const sent: Sent[] = [];
  const helperCalls: { op: string; args: Record<string, unknown> }[] = [];
  const fakes: Fake[] = [];
  const helper = async (op: string, args: Record<string, unknown> = {}) => {
    helperCalls.push({ op, args });
    if (scene.helperThrows) throw new Error('helper 起不来');
    if (op === 'browserProfile') {
      const asked = Array.isArray(args.pids) ? args.pids as number[] : [];
      const expected = typeof args.expected === 'string' ? args.expected : '';
      return profileOf(scene, expected, asked) as unknown as Record<string, unknown>;
    }
    return contentOf(scene) as unknown as Record<string, unknown>;
  };
  const mapping = browserGeometry({
    helper,
    browserPids: async () => {
      options.onPids?.();
      // A deliberately malformed reading can be injected here: the layer under test has to refuse it whole.
      return (options.portPids ? options.portPids() : scene.pids ?? [PID]) as number[];
    },
  });
  const browser = createBrowser({
    profileDir: 'P',
    faults: new Faults(),
    timeoutMs: 10_000,
    find: () => '/x/msedge.exe',
    running: async () => 9333,
    launch: async () => { throw new Error('已经开着的浏览器不用再开'); },
    targets: async () => [tab('T-main')],
    open: async () => tab('T-scratch'),
    close: async () => {},
    connect: async () => { const fake = fakeCdp(scene, sent); fakes.push(fake); return fake.cdp; },
    geometryResolver: info => {
      if (options.resolverThrows) throw new Error('没有几何');
      return mapping(info);
    },
  });
  const events: ActionEvent[] = [];
  const arbiter = createArbiter({ sink: event => { events.push(event); } });
  const withPage = <T>(work: (page: Page, signal: AbortSignal) => Promise<T>): Promise<T> =>
    withCall(caller(), undefined, () => browser.run(work), arbiter);
  const withScratch = <T>(work: (page: Page, signal: AbortSignal) => Promise<T>): Promise<T> =>
    withCall(caller(), undefined, () => browser.scratch(work), arbiter);
  return { browser, events, sent, fakes, helperCalls, withPage, withScratch };
}

const contentCalls = (harnessed: { helperCalls: { op: string; args: Record<string, unknown> }[] }) =>
  harnessed.helperCalls.filter(one => one.op === 'content');
const profileCalls = (harnessed: { helperCalls: { op: string; args: Record<string, unknown> }[] }) =>
  harnessed.helperCalls.filter(one => one.op === 'browserProfile');
const methods = (sent: Sent[]): string[] => sent.map(one => one.method);
const count = (sent: Sent[], method: string): number => methods(sent).filter(one => one === method).length;
const spaces = (events: ActionEvent[]): string[] => [...new Set(events.map(event => event.space))];
const placed = (events: ActionEvent[]): ActionEvent[] => events.filter(event => event.to !== undefined);
const presses = (sent: Sent[]): Record<string, unknown>[] =>
  sent.filter(one => one.method === 'Input.dispatchMouseEvent' && one.params.type === 'mousePressed').map(one => one.params);
const witnessReads = (sent: Sent[]): Sent[] =>
  sent.filter(one => one.method === 'Runtime.evaluate' && String(one.params.expression).includes('realmIntact'));

const CANDIDATE = { targetId: 'T-main', pid: PID, layout: { cssWidth: 800, cssHeight: 560, pageZoom: 1 } };

/** Waits for the fake browser to reach a point in its answer, instead of guessing with a fixed delay. */
async function until(condition: () => boolean, ms = 1_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error('测试里的假浏览器没有走到这一步');
    await pause(5);
  }
}
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Reads one tab's viewport straight from the layer that measures it, with nothing else in the way. */
async function read(scene: Scene, candidate = CANDIDATE) {
  const sent: Sent[] = [];
  const fake = fakeCdp(scene, sent);
  const reading = await readTabViewport(fake.cdp, candidate, { browserPids: async () => scene.pids ?? [PID] });
  return { reading, sent, watching: fake.watching() };
}

test('a real click drives the tab and is audited without a position while the surface is unproven', async () => {
  const harnessed = harness({});
  await harnessed.withPage(page => page.click({ ref: 1 }));

  assert.deepEqual(spaces(harnessed.events), ['window'], 'no step claims a place on the screen yet');
  assert.deepEqual(placed(harnessed.events), [], 'no audit event carries coordinates');
  assert.equal(harnessed.events[harnessed.events.length - 1].phase, 'succeeded');
  assert.equal(harnessed.events[0].seq, 1);

  // The input is real and unchanged: the mouse events still speak the page's own CSS pixels.
  const mouse = presses(harnessed.sent);
  assert.equal(mouse.length, 1);
  assert.equal(mouse[0].x, 42);
  assert.equal(mouse[0].y, 24);

  // The measurement still runs, through a world the document cannot reach, named by the browser itself.
  const world = harnessed.sent.find(one => one.method === 'Page.createIsolatedWorld');
  assert.ok(world);
  assert.equal(world.params.worldName, WITNESS_WORLD);
  assert.equal(world.params.grantUniveralAccess, false);
  const value = witnessReads(harnessed.sent);
  assert.equal(value.length, 1);
  assert.equal(value[0].params.uniqueContextId, 'u-1');
  assert.equal(value[0].params.contextId, undefined);
  assert.equal(count(harnessed.sent, 'Runtime.disable'), 1);
  assert.equal(count(harnessed.sent, 'Page.getFrameTree'), 2);
  for (const fake of harnessed.fakes) assert.equal(fake.watching(), 0, 'no context listener is left behind');

  // The profile is checked first, with this browser's own profile directory and the processes its port named, and the
  // window is only measured for the processes the helper proved were started with it.
  const proofs = profileCalls(harnessed);
  assert.equal(proofs.length, 1);
  assert.deepEqual(proofs[0].args, { expected: 'P', pids: [PID] });
  const contents = contentCalls(harnessed);
  assert.equal(contents.length, 1);
  assert.deepEqual(contents[0].args, { pid: PID });
  assert.equal(harnessed.helperCalls.length, 2, 'one proof and one window reading, per measurement');

  const forbidden = ['Page.bringToFront', 'Target.activateTarget', 'Page.navigate', 'Emulation.setDeviceMetricsOverride'];
  for (const method of forbidden) assert.equal(count(harnessed.sent, method), 0, `${method} is never used to find a place`);

  await harnessed.browser.stop();
});

test('every click measures again, once', async () => {
  const harnessed = harness({});
  await harnessed.withPage(page => page.click({ ref: 1 }));
  await harnessed.withPage(page => page.click({ ref: 2 }));

  assert.equal(contentCalls(harnessed).length, 2, 'the second click does not borrow the first measurement');
  assert.equal(profileCalls(harnessed).length, 2, 'the profile is proven again for the second click, never carried over');
  assert.equal(new Set(harnessed.events.map(event => event.requestId)).size, 2);
  assert.equal(presses(harnessed.sent).length, 2);
  assert.deepEqual(spaces(harnessed.events), ['window']);

  await harnessed.browser.stop();
});

test('a page keeps working when the geometry layer itself fails', async () => {
  const harnessed = harness({}, { resolverThrows: true });
  await harnessed.withPage(page => page.click({ ref: 1 }));

  assert.equal(presses(harnessed.sent).length, 1, 'the click is still a real click');
  assert.deepEqual(spaces(harnessed.events), ['window']);
  assert.deepEqual(placed(harnessed.events), []);
  assert.equal(harnessed.events[harnessed.events.length - 1].phase, 'succeeded');

  await harnessed.browser.stop();
});

test('a browser whose processes were started with another profile is never measured', async () => {
  // The port names one process, and the helper read it fine — but it was started with a different profile, so it is not
  // this agent's browser and its window must not be measured or witnessed at all.
  const harnessed = harness({
    pids: [999],
    profile: { status: 'mismatch', complete: true, incompleteReason: null, expected: 'P', candidates: 1, matched: [], unmatched: [999], unknown: [], evidence: [] },
  });
  await harnessed.withPage(page => page.click({ ref: 1 }));

  assert.equal(contentCalls(harnessed).length, 0, 'no window is measured for processes that belong to another profile');
  assert.equal(witnessReads(harnessed.sent).length, 0, 'the tab is not read at all for a browser this agent does not own');
  assert.equal(presses(harnessed.sent).length, 1, 'the real click still happens');
  assert.deepEqual(placed(harnessed.events), [], 'still no claimed position');
  assert.deepEqual(spaces(harnessed.events), ['window']);

  await harnessed.browser.stop();
});

test('a scratch tab is measured over its own connection, for its own tab', async () => {
  const harnessed = harness({});
  await harnessed.withScratch(page => page.click({ ref: 1 }));

  assert.equal(contentCalls(harnessed).length, 1);
  assert.equal(profileCalls(harnessed).length, 1);
  assert.equal(count(harnessed.sent, 'Page.createIsolatedWorld'), 1);
  assert.equal(witnessReads(harnessed.sent).length, 1);
  assert.deepEqual(spaces(harnessed.events), ['window']);
  assert.equal(harnessed.events[harnessed.events.length - 1].phase, 'succeeded');

  await harnessed.browser.stop();
});

// The profile check is the first layer of the measurement, and it is strict: only a complete answer in which every
// process the port named is read and positively attributed to this agent's own profile may go on to be measured.

test('a complete reading with no matching process measures nothing', async () => {
  const harnessed = harness({
    profile: { status: 'mismatch', complete: true, incompleteReason: null, expected: 'P', candidates: 1, matched: [], unmatched: [PID], unknown: [], evidence: [] },
  });
  await harnessed.withPage(page => page.click({ ref: 1 }));

  assert.equal(profileCalls(harnessed).length, 1);
  assert.deepEqual(profileCalls(harnessed)[0].args, { expected: 'P', pids: [PID] });
  assert.equal(contentCalls(harnessed).length, 0, 'no window is measured when no process owns the profile');
  assert.equal(witnessReads(harnessed.sent).length, 0);
  assert.equal(presses(harnessed.sent).length, 1);
  assert.deepEqual(placed(harnessed.events), []);
  assert.deepEqual(spaces(harnessed.events), ['window']);

  await harnessed.browser.stop();
});

test('a partial or unknown profile reading measures nothing', async () => {
  const asked = [PID, 4300];
  const partials: Record<string, unknown>[] = [
    // A process whose command line could not be read: the answer is not complete, so no process is trusted.
    { status: 'unknown', complete: false, incompleteReason: 'access denied', expected: 'P', candidates: 2, matched: [], unmatched: [], unknown: [{ pid: PID, reason: 'access denied' }], evidence: [] },
    // It says matched but also reports an unreadable process — contradictory, and refused on the unknown list alone.
    { status: 'matched', complete: false, incompleteReason: 'one process unreadable', expected: 'P', candidates: 2, matched: [PID], unmatched: [4300], unknown: [{ pid: 4300, reason: 'access denied' }], evidence: [] },
    // It claims completeness yet names a reason for being incomplete, which the helper never does.
    { status: 'matched', complete: true, incompleteReason: 'one process unreadable', expected: 'P', candidates: 2, matched: [PID, 4300], unmatched: [], unknown: [], evidence: [] },
    // Only one of the port's two processes was examined at all.
    { status: 'matched', complete: true, incompleteReason: null, expected: 'P', candidates: 2, matched: [PID], unmatched: [], unknown: [], evidence: [] },
  ];
  for (const profile of partials) {
    const harnessed = harness({ pids: asked, profile });
    await harnessed.withPage(page => page.click({ ref: 1 }));
    assert.equal(contentCalls(harnessed).length, 0, `no window measured for ${JSON.stringify(profile)}`);
    assert.equal(witnessReads(harnessed.sent).length, 0);
    assert.equal(presses(harnessed.sent).length, 1);
    assert.deepEqual(placed(harnessed.events), []);
    await harnessed.browser.stop();
  }
});

test('a profile answer with damaged or foreign process ids measures nothing', async () => {
  const asked = [PID, 4300];
  const broken: Record<string, unknown>[] = [
    // A bare string where a process id must be.
    { status: 'matched', complete: true, incompleteReason: null, expected: 'P', candidates: 2, matched: [PID, '4300'], unmatched: [], unknown: [], evidence: [] },
    // A process the port never named.
    { status: 'matched', complete: true, incompleteReason: null, expected: 'P', candidates: 2, matched: [PID, 999], unmatched: [4300], unknown: [], evidence: [] },
    // The same process on both sides.
    { status: 'matched', complete: true, incompleteReason: null, expected: 'P', candidates: 2, matched: [PID, 4300], unmatched: [4300], unknown: [], evidence: [] },
    // A count that does not add up.
    { status: 'matched', complete: true, incompleteReason: null, expected: 'P', candidates: 3, matched: [PID], unmatched: [4300], unknown: [], evidence: [] },
    // Only one of the port's processes accounted for.
    { status: 'matched', complete: true, incompleteReason: null, expected: 'P', candidates: 2, matched: [PID], unmatched: [], unknown: [], evidence: [] },
    // The helper answers about some other profile altogether.
    { status: 'matched', complete: true, incompleteReason: null, expected: 'C:/other/profile', candidates: 2, matched: [PID, 4300], unmatched: [], unknown: [], evidence: [] },
    // A helper that does not know the operation answers with an error instead of a reading.
    { error: 'unsupported operation: browserProfile' },
    // Not even an object.
    null as unknown as Record<string, unknown>,
  ];
  for (const profile of broken) {
    const harnessed = harness({ pids: asked, profile });
    await harnessed.withPage(page => page.click({ ref: 1 }));
    assert.equal(contentCalls(harnessed).length, 0, `no window measured for ${JSON.stringify(profile)}`);
    assert.equal(witnessReads(harnessed.sent).length, 0);
    assert.equal(presses(harnessed.sent).length, 1);
    await harnessed.browser.stop();
  }
});

test('a helper that cannot answer the profile check leaves the click real and unplaced', async () => {
  const harnessed = harness({ helperThrows: true });
  await harnessed.withPage(page => page.click({ ref: 1 }));

  assert.equal(profileCalls(harnessed).length, 1, 'the profile check is still attempted');
  assert.equal(contentCalls(harnessed).length, 0, 'nothing is measured when the check cannot run');
  assert.equal(witnessReads(harnessed.sent).length, 0);
  assert.equal(presses(harnessed.sent).length, 1, 'the real click still happens');
  assert.deepEqual(spaces(harnessed.events), ['window']);
  assert.deepEqual(placed(harnessed.events), []);

  await harnessed.browser.stop();
});

test('two clicks whose port processes changed are each proved afresh', async () => {
  const scene: Scene = { pids: [PID] };
  const harnessed = harness(scene);
  await harnessed.withPage(page => page.click({ ref: 1 }));

  scene.pids = [4300];
  scene.content = { pid: 4300 };
  await harnessed.withPage(page => page.click({ ref: 2 }));

  assert.deepEqual(profileCalls(harnessed).map(one => one.args.pids), [[PID], [4300]], 'each click proves the processes it sees now');
  assert.deepEqual(contentCalls(harnessed).map(one => one.args.pid), [PID, 4300], 'and measures the window of the processes it just proved');

  await harnessed.browser.stop();
});

test('one measurement reads the port processes once, shared by the proof and the witness', async () => {
  let reads = 0;
  const harnessed = harness({}, { onPids: () => { reads += 1; } });
  await harnessed.withPage(page => page.click({ ref: 1 }));

  assert.equal(reads, 1, 'the port is asked once, not again for the witness');
  assert.equal(profileCalls(harnessed).length, 1);
  assert.equal(contentCalls(harnessed).length, 1);
  assert.equal(witnessReads(harnessed.sent).length, 1);

  await harnessed.browser.stop();
});

// The port's own list is taken whole or not at all. One entry the reader cannot vouch for fails the whole
// measurement instead of being dropped, so the helper can never certify a set that is not the set the port named.
test('a port process list with an unusable entry is refused whole, not narrowed', async () => {
  const readings: { why: string; value: unknown }[] = [
    { why: 'a string among the ids', value: [PID, 'bad'] },
    { why: 'a zero id', value: [PID, 0] },
    { why: 'a negative id', value: [PID, -5] },
    { why: 'a fractional id', value: [PID, 4.5] },
    { why: 'a NaN id', value: [PID, Number.NaN] },
    { why: 'not a list at all', value: 'not a list' },
  ];
  for (const reading of readings) {
    const harnessed = harness({}, { portPids: () => reading.value });
    await harnessed.withPage(page => page.click({ ref: 1 }));

    assert.equal(profileCalls(harnessed).length, 0, `the helper is not asked about a list with ${reading.why}`);
    assert.equal(contentCalls(harnessed).length, 0, `nothing is measured for a list with ${reading.why}`);
    assert.equal(witnessReads(harnessed.sent).length, 0);
    assert.equal(presses(harnessed.sent).length, 1, 'the real click still happens');
    assert.deepEqual(placed(harnessed.events), []);
    assert.deepEqual(spaces(harnessed.events), ['window']);

    await harnessed.browser.stop();
  }
});

test('an empty port process list measures nothing', async () => {
  const harnessed = harness({}, { portPids: () => [] });
  await harnessed.withPage(page => page.click({ ref: 1 }));

  assert.equal(profileCalls(harnessed).length, 0);
  assert.equal(contentCalls(harnessed).length, 0);
  assert.equal(witnessReads(harnessed.sent).length, 0);
  assert.equal(presses(harnessed.sent).length, 1);
  assert.deepEqual(placed(harnessed.events), []);

  await harnessed.browser.stop();
});

test('more distinct port processes than the helper accepts measure nothing', async () => {
  const harnessed = harness({}, { portPids: () => Array.from({ length: 9 }, (_, at) => 4000 + at) });
  await harnessed.withPage(page => page.click({ ref: 1 }));

  assert.equal(profileCalls(harnessed).length, 0, 'nine distinct ids are more than the helper takes');
  assert.equal(contentCalls(harnessed).length, 0);
  assert.equal(presses(harnessed.sent).length, 1);
  assert.deepEqual(placed(harnessed.events), []);

  await harnessed.browser.stop();
});

test('a reading that names the same process more than once is asked about once', async () => {
  for (const reading of [[PID, PID], Array.from({ length: 9 }, () => PID)]) {
    const harnessed = harness({}, { portPids: () => reading });
    await harnessed.withPage(page => page.click({ ref: 1 }));

    assert.equal(profileCalls(harnessed).length, 1, 'a legal repeat is folded before the helper is asked');
    assert.deepEqual(profileCalls(harnessed)[0].args, { expected: 'P', pids: [PID] });
    assert.deepEqual(contentCalls(harnessed).map(one => one.args.pid), [PID]);
    assert.equal(presses(harnessed.sent).length, 1);

    await harnessed.browser.stop();
  }
});

test('the tab viewport itself reads cleanly and says what it saw', async () => {
  const { reading, sent, watching } = await read({});

  assert.equal(reading.ok, true);
  if (!reading.ok) return;
  assert.equal(reading.viewport.innerWidthCss, 800);
  assert.equal(reading.viewport.innerHeightCss, 560);
  assert.equal(reading.viewport.rootClientWidthCss, 785);
  assert.equal(reading.viewport.cdpLayoutWidthCss, 800);
  assert.equal(reading.viewport.cdpVisualScale, 1);
  assert.equal(reading.viewport.cdpVisualOffsetX, 0);
  assert.equal(reading.viewport.cdpVisualOffsetY, 0);
  assert.ok(reading.evidence.some(line => line.includes('隔离世界')));
  assert.equal(witnessReads(sent)[0].params.uniqueContextId, 'u-1');
  assert.equal(witnessReads(sent)[0].params.contextId, undefined);
  assert.equal(count(sent, 'Runtime.disable'), 1);
  assert.equal(count(sent, 'Page.getFrameTree'), 2);
  assert.equal(watching, 0);
});

test('an announcement about another world does not put the wait to sleep', async () => {
  const sent: Sent[] = [];
  const fake = fakeCdp({ announce: null }, sent);
  const started = Date.now();
  const reading = readTabViewport(fake.cdp, CANDIDATE, { browserPids: async () => [PID] });

  // The read now holds the id of a world it was handed and waits for the browser to name that world on this same socket.
  await until(() => sent.some(one => one.method === 'Page.createIsolatedWorld'));
  await pause(10);

  // Several announcements that have nothing to do with this read arrive first — other frames, another world name, a
  // destroyed world, and the same numeric id announced for a different frame. None of them can take the one wake the read
  // is waiting on: the wait has to be armed again after each, not left asleep until its timer runs out.
  for (const one of [
    { created: { id: 9, uniqueId: 'u-other', frameId: 'F2' } },
    { created: { id: 10, uniqueId: 'u-named', name: 'main' } },
    { destroyed: { id: 77, uniqueId: 'u-ghost' } },
    { created: { id: 3, uniqueId: 'u-frame2', frameId: 'F2' } },
  ] as Announce[]) {
    fake.say(one);
    await pause(5);
  }
  // The world this read is waiting for — this id, this frame, this world name — is announced afterwards and has to wake it
  // at once.
  fake.say({ created: { id: 3, uniqueId: 'u-1' } });

  const answer = await reading;
  const elapsed = Date.now() - started;
  assert.equal(answer.ok, true, 'the relevant announcement still wakes the read');
  assert.ok(elapsed < 1_900, `woken by the announcement, not by the two-second timer (took ${elapsed} ms)`);
  if (!answer.ok) return;
  assert.equal(answer.viewport.innerWidthCss, 800);
  assert.equal(witnessReads(sent)[0].params.uniqueContextId, 'u-1', 'the world that was announced is the one that was read');
  assert.equal(count(sent, 'Runtime.disable'), 1, 'runtime is switched off again once the read is done');
  assert.equal(fake.watching(), 0, 'no listener is left behind');

  // Nothing said after the read can reach it: the listener is gone and the wait is settled, so the cleanup is not just
  // the listener being dropped but the whole wait being over.
  fake.say({ created: { id: 3, uniqueId: 'u-1' } });
  fake.say({ cleared: true });
  await pause(20);
  assert.equal(fake.watching(), 0);
});

test('a world the browser never names is refused, and the wait is bounded', async () => {
  const { reading, watching } = await read({ announce: null });
  assert.equal(reading.ok, false);
  if (reading.ok) return;
  assert.match(reading.reason, /没有正式登记/);
  assert.equal(watching, 0);
});

test('a world named without a unique id is refused', async () => {
  const { reading, sent, watching } = await read({ announce: [{ created: { id: 3, uniqueId: null } }] });
  assert.equal(reading.ok, false);
  assert.equal(witnessReads(sent).length, 0, 'nothing is read in a world the browser did not name');
  assert.equal(watching, 0, 'the listener is taken down when the bounded wait ends');
});

test('a world announced in another frame, or under another name, is refused', async () => {
  const other = await read({ announce: [{ created: { id: 3, frameId: 'F2' } }] });
  assert.equal(other.reading.ok, false);
  assert.equal(other.watching, 0);
  const named = await read({ announce: [{ created: { id: 3, name: 'main' } }] });
  assert.equal(named.reading.ok, false);
  assert.equal(named.watching, 0);
});

test('a world destroyed before the read is refused', async () => {
  const { reading, watching } = await read({ announce: [{ created: { id: 3 } }, { destroyed: { id: 3, uniqueId: 'u-1' } }] });
  assert.equal(reading.ok, false);
  assert.equal(watching, 0, 'the listener is taken down when the wait ends on a destroyed world');
});

test('a cleared document takes the world it announced with it', async () => {
  // The numeric id alone is never enough: a cleared document says every world that was alive is gone, so the world this
  // read just created cannot be handed to whoever now holds that number.
  const { reading, sent, watching } = await read({ announce: [{ created: { id: 3 } }, { cleared: true }] });
  assert.equal(reading.ok, false);
  assert.equal(witnessReads(sent).length, 0);
  assert.equal(watching, 0, 'the listener is taken down when the wait ends on a cleared document');
});

test('a reused numeric id only ever accepts the world announced with it', async () => {
  const { reading, sent, watching } = await read({
    announce: [{ created: { id: 3, uniqueId: 'u-old' } }, { cleared: true }, { created: { id: 3, uniqueId: 'u-new' } }],
  });
  assert.equal(reading.ok, true);
  const reads = witnessReads(sent);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].params.uniqueContextId, 'u-new');
  assert.notEqual(reads[0].params.uniqueContextId, 'u-old');
  assert.equal(watching, 0);
});

test('a hidden tab is refused', async () => {
  const { reading } = await read({ visibility: 'hidden' });
  assert.equal(reading.ok, false);
  if (reading.ok) return;
  assert.match(reading.reason, /不可见/);
});

test('a document replaced while it is being read is refused', async () => {
  const { reading } = await read({ loader: 'L1', loaderAfter: 'L2' });
  assert.equal(reading.ok, false);
  if (reading.ok) return;
  assert.match(reading.reason, /换了一份文档/);
});

test('a tab whose window the browser will not name is refused', async () => {
  const { reading } = await read({ windowId: null });
  assert.equal(reading.ok, false);
  if (reading.ok) return;
  assert.match(reading.reason, /哪个窗口/);
});

test('a pinch-zoomed tab is refused, and a plainly scrolled one is not', async () => {
  const scrolled = await read({ visual: { pageY: 500 } });
  assert.equal(scrolled.reading.ok, true, 'scrolling the document does not move the visual viewport');

  const pinched = await read({ visual: { offsetY: 12 } });
  assert.equal(pinched.reading.ok, false, 'a visual viewport offset leaves the CSS viewport unproven');
});

test('a classic scrollbar is read as the tab\'s own viewport, not as a mismatch', async () => {
  const { reading } = await read({ inner: [800, 560], root: [785, 560], layout: [800, 560] });
  assert.equal(reading.ok, true);
  if (!reading.ok) return;
  assert.equal(reading.viewport.rootClientWidthCss, 785);
  assert.equal(reading.viewport.innerWidthCss, 800);
});

test('a tampered realm is refused', async () => {
  const { reading, sent } = await read({ realmIntact: false });
  assert.equal(reading.ok, false);
  assert.equal(witnessReads(sent).length, 1, 'the read happened, and its answer was rejected');
});
