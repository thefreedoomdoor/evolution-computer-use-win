import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Offline regression for the physical point a desktop input reports back to the host: src/desktop/win32.ps1 keeps
// "did this input reach a point" separate from the coordinate value, so a monitor left of the primary one (a real
// negative X, including -1) still reports its exact pixel, and an input that reached nothing reports no point at all.
// The fixture compiles the helper's own C# block and calls ResetAct/ActReply only: no window, no synthesized input.
test('a desktop input reports its real screen point, including negative ones', {
  skip: process.platform !== 'win32' && 'requires Windows PowerShell to compile the helper',
}, () => {
  const source = fileURLToPath(new URL('../src/desktop/win32.ps1', import.meta.url));
  const fixture = fileURLToPath(new URL('./fixtures/desktop-action-coordinates.ps1', import.meta.url));
  const root = process.env.SystemRoot;
  assert.ok(root, 'Windows SystemRoot is needed to locate PowerShell');
  const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fixture, '-Source', source,
  ], { windowsHide: true, encoding: 'utf8', timeout: 120_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'offline coordinate assertions failed\n' + (result.stdout ?? '') + (result.stderr ?? ''));
  assert.equal((result.stdout ?? '').trim(), 'DESKTOP_ACTION_COORDINATES_OK 9');
});
