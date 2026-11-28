/**
 * The native gateway, without a host: a fake tool service, a fake agent registry and a fake computer runtime, so the
 * identity checks, the image conversion and the registration lifecycle can all be exercised offline.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  agentKey,
  installNativeGateway,
  LIFETIME_SEQUENCE_SLOT,
  NATIVE_OUTPUT_SCHEMA,
  NativeGatewayError,
  type NativeAgent,
  type NativeAgentPaths,
  type NativeComputer,
  type NativeGatewayContext,
  type NativeGatewayOptions,
  type NativeModePatch,
  type NativeMultiMouseRuntime,
  type NativeRuntimeHooks,
  type NativeToolValue,
  type TrustedCallerContext,
} from '../src/native-tools.ts';
import type { ActionActor, ActionEvent, ToolResult, ToolSpec } from '../src/tool.ts';
import type { Image } from '../src/shared/image.ts';

interface DefinitionLike {
  name: string;
  description: string;
  parameters: unknown;
  output: { schema: unknown; render(args: unknown, value: unknown): Array<Record<string, unknown>> };
  execute(args: unknown, exec: unknown): Promise<NativeToolValue>;
  isConcurrencySafe?: boolean;
}

interface Registration {
  agent: NativeAgent;
  definition: DefinitionLike;
  disposed: boolean;
}

interface CallLog {
  agent: NativeAgent;
  name: string;
  args: unknown;
  signal: AbortSignal;
  caller: TrustedCallerContext | undefined;
}

interface SavedImage {
  data: Uint8Array;
  mediaType: string;
  name?: string;
}

function toolSpec(name: string): ToolSpec {
  return {
    name,
    description: 'runs ' + name,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
    async execute() {
      return { text: name + ' done' };
    },
  };
}

class FakeHost {
  readonly agents = new Map<string, NativeAgent>();
  readonly roots = new Map<NativeAgent, NativeAgent>();
  readonly registrations: Registration[] = [];
  readonly calls: CallLog[] = [];
  readonly saved: SavedImage[] = [];
  readonly stops: string[] = [];
  readonly halts: string[] = [];
  readonly releases: string[] = [];
  readonly hooks = new Map<string, NativeRuntimeHooks>();
  readonly modes: Array<[string, string]> = [];
  readonly inits: string[] = [];
  readonly computers = new Map<string, FakeComputer>();
  readonly paths = new Map<string, NativeAgentPaths>();
  readonly specs = new Map<string, ToolSpec[]>();
  results = new Map<string, (agent: NativeAgent, name: string, args: unknown) => ToolResult>();
  private readonly listeners = new Map<string, Array<(payload: { agent: NativeAgent }) => void | Promise<void>>>();
  attachmentsAvailable = true;

  readonly ctx: NativeGatewayContext = {
    agents: {
      get: id => this.agents.get(id),
      list: () => [...this.agents.values()],
    },
    subagents: {
      // The real manager resolves a delegated child only after it publishes residency. A fake agent with no
      // mapping and a subagent header is therefore "created before the activation exists": rootOf must throw,
      // never fall back to the child itself (that would invent a root identity).
      rootOf: agent => {
        const known = this.roots.get(agent);
        if (known) return known;
        const header = agent.session?.header as { origin?: unknown } | undefined;
        if (header?.origin === 'subagent') {
          const error = new Error('agent has no active runtime owner');
          (error as Error & { code?: string }).code = 'UNAUTHORIZED';
          throw error;
        }
        return agent;
      },
    },
    get: name => (name === 'attachments' && this.attachmentsAvailable ? this.attachmentStore() : undefined),
    on: (event, listener) => {
      const list = this.listeners.get(event) ?? [];
      const entry = listener;
      list.push(entry);
      this.listeners.set(event, list);
      return () => {
        const index = list.indexOf(entry);
        if (index >= 0) list.splice(index, 1);
      };
    },
  };

  attachmentStore(): { saveImage(input: SavedImage): Promise<Record<string, unknown>> } {
    return {
      saveImage: async input => {
        this.saved.push(input);
        return { attachmentId: 'att-' + this.saved.length, mediaType: input.mediaType, bytes: input.data.byteLength, width: 3, height: 2, name: input.name };
      },
    };
  }

  addAgent(id: string, header: Record<string, unknown> = { delegationDepth: 0 }, root?: NativeAgent): NativeAgent {
    const tools = {
      register: (definition: unknown): (() => void) => {
        const registration: Registration = { agent, definition: definition as DefinitionLike, disposed: false };
        this.registrations.push(registration);
        return () => {
          registration.disposed = true;
        };
      },
    };
    const agent: NativeAgent = { id, ctx: { tools }, session: { header: { id, ...header } } };
    this.agents.set(id, agent);
    this.specs.set(id, [toolSpec('computer_use')]);
    if (root) this.roots.set(agent, root);
    return agent;
  }

  factory(acceptsCaller = true): (paths: NativeAgentPaths, agent: NativeAgent, hooks: NativeRuntimeHooks) => NativeComputer {
    return (paths, agent, hooks) => {
      this.paths.set(agent.id, paths);
      this.hooks.set(agent.id, hooks);
      const computer = new FakeComputer(this, agent);
      computer.acceptsCaller = acceptsCaller;
      this.computers.set(agent.id, computer);
      return computer;
    };
  }

  async emit(event: string, payload: { agent: NativeAgent }): Promise<void> {
    for (const listener of [...(this.listeners.get(event) ?? [])]) await listener(payload);
  }

  definitionOf(agent: NativeAgent, name: string): DefinitionLike {
    const found = this.registrations.filter(entry => entry.agent === agent && !entry.disposed && entry.definition.name === name).at(-1);
    if (!found) throw new Error('no live registration of "' + name + '" for ' + agent.id);
    return found.definition;
  }

  live(agent: NativeAgent): string[] {
    return this.registrations.filter(entry => entry.agent === agent && !entry.disposed).map(entry => entry.definition.name);
  }
}

class FakeComputer implements NativeComputer {
  acceptsCaller = true;
  private readonly host: FakeHost;
  private readonly agent: NativeAgent;

  constructor(host: FakeHost, agent: NativeAgent) {
    this.host = host;
    this.agent = agent;
  }

  tools(): ToolSpec[] {
    return this.host.specs.get(this.agent.id) ?? [];
  }

  async call(name: string, args: unknown, signal: AbortSignal, caller?: TrustedCallerContext): Promise<ToolResult> {
    this.host.calls.push({ agent: this.agent, name, args, signal, caller });
    const result = this.host.results.get(this.agent.id);
    return result ? result(this.agent, name, args) : { text: name + ' done' };
  }

  stop(): void {
    this.host.stops.push(this.agent.id);
  }

  halt(): void {
    this.host.halts.push(this.agent.id);
  }

  release(): void {
    this.host.releases.push(this.agent.id);
  }

  setDesktopMode(mode: string): void {
    this.host.modes.push([this.agent.id, mode]);
  }

  autoInit(): void {
    this.host.inits.push(this.agent.id);
  }
}

function install(host: FakeHost, options: Partial<NativeGatewayOptions> = {}) {
  return installNativeGateway(host.ctx, {
    dataRoot: 'C:\\gateway-data',
    createComputer: host.factory(),
    log() {},
    modeFile: false,
    stopFile: false,
    multiMouse: false,
    ...options,
  });
}

function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function aborting(reason = 'test cancel'): AbortController {
  const controller = new AbortController();
  controller.abort(new Error(reason));
  return controller;
}

function imageResult(image: Partial<Image> = {}): ToolResult {
  return { text: 'picture taken', images: [{ data: Buffer.from([1, 2, 3]), mediaType: 'image/png', caption: '屏幕', ...image }] };
}

test('registers each live agent tool set on that agent own scoped tool service', async () => {
  const host = new FakeHost();
  const gateway = install(host);
  const root = host.addAgent('session-root');
  host.specs.set('session-root', [toolSpec('computer_use'), toolSpec('page_open')]);
  await host.emit('agent/created', { agent: root });

  assert.deepEqual(host.live(root), ['computer_use', 'page_open']);
  const definition = host.definitionOf(root, 'computer_use');
  assert.equal(definition.description, 'runs computer_use');
  assert.deepEqual(definition.parameters, host.specs.get('session-root')![0]!.inputSchema);
  assert.equal(definition.output.schema, NATIVE_OUTPUT_SCHEMA);
  assert.equal(definition.isConcurrencySafe, undefined, 'desktop calls must stay serialized');
  assert.equal(typeof definition.output.render, 'function');
  assert.equal(gateway.size(), 1);
  assert.deepEqual(gateway.toolNames('session-root'), ['computer_use', 'page_open']);
  gateway.dispose();
});

test('adopts agents that already existed when the plugin loaded', async () => {
  const host = new FakeHost();
  const root = host.addAgent('session-old');
  const gateway = install(host);
  await settle();
  assert.deepEqual(host.live(root), ['computer_use']);
  assert.equal(gateway.size(), 1);
  gateway.dispose();
});

test('refuses an agent whose runtime would ignore the trusted caller', async () => {
  const host = new FakeHost();
  const logs: string[] = [];
  const root = host.addAgent('session-untrusted');
  const refuseFactory = host.factory(false);
  let builds = 0;
  const gateway = install(host, {
    createComputer: (paths, agent, hooks) => {
      builds += 1;
      return refuseFactory(paths, agent, hooks);
    },
    log: message => logs.push(message),
  });
  await host.emit('agent/created', { agent: root });

  assert.deepEqual(host.live(root), [], 'no tool may be registered for a runtime that drops the caller');
  assert.equal(gateway.size(), 0);
  assert.equal(builds, 1, 'the adoption sweep and the created event build one runtime, not two');
  assert.deepEqual(host.stops, ['session-untrusted'], 'the refused runtime is shut down, not kept around');
  assert.ok(
    logs.some(message => /does not accept a trusted caller/.test(message)),
    'the refusal names the missing capability: ' + logs.join(' | '),
  );
  gateway.dispose();
});

test('a refused object does not poison a fresh lifetime of the same id', async () => {
  const host = new FakeHost();
  const bad = host.addAgent('session-dup');
  const acceptFactory = host.factory(true);
  const refuseFactory = host.factory(false);
  const gateway = install(host, {
    // One factory that refuses only the object handed to it, like a runtime type that never learns the caller.
    createComputer: (paths, agent, hooks) => (agent === bad ? refuseFactory : acceptFactory)(paths, agent, hooks),
    log() {},
  });
  await host.emit('agent/created', { agent: bad });
  assert.deepEqual(host.live(bad), [], 'the refused lifetime registers nothing');

  // A brand-new live object for the same id is a fresh lifetime with its own runtime: the memo is per object, not per id.
  const fresh = host.addAgent('session-dup');
  await host.emit('agent/created', { agent: fresh });
  assert.deepEqual(host.live(fresh), ['computer_use'], 'a new lifetime of the same id is not refused by the old object');
  assert.deepEqual(host.stops, ['session-dup'], 'only the refused runtime was stopped, the new one is still live');

  gateway.dispose();
});

test('a file picture becomes a stored attachment and renders as an image block', async () => {
  const host = new FakeHost();
  const gateway = install(host);
  const root = host.addAgent('session-shot');
  host.specs.set('session-shot', [toolSpec('page_shot')]);
  await host.emit('agent/created', { agent: root });
  host.results.set('session-shot', () => imageResult());

  const definition = host.definitionOf(root, 'page_shot');
  const value = await definition.execute({ text: 'now' }, { agent: root, signal: new AbortController().signal });

  assert.deepEqual(value, {
    text: 'picture taken',
    images: [{ attachmentId: 'att-1', mediaType: 'image/png', bytes: 3, width: 3, height: 2, name: 'page_shot-1.png', caption: '屏幕' }],
  });
  assert.equal(host.saved.length, 1);
  assert.equal(host.saved[0]!.name, 'page_shot-1.png');
  assert.equal(host.saved[0]!.data.byteLength, 3);

  const blocks = definition.output.render({ text: 'now' }, value);
  assert.deepEqual(blocks, [
    { type: 'text', text: 'picture taken' },
    { type: 'text', text: '屏幕' },
    { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 3, width: 3, height: 2, name: 'page_shot-1.png' } },
  ]);
  gateway.dispose();
});

test('a picture with nowhere to store it fails closed instead of dropping it', async () => {
  const host = new FakeHost();
  host.attachmentsAvailable = false;
  const gateway = install(host);
  const root = host.addAgent('session-noshot');
  host.specs.set('session-noshot', [toolSpec('page_shot')]);
  await host.emit('agent/created', { agent: root });
  host.results.set('session-noshot', () => imageResult());
  const definition = host.definitionOf(root, 'page_shot');
  await assert.rejects(definition.execute({}, { agent: root, signal: new AbortController().signal }), (error: unknown) => {
    assert.ok(error instanceof NativeGatewayError);
    assert.equal(error.code, 'TOOL_CONTEXT_UNAVAILABLE');
    assert.match(error.message, /cannot store images/);
    return true;
  });
  gateway.dispose();
});

test('passes the proven caller and the host cancellation signal to the runtime', async () => {
  const host = new FakeHost();
  const gateway = install(host);
  const parent = host.addAgent('session-parent');
  const child = host.addAgent('session-child', { delegationDepth: 1 }, parent);
  await host.emit('agent/created', { agent: parent });
  await host.emit('agent/created', { agent: child });
  const controller = new AbortController();
  await host.definitionOf(child, 'computer_use').execute({}, { agent: child, signal: controller.signal, callId: 'call-7' });
  const call = host.calls.at(-1)!;
  assert.equal(call.agent, child);
  assert.equal(call.signal, controller.signal);
  assert.ok(call.caller);
  assert.equal(call.caller!.identity, 'trusted');
  assert.equal(call.caller!.agentId, 'session-child');
  assert.equal(call.caller!.rootAgentId, 'session-parent');
  assert.equal(call.caller!.depth, 1);
  assert.equal(typeof call.caller!.lifetime, 'number');
  assert.equal(call.caller!.callId, 'call-7');
  assert.equal(call.caller!.sessionId, 'session-child');
  assert.ok(Object.isFrozen(call.caller));

  // The lifetime number identifies this runtime; a different agent's runtime gets a different one.
  await host.definitionOf(parent, 'computer_use').execute({}, { agent: parent, signal: controller.signal });
  const other = host.calls.at(-1)!;
  assert.equal(typeof other.caller!.lifetime, 'number');
  assert.notEqual(other.caller!.lifetime, call.caller!.lifetime);
  gateway.dispose();
});

test('refuses a call whose agent is not the live agent the runtime belongs to', async () => {
  const host = new FakeHost();
  const gateway = install(host);
  const root = host.addAgent('session-root');
  await host.emit('agent/created', { agent: root });
  const definition = host.definitionOf(root, 'computer_use');

  const impostor: NativeAgent = { id: 'session-root' };
  host.agents.set('session-root', impostor);

  await assert.rejects(definition.execute({}, { agent: root, signal: new AbortController().signal }), (error: unknown) => {
    assert.ok(error instanceof NativeGatewayError);
    assert.match(error.message, /not the live agent/);
    return true;
  });
  assert.equal(host.calls.length, 0, 'a failed identity check never reaches the desktop');
  gateway.dispose();
});

test('refuses calls with no agent, no signal or an unregistered root', async () => {
  const host = new FakeHost();
  const gateway = install(host);
  const root = host.addAgent('session-root');
  await host.emit('agent/created', { agent: root });
  const definition = host.definitionOf(root, 'computer_use');

  await assert.rejects(definition.execute({}, { signal: new AbortController().signal }), (error: unknown) => {
    assert.ok(error instanceof NativeGatewayError);
    assert.equal(error.code, 'TOOL_CONTEXT_UNAVAILABLE');
    return true;
  });
  await assert.rejects(definition.execute({}, { agent: root }), (error: unknown) => {
    assert.ok(error instanceof NativeGatewayError);
    assert.match(error.message, /cancellation signal/);
    return true;
  });
  const outsider: NativeAgent = { id: 'session-elsewhere' };
  host.roots.set(root, outsider);
  await assert.rejects(definition.execute({}, { agent: root, signal: new AbortController().signal }), (error: unknown) => {
    assert.ok(error instanceof NativeGatewayError);
    assert.match(error.message, /root agent is not live/);
    return true;
  });
  assert.equal(host.calls.length, 0);
  gateway.dispose();
});

test('refuses a call after the agent was disposed', async () => {
  const host = new FakeHost();
  const gateway = install(host);
  const root = host.addAgent('session-root');
  await host.emit('agent/created', { agent: root });
  const definition = host.definitionOf(root, 'computer_use');

  await host.emit('agent/disposed', { agent: root });
  assert.equal(host.stops.at(-1), 'session-root');
  assert.deepEqual(host.live(root), []);

  await assert.rejects(definition.execute({}, { agent: root, signal: new AbortController().signal }), (error: unknown) => {
    assert.ok(error instanceof NativeGatewayError);
    assert.match(error.message, /disposed/);
    return true;
  });
  assert.equal(host.calls.length, 0);
  gateway.dispose();
});

test('refuses a tool the agent no longer has, and resyncs the registration list', async () => {
  const host = new FakeHost();
  const gateway = install(host);
  const root = host.addAgent('session-root');
  host.specs.set('session-root', [toolSpec('computer_use'), toolSpec('desktop')]);
  await host.emit('agent/created', { agent: root });
  assert.deepEqual(host.live(root), ['computer_use', 'desktop']);
  const desktop = host.definitionOf(root, 'desktop');

  host.specs.set('session-root', [toolSpec('computer_use')]);
  await host.definitionOf(root, 'computer_use').execute({}, { agent: root, signal: new AbortController().signal });
  assert.deepEqual(host.live(root), ['computer_use']);

  await assert.rejects(desktop.execute({}, { agent: root, signal: new AbortController().signal }), (error: unknown) => {
    assert.ok(error instanceof NativeGatewayError);
    assert.equal(error.code, 'TOOL_UNAVAILABLE');
    return true;
  });
  assert.equal(host.calls.length, 1, 'the disabled tool never reached the desktop');
  gateway.dispose();
});

test('an aborted call never reaches the desktop', async () => {
  const host = new FakeHost();
  const gateway = install(host);
  const root = host.addAgent('session-root');
  await host.emit('agent/created', { agent: root });
  const controller = aborting();
  await assert.rejects(host.definitionOf(root, 'computer_use').execute({}, { agent: root, signal: controller.signal }), /test cancel/);
  assert.equal(host.calls.length, 0);
  gateway.dispose();
});

test('every agent gets its own browser profile and log under one shared data directory', async () => {
  const host = new FakeHost();
  const gateway = install(host);
  const first = host.addAgent('session-one');
  const second = host.addAgent('session-two');
  await host.emit('agent/created', { agent: first });
  await host.emit('agent/created', { agent: second });

  const one = host.paths.get('session-one')!;
  const two = host.paths.get('session-two')!;
  assert.equal(one.dataDir, 'C:\\gateway-data');
  assert.equal(two.dataDir, 'C:\\gateway-data');
  assert.notEqual(one.profileDir, two.profileDir);
  // A profile of its own, inside this gateway instance's namespace and in a directory of its own lifetime.
  assert.match(one.profileDir, /^C:\\gateway-data\\browser\\gw-[0-9a-f]{12}\\session-one-l\d+$/);
  assert.match(two.profileDir, /^C:\\gateway-data\\browser\\gw-[0-9a-f]{12}\\session-two-l\d+$/);
  const namespaceOf = (dir: string) => dir.split('\\')[3];
  assert.equal(namespaceOf(one.profileDir), namespaceOf(two.profileDir), 'one namespace per gateway instance');
  assert.match(one.messagesPath!, /^C:\\gateway-data\\agents\\gw-[0-9a-f]{12}\\session-one-l\d+\\messages\.jsonl$/);
  assert.equal(namespaceOf(one.messagesPath!), namespaceOf(one.profileDir), 'the log sits in the same namespace');
  assert.equal(one.proceduresDir, 'C:\\gateway-data\\procedures');
  gateway.dispose();
});

test('turning logging or procedures off is honoured in the paths', async () => {
  const host = new FakeHost();
  const gateway = install(host, { messages: false, proceduresDir: false });
  const root = host.addAgent('session-quiet');
  await host.emit('agent/created', { agent: root });
  const paths = host.paths.get('session-quiet')!;
  assert.equal(paths.messagesPath, null);
  assert.equal(paths.proceduresDir, null);
  gateway.dispose();
});

test('dispose unwinds every registration, stops every runtime and stops adopting agents', async () => {
  const host = new FakeHost();
  const gateway = install(host);
  const root = host.addAgent('session-root');
  await host.emit('agent/created', { agent: root });
  gateway.dispose();

  assert.deepEqual(host.live(root), []);
  assert.deepEqual(host.stops, ['session-root']);
  assert.equal(gateway.size(), 0);

  const late = host.addAgent('session-late');
  await host.emit('agent/created', { agent: late });
  assert.deepEqual(host.live(late), []);
  assert.equal(gateway.size(), 0);
});

test('an asynchronous stop is awaited and a failing one is logged, never left dangling', async () => {
  const host = new FakeHost();
  const notes: string[] = [];
  const order: string[] = [];
  let release: (() => void) | undefined;
  const gateway = install(host, {
    log: text => notes.push(text),
    createComputer: (paths, agent, hooks) => {
      const computer = new FakeComputer(host, agent);
      computer.acceptsCaller = true;
      host.paths.set(agent.id, paths);
      host.hooks.set(agent.id, hooks);
      const stop = computer.stop.bind(computer);
      computer.stop = () => {
        stop();
        order.push('stop()');
        return new Promise<void>((resolve, reject) => {
          release = () => {
            order.push('stopped');
            reject(new Error('stop failed'));
            resolve();
          };
        });
      };
      return computer;
    },
  });
  const root = host.addAgent('session-slow-stop');
  await host.emit('agent/created', { agent: root });

  const done = gateway.dispose();
  order.push('after dispose()');
  assert.deepEqual(order, ['stop()', 'after dispose()'], 'the stop is started before dispose returns');
  release!();
  await done;
  assert.equal(order.at(-1), 'stopped', 'the returned promise settles only after the runtime finished stopping');
  assert.equal(notes.some(text => /stop failed/.test(text)), true, 'the failure is reported through the log');
});

test('the global desktop mode reaches current and future runtimes', async () => {
  const host = new FakeHost();
  const gateway = install(host, { desktopMode: 'background' });
  const first = host.addAgent('session-one');
  await host.emit('agent/created', { agent: first });
  gateway.setDesktopMode('foreground');
  const second = host.addAgent('session-two');
  await host.emit('agent/created', { agent: second });

  assert.deepEqual(host.modes, [
    ['session-one', 'background'],
    ['session-one', 'foreground'],
    ['session-two', 'foreground'],
  ]);
  gateway.dispose();
});

test('agent keys stay filesystem safe without collisions', () => {
  assert.equal(agentKey('session-1a2b'), 'session-1a2b');
  const weird = agentKey('会话/../x');
  assert.match(weird, /^agent-[0-9a-f]+$/);
  assert.notEqual(weird, agentKey('会话/../y'));
});

test('the startup scan runs once, on a runtime of its own, when asked', async () => {
  const host = new FakeHost();
  const gateway = install(host, { autoInit: true });
  await settle();
  assert.deepEqual(host.inits, ['_gateway']);
  assert.match(host.paths.get('_gateway')?.profileDir ?? '', /^C:\\gateway-data\\browser\\gw-[0-9a-f]{12}\\_gateway$/);
  gateway.dispose();
  assert.deepEqual(host.stops, ['_gateway']);
});

test('no startup scan happens unless asked', async () => {
  const host = new FakeHost();
  const gateway = install(host);
  await settle();
  assert.deepEqual(host.inits, []);
  gateway.dispose();
});

test('the native transport mounts the gateway without the MCP bridge or the probe', async () => {
  const host = new FakeHost();
  const mounted: unknown[] = [];
  const disposers: Array<() => unknown> = [];
  const ctx = {
    ...host.ctx,
    plugin(plugin: unknown) {
      mounted.push(plugin);
    },
    effect(effect: () => (() => void) | void) {
      const dispose = effect();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  };
  const { apply } = await import('../src/plugin.ts');
  await apply(ctx as never, {
    toolTransport: 'native',
    dataDir: scratch('plugin-transport'),
    autoInit: false,
    modeFile: false,
    stopFile: false,
    multiMouse: false,
  });
  assert.deepEqual(mounted, []);

  const root = host.addAgent('session-native');
  await host.emit('agent/created', { agent: root });
  assert.ok(host.live(root).includes('computer_use'));

  // Await the real gateway's disposal so the runtime this test built is fully stopped before the process moves on.
  for (const dispose of [...disposers].reverse()) await dispose();
  assert.deepEqual(host.live(root), []);
});

function scratch(name: string): string {
  return mkdtempSync(join(tmpdir(), 'ecu-native-' + name + '-'));
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function lifetimeOf(path: string | null): number {
  const match = /-l(\d+)$/.exec(path ?? '');
  if (!match) assert.fail('a runtime directory carries the lifetime it was opened for: ' + String(path));
  return Number(match[1]);
}

/**
 * The lifetime sequence lives on globalThis under a registered symbol, so a test that replaces it must put back exactly
 * what it found: an own property that existed (even one holding undefined) is restored by value, and only a slot that
 * was genuinely absent is deleted again.
 */
const SLOT_BAG = globalThis as unknown as Record<symbol, unknown>;

async function withLifetimeSlot(value: unknown, work: () => Promise<void>): Promise<void> {
  const had = Object.hasOwn(globalThis, LIFETIME_SEQUENCE_SLOT);
  const previous = SLOT_BAG[LIFETIME_SEQUENCE_SLOT];
  SLOT_BAG[LIFETIME_SEQUENCE_SLOT] = value;
  try {
    await work();
  } finally {
    if (had) SLOT_BAG[LIFETIME_SEQUENCE_SLOT] = previous;
    else Reflect.deleteProperty(globalThis, LIFETIME_SEQUENCE_SLOT);
  }
}

async function withoutLifetimeSlot(work: () => Promise<void>): Promise<void> {
  const had = Object.hasOwn(globalThis, LIFETIME_SEQUENCE_SLOT);
  const previous = SLOT_BAG[LIFETIME_SEQUENCE_SLOT];
  Reflect.deleteProperty(globalThis, LIFETIME_SEQUENCE_SLOT);
  try {
    await work();
  } finally {
    if (had) SLOT_BAG[LIFETIME_SEQUENCE_SLOT] = previous;
    else Reflect.deleteProperty(globalThis, LIFETIME_SEQUENCE_SLOT);
  }
}

/** The part of plugin/lib/multi-mouse-runtime.mjs this file drives directly. */
interface RealMultiMouseRuntime {
  publishMode(rootId: string, patch: { enabled?: boolean; task?: string }): unknown;
  getMode(rootId: string): { rootId: string; enabled: boolean; task: string; epoch: number };
  publishAction(event: ActionEvent): unknown;
  publishActorLive(actor: ActionActor): boolean;
  publishActorDisposed(actor: ActionActor): boolean;
  subscribe(type: string, listener: (payload: unknown) => void): () => void;
  dispose(): void;
}

function actorFromAnnouncement(payload: unknown): ActionActor {
  const event = payload as { rootId?: unknown; agentId?: unknown; depth?: unknown; lifetime?: unknown };
  return {
    trust: 'trusted',
    agentId: String(event.agentId),
    rootAgentId: String(event.rootId),
    depth: Number(event.depth ?? 0),
    lifetime: Number(event.lifetime),
  };
}

function actorOfAgent(actors: ActionActor[], agentId: string): ActionActor {
  const found = actors.filter(actor => actor.agentId === agentId).at(-1);
  if (!found) assert.fail('the overlay never heard of ' + agentId);
  return found;
}

function realAction(actor: ActionActor, requestId: string, seq: number): ActionEvent {
  return {
    kind: 'desktop-action',
    requestId,
    seq,
    phase: 'executing',
    actor,
    area: 'global',
    action: { kind: 'click', button: 'left' },
    space: 'physical',
    sampleMs: 12,
    at: 1_700_000_000_000,
  };
}

async function realOverlay(name: string): Promise<{ runtime: RealMultiMouseRuntime; dir: string }> {
  // 插件是纯 .mjs，这里按 src/native-tools.ts 的写法用 URL specifier 动态载入：静态 import 会让 tsc 报 TS7016。
  const specifier = new URL('../plugin/lib/multi-mouse-runtime.mjs', import.meta.url).href;
  const loaded = await import(specifier) as {
    createMultiMouseRuntime: (options: { dataDir: string }) => RealMultiMouseRuntime;
  };
  const dir = scratch(name);
  return { runtime: loaded.createMultiMouseRuntime({ dataDir: dir }), dir };
}

class FakeMultiMouse {
  readonly actions: ActionEvent[] = [];
  readonly patches: Array<[string, NativeModePatch]> = [];
  readonly released: ActionActor[] = [];
  readonly lives: ActionActor[] = [];
  disposed = false;
  enabled = true;
  task = '';
  epoch = 1;

  publishAction(event: ActionEvent): void {
    this.actions.push(event);
  }

  publishMode(rootId: string, patch: NativeModePatch): void {
    this.patches.push([rootId, patch]);
    if (typeof patch.enabled === 'boolean') this.enabled = patch.enabled;
    if (typeof patch.task === 'string') this.task = patch.task;
  }

  getMode(rootId: string): { rootId: string; enabled: boolean; task: string; epoch: number } {
    return { rootId, enabled: this.enabled, task: this.task, epoch: this.epoch };
  }

  publishActorLive(actor: ActionActor): boolean {
    this.lives.push(actor);
    return true;
  }

  publishActorDisposed(actor: ActionActor): void {
    this.released.push(actor);
  }

  dispose(): void {
    this.disposed = true;
  }
}

class BumpingMultiMouse extends FakeMultiMouse {
  private level = 1;

  override publishMode(rootId: string, patch: NativeModePatch): void {
    super.publishMode(rootId, patch);
    this.level += 1;
  }

  override getMode(rootId: string): { rootId: string; enabled: boolean; task: string; epoch: number } {
    return { ...super.getMode(rootId), epoch: this.level };
  }
}

function actionEvent(agentId: string, rootAgentId = agentId): ActionEvent {
  return {
    kind: 'desktop-action',
    requestId: 'request-1',
    seq: 1,
    phase: 'executing',
    actor: { trust: 'trusted', agentId, rootAgentId, depth: rootAgentId === agentId ? 0 : 1, lifetime: 1 },
    area: 'global',
    action: { kind: 'click', button: 'left' },
    space: 'physical',
    sampleMs: 12,
    at: 1_700_000_000_000,
  };
}

test('refuses every desktop tool while the user stop sign is up, and releases the runtimes when it goes', async () => {
  const host = new FakeHost();
  const dir = scratch('stop');
  const stopFile = join(dir, 'desktop-stopped');
  writeFileSync(stopFile, '');
  const gateway = install(host, { stopFile, pollMs: 50 });
  try {
    const root = host.addAgent('session-stopped');
    await host.emit('agent/created', { agent: root });
    assert.equal(gateway.halted(), true);
    assert.deepEqual(host.halts, ['session-stopped'], 'the runtime is stopped as soon as it exists');
    const definition = host.definitionOf(root, 'computer_use');
    await assert.rejects(definition.execute({}, { agent: root, signal: new AbortController().signal }), (error: unknown) => {
      assert.ok(error instanceof NativeGatewayError);
      assert.equal(error.code, 'TOOL_STOPPED');
      assert.match(error.message, /用户按了停下/);
      return true;
    });
    assert.equal(host.calls.length, 0, 'nothing reaches the desktop while the user has stopped it');

    rmSync(stopFile);
    await wait(150);
    assert.equal(gateway.halted(), false);
    assert.deepEqual(host.releases, ['session-stopped'], 'the user lifting the stop sign releases the runtime');
    await definition.execute({}, { agent: root, signal: new AbortController().signal });
    assert.equal(host.calls.length, 1);
  } finally {
    gateway.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stop pressed inside one runtime raises the shared stop sign for every agent', async () => {
  const host = new FakeHost();
  const dir = scratch('stop-press');
  const stopFile = join(dir, 'desktop-stopped');
  const gateway = install(host, { stopFile, pollMs: 50 });
  try {
    const root = host.addAgent('session-press');
    await host.emit('agent/created', { agent: root });
    assert.equal(gateway.halted(), false);

    host.hooks.get('session-press')!.onHalt!();
    assert.equal(existsSync(stopFile), true, 'the sign outlives the agent that was stopped');
    assert.equal(gateway.halted(), true);
    assert.deepEqual(host.halts, ['session-press'], 'the runtime that was running is stopped');

    const definition = host.definitionOf(root, 'computer_use');
    await assert.rejects(definition.execute({}, { agent: root, signal: new AbortController().signal }), /用户按了停下/);
    assert.equal(host.calls.length, 0, 'nothing reaches the desktop after the user pressed stop');

    const late = host.addAgent('session-late');
    await host.emit('agent/created', { agent: late });
    assert.ok(host.halts.includes('session-late'), 'an agent that joins later starts stopped too');

    rmSync(stopFile);
    await wait(150);
    assert.equal(gateway.halted(), false);
    await definition.execute({}, { agent: root, signal: new AbortController().signal });
    assert.equal(host.calls.length, 1);
  } finally {
    gateway.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reads the shared desktop-mode file, switches live runtimes and starts new ones in that mode', async () => {
  const host = new FakeHost();
  const dir = scratch('mode');
  const modeFile = join(dir, 'desktop-mode.json');
  writeFileSync(modeFile, JSON.stringify({ desktopMode: 'background' }));
  const gateway = install(host, { modeFile, pollMs: 50 });
  try {
    await wait(150);
    const root = host.addAgent('session-mode');
    await host.emit('agent/created', { agent: root });
    assert.deepEqual(host.modes, [['session-mode', 'background']]);

    writeFileSync(modeFile, JSON.stringify({ desktopMode: 'foreground' }));
    await wait(150);
    assert.deepEqual(host.modes.at(-1), ['session-mode', 'foreground']);

    const later = host.addAgent('session-later');
    await host.emit('agent/created', { agent: later });
    assert.deepEqual(host.modes.at(-1), ['session-later', 'foreground']);

    // A file caught mid-write is ignored rather than resetting the mode.
    writeFileSync(modeFile, '{"desktopMode":');
    await wait(150);
    assert.deepEqual(host.modes.at(-1), ['session-later', 'foreground']);
  } finally {
    gateway.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adds multi_mouse only with the overlay runtime, and forwards the mode with the proven root', async () => {
  const host = new FakeHost();
  const mouse = new FakeMultiMouse();
  const gateway = install(host, { multiMouse: mouse });
  const parent = host.addAgent('session-parent');
  const child = host.addAgent('session-child', { delegationDepth: 1 }, parent);
  await host.emit('agent/created', { agent: parent });
  await host.emit('agent/created', { agent: child });
  assert.ok(host.live(child).includes('multi_mouse'));
  const definition = host.definitionOf(child, 'multi_mouse');
  const parameters = definition.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['enabled', 'task']);
  assert.deepEqual(parameters.required, ['enabled']);

  const value = await definition.execute({ enabled: true, task: '画图' }, { agent: child, signal: new AbortController().signal });
  assert.deepEqual(mouse.patches, [['session-parent', { enabled: true, task: '画图' }]]);
  assert.match(value.text, /多指针显示已打开/);
  assert.match(value.text, /画图/);

  for (const bad of [{ enabled: 'yes' }, { enabled: true, extra: 1 }]) {
    await assert.rejects(definition.execute(bad, { agent: child, signal: new AbortController().signal }), (error: unknown) => {
      assert.ok(error instanceof NativeGatewayError);
      assert.equal(error.code, 'INVALID_ARGUMENT');
      return true;
    });
  }
  assert.equal(mouse.patches.length, 1, 'a rejected argument never reaches the overlay');

  gateway.dispose();
  assert.equal(mouse.disposed, false, 'the overlay owns its runtime; unmounting only stops calling it');
});

test('notices an overlay that leaves the epoch alone when only the task changes', async () => {
  const host = new FakeHost();
  const logs: string[] = [];
  const gateway = install(host, { multiMouse: new FakeMultiMouse(), log: message => logs.push(message) });
  const root = host.addAgent('session-stale');
  await host.emit('agent/created', { agent: root });

  const definition = host.definitionOf(root, 'multi_mouse');
  await definition.execute({ enabled: true, task: '画图' }, { agent: root, signal: new AbortController().signal });
  assert.ok(
    logs.some(message => /did not bump the epoch/.test(message)),
    'a task switch that keeps the epoch is reported: ' + logs.join(' | '),
  );
  gateway.dispose();
});

test('stays quiet when the overlay bumps the epoch for the task switch', async () => {
  const host = new FakeHost();
  const logs: string[] = [];
  const gateway = install(host, { multiMouse: new BumpingMultiMouse(), log: message => logs.push(message) });
  const root = host.addAgent('session-epoch');
  await host.emit('agent/created', { agent: root });

  const definition = host.definitionOf(root, 'multi_mouse');
  const value = await definition.execute({ enabled: true, task: '写文档' }, { agent: root, signal: new AbortController().signal });
  assert.match(value.text, /写文档/);
  assert.ok(!logs.some(message => /did not bump the epoch/.test(message)), logs.join(' | '));
  gateway.dispose();
});

test('without the overlay runtime there is no multi_mouse tool at all', async () => {
  const host = new FakeHost();
  const gateway = install(host, { multiMouse: false });
  const root = host.addAgent('session-plain');
  await host.emit('agent/created', { agent: root });
  assert.ok(!host.live(root).includes('multi_mouse'));
  assert.throws(() => host.definitionOf(root, 'multi_mouse'), /no live registration/);
  gateway.dispose();
});

test('forwards the runtime action events to the overlay with a pinned epoch, and a broken overlay never breaks a call', async () => {
  const host = new FakeHost();
  const mouse = new FakeMultiMouse();
  const gateway = install(host, { multiMouse: mouse });
  const root = host.addAgent('session-action');
  await host.emit('agent/created', { agent: root });
  const hooks = host.hooks.get('session-action');
  assert.ok(hooks);
  assert.equal(typeof hooks!.onAction, 'function');

  const event = actionEvent('session-action');
  hooks!.onAction!(event);
  const published = mouse.actions[0] as (ActionEvent & { epoch?: number }) | undefined;
  assert.ok(published, 'the action reaches the overlay');
  assert.equal(published.kind, 'desktop-action');
  assert.equal(published.requestId, 'request-1');
  assert.equal(published.phase, 'executing');
  assert.deepEqual(published.actor, event.actor, 'the actor is passed through untouched');
  assert.deepEqual(published.action, event.action);
  assert.equal(published.space, 'physical');
  assert.equal(published.sampleMs, 12);
  assert.equal(published.at, 1_700_000_000_000);
  assert.equal(published.epoch, 1, 'the epoch of the root is pinned before the runtime sees the action');

  mouse.publishAction = () => {
    throw new Error('overlay gone');
  };
  assert.doesNotThrow(() => hooks!.onAction!(event));
  assert.equal(host.calls.length, 0);
  gateway.dispose();
});

test('pins the epoch of one action across its phases, even when the task switches mid-flight', async () => {
  const host = new FakeHost();
  const mouse = new FakeMultiMouse();
  const gateway = install(host, { multiMouse: mouse });
  const root = host.addAgent('session-pinned');
  await host.emit('agent/created', { agent: root });
  const hooks = host.hooks.get('session-pinned');
  assert.ok(hooks?.onAction, 'the gateway hands the runtime its action sink');
  const epochOf = (index: number): unknown => (mouse.actions[index] as ActionEvent & { epoch?: number } | undefined)?.epoch;

  hooks.onAction!({ ...actionEvent('session-pinned'), phase: 'queued', seq: 1 });
  // The user switches task while the pointer is still down: the overlay moves on to the next epoch.
  mouse.epoch = 2;
  hooks.onAction!({ ...actionEvent('session-pinned'), phase: 'executing', seq: 2 });
  hooks.onAction!({ ...actionEvent('session-pinned'), phase: 'succeeded', seq: 3, ok: true });

  assert.deepEqual(
    mouse.actions.map(event => event.phase),
    ['queued', 'executing', 'succeeded'],
  );
  assert.deepEqual(
    [epochOf(0), epochOf(1), epochOf(2)],
    [1, 1, 1],
    'an action that started on epoch 1 stays on epoch 1, or it would be drawn as part of the new task',
  );

  hooks.onAction!({ ...actionEvent('session-pinned'), requestId: 'request-2', phase: 'queued', seq: 1 });
  assert.equal(epochOf(3), 2, 'the next action starts on the current epoch');
  gateway.dispose();
});

test('never invents an epoch when the overlay cannot report one', async () => {
  const host = new FakeHost();
  const pushed: ActionEvent[] = [];
  const gateway = install(host, {
    multiMouse: {
      publishAction(event: ActionEvent): void {
        pushed.push(event);
      },
    },
  });
  const root = host.addAgent('session-bare');
  await host.emit('agent/created', { agent: root });
  const event = actionEvent('session-bare');
  host.hooks.get('session-bare')!.onAction!(event);
  assert.deepEqual(pushed, [event], 'without getMode the event is forwarded exactly as it came');
  gateway.dispose();
});

test('releasing an agent runtime fades its pointers through the overlay runtime, not the writer', async () => {
  const host = new FakeHost();
  const mouse = new FakeMultiMouse();
  const gateway = install(host, { multiMouse: mouse });
  const root = host.addAgent('session-pointer');
  await host.emit('agent/created', { agent: root });
  const child = host.addAgent('session-pointer-child', { delegationDepth: 1 }, root);
  await host.emit('agent/created', { agent: child });

  await host.emit('agent/disposed', { agent: child });
  assert.equal(mouse.released.length, 1, 'the disposed agent releases its pointers at once');
  const actor = mouse.released[0]!;
  assert.equal(actor.trust, 'trusted');
  assert.equal(actor.agentId, 'session-pointer-child');
  assert.equal(actor.rootAgentId, 'session-pointer');
  assert.equal(actor.depth, 1);
  assert.equal(typeof actor.lifetime, 'number');
  assert.ok(actor.lifetime > 0);

  gateway.dispose();
  assert.deepEqual(mouse.released.map(entry => entry.agentId).sort(), ['session-pointer', 'session-pointer-child']);
  assert.equal(mouse.disposed, false, 'the gateway never disposes the process-wide runtime');
  assert.deepEqual([...host.stops].sort(), ['session-pointer', 'session-pointer-child']);
});

test('announces every live agent to the overlay and never claims a released one', async () => {
  const host = new FakeHost();
  const mouse = new FakeMultiMouse();
  const gateway = install(host, { multiMouse: mouse });
  const root = host.addAgent('session-live-actor');
  await host.emit('agent/created', { agent: root });
  const child = host.addAgent('session-live-actor-child', { delegationDepth: 1 }, root);
  await host.emit('agent/created', { agent: child });

  assert.deepEqual(mouse.lives.map(actor => actor.agentId).sort(), ['session-live-actor', 'session-live-actor-child']);
  assert.equal(mouse.lives[1]!.rootAgentId, 'session-live-actor');
  assert.equal(mouse.lives[1]!.depth, 1);
  assert.notEqual(mouse.lives[0]!.lifetime, mouse.lives[1]!.lifetime, 'each runtime has its own lifetime');
  gateway.dispose();
  assert.equal(mouse.lives.length, 2, 'disposal never re-announces a dead agent');
});

test('a runtime that refused to announce an agent is never asked to release it', async () => {
  const host = new FakeHost();
  let liveCalls = 0;
  const disposed: ActionActor[] = [];
  const gateway = install(host, {
    multiMouse: {
      publishAction(): void {},
      publishActorLive(): boolean {
        liveCalls += 1;
        return false;
      },
      publishActorDisposed(actor: ActionActor): void {
        disposed.push(actor);
      },
    },
  });
  const root = host.addAgent('session-refused');
  await host.emit('agent/created', { agent: root });
  assert.equal(liveCalls, 1, 'the gateway still offers the agent to the overlay');
  host.specs.set('session-refused', [toolSpec('computer_use')]);
  assert.deepEqual(host.live(root), ['computer_use'], 'the tools are registered all the same');

  await host.emit('agent/disposed', { agent: root });
  assert.deepEqual(disposed, [], 'the overlay never heard of this agent, so there is nothing to release');
  gateway.dispose();
});

test('a runtime that cannot release an actor still unwinds cleanly', async () => {
  const host = new FakeHost();
  const gateway = install(host, { multiMouse: { publishAction(): void {} } });
  const root = host.addAgent('session-quiet');
  await host.emit('agent/created', { agent: root });
  assert.doesNotThrow(() => gateway.dispose());
  assert.deepEqual(host.live(root), []);
  assert.deepEqual(host.stops, ['session-quiet']);
});

test('a new lifetime of one session id waits for the previous runtime to stop', async () => {
  const host = new FakeHost();
  const order: string[] = [];
  const seen: NativeAgentPaths[] = [];
  let releaseStop: (() => void) | undefined;
  const gateway = install(host, {
    createComputer: (paths, agent, hooks) => {
      order.push('create:' + agent.id);
      seen.push(paths);
      const computer = new FakeComputer(host, agent);
      computer.acceptsCaller = true;
      host.paths.set(agent.id, paths);
      host.hooks.set(agent.id, hooks);
      computer.stop = () => {
        order.push('stop:' + agent.id);
        return new Promise<void>(resolve => {
          releaseStop = () => {
            order.push('stopped:' + agent.id);
            resolve();
          };
        });
      };
      return computer;
    },
  });

  const first = host.addAgent('session-restart');
  await host.emit('agent/created', { agent: first });
  // The registry replaces the object: a cold resume, same session id, new lifetime.
  const second = host.addAgent('session-restart');
  const restarting = host.emit('agent/created', { agent: second });
  await settle();

  assert.deepEqual(order, ['create:session-restart', 'stop:session-restart'], 'the old runtime stops before a new one starts');
  releaseStop!();
  await restarting;
  assert.deepEqual(order, ['create:session-restart', 'stop:session-restart', 'stopped:session-restart', 'create:session-restart']);
  assert.deepEqual(host.live(second), ['computer_use'], 'the new lifetime gets its own registration');
  assert.deepEqual(host.live(first), [], 'the old registration stays gone');
  // The replacement never opens the predecessor's profile or log, even though it waited for it to stop.
  assert.equal(seen.length, 2);
  assert.notEqual(seen[1]!.profileDir, seen[0]!.profileDir, 'a new lifetime never reuses the old browser profile');
  assert.notEqual(seen[1]!.messagesPath, seen[0]!.messagesPath, 'and never appends to the old message log');
  assert.match(seen[0]!.profileDir, /\\session-restart-l\d+$/);
  assert.match(seen[1]!.profileDir, /\\session-restart-l\d+$/);
  // The shared sequence means a lifetime is no longer "the first one this install hands out", so only the shape and
  // the strict ordering are guaranteed: a replacement must be newer than the one it replaces, never the same number.
  const firstLifetime = lifetimeOf(seen[0]!.profileDir);
  const secondLifetime = lifetimeOf(seen[1]!.profileDir);
  assert.equal(Number.isSafeInteger(firstLifetime), true, 'a lifetime is a safe integer');
  assert.equal(secondLifetime > firstLifetime, true, 'the replacement gets a strictly newer lifetime, never a reused one');

  const closing = gateway.dispose();
  releaseStop!();
  await closing;
  assert.deepEqual(order.at(-1), 'stopped:session-restart', 'the replacement runtime is stopped on shutdown too');
});

test('a predecessor that refuses to stop still gets a fresh profile', async () => {
  const host = new FakeHost();
  const seen: NativeAgentPaths[] = [];
  const notes: string[] = [];
  const gateway = install(host, {
    log: text => notes.push(text),
    shutdownGraceMs: 30,
    createComputer: (paths, agent, hooks) => {
      seen.push(paths);
      host.paths.set(agent.id, paths);
      host.hooks.set(agent.id, hooks);
      const computer = new FakeComputer(host, agent);
      computer.acceptsCaller = true;
      computer.stop = () => {
        host.stops.push(agent.id);
        return new Promise<void>(() => {});
      };
      return computer;
    },
  });

  const first = host.addAgent('session-clingy');
  await host.emit('agent/created', { agent: first });
  const second = host.addAgent('session-clingy');
  await host.emit('agent/created', { agent: second });

  assert.equal(seen.length, 2, 'a stuck predecessor never blocks its successor forever');
  assert.notEqual(seen[1]!.profileDir, seen[0]!.profileDir, 'the successor never opens the profile it could not close');
  assert.notEqual(seen[1]!.messagesPath, seen[0]!.messagesPath);
  assert.deepEqual(host.live(second), ['computer_use']);
  assert.deepEqual(host.live(first), []);
  assert.ok(notes.some(text => text.includes('did not finish within')), 'giving up on the stuck stop is reported');
  await gateway.dispose();
});

test('two gateways on one data directory never share a directory', async () => {
  const one = new FakeHost();
  const two = new FakeHost();
  const first = install(one);
  const second = install(two);
  const left = one.addAgent('session-shared');
  const right = two.addAgent('session-shared');
  await one.emit('agent/created', { agent: left });
  await two.emit('agent/created', { agent: right });

  const a = one.paths.get('session-shared')!;
  const b = two.paths.get('session-shared')!;
  assert.notEqual(a.profileDir, b.profileDir, 'a reloaded gateway never opens the old instance profile');
  assert.notEqual(a.messagesPath, b.messagesPath);
  assert.match(a.profileDir, /^C:\\gateway-data\\browser\\gw-[0-9a-f]{12}\\session-shared-l\d+$/);
  assert.match(b.profileDir, /^C:\\gateway-data\\browser\\gw-[0-9a-f]{12}\\session-shared-l\d+$/);
  assert.notEqual(a.profileDir.split('\\')[3], b.profileDir.split('\\')[3], 'each instance has its own namespace');
  await first.dispose();
  await second.dispose();
});

test('a profile directory from an older layout is never deleted', async () => {
  const dataRoot = scratch('legacy');
  const legacy = join(dataRoot, 'browser', 'session-legacy');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'Cookies'), 'old');
  const host = new FakeHost();
  const gateway = install(host, { dataRoot });
  const root = host.addAgent('session-legacy');
  await host.emit('agent/created', { agent: root });

  assert.notEqual(host.paths.get('session-legacy')!.profileDir, legacy, 'the new runtime does not open the old profile');
  await gateway.dispose();
  assert.ok(existsSync(join(legacy, 'Cookies')), 'the old profile is left exactly where it was');
  rmSync(dataRoot, { recursive: true, force: true });
});

test('a late disposal event for an older lifetime never unwinds its replacement', async () => {
  const host = new FakeHost();
  const gateway = install(host);
  const first = host.addAgent('session-ghost');
  await host.emit('agent/created', { agent: first });
  const second = host.addAgent('session-ghost');
  await host.emit('agent/created', { agent: second });
  assert.deepEqual(host.live(second), ['computer_use']);

  // The event for the object that already lost the id arrives late.
  await host.emit('agent/disposed', { agent: first });
  assert.deepEqual(host.live(second), ['computer_use'], 'the live lifetime keeps its tools');
  assert.equal(gateway.size(), 1);
  assert.deepEqual(host.stops, ['session-ghost'], 'only the replaced runtime was stopped, once');
  gateway.dispose();
});

test('a stale object cannot take over the id a live agent still owns', async () => {
  const host = new FakeHost();
  const notes: string[] = [];
  const gateway = install(host, { log: text => notes.push(text) });
  const live = host.addAgent('session-owned');
  await host.emit('agent/created', { agent: live });

  const impostor: NativeAgent = { id: 'session-owned', ctx: live.ctx, session: live.session };
  await host.emit('agent/created', { agent: impostor });
  assert.equal(notes.some(text => /is not the live agent/.test(text)), true, 'the impostor is refused and reported');
  assert.deepEqual(host.live(live), ['computer_use'], 'the live lifetime is untouched');
  assert.deepEqual(host.live(impostor), [], 'and the impostor gets nothing');
  assert.deepEqual(host.stops, [], 'nothing was stopped for the impostor');
  gateway.dispose();
});

test('a factory that finishes after its agent was disposed registers nothing and stops itself', async () => {
  const host = new FakeHost();
  let finish: ((computer: NativeComputer) => void) | undefined;
  const gateway = install(host, {
    createComputer: (paths, agent, hooks) => {
      host.paths.set(agent.id, paths);
      host.hooks.set(agent.id, hooks);
      return new Promise<NativeComputer>(resolve => {
        finish = resolve;
      });
    },
  });

  const root = host.addAgent('session-slow-start');
  const creating = host.emit('agent/created', { agent: root });
  await settle();
  await host.emit('agent/disposed', { agent: root });

  const computer = new FakeComputer(host, root);
  computer.acceptsCaller = true;
  finish!(computer);
  await creating;

  assert.deepEqual(host.live(root), [], 'a torn-down agent never comes back with tools');
  assert.equal(gateway.size(), 0);
  assert.deepEqual(host.stops, ['session-slow-start'], 'the runtime that outlived its agent is stopped');
  gateway.dispose();
});

test('dispose waits for a start that was still building its runtime', async () => {
  const host = new FakeHost();
  let finish: ((computer: NativeComputer) => void) | undefined;
  const gateway = install(host, {
    createComputer: (paths, agent, hooks) => {
      host.paths.set(agent.id, paths);
      host.hooks.set(agent.id, hooks);
      return new Promise<NativeComputer>(resolve => {
        finish = resolve;
      });
    },
  });

  const root = host.addAgent('session-mid-start');
  const creating = host.emit('agent/created', { agent: root });
  await settle();

  const done = gateway.dispose();
  const computer = new FakeComputer(host, root);
  computer.acceptsCaller = true;
  finish!(computer);
  await creating;
  await done;

  assert.deepEqual(host.live(root), [], 'nothing is registered during shutdown');
  assert.deepEqual(host.stops, ['session-mid-start'], 'the runtime built during shutdown is stopped');
});

test('adoption and the created event never build two runtimes for one agent', async () => {
  const host = new FakeHost();
  // The agent exists before the gateway mounts, so adoption starts a runtime while the created event arrives too.
  const root = host.addAgent('session-raced');
  let builds = 0;
  const gateway = install(host, {
    createComputer: (paths, agent, hooks) => {
      builds += 1;
      host.paths.set(agent.id, paths);
      host.hooks.set(agent.id, hooks);
      const computer = new FakeComputer(host, agent);
      computer.acceptsCaller = true;
      return computer;
    },
  });
  await host.emit('agent/created', { agent: root });
  await settle();

  assert.equal(builds, 1, 'one runtime per agent, whichever trigger wins');
  assert.deepEqual(host.live(root), ['computer_use']);
  assert.equal(gateway.size(), 1);
  gateway.dispose();
  assert.deepEqual(host.stops, ['session-raced'], 'and exactly one stop');
});

test('a runtime whose stop never settles cannot hang shutdown', async () => {
  const host = new FakeHost();
  const notes: string[] = [];
  const gateway = install(host, {
    log: text => notes.push(text),
    shutdownGraceMs: 20,
    createComputer: (paths, agent, hooks) => {
      host.paths.set(agent.id, paths);
      host.hooks.set(agent.id, hooks);
      const computer = new FakeComputer(host, agent);
      computer.acceptsCaller = true;
      computer.stop = () => {
        host.stops.push(agent.id);
        return new Promise<void>(() => {});
      };
      return computer;
    },
  });

  const root = host.addAgent('session-stuck');
  await host.emit('agent/created', { agent: root });
  await gateway.dispose();

  assert.deepEqual(host.live(root), [], 'the tools are gone even though the stop never answered');
  assert.deepEqual(host.stops, ['session-stuck'], 'the stop was asked for once');
  assert.equal(notes.some(text => /did not finish within/.test(text)), true, 'giving up is reported, not silent');
});

test('a factory that never answers cannot hang shutdown', async () => {
  const host = new FakeHost();
  const notes: string[] = [];
  const gateway = install(host, {
    log: text => notes.push(text),
    shutdownGraceMs: 20,
    createComputer: () => new Promise<NativeComputer>(() => {}),
  });

  const root = host.addAgent('session-never');
  void host.emit('agent/created', { agent: root });
  await settle();
  await gateway.dispose();

  assert.deepEqual(host.live(root), [], 'nothing is registered for an agent whose runtime never arrived');
  assert.equal(notes.some(text => /did not finish within/.test(text)), true, 'the abandoned start is reported');
});

test('a genuinely absent lifetime sequence starts at one and then moves on', async () => {
  await withoutLifetimeSlot(async () => {
    const host = new FakeHost();
    const gateway = install(host);
    const first = host.addAgent('session-first-life');
    const second = host.addAgent('session-second-life');
    await host.emit('agent/created', { agent: first });
    await host.emit('agent/created', { agent: second });

    assert.equal(lifetimeOf(host.paths.get('session-first-life')!.profileDir), 1, 'the first runtime of a fresh process gets lifetime 1');
    assert.equal(lifetimeOf(host.paths.get('session-second-life')!.profileDir), 2, 'the next one moves on instead of restarting at 1');
    await gateway.dispose();
  });
});

test('a damaged lifetime sequence fails closed instead of handing out a retired number', async () => {
  const damaged: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a numeric string', '3'],
    ['a negative number', -1],
    ['NaN', Number.NaN],
    ['a fraction', 3.5],
    ['Infinity', Number.POSITIVE_INFINITY],
  ];
  for (const [label, value] of damaged) {
    await withLifetimeSlot(value, async () => {
      const host = new FakeHost();
      const notes: string[] = [];
      const gateway = install(host, { log: text => notes.push(text) });
      const root = host.addAgent('session-damaged');
      await host.emit('agent/created', { agent: root });

      assert.deepEqual(host.live(root), [], label + ': no tool is registered on a corrupt sequence');
      assert.equal(gateway.size(), 0, label + ': no runtime was created');
      assert.equal(host.paths.has('session-damaged'), false, label + ': no profile was opened');
      assert.deepEqual(host.stops, [], label + ': nothing was started, so nothing has to stop');
      assert.equal(notes.some(text => /cannot attach the computer-use runtime/.test(text)), true, label + ': the refusal is reported, not silent');
      assert.equal(Object.is(SLOT_BAG[LIFETIME_SEQUENCE_SLOT], value), true, label + ': the damaged value is left alone, never overwritten');
      await gateway.dispose();
    });
  }
});

test('an exhausted lifetime sequence fails closed instead of wrapping around', async () => {
  await withLifetimeSlot(Number.MAX_SAFE_INTEGER, async () => {
    const host = new FakeHost();
    const notes: string[] = [];
    const gateway = install(host, { log: text => notes.push(text) });
    const root = host.addAgent('session-exhausted');
    await host.emit('agent/created', { agent: root });

    assert.deepEqual(host.live(root), [], 'no tool is registered once the sequence is spent');
    assert.equal(gateway.size(), 0);
    assert.equal(host.paths.has('session-exhausted'), false, 'no profile is opened for a lifetime that cannot be issued');
    assert.equal(notes.some(text => /lifetime sequence is exhausted/.test(text)), true, 'exhaustion is reported as such');
    assert.equal(SLOT_BAG[LIFETIME_SEQUENCE_SLOT], Number.MAX_SAFE_INTEGER, 'the sequence is never advanced past its limit');
    await gateway.dispose();
  });
});

test('every reload of the gateway hands one agent id a newer lifetime than the last', async () => {
  const lives: number[] = [];
  for (let generation = 0; generation < 3; generation += 1) {
    const host = new FakeHost();
    const gateway = install(host);
    const root = host.addAgent('session-reloaded');
    await host.emit('agent/created', { agent: root });
    lives.push(lifetimeOf(host.paths.get('session-reloaded')!.profileDir));
    await gateway.dispose();
  }

  assert.equal(new Set(lives).size, 3, 'no two reloads ever get the same lifetime');
  assert.deepEqual([...lives].sort((left, right) => left - right), lives, 'and they only ever move forward');
});

test('a reloaded gateway keeps taking real overlay actions for the same agent id', async () => {
  const { runtime, dir } = await realOverlay('real-lifetime');
  try {
    const announced: ActionActor[] = [];
    const accepted: ActionEvent[] = [];
    runtime.subscribe('actor-live', payload => { announced.push(actorFromAnnouncement(payload)); });
    runtime.subscribe('action', payload => { accepted.push(payload as ActionEvent); });
    runtime.publishMode('session-real-root', { enabled: true });

    const host = new FakeHost();
    const gateway = install(host, { multiMouse: runtime as unknown as NativeMultiMouseRuntime });
    const root = host.addAgent('session-real-root');
    const child = host.addAgent('session-real-child', { delegationDepth: 1 }, root);
    await host.emit('agent/created', { agent: root });
    await host.emit('agent/created', { agent: child });

    const firstLife = lifetimeOf(host.paths.get('session-real-child')!.profileDir);
    assert.equal(actorOfAgent(announced, 'session-real-child').lifetime, firstLife, 'the overlay hears exactly the lifetime the gateway allocated');
    const firstActor: ActionActor = {
      trust: 'trusted',
      agentId: 'session-real-child',
      rootAgentId: 'session-real-root',
      depth: 1,
      lifetime: firstLife,
    };
    assert.notEqual(runtime.publishAction(realAction(firstActor, 'request-first', 1)), null, 'the live lifetime reaches the overlay');
    assert.equal(accepted.length, 1, 'and is shown, not merely accepted');

    await gateway.dispose();

    const next = new FakeHost();
    const reloaded = install(next, { multiMouse: runtime as unknown as NativeMultiMouseRuntime });
    const nextRoot = next.addAgent('session-real-root');
    const nextChild = next.addAgent('session-real-child', { delegationDepth: 1 }, nextRoot);
    await next.emit('agent/created', { agent: nextRoot });
    await next.emit('agent/created', { agent: nextChild });

    const secondLife = lifetimeOf(next.paths.get('session-real-child')!.profileDir);
    assert.equal(secondLife > firstLife, true, 'a reloaded gateway never reuses a lifetime the overlay already retired');
    const secondActor: ActionActor = { ...firstActor, lifetime: secondLife };
    assert.notEqual(runtime.publishAction(realAction(secondActor, 'request-second', 1)), null, 'the replacement lifetime is accepted by the shared runtime');
    assert.equal(accepted.length, 2, 'and is shown under its own lifetime');

    // The gateway's own action path (runtime hook -> pinned epoch -> shared runtime) has to survive the reload too.
    next.hooks.get('session-real-child')!.onAction!(realAction(secondActor, 'request-gateway-live', 1));
    assert.equal(accepted.length, 3, 'the reloaded gateway forwards real actions for the lifetime it allocated');

    assert.equal(runtime.publishAction(realAction(firstActor, 'request-late-action', 1)), null, 'a late action from the retired lifetime is dropped');
    // The replacement still holds the shared runtime, so driving its own hook is the end-to-end path: the refusal has to
    // come from the runtime, not from a gateway that merely stopped forwarding.
    next.hooks.get('session-real-child')!.onAction!(realAction(firstActor, 'request-gateway-late', 1));
    assert.equal(accepted.length, 3, 'the reloaded gateway cannot push a retired lifetime through its hook either');
    // The disposed gateway is silent for a different reason: it let go of the shared runtime, so it has nothing to publish with.
    host.hooks.get('session-real-child')!.onAction!(realAction(firstActor, 'request-gateway-late-again', 1));
    assert.equal(accepted.length, 3, 'and the disposed gateway no longer publishes at all');
    assert.equal(runtime.publishActorDisposed(firstActor), true);
    assert.notEqual(runtime.publishAction(realAction(secondActor, 'request-third', 1)), null, 'a repeated disposal of the old lifetime never unwinds the live one');
    assert.equal(accepted.length, 4);
    assert.equal(runtime.getMode('session-real-root').enabled, true, 'the gateway never disposes the shared overlay runtime');

    await reloaded.dispose();
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two live gateways never hand one agent id the same real lifetime', async () => {
  const { runtime, dir } = await realOverlay('real-two-gateways');
  try {
    const accepted: ActionEvent[] = [];
    runtime.subscribe('action', payload => { accepted.push(payload as ActionEvent); });
    runtime.publishMode('session-twin-root', { enabled: true });

    const hosts = [new FakeHost(), new FakeHost()];
    const gateways = hosts.map(host => install(host, { multiMouse: runtime as unknown as NativeMultiMouseRuntime }));
    const lives: number[] = [];
    for (const host of hosts) {
      const root = host.addAgent('session-twin-root');
      const child = host.addAgent('session-twin-child', { delegationDepth: 1 }, root);
      await host.emit('agent/created', { agent: root });
      await host.emit('agent/created', { agent: child });
      lives.push(lifetimeOf(host.paths.get('session-twin-child')!.profileDir));
    }

    assert.equal(new Set(lives).size, 2, 'two installs of one process never collide on a lifetime');
    assert.equal(lives[1]! > lives[0]!, true, 'the later install is strictly newer');
    for (const lifetime of lives) {
      const actor: ActionActor = {
        trust: 'trusted',
        agentId: 'session-twin-child',
        rootAgentId: 'session-twin-root',
        depth: 1,
        lifetime,
      };
      assert.notEqual(runtime.publishAction(realAction(actor, 'request-twin-' + lifetime, 1)), null, 'lifetime ' + lifetime + ' reaches the overlay');
    }
    assert.equal(accepted.length, 2, 'both installs are shown, each under its own lifetime');

    for (const gateway of gateways) await gateway.dispose();
    assert.equal(runtime.getMode('session-twin-root').enabled, true, 'the shared overlay runtime outlives both gateways');
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

function waitUntil(ready: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (ready()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(label));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

test('a delegated child registers its tools before its root resolves, but never announces or runs', async () => {
  const host = new FakeHost();
  const mouse = new FakeMultiMouse();
  const gateway = install(host, { multiMouse: mouse });
  const root = host.addAgent('session-early-root');
  const child = host.addAgent('session-early-child', { delegationDepth: 1, origin: 'subagent' });
  const childLives = () => mouse.lives.filter(actor => actor.agentId === child.id);

  await host.emit('agent/created', { agent: root });
  await host.emit('agent/created', { agent: child });

  assert.equal(host.computers.has(child.id), true, 'the runtime is created even while the root is not resolvable yet');
  assert.ok(host.live(child).includes('computer_use'), 'the definition is registered before the root exists');
  assert.ok(host.live(child).includes('multi_mouse'), 'an available overlay still adds multi_mouse to an unbound agent');
  assert.deepEqual(childLives(), [], 'an unbound agent is never announced to the overlay');

  const definition = host.definitionOf(child, 'computer_use');
  await assert.rejects(definition.execute({ target: 'probe' }, { agent: child, signal: new AbortController().signal }), (error: unknown) => {
    assert.ok(error instanceof NativeGatewayError);
    assert.equal(error.code, 'TOOL_CONTEXT_UNAVAILABLE');
    assert.match(error.message, /cannot resolve the calling agent's root agent/);
    const cause = (error as NativeGatewayError & { cause?: { code?: string } }).cause;
    assert.equal(cause?.code, 'UNAUTHORIZED', 'the host refusal is preserved as the cause');
    return true;
  });
  assert.equal(host.calls.length, 0, 'an unproven call never reaches the desktop runtime');
  assert.deepEqual(childLives(), [], 'a failed first call leaves no actor behind');
  assert.deepEqual(mouse.released, [], 'a failed first call has nothing to release');

  // The same refusal holds for a cancelled first call: it fails before the identity is bound, so actor stays 0.
  await assert.rejects(definition.execute({ target: 'probe' }, { agent: child, signal: aborting().signal }), /cannot resolve the calling agent's root agent/);
  assert.deepEqual(childLives(), []);
  await gateway.dispose();
});

test('the first proven call binds the root once and concurrent calls share that caller', async () => {
  const host = new FakeHost();
  const mouse = new FakeMultiMouse();
  const gateway = install(host, { multiMouse: mouse });
  const root = host.addAgent('session-bind-root');
  const child = host.addAgent('session-bind-child', { delegationDepth: 1, origin: 'subagent' });
  const childLives = () => mouse.lives.filter(actor => actor.agentId === child.id);
  await host.emit('agent/created', { agent: root });
  await host.emit('agent/created', { agent: child });
  host.roots.set(child, root);

  const definition = host.definitionOf(child, 'computer_use');
  await Promise.all([
    definition.execute({ target: 'one' }, { agent: child, signal: new AbortController().signal }),
    definition.execute({ target: 'two' }, { agent: child, signal: new AbortController().signal }),
  ]);

  assert.equal(childLives().length, 1, 'the first proven call announces the actor exactly once');
  assert.equal(childLives()[0]!.rootAgentId, root.id);
  assert.equal(childLives()[0]!.depth, 1);
  assert.equal(host.calls.length, 2);
  assert.deepEqual(host.calls[0]!.caller, host.calls[1]!.caller, 'both calls use the one bound caller');
  assert.equal(host.calls[0]!.caller?.agentId, child.id);
  assert.equal(host.definitionOf(child, 'computer_use'), definition, 'binding does not re-register the same definition');
  await gateway.dispose();
  assert.equal(mouse.released.filter(actor => actor.agentId === child.id).length, 1, 'the bound actor is released exactly once');
});

test('a root that changes after binding is refused without another call or announce', async () => {
  const host = new FakeHost();
  const mouse = new FakeMultiMouse();
  const gateway = install(host, { multiMouse: mouse });
  const root = host.addAgent('session-change-root');
  const other = host.addAgent('session-change-other');
  const child = host.addAgent('session-change-child', { delegationDepth: 1, origin: 'subagent' });
  const childLives = () => mouse.lives.filter(actor => actor.agentId === child.id);
  await host.emit('agent/created', { agent: root });
  await host.emit('agent/created', { agent: child });
  host.roots.set(child, root);
  const definition = host.definitionOf(child, 'computer_use');
  await definition.execute({ target: 'first' }, { agent: child, signal: new AbortController().signal });
  assert.equal(host.calls.length, 1);
  assert.equal(childLives().length, 1);

  host.roots.set(child, other);
  await assert.rejects(definition.execute({ target: 'second' }, { agent: child, signal: new AbortController().signal }), (error: unknown) => {
    assert.ok(error instanceof NativeGatewayError);
    assert.equal(error.code, 'TOOL_ROOT_CHANGED');
    assert.match(error.message, /root changed since this runtime was created/);
    return true;
  });
  assert.equal(host.calls.length, 1, 'a changed root never reaches the desktop');
  assert.equal(childLives().length, 1, 'a changed root is never announced again');
  await gateway.dispose();
  assert.equal(mouse.released.filter(actor => actor.agentId === child.id).length, 1);
});

test('two direct children and a grandchild each bind their own identity and scoped tools', async () => {
  const host = new FakeHost();
  const mouse = new FakeMultiMouse();
  const gateway = install(host, { multiMouse: mouse });
  const root = host.addAgent('session-tree-root');
  const first = host.addAgent('session-tree-first', { delegationDepth: 1, origin: 'subagent' });
  const second = host.addAgent('session-tree-second', { delegationDepth: 1, origin: 'subagent' });
  const grand = host.addAgent('session-tree-grand', { delegationDepth: 2, origin: 'subagent' });
  await host.emit('agent/created', { agent: root });
  for (const agent of [first, second, grand]) await host.emit('agent/created', { agent });
  host.roots.set(first, root);
  host.roots.set(second, root);
  host.roots.set(grand, root);

  for (const agent of [first, second, grand]) {
    const definition = host.definitionOf(agent, 'computer_use');
    await definition.execute({ target: agent.id }, { agent, signal: new AbortController().signal });
  }
  assert.equal(host.calls.length, 3);
  const depths = host.calls.map(call => call.caller?.depth);
  assert.deepEqual(depths, [1, 1, 2], 'each child keeps its own depth and the grandchild is deeper');
  assert.deepEqual(host.calls.map(call => call.caller?.rootAgentId), [root.id, root.id, root.id]);
  assert.deepEqual(host.calls.map(call => call.caller?.agentId), [first.id, second.id, grand.id]);
  assert.deepEqual(
    [first, second, grand].map(agent => mouse.lives.filter(actor => actor.agentId === agent.id).length),
    [1, 1, 1],
    'each agent is announced under its own identity, never under the root',
  );
  for (const agent of [first, second, grand]) {
    assert.ok(host.live(agent).includes('computer_use'), "tools stay on the agent's own scoped service");
  }
  await gateway.dispose();
});

test('a runtime that answers after shutdown starts is stopped and never announced', async () => {
  let deliver!: (computer: NativeComputer) => void;
  const late = new Promise<NativeComputer>(resolve => {
    deliver = resolve;
  });
  const host = new FakeHost();
  const mouse = new FakeMultiMouse();
  const gateway = install(host, { createComputer: () => late, multiMouse: mouse });
  const child = host.addAgent('session-late-factory', { delegationDepth: 1, origin: 'subagent' });

  const creation = host.emit('agent/created', { agent: child });
  await settle();
  await settle();
  assert.deepEqual(host.live(child), [], 'nothing is registered until the factory answers');
  assert.deepEqual(mouse.lives, [], 'no identity is published before the runtime exists');

  const closing = gateway.dispose();
  deliver(new FakeComputer(host, child));
  await creation;
  await closing;
  assert.deepEqual(host.stops, [child.id], 'a runtime built after shutdown started is stopped, not adopted');
  assert.equal(gateway.size(), 0);
  assert.deepEqual(host.live(child), []);
  assert.deepEqual(mouse.lives, []);
});

test('a refused runtime never publishes an identity', async () => {
  const host = new FakeHost();
  const mouse = new FakeMultiMouse();
  const gateway = install(host, { createComputer: host.factory(false), multiMouse: mouse, log() {} });
  const root = host.addAgent('session-refused-publish');
  await host.emit('agent/created', { agent: root });
  assert.deepEqual(host.live(root), []);
  assert.deepEqual(mouse.lives, [], 'a runtime that ignores the caller is never announced');
  assert.deepEqual(mouse.released, []);
  await gateway.dispose();
});

test('an overlay that loads after an unbound child still adds multi_mouse without announcing it', async () => {
  const specifier = new URL('../plugin/lib/multi-mouse-runtime.mjs', import.meta.url).href;
  const loaded = (await import(specifier)) as {
    getMultiMouseRuntime: (options?: { dataDir?: string }) => RealMultiMouseRuntime;
    resetMultiMouseRuntime?: () => void;
  };
  const dir = scratch('late-overlay');
  const previous = process.env.EVOCU_DATA_DIR;
  process.env.EVOCU_DATA_DIR = dir;
  loaded.resetMultiMouseRuntime?.();
  const runtime = loaded.getMultiMouseRuntime({ dataDir: dir });
  const actors: ActionActor[] = [];
  const stop = runtime.subscribe('actor-live', payload => {
    actors.push(actorFromAnnouncement(payload));
  });
  try {
    const host = new FakeHost();
    const root = host.addAgent('session-overlay-root');
    const child = host.addAgent('session-overlay-child', { delegationDepth: 1, origin: 'subagent' });
    const gateway = install(host, { multiMouse: undefined });
    await waitUntil(() => host.live(child).includes('multi_mouse'), "the late overlay never refreshed the child's tools", 4000);
    assert.ok(host.live(child).includes('computer_use'));
    assert.deepEqual(actors.filter(actor => actor.agentId === child.id), [], 'an unbound child is never announced by a late overlay');
    await gateway.dispose();
  } finally {
    stop();
    loaded.resetMultiMouseRuntime?.();
    if (previous === undefined) delete process.env.EVOCU_DATA_DIR;
    else process.env.EVOCU_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a first call cancelled or stopped before binding leaves no actor behind', async () => {
  const host = new FakeHost();
  const mouse = new FakeMultiMouse();
  const dir = scratch('stop-unbound');
  const stopFile = join(dir, 'desktop-stopped');
  const gateway = install(host, { multiMouse: mouse, stopFile, pollMs: 50, modeFile: false });
  const childLives = () => mouse.lives.filter(actor => actor.agentId === 'session-stop-child');
  try {
    const root = host.addAgent('session-stop-root');
    const child = host.addAgent('session-stop-child', { delegationDepth: 1, origin: 'subagent' });
    await host.emit('agent/created', { agent: root });
    await host.emit('agent/created', { agent: child });
    host.roots.set(child, root);
    const definition = host.definitionOf(child, 'computer_use');

    await assert.rejects(definition.execute({ target: 'cancelled' }, { agent: child, signal: aborting().signal }), /test cancel/);
    assert.deepEqual(childLives(), [], 'a cancelled first call binds no identity');

    writeFileSync(stopFile, '');
    await waitUntil(() => gateway.halted(), 'the stop sign was never noticed', 2000);
    await assert.rejects(definition.execute({ target: 'stopped' }, { agent: child, signal: new AbortController().signal }), (error: unknown) => {
      assert.ok(error instanceof NativeGatewayError);
      assert.equal(error.code, 'TOOL_STOPPED');
      return true;
    });
    assert.deepEqual(childLives(), [], 'a stopped first call binds no identity');
    assert.equal(host.calls.length, 0);
  } finally {
    await gateway.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
