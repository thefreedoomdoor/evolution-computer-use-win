import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
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
    // 抢下来的过期锁应该立刻删掉，数据目录里不能攒 .stale 垃圾
    assert.deepEqual(readdirSync(d).filter((n) => n.includes('.stale')), []);
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

test('refresh bumps the lock mtime and never truncates its content', () => {
  const d = dir();
  const file = join(d, 'overlay.lock');
  try {
    assert.equal(tryClaimOverlayLock(file, process.pid), 'claimed');
    const size = statSync(file).size;
    for (let i = 1; i <= 200; i++) {
      assert.equal(refreshOverlayLock(file, process.pid, Date.now() + i * 1000), true);
      // 刷新期间内容必须始终是完整 pid：早先 writeFileSync 会截断成 0 字节，
      // 别的进程读到空串就把持锁者当成已死，两块浮窗因此来回倒手。
      assert.equal(readFileSync(file, 'utf8'), String(process.pid));
      assert.equal(statSync(file).size, size);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('an empty lock that was just created is not stolen, a stale one is', () => {
  const d = dir();
  const file = join(d, 'overlay.lock');
  try {
    writeFileSync(file, '');
    const now = Date.now();
    // 刚创建、内容还没落盘：不能当成「持锁者已死」
    assert.equal(tryClaimOverlayLock(file, 4444, now), 'held');
    // 一秒后仍是空的（内容真丢了）：按过期接管
    assert.equal(tryClaimOverlayLock(file, 4444, now + 1000), 'claimed');
    assert.equal(readFileSync(file, 'utf8'), '4444');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('refresh by a foreign pid is refused and leaves the lock intact', () => {
  const d = dir();
  const file = join(d, 'overlay.lock');
  try {
    assert.equal(tryClaimOverlayLock(file, process.pid), 'claimed');
    assert.equal(refreshOverlayLock(file, 8888), false);
    assert.equal(readFileSync(file, 'utf8'), String(process.pid));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a concurrent reader never observes an empty lock while the holder refreshes', async () => {
  const d = dir();
  const file = join(d, 'overlay.lock');
  const { spawn } = await import('node:child_process');
  try {
    assert.equal(tryClaimOverlayLock(file, process.pid), 'claimed');
    const script = "const fs=require('node:fs');let n=0,bad=0;const end=Date.now()+1200;"
      + "while(Date.now()<end){n++;if(fs.readFileSync(process.argv[1],'utf8').trim()==='')bad++;}"
      + "process.stdout.write(JSON.stringify({n,bad}));";
    const child = spawn(process.execPath, ['-e', script, file], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    const timer = setInterval(() => { refreshOverlayLock(file, process.pid); }, 1);
    await new Promise((resolve) => child.on('close', resolve));
    clearInterval(timer);
    const result = JSON.parse(out) as { n: number; bad: number };
    assert.ok(result.n > 100, '读锁的进程应该有足够多的采样，实际 ' + result.n);
    assert.equal(result.bad, 0, '读锁的进程一次都不该读到空内容');
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
