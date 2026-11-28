import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../probes/desktop-agent-identity/index.mjs'

const ALLOWED_SCHEMA_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'description', 'title', 'default', 'examples',
])
function assertSupportedSchema(schema) {
  if (!schema || typeof schema !== 'object') return
  assert.ok(!Array.isArray(schema), 'schema must be an object')
  for (const key of Object.keys(schema)) {
    assert.ok(ALLOWED_SCHEMA_KEYWORDS.has(key), `unsupported JSON schema keyword: ${key}`)
  }
  for (const child of Object.values(schema.properties ?? {})) assertSupportedSchema(child)
  if (schema.items) assertSupportedSchema(schema.items)
  for (const child of schema.oneOf ?? []) assertSupportedSchema(child)
}

function host() {
  const live = new Map()
  const parents = new WeakMap()
  const listeners = new Map()
  const tools = new Map()
  let cleanup
  let rootCalls = 0
  const ctx = {
    agents: live,
    subagents: {
      rootOf(caller) {
        rootCalls++
        let root = caller
        while (parents.has(root)) root = parents.get(root)
        return root
      },
    },
    effect(setup) { cleanup = setup() },
    on(event, fn) {
      assert.ok(!listeners.has(event))
      listeners.set(event, fn)
      return () => listeners.delete(event)
    },
    tools: {
      register(definition) {
        assert.equal(definition.name, 'ecu_pointer_identity_probe')
        assertSupportedSchema(definition.parameters)
        assertSupportedSchema(definition.output?.schema)
        assert.ok(!tools.has(definition.name))
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  return {
    ctx, live, parents, listeners, tools,
    get rootCalls() { return rootCalls },
    activate: (config = {}) => apply(ctx, config),
    unload: () => cleanup(),
    emit: (event, agent) => listeners.get(event)?.call(agent, { agent }),
    open(id, parent) {
      const agent = { id }
      live.set(id, agent)
      this.emit('agent/created', agent)
      if (parent) parents.set(agent, parent)
      return agent
    },
    close(agent) {
      assert.equal(live.get(agent.id), agent)
      live.delete(agent.id)
      this.emit('agent/disposed', agent)
    },
    get definition() { return tools.get('ecu_pointer_identity_probe') },
    call(agent, signal = new AbortController().signal) {
      return this.definition.execute({}, { agent, signal })
    },
  }
}

test('attributes direct and nested callers to the exact live root without returning IDs', async () => {
  const h = host()
  h.activate()
  const root = h.open('private-root-id')
  const child = h.open('private-child-id', root)
  const grandchild = h.open('private-grandchild-id', child)
  assert.equal(h.rootCalls, 0, 'created events must not depend on tree registration order')
  const nested = await h.call(grandchild)
  const direct = await h.call(child)
  const primary = await h.call(root)
  for (const result of [primary, direct, nested]) {
    assert.equal(result.verdict, 'verified')
    assert.equal(result.rootOrdinal, primary.callerOrdinal)
    assert.equal(result.callerCreatedObserved, true)
    assert.equal(result.rootCreatedObserved, true)
  }
  assert.equal(primary.rootIsCaller, true)
  assert.equal(direct.rootIsCaller, false)
  assert.equal(nested.rootIsCaller, false)
  assert.equal(new Set([primary.callerOrdinal, direct.callerOrdinal, nested.callerOrdinal]).size, 3)
  assert.deepEqual(await h.call(grandchild), nested)
  const [part] = h.definition.output.render({}, nested)
  assert.equal(part.type, 'text')
  assert.deepEqual(JSON.parse(part.text), nested)
  assert.doesNotMatch(part.text, /private-/)
  h.unload()
})

test('rejects identity arguments and fails closed for a missing or forged execution context', async () => {
  const h = host()
  h.activate()
  const root = h.open('root')
  await assert.rejects(h.definition.execute({ agent: root }, { agent: root }), /only an empty object/)
  for (const [exec, reason] of [
    [undefined, 'no-execution-context'],
    [{}, 'no-caller-agent'],
    [{ agent: { id: root.id } }, 'caller-not-live'],
  ]) {
    const actual = await h.definition.execute({}, exec)
    assert.deepEqual(actual, {
      probe: 'ecu_pointer_identity_probe', schemaVersion: 2, verdict: 'unverified', reason,
    })
  }
  assert.equal(h.rootCalls, 0)
  h.unload()
})

test('rejects unverified or changed root ownership', async () => {
  const h = host()
  h.activate()
  const root = h.open('root')
  const child = h.open('child', root)
  assert.equal((await h.call(child)).verdict, 'verified')
  const other = h.open('other')
  h.parents.set(child, other)
  assert.equal((await h.call(child)).reason, 'root-changed')
  h.parents.set(child, { id: root.id })
  assert.equal((await h.call(child)).reason, 'root-not-live')
  h.ctx.subagents.rootOf = () => { throw new Error('runtime unavailable') }
  assert.equal((await h.call(child)).reason, 'root-unresolved')
  h.ctx.agents = { get() { throw new Error('registry unavailable') } }
  assert.equal((await h.call(child)).reason, 'agent-registry-error')
  h.unload()
})

test('correlates disposal to the same verified object and only within its own root', async () => {
  const h = host()
  h.activate()
  const root = h.open('root')
  const child = h.open('child', root)
  const other = h.open('other')
  const silent = h.open('never-probed', root)
  const first = await h.call(child)
  h.close(silent)
  h.emit('agent/disposed', { id: child.id })
  assert.deepEqual((await h.call(root)).recentDisposedOrdinals, [])
  h.close(child)
  h.emit('agent/disposed', child)
  assert.equal((await h.call(child)).reason, 'caller-not-live')
  const fromRoot = await h.call(root)
  assert.deepEqual(fromRoot.recentDisposedOrdinals, [first.callerOrdinal])
  fromRoot.recentDisposedOrdinals.length = 0
  assert.deepEqual((await h.call(root)).recentDisposedOrdinals, [first.callerOrdinal])
  assert.deepEqual((await h.call(other)).recentDisposedOrdinals, [])
  const resumed = h.open(child.id, root)
  const second = await h.call(resumed)
  assert.equal(second.verdict, 'verified')
  assert.equal(second.callerCreatedObserved, true)
  assert.equal(second.rootOrdinal, first.rootOrdinal)
  assert.notEqual(second.callerOrdinal, first.callerOrdinal)
  assert.equal((await h.call(child)).reason, 'caller-not-live')
  h.unload()
})

test('keeps only the last 32 verified disposal observations', async () => {
  const h = host()
  h.activate()
  const root = h.open('root')
  const ordinals = []
  for (let i = 0; i < 35; i++) {
    const agent = h.open('child-' + i, root)
    ordinals.push((await h.call(agent)).callerOrdinal)
    h.close(agent)
  }
  assert.deepEqual((await h.call(root)).recentDisposedOrdinals, ordinals.slice(-32))
  h.unload()
})

test('honors host cancellation before committing an observation', async () => {
  const h = host()
  h.activate()
  const root = h.open('root')
  const child = h.open('child', root)
  const controller = new AbortController()
  controller.abort(new Error('cancel before entry'))
  await assert.rejects(h.call(child, controller.signal), /cancel before entry/)
  assert.equal(h.rootCalls, 0)
  const midway = new AbortController()
  const resolve = h.ctx.subagents.rootOf
  h.ctx.subagents.rootOf = caller => {
    midway.abort(new Error('cancel before commit'))
    return resolve(caller)
  }
  await assert.rejects(h.call(child, midway.signal), /cancel before commit/)
  h.ctx.subagents.rootOf = resolve
  h.close(child)
  assert.deepEqual((await h.call(root)).recentDisposedOrdinals, [])
  h.unload()
})

test('unloads tool and listeners and does not carry observations across activation', async () => {
  const h = host()
  const root = h.open('root')
  h.activate()
  assert.equal((await h.call(root)).callerCreatedObserved, false)
  const child = h.open('child', root)
  assert.equal((await h.call(child)).callerCreatedObserved, true)
  const old = h.definition
  h.unload()
  h.unload()
  assert.equal(h.tools.size, 0)
  assert.equal(h.listeners.size, 0)
  await assert.rejects(old.execute({}, { agent: child }), /probe is unloaded/)
  h.activate()
  const fresh = await h.call(child)
  assert.equal(fresh.verdict, 'verified')
  assert.equal(fresh.callerCreatedObserved, false)
  assert.deepEqual(fresh.recentDisposedOrdinals, [])
  h.unload()
})

test('writes optional evidence with session-header tree details when configured', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'ecu-identity-evidence-'))
  const file = join(dir, 'events.jsonl')
  try {
    const h = host()
    h.activate({ evidencePath: file })
    const root = h.open('root')
    root.session = { header: { id: 'root', isSeeded: false, delegationDepth: 0 } }
    const child = h.open('child', root)
    child.session = { header: { id: 'child', isSeeded: false, parentSession: 'root', origin: 'subagent', delegationDepth: 1 } }
    await h.call(child)
    const [entry] = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(entry.verdict, 'verified')
    assert.equal(entry.callerId, 'child')
    assert.equal(entry.rootId, 'root')
    assert.equal(entry.callerHeader.delegationDepth, 1)
    assert.equal(entry.callerHeader.parentSession, 'root')
    assert.equal(entry.rootHeader.origin, null)
    h.unload()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('emits a credential-free receipt only after successful native registration', t => {
  const h = host()
  const register = h.ctx.tools.register
  const receipt = t.mock.method(console, 'info', () => {
    assert.equal(h.listeners.size, 2)
    assert.equal(h.tools.has('ecu_pointer_identity_probe'), true)
  })
  h.ctx.tools.register = () => { throw new Error('registration rejected') }
  assert.throws(() => h.activate(), /registration rejected/)
  assert.equal(receipt.mock.callCount(), 0)
  h.ctx.tools.register = register
  h.activate()
  assert.equal(receipt.mock.callCount(), 1)
  assert.deepEqual(receipt.mock.calls[0].arguments, [
    `[ecu-native-probe] registered tool=ecu_pointer_identity_probe schemaVersion=2 pid=${process.pid}`,
  ])
  h.unload()
  assert.equal(receipt.mock.callCount(), 1)
})

test('rolls back prior listeners after an activation failure', () => {
  const h = host()
  h.ctx.tools.register = () => { throw new Error('host refused registration') }
  assert.throws(() => h.activate(), /host refused registration/)
  assert.equal(h.listeners.size, 0)
  assert.equal(h.tools.size, 0)
  const partial = host()
  const on = partial.ctx.on
  partial.ctx.on = (event, fn) => {
    if (event === 'agent/disposed') throw new Error('host refused listener')
    return on(event, fn)
  }
  assert.throws(() => partial.activate(), /host refused listener/)
  assert.equal(partial.listeners.size, 0)
  assert.equal(partial.tools.size, 0)
})
