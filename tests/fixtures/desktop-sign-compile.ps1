# Offline assertions for Sign as its own compilation unit and its stop path in src/desktop/win32.ps1.
# Run by tests/desktopSign.test.ts. This file synthesizes no input and opens no window: it compiles the helper's
# real Desk and Sign C# blocks in production order, binds Sign.Abort exactly as production does, and only exercises
# the stop flag. A passing run prints "DESKTOP_SIGN_COMPILE_OK <caseCount>"; any failed assertion throws.
param([Parameter(Mandatory = $true)][string]$Source)
$ErrorActionPreference = 'Stop'

$text = [System.IO.File]::ReadAllText($Source)
$pattern = "(?s)Add-Type\s+-ReferencedAssemblies\s+(?<refs>[^\r\n]*?)\s+-TypeDefinition\s+@'\r?\n(?<body>.*?)\r?\n'@"
$blocks = [regex]::Matches($text, $pattern)
if ($blocks.Count -lt 2) { throw 'the helper C# blocks were not found in ' + $Source }
$deskBlock = $null
$signBlock = $null
foreach ($block in $blocks) {
  $body = $block.Groups['body'].Value
  if ($body -match 'public static class Desk') { $deskBlock = $block }
  elseif ($body -match 'public static class Sign') { $signBlock = $block }
}
if ($null -eq $deskBlock -or $null -eq $signBlock) { throw 'the Desk and Sign blocks were not both found in ' + $Source }

# Compile Desk first, with the real reference list written on its own Add-Type line.
$deskRefs = @($deskBlock.Groups['refs'].Value -split '\s*,\s*' | Where-Object { $_ })
if ($deskRefs.Count -eq 0) { throw 'the Desk Add-Type has no referenced assemblies' }
Add-Type -ReferencedAssemblies $deskRefs -TypeDefinition $deskBlock.Groups['body'].Value

# Compile Sign next, with the same references production builds for it.
$signRefs = @('System.Windows.Forms', 'System.Drawing')
try {
  Add-Type -AssemblyName System.Web.Extensions
  $signRefs += [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location
} catch {
  $signRefs += 'System.Web.Extensions'
}
Add-Type -ReferencedAssemblies $signRefs -TypeDefinition $signBlock.Groups['body'].Value

$cases = 0
function Require([bool]$condition, [string]$message) {
  if (-not $condition) { throw 'desktop sign assertion failed: ' + $message }
}

# 1. The two production blocks compile as separate units: Sign cannot be part of Desk's assembly.
Require ($null -ne [Desk]) 'Desk did not compile'
Require ($null -ne [Sign]) 'Sign did not compile on its own'
Require ([Sign].Assembly -ne [Desk].Assembly) 'Sign must compile as its own assembly, not as part of Desk'
$cases++

# 2. Bind exactly as production does: a pure CLR delegate over the compiled Desk.MarkAborting.
$markAborting = [Desk].GetMethod('MarkAborting', [System.Reflection.BindingFlags]'Public,Static')
Require ($null -ne $markAborting) 'Desk.MarkAborting is missing'
[Desk]::ResetAct('')
[Sign]::Abort = [System.Action][System.Delegate]::CreateDelegate([System.Action], $markAborting)
Require ($null -ne [Sign]::Abort) 'Sign.Abort was not bound'
Require ([Sign]::Abort.Method.IsStatic) 'Sign.Abort must point at a static method'
Require ([Sign]::Abort.Method.MethodHandle -eq $markAborting.MethodHandle) 'Sign.Abort must point at Desk.MarkAborting'
Require ($null -eq [Sign]::Abort.Target) 'Sign.Abort must have no PowerShell/script-block target'
$cases++

# 3. Run that delegate on a plain CLR thread-pool thread: no PowerShell runspace is needed to stop the input.
[Desk]::ResetAct('')
Require ($false -eq [Desk]::Aborting) 'ResetAct must clear Aborting first'
$pooled = [System.Threading.Tasks.Task]::Run([Sign]::Abort)
Require ($pooled.Wait(5000)) 'Sign.Abort did not finish on a CLR thread-pool thread within 5s'
Require (-not $pooled.IsFaulted) 'Sign.Abort faulted on a CLR thread-pool thread'
Require ([Desk]::Aborting) 'Sign.Abort on a CLR thread-pool thread must set Desk.Aborting'
$cases++

# 4. Halt calls the same local delegate synchronously, before its visual work. No UI exists here, so the visual
#    work is expected to throw a NullReferenceException from Sign's own visual methods after the stop flag is set;
#    that expected exception is asserted by type and stack, never swallowed blindly.
[Desk]::ResetAct('')
$flags = [System.Reflection.BindingFlags]'NonPublic,Static'
$activeField = [Sign].GetField('active', $flags)
$halt = [Sign].GetMethod('Halt', $flags)
Require ($null -ne $activeField) 'Sign.active is missing'
Require ($null -ne $halt) 'Sign.Halt is missing'
$activeField.SetValue($null, $true)
$inner = $null
try {
  $halt.Invoke($null, @())
} catch [System.Management.Automation.MethodInvocationException] {
  $inner = $_.Exception.InnerException
}
Require ($null -ne $inner) 'Halt did not reach the expected no-UI visual failure'
Require ($inner -is [System.NullReferenceException]) ('Halt must fail only in its no-UI visual path, but threw ' + $inner.GetType().FullName)
$stack = if ($null -eq $inner.StackTrace) { '' } else { $inner.StackTrace }
Require ($stack -match '(?m)Sign\.(Follow|FollowPointer|DrawCapsule)\(\)') ('Halt did not fail inside Sign visual methods: ' + $stack)
Require ([Desk]::Aborting) 'Halt must set Desk.Aborting before its visual work'
Require ($false -eq $activeField.GetValue($null)) 'Halt must clear Sign.active before its visual work'
$cases++

# 5. A later input reset clears the flag, so the stop is one input, not a permanent mode.
[Desk]::ResetAct('')
Require ($false -eq [Desk]::Aborting) 'ResetAct must clear Aborting after Halt'
$cases++

'DESKTOP_SIGN_COMPILE_OK ' + $cases
