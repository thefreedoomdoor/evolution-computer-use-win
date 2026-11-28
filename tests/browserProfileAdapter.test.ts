import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readProfileAnswer } from '../src/computer.ts';
import { browserProcessIds, type Cdp } from '../src/browser/cdp.ts';

// These two functions are the strict edges of the profile proof: the parser that decides whether a desktop helper's
// `browserProfile` answer may be trusted as a partition of exactly the processes that were asked about, and the reader
// of Chromium's own process list, which must refuse a damaged list rather than quietly report the survivors as complete.
// Everything here is offline: a plain object stands in for the helper's answer and for the browser's socket.

const WANT = 'C:\\Users\\freezingcold\\AppData\\Local\\evolution-cu\\profiles\\agent-1';
const OTHER = 'C:\\Users\\freezingcold\\AppData\\Local\\evolution-cu\\profiles\\agent-2';

const answer = (patch: Record<string, unknown> = {}) => ({
  status: 'matched',
  complete: true,
  incompleteReason: null,
  expected: WANT,
  candidates: 2,
  matched: [4200, 4300],
  unmatched: [],
  unknown: [],
  evidence: [],
  ...patch,
});

test('a complete reading that names every asked process is trusted whole', () => {
  assert.deepEqual(readProfileAnswer(answer(), [4200, 4300], WANT), [4200, 4300]);
});

test('a complete reading that splits the asked processes yields only the matching side', () => {
  const split = answer({ matched: [4200], unmatched: [4300] });
  assert.deepEqual(readProfileAnswer(split, [4200, 4300], WANT), [4200]);
});

test('the profile path is compared loosely but never ignored', () => {
  const spaced = answer({ expected: 'c:/Users/freezingcold/AppData/Local/evolution-cu/profiles/agent-1/' });
  assert.deepEqual(readProfileAnswer(spaced, [4200, 4300], WANT), [4200, 4300], 'case, slashes and a trailing separator name the same folder');
  assert.equal(readProfileAnswer(answer({ expected: OTHER }), [4200, 4300], WANT), null, 'another folder is another profile');
  assert.equal(readProfileAnswer(answer({ expected: '' }), [4200, 4300], WANT), null);
});

test('any doubt about completeness refuses the whole reading', () => {
  const doubts: Record<string, unknown>[] = [
    { unknown: undefined },
    { unknown: null },
    { unknown: [{ pid: 4200, reason: 'access denied' }] },
    { complete: false },
    { complete: 'true' },
    { status: 'mismatch' },
    { status: 'unknown' },
    { status: undefined },
    { incompleteReason: 'one process unreadable' },
  ];
  for (const patch of doubts) {
    assert.equal(readProfileAnswer(answer(patch), [4200, 4300], WANT), null, JSON.stringify(patch));
  }
});

test('the partition has to be exact: no overlap, no foreign process, nothing missing', () => {
  const bad: Record<string, unknown>[] = [
    { matched: [4200, 4300], unmatched: [4300], candidates: 2 },              // same process on both sides
    { matched: [4200, 999], unmatched: [], candidates: 2 },                   // a process never asked about
    { matched: [4200], unmatched: [], candidates: 2 },                        // one asked process missing
    { matched: [4200, 4300], unmatched: [], candidates: 3 },                  // the count does not add up
    { matched: [4200, 4300], unmatched: [4300], candidates: 3 },              // overlap hidden by the count
    { matched: [], unmatched: [4200, 4300], candidates: 2 },                  // nothing matched at all
    { matched: [4200, 4200], unmatched: [4300], candidates: 3 },              // a process listed twice
    { matched: [4200, 4300], unmatched: [], candidates: 0 },
    { matched: [4200, 4300], unmatched: [], candidates: 2.5 },
    { matched: [4200, '4300'], unmatched: [], candidates: 2 },
    { matched: [4200, -1], unmatched: [], candidates: 2 },
    { matched: 'x', unmatched: [], candidates: 2 },
    { matched: [4200, 4300], unmatched: {}, candidates: 2 },
  ];
  for (const patch of bad) {
    assert.equal(readProfileAnswer(answer(patch), [4200, 4300], WANT), null, JSON.stringify(patch));
  }
});

test('a reading about no processes, or more than the helper compares, is refused', () => {
  assert.equal(readProfileAnswer(answer({ matched: [], unmatched: [], candidates: 1 }), [], WANT), null, 'nothing was asked');
  const many = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.equal(readProfileAnswer(answer({ candidates: 9, matched: many }), many, WANT), null, 'more than one helper answer covers');
});

test('anything that is not an answer object at all is refused', () => {
  for (const value of [null, undefined, 42, 'matched', [], [answer()]]) {
    assert.equal(readProfileAnswer(value, [4200], WANT), null, JSON.stringify(value) ?? 'undefined');
  }
});

/** A browser socket that answers `SystemInfo.getProcessInfo` with whatever the test hands it, and records what was sent. */
function socket(processInfo: unknown) {
  const sent: string[] = [];
  const cdp = {
    send: async (method: string) => {
      sent.push(method);
      return { processInfo };
    },
    close: () => {},
  } as unknown as Cdp;
  return { cdp, sent };
}

test('a sound process list yields the browser processes once each', async () => {
  const { cdp, sent } = socket([
    { type: 'browser', id: 4200 },
    { type: 'browser', id: 4200 },
    { type: 'page', id: 4300 },
    { type: 'browser', id: 4301 },
  ]);
  assert.deepEqual(await browserProcessIds(cdp), [4200, 4301]);
  assert.deepEqual(sent, ['SystemInfo.getProcessInfo'], 'only the process list is read, nothing is activated');
});

test('a damaged process list is refused whole, never reported as the survivors', async () => {
  const damaged: unknown[] = [
    [{ type: 'browser', id: 4200 }, null],
    [{ type: 'browser', id: 4200 }, []],
    [{ type: 'browser', id: 4200 }, { type: 'browser', id: 0 }],
    [{ type: 'browser', id: 4200 }, { type: 'browser', id: -5 }],
    [{ type: 'browser', id: 4200 }, { type: 'browser', id: 4.5 }],
    [{ type: 'browser', id: 4200 }, { type: 'browser', id: '4301' }],
    [{ type: 'browser', id: 4200 }, { type: 'browser' }],
    [{ type: 'browser', id: 4200 }, { id: 4301 }],
    [{ type: 'browser', id: 4200 }, { type: '', id: 4301 }],
    [{ type: 'browser', id: 4200 }, { type: 7, id: 4301 }],
  ];
  for (const processInfo of damaged) {
    const { cdp } = socket(processInfo);
    assert.deepEqual(await browserProcessIds(cdp), [], JSON.stringify(processInfo));
  }
});

test('a missing or non-list answer names no processes', async () => {
  for (const processInfo of [undefined, null, {}, 'x', 5]) {
    const { cdp } = socket(processInfo);
    assert.deepEqual(await browserProcessIds(cdp), [], JSON.stringify(processInfo) ?? 'undefined');
  }
  const { cdp } = socket([]);
  assert.deepEqual(await browserProcessIds(cdp), []);
});
