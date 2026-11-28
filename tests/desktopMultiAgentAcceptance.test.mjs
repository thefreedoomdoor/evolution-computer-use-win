import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateAcceptance } from '../probes/desktop-multi-agent-acceptance/index.mjs'

const rootHeader = { id: 'root', parentSession: null, origin: null, delegationDepth: 0 }
const direct = (id) => ({
  callerId: id, rootId: 'root', verdict: 'verified', reason: 'ok', rootIsCaller: false,
  callerHeader: { id, parentSession: 'root', origin: 'subagent', delegationDepth: 1 },
})
const nested = (id, parent) => ({
  callerId: id, rootId: 'root', verdict: 'verified', reason: 'ok', rootIsCaller: false,
  callerHeader: { id, parentSession: parent, origin: 'subagent', delegationDepth: 2 },
})

test('accepts two direct children plus one nested grandchild under one root', () => {
  const result = evaluateAcceptance({
    rootId: 'root',
    rootHeader,
    directChildIds: ['a', 'b', 'c'],
    events: [direct('a'), direct('b'), direct('c'), nested('d', 'c')],
  })
  assert.equal(result.status, 'pass')
  assert.deepEqual(result.summary, {
    events: 4, directChildren: 3, grandchildren: 1,
    verdicts: [
      { callerId: 'a', verdict: 'verified', depth: 1 },
      { callerId: 'b', verdict: 'verified', depth: 1 },
      { callerId: 'c', verdict: 'verified', depth: 1 },
      { callerId: 'd', verdict: 'verified', depth: 2 },
    ],
  })
})

test('rejects a shallow tree, a wrong root and an unverified nested caller', () => {
  const shallow = evaluateAcceptance({ rootId: 'root', rootHeader, events: [direct('a')] })
  assert.equal(shallow.status, 'fail')

  const wrongRoot = evaluateAcceptance({
    rootId: 'root', rootHeader,
    events: [{ ...direct('a'), rootId: 'other' }, direct('b'), nested('d', 'b')],
  })
  assert.equal(wrongRoot.status, 'fail')

  const badNested = evaluateAcceptance({
    rootId: 'root', rootHeader,
    events: [direct('a'), direct('b'), { ...nested('d', 'b'), verdict: 'unverified' }],
  })
  assert.equal(badNested.status, 'fail')
})

test('rejects a marked root or more than one root', () => {
  const markedRoot = evaluateAcceptance({
    rootId: 'root',
    rootHeader: { ...rootHeader, origin: 'subagent', delegationDepth: 1, parentSession: 'parent' },
    events: [direct('a'), direct('b'), nested('d', 'b')],
  })
  assert.equal(markedRoot.status, 'fail')
})
