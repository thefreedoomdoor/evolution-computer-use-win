/**
 * Isolated DSH Desktop acceptance driver for the multi-Agent identity gate.
 * It creates one real top-level Agent, starts two direct children plus a third
 * direct child that must spawn one nested grandchild through the host's own
 * subagent tool, and waits for the read-only identity probe evidence.
 * It never touches the Desktop and never writes to the main DSH profile.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'desktop-multi-agent-acceptance'
export const inject = ['tools', 'agents', 'subagents', 'agentPresets']

const DIRECT_NAMES = ['agent-alpha', 'agent-beta', 'agent-gamma']

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

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

function textOfOutput(output) {
  if (!Array.isArray(output)) return ''
  return output
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

export function evaluateAcceptance({ rootId, rootHeader, events, directChildIds = [] }) {
  const unique = new Map()
  for (const event of events) {
    if (event && typeof event.callerId === 'string' && !unique.has(event.callerId)) unique.set(event.callerId, event)
  }
  const all = [...unique.values()]
  const direct = all.filter(event =>
    event.callerHeader?.delegationDepth === 1 && event.callerHeader?.parentSession === rootId)
  const directIds = new Set([...directChildIds, ...direct.map(event => event.callerId)])
  const grandchildren = all.filter(event =>
    event.callerHeader?.delegationDepth === 2 && directIds.has(event.callerHeader?.parentSession))
  const directIdsFromEvents = new Set(direct.map(event => event.callerId))
  const checks = []
  const push = (id, ok, detail) => checks.push({ id, ok: ok === true, detail })

  push('root-is-top-level',
    rootHeader !== null && rootHeader.origin !== 'subagent' && (rootHeader.delegationDepth ?? 0) === 0,
    rootHeader ? { origin: rootHeader.origin, delegationDepth: rootHeader.delegationDepth, parentSession: rootHeader.parentSession } : 'root header unavailable')

  push('two-direct-children',
    directIdsFromEvents.size >= 2,
    { count: directIdsFromEvents.size, ids: [...directIdsFromEvents] })

  push('direct-children-verified',
    direct.length >= 2 && direct.every(event =>
      event.verdict === 'verified' && event.rootId === rootId && event.rootIsCaller === false &&
      event.callerHeader?.origin === 'subagent' && event.callerHeader?.parentSession === rootId),
    direct.map(event => ({
      callerId: event.callerId,
      verdict: event.verdict,
      reason: event.reason,
      rootIsCaller: event.rootIsCaller,
      origin: event.callerHeader?.origin ?? null,
      depth: event.callerHeader?.delegationDepth ?? null,
      parentSession: event.callerHeader?.parentSession ?? null,
    })))

  push('nested-grandchild-verified',
    grandchildren.length >= 1 && grandchildren.every(event =>
      event.verdict === 'verified' && event.rootId === rootId && event.rootIsCaller === false),
    grandchildren.map(event => ({
      callerId: event.callerId,
      verdict: event.verdict,
      reason: event.reason,
      rootIsCaller: event.rootIsCaller,
      depth: event.callerHeader?.delegationDepth ?? null,
      parentSession: event.callerHeader?.parentSession ?? null,
    })))

  push('all-calls-share-root',
    all.length >= 3 && all.every(event => event.rootId === rootId),
    { events: all.length, rootId })

  return {
    status: checks.every(check => check.ok) ? 'pass' : 'fail',
    checks,
    summary: {
      events: all.length,
      directChildren: directIdsFromEvents.size,
      grandchildren: grandchildren.length,
      verdicts: all.map(event => ({ callerId: event.callerId, verdict: event.verdict, depth: event.callerHeader?.delegationDepth ?? null })),
    },
  }
}

function readEvents(path) {
  if (!path || !existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
}

async function createRootWithRetry(ctx, options, signal) {
  let lastError
  for (let attempt = 0; attempt < 150; attempt++) {
    signal?.throwIfAborted()
    try {
      return await ctx.agents.create(options)
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (!/factory|not registered|not available|unavailable/i.test(message)) throw error
      await sleep(200)
    }
  }
  throw lastError ?? new Error('agent factory unavailable')
}

function childPrompt(name) {
  return [
    'You are a participant in a read-only identity acceptance run.',
    'Do exactly this and nothing else:',
    '1. Call the tool "ecu_pointer_identity_probe" exactly once with an empty object {}.',
    '2. Reply with the tool result JSON verbatim.',
    'Do not use any other tool. Do not write files.',
    'Your participant name is ' + name + '.',
  ].join('\n')
}

function gammaPrompt() {
  return [
    'You are a participant in a read-only identity acceptance run.',
    'Do exactly this and nothing else:',
    '1. Call the tool "ecu_pointer_identity_probe" exactly once with an empty object {}.',
    '2. Use the subagent tool exactly once to create one child named "agent-delta" with this prompt:',
    '   Call the tool "ecu_pointer_identity_probe" exactly once with an empty object {}, then reply DONE. Do not use any other tool.',
    '3. Wait for that child to finish, then reply DONE.',
    'Your participant name is agent-gamma.',
  ].join('\n')
}

function withTimeout(promise, ms, label, controller) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { controller?.abort() } catch {}
        reject(new Error('timeout after ' + ms + 'ms: ' + label))
      }, ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

export function apply(ctx, config = {}) {
  if (process.env.ECU_ACCEPTANCE !== '1') return
  const evidencePath = process.env.ECU_IDENTITY_EVIDENCE || config.evidencePath || ''
  const reportPath = process.env.ECU_ACCEPTANCE_REPORT || config.reportPath || ''
  const provider = process.env.ECU_ACCEPTANCE_PROVIDER || 'deepseek-account'
  const model = process.env.ECU_ACCEPTANCE_MODEL || 'deepseek-flash'
  const timeoutMs = Number(process.env.ECU_ACCEPTANCE_TIMEOUT_MS || 240000)
  if (!evidencePath || !reportPath) {
    console.error('[ecu-acceptance] ECU_IDENTITY_EVIDENCE and ECU_ACCEPTANCE_REPORT are required')
    return
  }
  mkdirSync(dirname(reportPath), { recursive: true })
  mkdirSync(dirname(evidencePath), { recursive: true })
  // Start from a clean evidence file for this acceptance run.
  try { writeFileSync(evidencePath, '', 'utf8') } catch {}
  const report = {
    version: 1,
    status: 'running',
    startedAt: new Date().toISOString(),
    root: null,
    children: [],
    evidencePath,
    checks: [],
    errors: [],
  }
  const writeReport = () => {
    try { writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8') } catch (error) {
      console.error('[ecu-acceptance] report write failed:', error instanceof Error ? error.message : String(error))
    }
  }
  const controller = new AbortController()
  let active = true

  ctx.effect(() => {
    const run = (async () => {
      try {
        if (typeof ctx.agents?.create !== 'function') throw new Error('agents.create unavailable')
        if (typeof ctx.subagents?.startActivation !== 'function') throw new Error('subagents.startActivation unavailable')
        if (typeof ctx.agentPresets?.mount !== 'function') throw new Error('agentPresets.mount unavailable')
        const rootHandle = await createRootWithRetry(ctx, {
          sessionId: randomUUID(),
          meta: { cwd: process.cwd() },
          agentOptions: { provider, model, reasoningEffort: 'high' },
          setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'standard') },
        }, controller.signal)
        const root = rootHandle.agent
        report.root = { id: root.id, header: headerOf(root), live: ctx.agents.get(root.id) === root }
        writeReport()
        if (!report.root.live) throw new Error('root agent is not live after creation')

        const common = {
          provider: 'spawn',
          delivery: 'parent',
          parent: root,
          signal: controller.signal,
          agentOptions: { provider, model, reasoningEffort: 'high' },
        }
        const starts = [
          ctx.subagents.startActivation({ ...common, name: DIRECT_NAMES[0], label: 'identity alpha', prompt: [{ type: 'text', text: childPrompt(DIRECT_NAMES[0]) }] }),
          ctx.subagents.startActivation({ ...common, name: DIRECT_NAMES[1], label: 'identity beta', prompt: [{ type: 'text', text: childPrompt(DIRECT_NAMES[1]) }] }),
          ctx.subagents.startActivation({ ...common, name: DIRECT_NAMES[2], label: 'identity gamma', prompt: [{ type: 'text', text: gammaPrompt() }] }),
        ]
        const started = await Promise.allSettled(starts)
        const activations = []
        for (let index = 0; index < started.length; index++) {
          const item = started[index]
          const base = { name: DIRECT_NAMES[index] }
          if (item.status === 'fulfilled') {
            activations.push(item.value)
            report.children.push({ ...base, childId: item.value.childId, activationName: item.value.name, started: true })
          } else {
            report.children.push({ ...base, started: false, error: item.reason instanceof Error ? item.reason.message : String(item.reason) })
            report.errors.push(base.name + ': ' + (item.reason instanceof Error ? item.reason.message : String(item.reason)))
          }
        }
        writeReport()
        if (!activations.length) throw new Error('no child activation started')

        const settled = await Promise.allSettled(activations.map(activation =>
          withTimeout(activation.result, timeoutMs, 'child result', controller)))
        const byChild = new Map(activations.map((activation, index) => [activation.childId, settled[index]]))
        for (const child of report.children) {
          if (!child.childId) continue
          const result = byChild.get(child.childId)
          if (!result) continue
          if (result.status === 'fulfilled') {
            child.stopReason = result.value?.stopReason ?? null
            child.output = textOfOutput(result.value?.output).slice(-2000)
            child.diagnostic = result.value?.diagnostic ?? null
          } else {
            child.error = result.reason instanceof Error ? result.reason.message : String(result.reason)
            report.errors.push(child.name + ' result: ' + child.error)
          }
        }
        writeReport()

        // Give the host one tick for any last probe evidence writes.
        await sleep(250)
        const events = readEvents(evidencePath)
        report.evidence = events
        const evaluation = evaluateAcceptance({
          rootId: root.id,
          rootHeader: report.root.header,
          events,
          directChildIds: activations.map(activation => activation.childId),
        })
        report.status = evaluation.status
        report.checks = evaluation.checks
        report.summary = evaluation.summary
        report.finishedAt = new Date().toISOString()
        writeReport()
        for (const activation of activations) {
          try { await activation.dispose() } catch (error) {
            report.errors.push('dispose ' + activation.childId + ': ' + (error instanceof Error ? error.message : String(error)))
          }
        }
        try { await rootHandle.dispose() } catch (error) {
          report.errors.push('dispose root: ' + (error instanceof Error ? error.message : String(error)))
        }
        report.finishedAt = new Date().toISOString()
        writeReport()
      } catch (error) {
        report.status = 'error'
        report.error = error instanceof Error ? error.message : String(error)
        report.finishedAt = new Date().toISOString()
        writeReport()
        console.error('[ecu-acceptance] failed:', report.error)
      }
    })()
    return () => {
      active = false
      try { controller.abort() } catch {}
      void run
    }
  }, 'desktop-multi-agent-acceptance.run()')
}
