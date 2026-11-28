import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pathLiteral = (url: URL) => "'" + fileURLToPath(url).replaceAll("'", "''") + "'";

test('multi-pointer rendering uses physical pixels and per-monitor DPI', {
  skip: process.platform !== 'win32' && 'requires Windows PowerShell and GDI+',
}, () => {
  const helper = pathLiteral(new URL('../scripts/windows-takeover.cs', import.meta.url));
  const fixture = pathLiteral(new URL('./fixtures/pointer-render.cs', import.meta.url));
  // Compile the helper and assertions as one assembly. Do not run Host.Run or create a window.
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Web.Extensions",
    "$tests = @(Add-Type -Path @(" + helper + ', ' + fixture + ") -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions,System.Core -PassThru | Where-Object { $_.Name -eq 'PointerRenderTests' })",
    "if ($tests.Count -ne 1) { throw 'PointerRenderTests missing from compiled assembly' }",
    "$method = $tests[0].GetMethod('Run')",
    "if ($null -eq $method) { throw 'PointerRenderTests.Run missing' }",
    "if ([System.Windows.Forms.Application]::OpenForms.Count -ne 0) { throw 'unexpected WinForms window before pixel tests' }",
    "$result = $method.Invoke($null, @())",
    "if ($result -ne 'POINTER_RENDER_OK 15') { throw \"Expected all 15 pixel checks, got: $result\" }",
    "if ([System.Windows.Forms.Application]::OpenForms.Count -ne 0) { throw 'pixel tests opened a WinForms window' }",
    'Write-Output $result',
  ].join('\n');
  const root = process.env.SystemRoot;
  assert.ok(root, 'Windows SystemRoot is needed to locate PowerShell');
  const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64'),
  ], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'], timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'offline pointer pixel assertions failed' + (result.signal ? ' (' + result.signal + ')' : ''));
});
