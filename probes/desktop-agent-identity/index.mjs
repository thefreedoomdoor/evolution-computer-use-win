/** Read-only DSH Desktop identity probe; never controls the desktop. */
import { appendFileSync } from 'node:fs'

export const name = 'desktop-agent-identity-probe'
export const inject = ['tools', 'agents', 'subagents']

const TOOL = 'ecu_pointer_identity_probe'
const VERSION = 2
const RECENT_DISPOSALS = 32
const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    probe: { type: 'string' },
    schemaVersion: { type: 'integer' },
    verdict: { type: 'string', enum: ['verified', 'unverified'] },
    reason: { type: 'string' },
    callerOrdinal: { type: 'integer' },
    rootOrdinal: { type: 'integer' },
    rootIsCaller: { type: 'boolean' },
    callerCreatedObserved: { type: 'boolean' },
    rootCreatedObserved: { type: 'boolean' },
    recentDisposedOrdinals: {
      type: 'array', items: { type: 'integer' },
    },
  },
  required: ['probe', 'schemaVersion', 'verdict', 'reason'],
}

function isAgent(value) {
  return value !== null && typeof value === 'object' && typeof value.id === 'string'
}

function unverified(reason) {
  return { probe: TOOL, schemaVersion: VERSION, verdict: 'unverified', reason }
}

export function apply(ctx, config = {}) {
  ctx.effect(() => {
    // Key observations by the live object, not by a session ID. A new Agent
    // created for a resumed session is a new lifetime even if its ID is reused.
    const records = new WeakMap()
    let nextOrdinal = 0
    let active = true
    const disposers = []

    function recordFor(agent) {
      let record = records.get(agent)
      if (!record) {
        record = { created: false, disposed: false }
        records.set(agent, record)
      }
      return record
    }

    function onCreated(payload) {
      const agent = payload?.agent
      if (!active || !isAgent(agent)) return
      if (records.get(agent)?.disposed) records.delete(agent)
      // rootOf need not be ready when the host emits this event.
      recordFor(agent).created = true
    }

    function onDisposed(payload) {
      const agent = payload?.agent
      if (!active || !isAgent(agent)) return
      const record = recordFor(agent)
      if (record.disposed) return
      record.disposed = true
      const rootRecord = record.root
      if (!rootRecord || rootRecord === record || rootRecord.disposed) return
      const recent = rootRecord.recentDisposals ??= []
      if (recent.length === RECENT_DISPOSALS) recent.shift()
      recent.push(record.ordinal)
    }

    function cleanup() {
      if (!active) return
      active = false
      const failures = []
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch (error) { failures.push(error) }
      }
      disposers.length = 0
      if (failures.length) throw new AggregateError(failures, 'Identity probe cleanup failed')
    }

    function track(dispose) {
      if (typeof dispose !== 'function') throw new Error('Host did not return an identity probe disposer')
      disposers.push(dispose)
    }

    const evidencePath = typeof config.evidencePath === 'string' && config.evidencePath
      ? config.evidencePath
      : (typeof process.env.ECU_IDENTITY_EVIDENCE === 'string' ? process.env.ECU_IDENTITY_EVIDENCE : '')

    function headerOf(agent) {
      try {
        const header = agent?.session?.header
        if (!header || typeof header !== 'object') return null
        return {
          id: typeof header.id === 'string' ? header.id : null,
          cwd: typeof header.cwd === 'string' ? header.cwd : null,
          parentSession: typeof header.parentSession === 'string' ? header.parentSession : null,
          isSeeded: header.isSeeded === true,
          origin: header.origin === 'subagent' ? 'subagent' : null,
          delegationDepth: Number.isInteger(header.delegationDepth) ? header.delegationDepth : 0,
        }
      } catch {
        return null
      }
    }

    function writeEvidence(value, exec) {
      if (!evidencePath) return
      try {
        const caller = exec?.agent
        const root = caller && isAgent(caller) && typeof ctx.subagents?.rootOf === 'function'
          ? (() => { try { return ctx.subagents.rootOf(caller) } catch { return undefined } })()
          : undefined
        const entry = {
          time: new Date().toISOString(),
          pid: process.pid,
          probe: value?.probe ?? TOOL,
          schemaVersion: value?.schemaVersion ?? VERSION,
          verdict: value?.verdict ?? 'unverified',
          reason: value?.reason ?? 'unknown',
          callerId: isAgent(caller) ? caller.id : null,
          rootId: isAgent(root) ? root.id : null,
          rootIsCaller: value?.rootIsCaller ?? null,
          callerOrdinal: value?.callerOrdinal ?? null,
          rootOrdinal: value?.rootOrdinal ?? null,
          callerCreatedObserved: value?.callerCreatedObserved ?? null,
          rootCreatedObserved: value?.rootCreatedObserved ?? null,
          callerHeader: headerOf(caller),
          rootHeader: headerOf(root),
        }
        appendFileSync(evidencePath, JSON.stringify(entry) + '\n', 'utf8')
      } catch (error) {
        console.error('[ecu-native-probe] evidence write failed:', error instanceof Error ? error.message : String(error))
      }
    }

    async function execute(args, exec) {
      const value = await evaluate(args, exec)
      writeEvidence(value, exec)
      return value
    }

    async function evaluate(args, exec) {
      if (!active) throw new Error('Identity probe is unloaded')
      exec?.signal?.throwIfAborted()
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
        throw new TypeError('Identity probe accepts only an empty object')
      }
      if (!exec || typeof exec !== 'object') return unverified('no-execution-context')
      const caller = exec.agent
      if (!isAgent(caller)) return unverified('no-caller-agent')
      const agents = ctx.agents
      if (typeof agents?.get !== 'function') return unverified('agent-registry-unavailable')
      try {
        if (agents.get(caller.id) !== caller) return unverified('caller-not-live')
      } catch {
        return unverified('agent-registry-error')
      }
      const subagents = ctx.subagents
      if (typeof subagents?.rootOf !== 'function') return unverified('subagents-unavailable')
      let root
      try {
        root = subagents.rootOf(caller)
      } catch {
        return unverified('root-unresolved')
      }
      if (!isAgent(root)) return unverified('root-unresolved')
      try {
        if (agents.get(root.id) !== root) return unverified('root-not-live')
      } catch {
        return unverified('agent-registry-error')
      }
      const callerRecord = recordFor(caller)
      const rootRecord = recordFor(root)
      if (callerRecord.disposed || rootRecord.disposed) return unverified('lifetime-disposed')
      if ((callerRecord.root && callerRecord.root !== rootRecord) ||
          (rootRecord.root && rootRecord.root !== rootRecord)) return unverified('root-changed')
      exec.signal?.throwIfAborted()
      rootRecord.root = rootRecord
      rootRecord.ordinal ??= ++nextOrdinal
      callerRecord.root = rootRecord
      callerRecord.ordinal ??= ++nextOrdinal
      return {
        probe: TOOL,
        schemaVersion: VERSION,
        verdict: 'verified', // Identity only, not lifecycle or full P1 acceptance.
        reason: 'ok',
        callerOrdinal: callerRecord.ordinal,
        rootOrdinal: rootRecord.ordinal,
        rootIsCaller: root === caller,
        callerCreatedObserved: callerRecord.created,
        rootCreatedObserved: rootRecord.created,
        recentDisposedOrdinals: [...(rootRecord.recentDisposals ?? [])],
      }
    }

    try {
      track(ctx.on('agent/created', onCreated))
      track(ctx.on('agent/disposed', onDisposed))
      track(ctx.tools.register({
        name: TOOL,
        description: 'Read-only native identity probe. Accepts no identity input. Reports only anonymous identity and lifecycle observations.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute,
      }))
      console.info(`[ecu-native-probe] registered tool=${TOOL} schemaVersion=${VERSION} pid=${process.pid}`)
    } catch (error) {
      try { cleanup() } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Identity probe activation and rollback failed')
      }
      throw error
    }
    return cleanup
  })
}
