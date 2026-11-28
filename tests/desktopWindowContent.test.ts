import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Offline regression for the read-only geometry query (Desk.Content in src/desktop/win32.ps1): a caller that has a pid
// or an hwnd gets native rectangles in one stated unit space, per-window DPI, and the flags that tell a hidden, cloaked
// or minimized window from a missing one — and nothing is measured that does not exist.
// The fixture compiles the helper's own C# block and measures two windows it creates itself, never shown: no other
// program's window is touched, no input is synthesized, and no window is activated.
test('the helper reports native window geometry read-only, in physical pixels', {
  skip: process.platform !== 'win32' && 'requires Windows PowerShell to compile the helper',
}, () => {
  const source = fileURLToPath(new URL('../src/desktop/win32.ps1', import.meta.url));
  const fixture = fileURLToPath(new URL('./fixtures/desktop-window-content.ps1', import.meta.url));
  const root = process.env.SystemRoot;
  assert.ok(root, 'Windows SystemRoot is needed to locate PowerShell');
  const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fixture, '-Source', source,
  ], { windowsHide: true, encoding: 'utf8', timeout: 120_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'offline window geometry assertions failed\n' + (result.stdout ?? '') + (result.stderr ?? ''));
  assert.equal((result.stdout ?? '').trim(), 'DESKTOP_WINDOW_CONTENT_OK 14');
});

// Reads the body of a switch branch written as `'name' { ... }`, matching braces instead of trusting a lazy regex:
// the content branch nests if-blocks, so a regex that stops at the first "\n\s*}" would return only the opening
// argument checks, never the answer the branch exists to give.
function branchBody(source: string, label: string): string {
  const at = source.indexOf("'" + label + "' {");
  assert.ok(at >= 0, `win32.ps1 must answer the '${label}' op`);
  const open = source.indexOf('{', at);
  assert.ok(open >= 0, `the '${label}' branch must open a block`);
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i += 1) {
    const c = source[i];
    if (quote !== null) {
      if (c === quote) {
        if (quote === "'" && source[i + 1] === "'") { i += 1; continue; }
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '#') { const nl = source.indexOf('\n', i); i = nl < 0 ? source.length : nl; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return source.slice(open + 1, i); }
  }
  return assert.fail(`the '${label}' branch is not closed`);
}

// The query is read-only by contract, and the contract lives in two places a PowerShell fixture cannot see: the driver
// must not treat it as an input op (no cancel token armed, no progress streaming), and the helper's branch must not
// touch the pointer, the foreground or any input queue.
test('the geometry query never enters the input path', () => {
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  const driver = read('../src/desktop/driver.ts');
  const inputOps = /const INPUT_OPS = new Set\(\[([^\]]*)\]\);/.exec(driver);
  assert.ok(inputOps, 'driver.ts must declare INPUT_OPS as one set literal');
  assert.doesNotMatch(inputOps[1], /['"]content['"]/, 'content must not be an input op: a read-only query must not arm a cancel token or stream progress');
  const helper = read('../src/desktop/win32.ps1');
  const branch = branchBody(helper, 'content');
  assert.match(branch, /\[Desk\]::Content\(/, 'the content branch must answer with the native geometry query');
  assert.doesNotMatch(branch, /SendInput|SetCursorPos|SetForegroundWindow|SetActiveWindow|ShowWindow|PostMessage/, 'a read-only query must not send input, move the pointer or change the foreground');
});
