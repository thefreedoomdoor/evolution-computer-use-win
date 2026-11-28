# Offline assertions for the physical point a desktop input reports back (Desk.ActReply in src/desktop/win32.ps1).
# Run by tests/desktopActionCoordinates.test.ts. This file synthesizes no input and opens no window: it compiles the
# helper's own C# block and only calls ResetAct/ActReply, so it runs on a machine with no desktop session.
# A passing run prints "DESKTOP_ACTION_COORDINATES_OK <caseCount>"; any failed assertion throws.
param([Parameter(Mandatory = $true)][string]$Source)
$ErrorActionPreference = 'Stop'

$text = [System.IO.File]::ReadAllText($Source)
$match = [regex]::Match($text, "(?s)-TypeDefinition @'\r?\n(.*?)\r?\n'@")
if (-not $match.Success) { throw 'the helper C# block was not found in ' + $Source }
Add-Type -ReferencedAssemblies System.Drawing, UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition $match.Groups[1].Value

$cases = 0
function Require([bool]$condition, [string]$message) {
  if (-not $condition) { throw 'desktop action coordinate assertion failed: ' + $message }
}
function Has([System.Collections.Generic.Dictionary[string, object]]$reply, [string]$key) {
  return $reply.ContainsKey($key)
}

# 1. An input that reached no point reports none at all, not a made-up 0,0.
[Desk]::ResetAct('')
$reply = [Desk]::ActReply()
Require ((-not (Has $reply 'sx')) -and (-not (Has $reply 'sy'))) ('no point must not report sx/sy')
Require ((-not (Has $reply 'sx2')) -and (-not (Has $reply 'sy2'))) ('no point must not report sx2/sy2')
Require ($reply['cancelled'] -eq $false) ('a fresh input is not cancelled')
$cases++

# 2. A monitor left of the primary one gives a real negative X; -1 is a place, not "no point".
[Desk]::ResetAct('')
[Desk]::HasAct = $true
[Desk]::ActX = -1
[Desk]::ActY = -40
$reply = [Desk]::ActReply()
Require ((Has $reply 'sx') -and (Has $reply 'sy')) ('a negative point is still a point')
Require ($reply['sx'] -eq -1) ('sx -1 must come back as -1, got ' + $reply['sx'])
Require ($reply['sy'] -eq -40) ('sy -40 must come back as -40, got ' + $reply['sy'])
$cases++

# 3. Both ends of a drag on that monitor keep their exact negative pixels.
[Desk]::ResetAct('')
[Desk]::HasAct = $true
[Desk]::ActX = -1919
[Desk]::ActY = -1
[Desk]::HasAct2 = $true
[Desk]::ActX2 = -1700
[Desk]::ActY2 = -1
$reply = [Desk]::ActReply()
Require ($reply['sx'] -eq -1919) ('drag start x kept, got ' + $reply['sx'])
Require ($reply['sy'] -eq -1) ('drag start y -1 kept, got ' + $reply['sy'])
Require ($reply['sx2'] -eq -1700) ('drag end x kept, got ' + $reply['sx2'])
Require ($reply['sy2'] -eq -1) ('drag end y -1 kept, got ' + $reply['sy2'])
$cases++

# 4. The next input does not inherit the previous one's point.
[Desk]::ResetAct('')
$reply = [Desk]::ActReply()
Require ((-not (Has $reply 'sx')) -and (-not (Has $reply 'sx2'))) ('reset must clear both points')
Require ([Desk]::ActX -eq 0 -and [Desk]::ActY -eq 0 -and [Desk]::ActX2 -eq 0 -and [Desk]::ActY2 -eq 0) ('reset must not leave a coordinate behind')
$cases++

# 5. The screen origin (0,0) is a real point and must not read as "none".
[Desk]::ResetAct('')
[Desk]::HasAct = $true
[Desk]::ActX = 0
[Desk]::ActY = 0
$reply = [Desk]::ActReply()
Require ((Has $reply 'sx') -and (Has $reply 'sy')) ('the origin is still a point')
Require ($reply['sx'] -eq 0 -and $reply['sy'] -eq 0) ('the origin keeps 0,0')
$cases++

# 6. Only the second end set: report that end and not a first one.
[Desk]::ResetAct('')
[Desk]::HasAct2 = $true
[Desk]::ActX2 = -3
[Desk]::ActY2 = 12
$reply = [Desk]::ActReply()
Require (-not (Has $reply 'sx')) ('no first end was set')
Require (($reply['sx2'] -eq -3) -and ($reply['sy2'] -eq 12)) ('the second end is reported on its own')
$cases++

# 7. A stop still reports cancelled, and still reports where the input got to.
[Desk]::ResetAct('')
[Desk]::HasAct = $true
[Desk]::ActX = -5
[Desk]::ActY = 7
[Desk]::WasCancelled = $true
$reply = [Desk]::ActReply()
Require ($reply['cancelled'] -eq $true) ('a cancelled input says so')
Require ($reply['sx'] -eq -5) ('a cancelled input keeps the point it reached')
$cases++

# 8. A stop from the overlay counts as cancelled too, with no point invented for it.
[Desk]::ResetAct('')
[Desk]::Aborting = $true
$reply = [Desk]::ActReply()
Require ($reply['cancelled'] -eq $true) ('the overlay stop counts as cancelled')
Require (-not (Has $reply 'sx')) ('a stop that reached nothing reports no point')
$cases++

# 9. Ordinary positive pixels are unchanged by the existence flag.
[Desk]::ResetAct('')
[Desk]::HasAct = $true
[Desk]::ActX = 1920
[Desk]::ActY = 1080
$reply = [Desk]::ActReply()
Require (($reply['sx'] -eq 1920) -and ($reply['sy'] -eq 1080)) ('positive pixels unchanged')
$cases++

Write-Output ('DESKTOP_ACTION_COORDINATES_OK ' + $cases)
