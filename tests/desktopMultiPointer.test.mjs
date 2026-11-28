import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pointerLabel, shouldTrackAgent } from '../probes/desktop-multi-pointer/index.mjs'
import {
  createPointerStore,
  createPointerStateWriter,
  isTrackableActor,
  writeStateAtomic,
  DEFAULT_PALETTE,
  TERMINAL_PHASES,
  isTerminalPhase,
} from '../src/desktop/pointerState.ts'

function agent(id, header) {
  return { id, session: { header } }
}

test('root without subagent origin is never tracked', () => {
  assert.equal(shouldTrackAgent(agent('root', { origin: null }), {}), false)
})

test('direct and nested subagents are tracked', () => {
  assert.equal(shouldTrackAgent(agent('child', { origin: 'subagent' }), {}), true)
  assert.equal(shouldTrackAgent(agent('grandchild', { origin: 'subagent' }), {}), true)
})

test('fallback uses runtime root and excludes the root itself', () => {
  const child = agent('child', {})
  const root = agent('root', {})
  const ctx = { subagents: { rootOf: (value) => (value === child ? root : value) } }
  assert.equal(shouldTrackAgent(child, ctx), true)
  assert.equal(shouldTrackAgent(root, ctx), false)
})

test('pointer labels are stable and identify the agent', () => {
  assert.equal(pointerLabel(agent('abcdef123456', {}), 2), 'Agent 2 - abcdef')
  assert.equal(pointerLabel({}, 3), 'Agent 3')
})

test('overlay helper renders vector cursors, not text labels', () => {
  const script = readFileSync(fileURLToPath(new URL('../scripts/multi-pointer.ps1', import.meta.url)), 'utf8')
  const overlay = readFileSync(fileURLToPath(new URL('../scripts/windows-takeover.cs', import.meta.url)), 'utf8')
  assert.match(script, /MultiPointerOverlay/)
  assert.match(script, /windows-takeover\.cs/)
  assert.match(overlay, /class MultiPointerFrame/)
  // The live overlay paints vector cursors through DrawVisualsInto into a
  // persistent DIB-backed surface and presents it with UpdateLayeredWindow.
  // It must not fall back to the allocating Bitmap helper for live frames.
  assert.match(overlay, /PointerFrame\.DrawVisualsInto\(g, visuals, screen\)/)
  assert.match(overlay, /EnsureSurface\(\)/)
  assert.match(overlay, /Native\.CreateArgbDib\(/)
  assert.match(overlay, /persistent DIB/)
  assert.match(overlay, /UpdateLayeredWindow/)
  assert.doesNotMatch(overlay, /PointerFrame\.DrawVisuals\(visuals, screen\)/)
  assert.match(overlay, /class PointerVisual/)
  assert.match(overlay, /DrawArrow/)
})

// --- pointer state writer coverage (task-39) ------------------------------------------------

function makeClock(start = 1000) {
  let value = start
  return {
    now: () => value,
    set(next) {
      value = next
    },
    advance(ms) {
      value += ms
    },
  }
}

function makeActor(over = {}) {
  return {
    trust: 'trusted',
    agentId: 'a1',
    rootAgentId: 'root',
    depth: 1,
    lifetime: 1,
    ...over,
  }
}

function pt(x, y) {
  return { x, y }
}

function makeEvent(over = {}) {
  const base = {
    kind: 'desktop-action',
    requestId: 'req-1',
    seq: 1,
    phase: 'executing',
    actor: makeActor(),
    area: 'global',
    action: { kind: 'move' },
    space: 'physical',
    sampleMs: 1000,
    at: 1000,
  }
  const merged = { ...base, ...over }
  merged.actor = { ...base.actor, ...(over.actor || {}) }
  merged.action = { ...base.action, ...(over.action || {}) }
  return merged
}

function storeWith(clock, over = {}) {
  return createPointerStore({ now: clock.now, ...over })
}

function first(store) {
  return store.snapshot()[0]
}

function tempStatePath() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pointer-state-'))
  return { dir, statePath: join(dir, 'nested', 'state.json') }
}

function readState(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function tempFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map((name) => String(name))
    .filter((name) => name.endsWith('.tmp'))
}

function containsNull(value) {
  if (value === null) return true
  if (Array.isArray(value)) return value.some(containsNull)
  if (value && typeof value === 'object') return Object.values(value).some(containsNull)
  return false
}

test('only a trusted, non-root, stable-lifetime identity is drawable', () => {
  assert.equal(isTrackableActor(makeActor()), true)
  const rejected = [
    makeActor({ trust: 'legacy' }),
    makeActor({ trust: 'unknown' }),
    makeActor({ agentId: 'root', rootAgentId: 'root' }),
    makeActor({ depth: 0 }),
    makeActor({ depth: -1 }),
    makeActor({ lifetime: Number.NaN }),
    makeActor({ lifetime: Number.POSITIVE_INFINITY }),
    makeActor({ lifetime: 0 }),
    makeActor({ lifetime: 1.5 }),
    makeActor({ agentId: '' }),
    makeActor({ rootAgentId: '' }),
    null,
    'trusted',
  ]
  for (const actor of rejected) assert.equal(isTrackableActor(actor), false)

  const clock = makeClock()
  const store = storeWith(clock)
  assert.equal(store.spawn(makeActor({ trust: 'legacy' })), false)
  assert.equal(store.spawn(makeActor({ agentId: 'root', rootAgentId: 'root' })), false)
  assert.equal(store.ingest(makeEvent({ actor: makeActor({ trust: 'legacy' }), to: pt(300, 200) })), false)
  assert.equal(store.ingest(makeEvent({ actor: makeActor({ agentId: 'root', rootAgentId: 'root' }), to: pt(1, 2) })), false)
  assert.equal(store.ingest(makeEvent({ actor: makeActor({ lifetime: Number.NaN }), to: pt(3, 4) })), false)
  assert.equal(store.size(), 0)
})

test('spawn asks the renderer to anchor at the real cursor and never fabricates coordinates', () => {
  const store = storeWith(makeClock())
  assert.equal(store.spawn(makeActor()), true)
  const entry = first(store)
  assert.equal(entry.id, 'a1')
  assert.equal(entry.epoch, 1)
  assert.equal(entry.seq, 1)
  assert.equal(entry.sampleMs, 0)
  assert.equal(entry.motionMs, 0)
  assert.equal(entry.opacity, 1)
  assert.equal(entry.headingRestore, true)
  assert.equal(entry.cursorAnchor, 'spawn')
  assert.equal(entry.color, DEFAULT_PALETTE[0])
  assert.equal(entry.ordinal, 1)
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'x'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'y'), false)
  assert.equal(store.spawn(makeActor()), false)
  assert.equal(store.size(), 1)
})

test('reusing an agent id with a new lifetime is epoch isolated', () => {
  const clock = makeClock()
  const store = storeWith(clock)
  assert.equal(store.spawn(makeActor({ lifetime: 1 })), true)
  assert.equal(store.spawn(makeActor({ lifetime: 2 })), true)
  assert.equal(store.size(), 1)
  assert.equal(first(store).epoch, 2)
  // A late event from the old lifetime can never resurrect the old pointer.
  assert.equal(store.spawn(makeActor({ lifetime: 1 })), false)
  assert.equal(store.size(), 1)
  assert.equal(store.ingest(makeEvent({ actor: makeActor({ lifetime: 2 }), to: pt(500, 400), sampleMs: 1100 })), true)
  assert.equal(store.ingest(makeEvent({ actor: makeActor({ lifetime: 1 }), to: pt(100, 100), sampleMs: 1200 })), false)
  assert.equal(store.size(), 1)
  assert.equal(first(store).epoch, 2)
  assert.equal(first(store).x, 500)
  assert.equal(first(store).y, 400)
})

test('the first real target keeps the spawn anchor and later frames retarget from it', () => {
  const clock = makeClock()
  const store = storeWith(clock)
  assert.equal(store.ingest(makeEvent({ to: pt(300, 200), sampleMs: 1000 })), true)
  let entry = first(store)
  assert.equal(entry.x, 300)
  assert.equal(entry.y, 200)
  assert.equal(entry.seq, 2)
  assert.equal(entry.cursorAnchor, 'spawn')
  assert.equal(entry.opacity, 1)
  assert.equal(entry.sampleMs, 1000)
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'headingDeg'), false)

  assert.equal(store.ingest(makeEvent({ seq: 2, phase: 'progress', to: pt(320, 220), sampleMs: 1016 })), true)
  entry = first(store)
  assert.equal(entry.seq, 3)
  assert.equal(entry.sampleMs, 1016)
  assert.equal(entry.motionMs, 16)
  // Sticky: later frames keep asking the renderer to depart from the real cursor, so a poll that
  // lands after several writes still cannot pop the pointer onto its target.
  assert.equal(entry.cursorAnchor, 'spawn')
  assert.ok(Math.abs(entry.headingDeg - 45) < 1e-9)
  assert.equal(entry.path, undefined)
  assert.equal(store.size(), 1)
})

test('each progress event retargets from real progress instead of replaying a path', () => {
  const clock = makeClock()
  const store = storeWith(clock)
  assert.equal(store.ingest(makeEvent({ seq: 1, to: pt(300, 200), sampleMs: 1000 })), true)
  assert.equal(store.ingest(makeEvent({ seq: 2, phase: 'progress', to: pt(310, 205), sampleMs: 1016 })), true)
  assert.equal(store.ingest(makeEvent({ seq: 3, phase: 'progress', to: pt(330, 215), sampleMs: 1032 })), true)
  const entry = first(store)
  assert.equal(entry.seq, 4)
  assert.equal(entry.path, undefined)
  assert.equal(entry.x, 330)
  assert.equal(entry.y, 215)
  assert.equal(entry.sampleMs, 1032)
})

test('stale sequence numbers and older samples are ignored', () => {
  const clock = makeClock()
  const store = storeWith(clock)
  assert.equal(store.ingest(makeEvent({ requestId: 'req-open', seq: 5, to: pt(300, 200), sampleMs: 2000 })), true)
  assert.equal(store.ingest(makeEvent({ requestId: 'req-open', seq: 3, to: pt(400, 400), sampleMs: 2100 })), false)
  let entry = first(store)
  assert.equal(entry.x, 300)
  assert.equal(entry.y, 200)
  assert.equal(store.ingest(makeEvent({ requestId: 'req-open', seq: 6, to: pt(410, 410), sampleMs: 1500 })), false)
  entry = first(store)
  assert.equal(entry.x, 300)
  assert.equal(entry.y, 200)
  assert.equal(store.ingest(makeEvent({ requestId: 'req-open', seq: 6, to: pt(310, 210), sampleMs: 2001 })), true)
  assert.equal(first(store).x, 310)
})

test('every terminal phase closes its request and rests at the last real target', () => {
  for (const phase of ['succeeded', 'cancelled', 'failed', 'uncertain']) {
    const clock = makeClock()
    const store = storeWith(clock)
    assert.equal(isTerminalPhase(phase), true)
    assert.equal(store.ingest(makeEvent({ to: pt(300, 200), sampleMs: 1000 })), true)
    assert.equal(store.ingest(makeEvent({ phase, seq: 2, to: pt(400, 300), sampleMs: 1050 })), true)
    let entry = first(store)
    assert.equal(entry.x, 400, phase)
    assert.equal(entry.y, 300, phase)
    assert.equal(entry.opacity, 1, phase)
    assert.equal(entry.path, undefined, phase)
    assert.equal(entry.headingDeg, undefined, phase)
    assert.equal(store.ingest(makeEvent({ phase: 'progress', seq: 3, to: pt(500, 500), sampleMs: 1070 })), false, phase)
    entry = first(store)
    assert.equal(entry.x, 400, phase)
    assert.equal(entry.y, 300, phase)
  }
  assert.equal(TERMINAL_PHASES.size, 4)
  assert.equal(isTerminalPhase('queued'), false)
  assert.equal(isTerminalPhase('executing'), false)
  assert.equal(isTerminalPhase('progress'), false)
})

test('a terminal event without coordinates never leaves a ghost pointer', () => {
  const clock = makeClock()
  const store = storeWith(clock)
  assert.equal(store.ingest(makeEvent({ phase: 'succeeded' })), false)
  assert.equal(store.size(), 0)
})

test('a terminal event without coordinates still closes an already-positioned pointer', () => {
  const clock = makeClock(1000)
  const store = storeWith(clock)
  assert.equal(store.ingest(makeEvent({ to: pt(300, 200), sampleMs: 1000 })), true)
  assert.equal(store.ingest(makeEvent({ seq: 2, phase: 'cancelled', sampleMs: 1016 })), true)
  assert.equal(first(store).x, 300)
  assert.equal(first(store).opacity, 1)
  // Post-terminal events for that requestId cannot resurrect motion.
  assert.equal(store.ingest(makeEvent({ seq: 3, phase: 'progress', to: pt(500, 500), sampleMs: 1032 })), false)
  assert.equal(first(store).x, 300)
})

test('queued/granted without coordinates neither draw nor retire the same lifetime', () => {
  const clock = makeClock(1000)
  const store = storeWith(clock)
  const actor = makeActor()
  assert.equal(store.ingest(makeEvent({ requestId: 'req-a', phase: 'queued', seq: 1 })), false)
  assert.equal(store.ingest(makeEvent({ requestId: 'req-a', phase: 'granted', seq: 2 })), false)
  assert.equal(store.size(), 0)
  assert.equal(store.has(actor), false)
  // The same request's first real point must still anchor normally (the key was not retired).
  assert.equal(
    store.ingest(makeEvent({ requestId: 'req-a', phase: 'approaching', seq: 3, from: pt(640, 480), sampleMs: 1100 })),
    true
  )
  const entry = first(store)
  assert.equal(entry.id, 'a1')
  assert.equal(entry.cursorAnchor, 'spawn')
  assert.equal(entry.x, 640)
  assert.equal(entry.y, 480)
  assert.equal(entry.seq, 2)
})

test('an unpositioned pending action never leaks into another pointer snapshot', (t) => {
  const { dir, statePath } = tempStatePath()
  try {
    const clock = makeClock(1000)
    const writer = createPointerStateWriter({ statePath, now: clock.now })
    const a = makeActor()
    const b = makeActor({ agentId: 'b1' })
    assert.equal(writer.ingest(makeEvent({ requestId: 'req-a', phase: 'queued', seq: 1, actor: a })), false)
    assert.equal(writer.store.size(), 0)
    assert.equal(existsSync(statePath), false)
    // A different pointer gets positioned: its first full snapshot must contain only itself.
    assert.equal(writer.ingest(makeEvent({ requestId: 'req-b', seq: 1, actor: b, to: pt(500, 400) })), true)
    const afterB = readState(statePath).pointers
    assert.deepEqual(afterB.map((row) => row.id), ['b1'])
    assert.equal(afterB[0].cursorAnchor, 'spawn')
    // A's first real target still writes a spawn anchor + target in ONE snapshot.
    clock.set(1100)
    assert.equal(
      writer.ingest(makeEvent({ requestId: 'req-a', phase: 'approaching', seq: 2, actor: a, to: pt(640, 480), sampleMs: 1100 })),
      true
    )
    const rows = readState(statePath).pointers
    assert.deepEqual(rows.map((row) => row.id).sort(), ['a1', 'b1'])
    const rowA = rows.find((row) => row.id === 'a1')
    assert.equal(rowA.cursorAnchor, 'spawn')
    assert.equal(rowA.x, 640)
    assert.equal(rowA.y, 480)
    assert.equal(rowA.motionMs, 200)
    assert.equal(containsNull(rows), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('several real writes before the native poll still leave the spawn anchor in the final document', (t) => {
  const { dir, statePath } = tempStatePath()
  try {
    const clock = makeClock(1000)
    const writer = createPointerStateWriter({ statePath, now: clock.now })
    const actor = makeActor()
    // The native renderer polls the file at ~16ms, so it can miss every intermediate snapshot and
    // only ever read the last one. Approaching + two progress rows land back to back here.
    assert.equal(writer.ingest(makeEvent({ phase: 'approaching', seq: 1, from: pt(640, 480), sampleMs: 1000 })), true)
    assert.equal(writer.ingest(makeEvent({ phase: 'executing', seq: 2, to: pt(700, 500), sampleMs: 1004 })), true)
    assert.equal(writer.ingest(makeEvent({ phase: 'progress', seq: 3, to: pt(760, 540), sampleMs: 1012 })), true)
    const rows = readState(statePath).pointers
    assert.equal(rows.length, 1)
    const row = rows[0]
    // The anchor must survive: the renderer still samples the real cursor and departs from it.
    assert.equal(row.cursorAnchor, 'spawn')
    assert.equal(row.x, 760)
    assert.equal(row.y, 540)
    assert.equal(row.seq, 4)
    assert.equal(row.sampleMs, 1012)
    // A progress row's motion is the real sample delta, clamped to [16, defaultMotionMs].
    assert.equal(row.motionMs, 16)
    // A later write is still an ordinary retarget and still keeps the anchor.
    assert.equal(writer.ingest(makeEvent({ phase: 'progress', seq: 4, to: pt(800, 560), sampleMs: 1028 })), true)
    const later = readState(statePath).pointers[0]
    assert.equal(later.cursorAnchor, 'spawn')
    assert.equal(later.x, 800)
    assert.equal(later.seq, 5)
    assert.deepEqual(tempFiles(dir), [])
    // Release overrides the anchor and is the only row that asks for a fresh sample.
    clock.set(1200)
    assert.equal(writer.release(actor), true)
    const fading = readState(statePath).pointers[0]
    assert.equal(fading.cursorAnchor, 'release')
    assert.equal(fading.opacity, 0)
    assert.equal(fading.x, 800)
    assert.equal(fading.y, 560)
    // The release row stays long enough (releaseMs + margin) for a 16ms poll to see the anchor.
    assert.equal(writer.sweep(1519), false)
    assert.equal(writer.sweep(1520), true)
    assert.deepEqual(readState(statePath), { pointers: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('release asks the renderer to merge back to the real cursor and then disappears', () => {
  const clock = makeClock(1000)
  const store = storeWith(clock, { releaseMs: 200 })
  assert.equal(store.ingest(makeEvent({ to: pt(300, 200), sampleMs: 1000 })), true)
  assert.equal(store.release(makeActor()), true)
  const entry = first(store)
  assert.equal(entry.x, 300)
  assert.equal(entry.y, 200)
  assert.equal(entry.opacity, 0)
  assert.equal(entry.cursorAnchor, 'release')
  assert.equal(entry.motionMs, 200)
  assert.equal(entry.seq, 3)
  assert.equal(store.sweep(1319), false)
  assert.equal(store.size(), 1)
  assert.equal(store.sweep(1320), true)
  assert.equal(store.size(), 0)
})

test('a pointer that never received a real coordinate is removed on release', () => {
  const clock = makeClock()
  const store = storeWith(clock)
  assert.equal(store.spawn(makeActor()), true)
  assert.equal(store.release(makeActor()), true)
  assert.equal(store.size(), 0)
})

test('a released epoch never comes back after its row is swept', () => {
  const clock = makeClock(1000)
  const store = storeWith(clock, { releaseMs: 200 })
  assert.equal(store.ingest(makeEvent({ to: pt(300, 200), sampleMs: 1000 })), true)
  assert.equal(store.release(makeActor()), true)
  assert.equal(store.sweep(1320), true)
  assert.equal(store.size(), 0)
  // Same (id, epoch) must not resurrect: the renderer already removed that pointer.
  assert.equal(store.spawn(makeActor()), false)
  assert.equal(store.ingest(makeEvent({ seq: 9, to: pt(700, 700), sampleMs: 1300 })), false)
  assert.equal(store.size(), 0)
  // A new Agent lifetime is a new epoch and starts a fresh pointer.
  assert.equal(store.ingest(makeEvent({ actor: makeActor({ lifetime: 2 }), to: pt(700, 700), sampleMs: 1300 })), true)
  assert.equal(store.size(), 1)
  assert.equal(first(store).epoch, 2)
})

test('duplicate or unknown releases are ignored', () => {
  const clock = makeClock(1000)
  const store = storeWith(clock)
  assert.equal(store.ingest(makeEvent({ to: pt(300, 200), sampleMs: 1000 })), true)
  assert.equal(store.release(makeActor()), true)
  assert.equal(store.release(makeActor()), false)
  assert.equal(store.release(makeActor({ agentId: 'other' })), false)
  assert.equal(store.release(makeActor({ trust: 'legacy' })), false)
})

test('heading follows the real direction of travel', () => {
  const right = storeWith(makeClock())
  assert.equal(right.ingest(makeEvent({ to: pt(100, 100), sampleMs: 1000 })), true)
  assert.equal(right.ingest(makeEvent({ seq: 2, phase: 'progress', to: pt(200, 100), sampleMs: 1016 })), true)
  assert.ok(Math.abs(first(right).headingDeg - 0) < 1e-9)

  const down = storeWith(makeClock())
  assert.equal(down.ingest(makeEvent({ to: pt(100, 100), sampleMs: 1000 })), true)
  assert.equal(down.ingest(makeEvent({ seq: 2, phase: 'progress', to: pt(100, 200), sampleMs: 1016 })), true)
  assert.ok(Math.abs(first(down).headingDeg - 90) < 1e-9)
})

test('events from an older mode epoch are dropped before they can spawn', () => {
  const clock = makeClock()
  let current = 5
  const store = storeWith(clock, { modeEpoch: () => current })
  assert.equal(store.ingest(makeEvent({ epoch: 3, to: pt(300, 200) })), false)
  assert.equal(store.size(), 0)
  assert.equal(store.ingest(makeEvent({ epoch: 5, to: pt(300, 200), sampleMs: 1000 })), true)
  assert.equal(first(store).x, 300)
  current = 6
  assert.equal(store.ingest(makeEvent({ epoch: 5, seq: 2, to: pt(400, 400), sampleMs: 1010 })), false)
  assert.equal(first(store).x, 300)
})

test('payload rows carry the documented native schema and no null values', () => {
  const clock = makeClock()
  const store = storeWith(clock)
  const allowed = new Set([
    'id',
    'epoch',
    'label',
    'color',
    'x',
    'y',
    'seq',
    'sampleMs',
    'motionMs',
    'opacity',
    'ordinal',
    'headingRestore',
    'cursorAnchor',
    'headingDeg',
    'path',
    'phase',
  ])

  assert.equal(store.ingest(makeEvent({ to: pt(300, 200), sampleMs: 1000 })), true)
  let doc = JSON.parse(store.payload())
  assert.equal(Array.isArray(doc.pointers), true)
  assert.equal(doc.pointers.length, 1)
  let row = doc.pointers[0]
  for (const key of [
    'id',
    'epoch',
    'label',
    'color',
    'x',
    'y',
    'seq',
    'sampleMs',
    'motionMs',
    'opacity',
    'ordinal',
    'headingRestore',
    'cursorAnchor',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, key), true, key)
  }
  assert.equal(row.x, 300)
  assert.equal(row.y, 200)
  assert.equal(row.cursorAnchor, 'spawn')
  assert.equal(typeof row.epoch, 'number')
  assert.equal(containsNull(row), false)

  assert.equal(store.ingest(makeEvent({ seq: 2, phase: 'progress', to: pt(340, 260), sampleMs: 1016 })), true)
  doc = JSON.parse(store.payload())
  assert.equal(doc.pointers.length, 1)
  row = doc.pointers[0]
  // A plain retarget: heading is present, no path (path would be followed from its first point).
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'headingDeg'), true)
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'path'), false)
  assert.equal(row.cursorAnchor, 'spawn')
  assert.equal(containsNull(row), false)
  for (const key of Object.keys(row)) assert.equal(allowed.has(key), true, key)
})

test('writer writes one atomic snapshot per action and leaves no temp files', (t) => {
  const clock = makeClock(1000)
  const { dir, statePath } = tempStatePath()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const writer = createPointerStateWriter({ statePath, now: clock.now })
  assert.equal(existsSync(statePath), false)
  writer.flush()
  assert.deepEqual(readState(statePath), { pointers: [] })

  assert.equal(writer.ingest(makeEvent({ to: pt(300, 200), sampleMs: 1000 })), true)
  let doc = readState(statePath)
  assert.equal(doc.pointers.length, 1)
  assert.equal(doc.pointers[0].x, 300)
  assert.equal(doc.pointers[0].y, 200)
  assert.equal(doc.pointers[0].cursorAnchor, 'spawn')
  assert.deepEqual(tempFiles(dir), [])

  assert.equal(writer.ingest(makeEvent({ seq: 2, phase: 'progress', to: pt(320, 220), sampleMs: 1016 })), true)
  doc = readState(statePath)
  assert.equal(doc.pointers.length, 1)
  assert.equal(doc.pointers[0].x, 320)
  assert.equal(doc.pointers[0].seq, 3)
  assert.equal(doc.pointers[0].cursorAnchor, 'spawn')
  assert.deepEqual(tempFiles(dir), [])
})

test('the first row of a new pointer carries anchor and target in one snapshot', (t) => {
  const clock = makeClock(1000)
  const { dir, statePath } = tempStatePath()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const writer = createPointerStateWriter({ statePath, now: clock.now })
  const actor = makeActor()
  assert.equal(writer.ingest(makeEvent({ to: pt(300, 200), sampleMs: 1000 })), true)
  const row = readState(statePath).pointers[0]
  assert.equal(row.cursorAnchor, 'spawn')
  assert.equal(row.x, 300)
  assert.equal(row.y, 200)
  // One write, and the anchor is still on the in-memory row afterwards (nothing consumes it).
  assert.equal(writer.store.get(actor).cursorAnchor, 'spawn')
})

test('writer.spawn writes an anchor-only row and the next target is ordinary', (t) => {
  const clock = makeClock(1000)
  const { dir, statePath } = tempStatePath()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const writer = createPointerStateWriter({ statePath, now: clock.now })
  const actor = makeActor()
  assert.equal(writer.spawn(actor, { label: 'Tester', color: '#123456' }), true)
  let row = readState(statePath).pointers[0]
  assert.equal(row.cursorAnchor, 'spawn')
  assert.equal(row.label, 'Tester')
  assert.equal(row.color, '#123456')
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'x'), false)
  assert.equal(writer.ingest(makeEvent({ to: pt(300, 200), sampleMs: 1000 })), true)
  row = readState(statePath).pointers[0]
  assert.equal(row.x, 300)
  assert.equal(row.seq, 2)
  assert.equal(row.cursorAnchor, 'spawn')
})

test('writer.release merges, then the sweep removes the faded row', (t) => {
  const clock = makeClock(1000)
  const { dir, statePath } = tempStatePath()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const writer = createPointerStateWriter({ statePath, now: clock.now, releaseMs: 200 })
  const actor = makeActor()
  assert.equal(writer.ingest(makeEvent({ to: pt(300, 200), sampleMs: 1000 })), true)
  assert.equal(writer.release(actor), true)
  let row = readState(statePath).pointers[0]
  assert.equal(row.opacity, 0)
  assert.equal(row.cursorAnchor, 'release')
  assert.equal(row.x, 300)
  assert.equal(row.y, 200)
  clock.set(1200)
  assert.equal(writer.sweep(), false)
  clock.set(1320)
  assert.equal(writer.sweep(), true)
  assert.deepEqual(readState(statePath), { pointers: [] })
  assert.equal(writer.sweep(), false)
})

test('writer.clear removes every pointer and is idempotent', (t) => {
  const clock = makeClock(1000)
  const { dir, statePath } = tempStatePath()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const writer = createPointerStateWriter({ statePath, now: clock.now })
  assert.equal(writer.ingest(makeEvent({ to: pt(300, 200), sampleMs: 1000 })), true)
  assert.equal(
    writer.ingest(makeEvent({
      requestId: 'req-2',
      actor: makeActor({ agentId: 'a2' }),
      to: pt(500, 400),
      sampleMs: 1000,
    })),
    true,
  )
  assert.equal(readState(statePath).pointers.length, 2)
  assert.equal(writer.clear(), true)
  assert.deepEqual(readState(statePath), { pointers: [] })
  assert.equal(writer.clear(), false)
})

test('writer does not spawn or write for a terminal event without coordinates', (t) => {
  const clock = makeClock(1000)
  const { dir, statePath } = tempStatePath()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const writer = createPointerStateWriter({ statePath, now: clock.now })
  assert.equal(writer.ingest(makeEvent({ phase: 'succeeded' })), false)
  assert.equal(writer.store.size(), 0)
  assert.equal(existsSync(statePath), false)
})

test('an event with no request id cannot leave an unflushed anchor row', (t) => {
  const clock = makeClock(1000)
  const { dir, statePath } = tempStatePath()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const writer = createPointerStateWriter({ statePath, now: clock.now })
  assert.equal(writer.ingest(makeEvent({ requestId: '', to: pt(300, 200) })), false)
  assert.equal(writer.store.size(), 0)
  assert.equal(existsSync(statePath), false)
  // The same lifetime still draws once a valid event arrives.
  assert.equal(writer.ingest(makeEvent({ requestId: 'req-2', to: pt(300, 200) })), true)
  assert.equal(first(writer.store).id, 'a1')
})

test('writeStateAtomic replaces the target with exact bytes and no temp residue', (t) => {
  const { dir, statePath } = tempStatePath()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeStateAtomic(statePath, '{"pointers":[]}')
  assert.equal(readFileSync(statePath, 'utf8'), '{"pointers":[]}')
  writeStateAtomic(statePath, '{"pointers":[{"id":"a"}]}')
  assert.equal(readFileSync(statePath, 'utf8'), '{"pointers":[{"id":"a"}]}')
  assert.deepEqual(tempFiles(dir), [])
})

test('output seq strictly increases and sampleMs never decreases over one action', () => {
  const clock = makeClock()
  const store = storeWith(clock)
  const events = [
    makeEvent({ seq: 1, to: pt(100, 100), sampleMs: 1000 }),
    makeEvent({ seq: 2, phase: 'progress', to: pt(110, 105), sampleMs: 1016 }),
    makeEvent({ seq: 3, phase: 'progress', to: pt(130, 110), sampleMs: 1032 }),
    makeEvent({ seq: 4, phase: 'succeeded', to: pt(140, 115), sampleMs: 1040 }),
  ]
  const seqs = []
  const samples = []
  for (const event of events) {
    assert.equal(store.ingest(event), true)
    seqs.push(first(store).seq)
    samples.push(first(store).sampleMs)
  }
  for (let index = 1; index < seqs.length; index += 1) {
    assert.ok(seqs[index] > seqs[index - 1], 'seq ' + index)
    assert.ok(samples[index] >= samples[index - 1], 'sample ' + index)
  }
  assert.equal(first(store).x, 140)
  assert.equal(first(store).y, 115)
  assert.equal(first(store).path, undefined)
})
