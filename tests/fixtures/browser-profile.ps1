# Offline assertions for the read-only browser profile query (Profile in src/desktop/win32.ps1).
# Run by tests/browserProfile.test.ts. It compiles the helper's own C# block and then calls the argument parser, the path
# normalizer and the per-pid verdict directly with hand-written inputs: no process is started or stopped, no window is
# activated, no WMI query runs, and no other program's command line is read.
# A passing run prints "BROWSER_PROFILE_OK <caseCount>"; any failed assertion throws.
param([Parameter(Mandatory = $true)][string]$Source)
$ErrorActionPreference = 'Stop'

$text = [System.IO.File]::ReadAllText($Source)
$match = [regex]::Match($text, "(?s)-TypeDefinition @'\r?\n(.*?)\r?\n'@")
if (-not $match.Success) { throw 'the helper C# block was not found in ' + $Source }
Add-Type -ReferencedAssemblies System.Drawing, UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition $match.Groups[1].Value

$cases = 0
function Check([string]$name, $actual, $expected) {
  $script:cases++
  if ($null -eq $expected) {
    if ($null -ne $actual) { throw ('browser profile assertion failed: ' + $name + ' should be null, got ' + [string]$actual) }
    return
  }
  if ($null -eq $actual) { throw ('browser profile assertion failed: ' + $name + ' should be ' + [string]$expected + ', got null') }
  if ([string]$actual -cne [string]$expected) { throw ('browser profile assertion failed: ' + $name + ' should be ' + [string]$expected + ', got ' + [string]$actual) }
}

$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = 'C:\profiles\agent-a'
# Not $pid: that is a read-only PowerShell automatic variable (the current process id) and cannot be a parameter.
function VerdictOf([long]$processId, [string]$name, [string]$exe, [string]$line, [string]$expected) {
  return [Profile]::Verdict($processId, $name, $exe, $line, $expected)
}
function VerdictLine([long]$processId, [string]$name, [string]$exe, [string]$line, [string]$expected) {
  $v = VerdictOf $processId $name $exe $line $expected
  return [string]$v['verdict'] + '/' + [string]$v['reason']
}

# 1-12: what counts as a fully-qualified path. A drive-relative form (C:foo), a rooted-without-drive form (\foo) and a
# relative one are refused outright instead of being completed from the current directory, and an environment variable or
# a device namespace is not a profile path either.
Check 'drive absolute' ([Profile]::Qualified('C:\Users\a\profile')) $true
Check 'forward slashes' ([Profile]::Qualified('c:/users/a/profile')) $true
Check 'unc' ([Profile]::Qualified('\\server\share\p')) $true
Check 'unc forward slashes' ([Profile]::Qualified('//server/share/p')) $true
Check 'device namespace' ([Profile]::Qualified('\\?\C:\p')) $false
Check 'device dot namespace' ([Profile]::Qualified('\\.\pipe\x')) $false
Check 'drive relative' ([Profile]::Qualified('C:foo')) $false
Check 'rooted without drive' ([Profile]::Qualified('\foo')) $false
Check 'rooted forward slash without drive' ([Profile]::Qualified('/foo')) $false
Check 'relative' ([Profile]::Qualified('relative\p')) $false
Check 'environment variable' ([Profile]::Qualified('%LOCALAPPDATA%\p')) $false
Check 'empty' ([Profile]::Qualified('')) $false

# 13-20: the normalized form two paths are compared in. Backslashes and forward slashes are one separator, '.' and '..'
# are resolved, and a trailing separator is dropped (a drive root keeps it).
Check 'dot and dotdot' ([Profile]::Path('C:\a\.\b\..\c\\')) 'C:\a\c'
Check 'root keeps its separator' ([Profile]::Path('C:\')) 'C:\'
Check 'trailing separator dropped' ([Profile]::Path('C:\a\')) 'C:\a'
Check 'separators unified' ([Profile]::Path('C:/a/b')) 'C:\a\b'
Check 'unc trailing separator dropped' ([Profile]::Path('\\server\share\p\')) '\\server\share\p'
Check 'drive relative has no path' ([Profile]::Path('C:foo')) $null
Check 'relative has no path' ([Profile]::Path('relative')) $null
# The helper itself is ASCII only, so a non-ASCII profile is spelled with character codes here: a .ps1 without a BOM is
# read in the machine's ANSI code page, and a literal Chinese path in this file would depend on that code page.
$cn = 'C:\' + [string][char]0x7528 + [char]0x6237 + '\' + [char]0x914D + [char]0x7F6E
Check 'unicode kept as written' ([Profile]::Path($cn + '\')) $cn

# 21-24: the command line is split by Windows itself, so a quoted path with spaces stays one argument.
Check 'no command line' ([Profile]::Args($null)) $null
Check 'empty command line' ([Profile]::Args('')) $null
Check 'quoted value with a space' (([Profile]::Args('msedge.exe --user-data-dir="C:\a b\p" --x')) -join '|') 'msedge.exe|--user-data-dir=C:\a b\p|--x'
Check 'quoted exe path' (([Profile]::Args('"C:\Program Files\Edge\msedge.exe" --user-data-dir="C:\p q"')) -join '|') 'C:\Program Files\Edge\msedge.exe|--user-data-dir=C:\p q'

# 25-31: a match is decided per pid, on the value of that pid's own --user-data-dir, after normalization. Case is not
# significant on Windows, a longer sibling path is a different profile, and a value that repeats the same directory is
# not a conflict.
Check 'equal value' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --user-data-dir="C:\profiles\agent-a" --remote-debugging-port=0' $profile) 'match/value-equal'
Check 'case, dot and trailing separator' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --user-data-dir="C:\Profiles\.\Agent-A\\"' $profile) 'match/value-equal'
Check 'forward slashes in the value' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --user-data-dir=C:/profiles/agent-a' $profile) 'match/value-equal'
Check 'value with spaces' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --user-data-dir="C:\profiles\agent a" --x' 'C:\profiles\agent a') 'match/value-equal'
$browser = 'C:\' + [string][char]0x6D4F + [char]0x89C8 + [char]0x5668
Check 'unicode value' (VerdictLine 100 'chrome.exe' 'C:\chrome.exe' ('chrome.exe --user-data-dir="' + $browser + '"') $browser) 'match/value-equal'
Check 'same value twice is not a conflict' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --user-data-dir=C:\p --user-data-dir=c:\P\' 'C:\p') 'match/value-equal'
Check 'unreadable exe still decides on the command line' (VerdictLine 100 'msedge.exe' '' 'msedge.exe --user-data-dir=C:\p' 'C:\p') 'match/value-equal'

# 32-41: everything this side cannot read with certainty is unknown, never a guessed match or a guessed non-match.
Check 'two different values' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --user-data-dir=C:\p --user-data-dir=C:\q' 'C:\p') 'unknown/switch-conflict'
Check 'bare switch' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --user-data-dir C:\p' 'C:\p') 'unknown/switch-without-value'
Check 'single dash switch' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe -user-data-dir=C:\p' 'C:\p') 'unknown/switch-single-dash'
Check 'empty value' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --user-data-dir=' 'C:\p') 'unknown/value-empty'
Check 'relative value' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --user-data-dir=relative\p' 'C:\p') 'unknown/value-not-absolute'
Check 'drive relative value' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --user-data-dir=C:foo' 'C:\p') 'unknown/value-not-absolute'
Check 'environment value' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --user-data-dir=%TEMP%\p' 'C:\p') 'unknown/value-not-absolute'
Check 'not a browser' (VerdictLine 100 'notepad.exe' 'C:\notepad.exe' 'notepad.exe --user-data-dir=C:\p' 'C:\p') 'unknown/not-a-browser-process'
Check 'exe is another program' (VerdictLine 100 'msedge.exe' 'C:\evil\notepad.exe' 'msedge.exe --user-data-dir=C:\p' 'C:\p') 'unknown/exe-mismatch'
Check 'no command line to read' (VerdictLine 100 'msedge.exe' $edge $null 'C:\p') 'unknown/command-line-unreadable'

# 42-45: a stated non-match is only stated when this side really read that pid's own command line.
Check 'switch absent' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --remote-debugging-port=0' 'C:\p') 'mismatch/switch-absent'
Check 'longer switch name is not this switch' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --user-data-dirx=C:\p' 'C:\p') 'mismatch/switch-absent'
Check 'different profile' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --user-data-dir=C:\profiles\agent-b' 'C:\p') 'mismatch/value-differs'
Check 'a longer sibling path is not the same profile' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --user-data-dir=C:\profiles\agent-a2' 'C:\profiles\agent-a') 'mismatch/value-differs'

# 46-49: the pid checks and the shape of the reply. The reply carries no command line and no profile path, so it can be
# written into the multi-pointer audit as it is.
Check 'invalid pid' (VerdictLine 0 'msedge.exe' $edge 'msedge.exe --user-data-dir=C:\p' 'C:\p') 'unknown/pid-invalid'
Check 'expected is relative' (VerdictLine 100 'msedge.exe' $edge 'msedge.exe --user-data-dir=C:\p' 'p') 'unknown/expected-not-absolute'
$reply = VerdictOf 100 'msedge.exe' $edge 'msedge.exe --user-data-dir="C:\profiles\agent-a"' $profile
Check 'reply keys' (($reply.Keys | Sort-Object) -join ',') 'pid,reason,verdict'
$leak = @($reply.Values | Where-Object { $_ -is [string] -and ($_.IndexOf('user-data-dir', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.IndexOf('C:\', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) })
Check 'reply repeats no command line and no path' $leak.Count 0

Write-Output ('BROWSER_PROFILE_OK ' + $cases)
