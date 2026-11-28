import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Offline regression for the read-only browser profile query (Profile in src/desktop/win32.ps1): given the profile
// directory this side launched a browser with, and the browser pids that browser's own SystemInfo reported, the helper
// decides per pid whether that pid's own command line names that exact directory — and says "unknown" for every form it
// cannot read with certainty. The fixture compiles the helper's own C# block and calls the parser, the normalizer and the
// verdict directly: no process is started or stopped, no window is activated, no input is synthesized.
test('the helper decides a browser pid profile read-only, and refuses what it cannot read', {
  skip: process.platform !== 'win32' && 'requires Windows PowerShell to compile the helper',
}, () => {
  const source = fileURLToPath(new URL('../src/desktop/win32.ps1', import.meta.url));
  const fixture = fileURLToPath(new URL('./fixtures/browser-profile.ps1', import.meta.url));
  const root = process.env.SystemRoot;
  assert.ok(root, 'Windows SystemRoot is needed to locate PowerShell');
  const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fixture, '-Source', source,
  ], { windowsHide: true, encoding: 'utf8', timeout: 120_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'offline browser profile assertions failed\n' + (result.stdout ?? '') + (result.stderr ?? ''));
  assert.equal((result.stdout ?? '').trim(), 'BROWSER_PROFILE_OK 49');
});

// The query is read-only by contract, and the contract lives in two places a reviewer can see: the operation is not one
// the driver treats as input (so it never arms a cancel token, never streams progress, never moves the pointer), and the
// dispatch branch touches no window, no foreground, no browser process.
test('the browser profile query never enters the input path and never touches a window', () => {
  const helper = readFileSync(fileURLToPath(new URL('../src/desktop/win32.ps1', import.meta.url)), 'utf8');
  const driver = readFileSync(fileURLToPath(new URL('../src/desktop/driver.ts', import.meta.url)), 'utf8');

  const inputOps = /const INPUT_OPS = new Set\(\[([^\]]*)\]\);/.exec(driver);
  assert.ok(inputOps, 'the driver input operation set was not found');
  assert.equal(inputOps[1].includes('browserProfile'), false, 'browserProfile must not be an input operation');

  // The branch is one line: capture up to the closing brace on that same line, so nothing from a later branch can be
  // mistaken for its body.
  const branch = /'browserProfile'\s*\{([^\n]*)\}/.exec(helper);
  assert.ok(branch, 'the browserProfile dispatch branch was not found');
  const body = branch[1];
  assert.match(body, /BrowserProfile\s+\$a\.expected\s+\$a\.pids/, 'the branch must only call the profile query');
  for (const forbidden of [
    'SendInput', 'SetCursorPos', 'SetForegroundWindow', 'SetActiveWindow', 'ShowWindow', 'PostMessage',
    'Stop-Process', 'Start-Process', 'taskkill',
  ]) {
    assert.equal(body.includes(forbidden), false, 'the read-only query must not call ' + forbidden);
  }
  assert.equal(body.includes('CancelFile'), false, 'the read-only query must not arm a cancel file');

  // The branch only forwards to the function, so the same rules are checked where the work happens: one process-table
  // read, no browser started or stopped, no window or foreground touched, no command line copied into the reply.
  const fn = /function BrowserProfile\(\$expected, \$pids\) \{([\s\S]*?)\n\}/.exec(helper);
  assert.ok(fn, 'the browserProfile helper function was not found');
  const work = fn[1];
  assert.equal((work.match(/Get-CimInstance/g) ?? []).length, 1, 'the query reads the process table once');
  for (const forbidden of ['Stop-Process', 'Start-Process', 'SetForegroundWindow', 'SendInput', 'CommandLine =', 'CommandLine=']) {
    assert.equal(work.includes(forbidden), false, 'the read-only query must not use ' + forbidden);
  }
  // The reply carries the expected path (the caller already knows it) and per-pid codes, but no command line text.
  assert.equal(/\$row\.CommandLine/.test(work.replace(/\[Profile\]::Verdict\([^)]*\)/, '')), false, 'no command line may be echoed');
});

// The query must not be answered from a substring or a prefix: C:\a\b2 is not C:\a\b, and a profile that merely sits
// under the expected directory is a different profile. The comparison is a normalized whole-path comparison.
test('the profile comparison is whole-path, not a prefix or substring test', () => {
  const helper = readFileSync(fileURLToPath(new URL('../src/desktop/win32.ps1', import.meta.url)), 'utf8');
  const profile = /public static class Profile \{([\s\S]*?)\n\}/.exec(helper);
  assert.ok(profile, 'the Profile class was not found in the helper');
  assert.equal(profile[1].includes('-like'), false, 'the profile query must not use a PowerShell wildcard match');
  assert.equal(/Contains\(\s*want/.test(profile[1]), false, 'the profile query must not test containment of the expected path');
  assert.match(profile[1], /string\.Equals\(key, want, StringComparison\.OrdinalIgnoreCase\)/, 'the value must be compared as a whole path');
});
