import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryClaimOverlayLock, refreshOverlayLock, releaseOverlayLock } from '../src/desktop/overlay.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'evocu-lock-'));

test('first claim wins, the same holder re-claims, another live pid is held', () => {
  const d = dir();
  const file = join(d, 'overlay.lock');
  try {
    // hold it as this very process, so the holder is provably alive
    assert.equal(tryClaimOverlayLock(file, process.pid), 'claimed');
    assert.equal(parseInt(readFileSync(file, 'utf8'), 10), process.pid);
    // the same process asking again still owns it
    assert.equal(tryClaimOverlayLock(file, process.pid), 'claimed');
    // a different process must not steal a fresh lock held by a live pid
    assert.equal(tryClaimOverlayLock(file, 1111), 'held');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a dead holder is taken over', () => {
  const d = dir();
  const file = join(d, 'overlay.lock');
  try {
    // a pid that is certainly not alive
    writeFileSync(file, '999999');
    assert.equal(tryClaimOverlayLock(file, 2222), 'claimed');
    assert.equal(parseInt(readFileSync(file, 'utf8'), 10), 2222);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a holder that stopped refreshing is stale after the window', () => {
  const d = dir();
  const file = join(d, 'overlay.lock');
  try {
    writeFileSync(file, String(process.pid));
    // fresh: our own live pid holds it
    assert.equal(tryClaimOverlayLock(file, 3333), 'held');
    // pretend 10 minutes passed: the lock is stale, so takeover wins even for a live holder
    assert.equal(tryClaimOverlayLock(file, 3333, Date.now() + 600_000), 'claimed');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('refresh and release only touch your own lock', () => {
  const d = dir();
  const file = join(d, 'overlay.lock');
  try {
    // hold it as this very process, so the holder is provably alive
    assert.equal(tryClaimOverlayLock(file, process.pid), 'claimed');
    assert.equal(refreshOverlayLock(file, process.pid), true);
    assert.equal(refreshOverlayLock(file, 5555), false);
    releaseOverlayLock(file, 5555);
    // not released: another pid still cannot claim a fresh lock held by a live process
    assert.equal(tryClaimOverlayLock(file, 6666), 'held');
    releaseOverlayLock(file, process.pid);
    assert.equal(tryClaimOverlayLock(file, 6666), 'claimed');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('release on a missing lock is quiet', () => {
  const d = dir();
  const file = join(d, 'nope.lock');
  try {
    releaseOverlayLock(file, 7777);
    assert.equal(tryClaimOverlayLock(file, 7777), 'claimed');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
