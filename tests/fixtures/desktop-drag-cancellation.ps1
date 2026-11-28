# Controlled regression for the point Desk.Drag lets go at (src/desktop/win32.ps1).
# Run by tests/desktopDragCancellation.test.ts. It synthesizes no input and opens no window: the real Drag method is cut
# out of the helper source with a brace, comment and quote aware scanner, then compiled into a stub class that declares no
# P/Invoke at all. In that stub PostMessage only records the message it was asked to post, and Live/Under/ClientToScreen/
# Aware/Stopped/Rest are plain stubs, so no window, no pointer, no process and no helper main loop is involved.
# What a passing run shows is the message sequence the helper would post for a drag, and nothing about a real window.
# A passing run prints one JSON line and "DRAG_CANCELLATION_OK <caseCount>"; a failed extraction or assertion prints
# "DRAG_CANCELLATION_FAIL <code> <detail>" and exits 2.
param([Parameter(Mandatory = $true)][string]$Source)
$ErrorActionPreference = 'Stop'

function Fail([string]$code, [string]$detail) {
  [Console]::Out.WriteLine('DRAG_CANCELLATION_FAIL ' + $code + ' ' + $detail)
  exit 2
}

# Cuts "signature ... { ... }" out of C#. Line comments, block comments, string literals and char literals are skipped so a
# brace inside any of them cannot end the method early. Returns $null when the signature or its body is not there.
function ExtractMethod([string]$text, [string]$signature) {
  $at = $text.IndexOf($signature, [System.StringComparison]::Ordinal)
  if ($at -lt 0) { return $null }
  $open = -1
  $i = $at + $signature.Length
  while ($i -lt $text.Length) {
    $c = $text[$i]
    if ($c -eq '{') { $open = $i; break }
    if ($c -eq ';' -or $c -eq '}') { return $null }
    $i++
  }
  if ($open -lt 0) { return $null }
  $depth = 0
  $j = $open
  while ($j -lt $text.Length) {
    $c = $text[$j]
    if ($c -eq '/' -and ($j + 1) -lt $text.Length) {
      $next = $text[$j + 1]
      if ($next -eq '/') {
        $end = $text.IndexOf("`n", $j + 2)
        if ($end -lt 0) { return $null }
        $j = $end + 1
        continue
      }
      if ($next -eq '*') {
        $end = $text.IndexOf('*/', $j + 2, [System.StringComparison]::Ordinal)
        if ($end -lt 0) { return $null }
        $j = $end + 2
        continue
      }
    }
    if ($c -eq '"' -or $c -eq "'") {
      $quote = $c
      $j++
      while ($j -lt $text.Length) {
        $d = $text[$j]
        if ($d -eq $quote) { break }
        if ($d -eq '\' -and $quote -eq '"') { $j++ }
        $j++
      }
      $j++
      continue
    }
    if ($c -eq '{') {
      $depth = $depth + 1
    } elseif ($c -eq '}') {
      $depth = $depth - 1
      if ($depth -eq 0) { return $text.Substring($at, $j - $at + 1) }
    }
    $j++
  }
  return $null
}

$text = [System.IO.File]::ReadAllText($Source)
if ([string]::IsNullOrEmpty($text)) { Fail 'source-empty' $Source }
$signature = 'public static void Drag('
$drag = ExtractMethod $text $signature
if ($null -eq $drag) { Fail 'drag-not-found' $signature }
$head = $drag.Substring(0, [Math]::Min(120, $drag.Length))
$tail = $drag.Substring([Math]::Max(0, $drag.Length - 120))
if (-not $drag.StartsWith($signature, [System.StringComparison]::Ordinal)) { Fail 'drag-start' $head }
if (-not $drag.EndsWith('}', [System.StringComparison]::Ordinal)) { Fail 'drag-end' $tail }
if ($drag.IndexOf('@"') -ge 0) { Fail 'drag-verbatim-string' 'the scanner does not handle verbatim strings' }
if ($drag.IndexOf('PostMessage') -lt 0) { Fail 'drag-no-postmessage' 'the cut is not the drag that posts its moves' }
$openCount = ([regex]::Matches($drag, '\{')).Count
$closeCount = ([regex]::Matches($drag, '\}')).Count
if ($openCount -ne $closeCount) { Fail 'drag-unbalanced' ($openCount.ToString() + ' ' + $closeCount.ToString()) }

$stepsMatch = [regex]::Match($text, '(?m)^[ \t]*const int DragSteps[ \t]*=[ \t]*([0-9]+)[ \t]*;')
if (-not $stepsMatch.Success) { Fail 'drag-steps-not-found' '' }
$steps = [int]$stepsMatch.Groups[1].Value
if ($steps -lt 1 -or $steps -gt 256) { Fail 'drag-steps-range' ([string]$steps) }

# Same member names and shapes the real Drag method uses, and nothing that reaches a window, a pointer or a process. The
# real Drag method is spliced in at @@DRAG@@; the step count is taken from the helper rather than copied.
$template = @'
using System;
using System.Collections.Generic;

public static class DragProbe {
  public struct POINT { public int X, Y; }
  public sealed class Rec {
    public long h;
    public uint msg;
    public long w;
    public int x;
    public int y;
  }
  public static List<Rec> Messages = new List<Rec>();
  public static List<int[]> Cursor = new List<int[]>();
  public static List<int[]> Progress = new List<int[]>();
  public static Action<int,int> CursorSink;
  public static Action<int,int> ProgressSink;
  public static bool WasCancelled;
  public static bool Aborting;
  public static bool HasAct, HasAct2;
  public static int ActX, ActY, ActX2, ActY2;
  public static long ChildHandle;
  public static int ChildLeft, ChildTop;
  public static int ScreenLeft, ScreenTop;
  public static int RestCalls;
  public static int CancelAfterRest;
  const int DragSteps = @@STEPS@@;

  // The real one also looks for the cancel file the host writes; here the host stop is the flag it would set.
  static bool Stopped() { return WasCancelled || Aborting; }

  // The real one sleeps in slices. Here it is the only place inside a drag where a stop can arrive, so a stop is
  // injected at the Nth call instead of by a real file or a real key.
  static bool Rest(int ms) {
    RestCalls = RestCalls + 1;
    if (CancelAfterRest > 0 && RestCalls >= CancelAfterRest) WasCancelled = true;
    return Stopped();
  }
  public static void Aware() { }
  static IntPtr Live(long hwnd) { return new IntPtr(hwnd); }
  // The real one walks down to the innermost child window and moves the point into that child client coordinates.
  static IntPtr Under(IntPtr top, ref POINT point) {
    if (ChildHandle == 0) return top;
    point.X = point.X - ChildLeft;
    point.Y = point.Y - ChildTop;
    return new IntPtr(ChildHandle);
  }
  static bool ClientToScreen(IntPtr h, ref POINT p) {
    p.X = p.X + ScreenLeft;
    p.Y = p.Y + ScreenTop;
    return true;
  }
  static IntPtr Pack(int low, int high) { return new IntPtr(((high & 0xFFFF) << 16) | (low & 0xFFFF)); }
  // Records the message instead of posting it, unpacking the same way a receiver would.
  static bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l) {
    Rec rec = new Rec();
    rec.h = h.ToInt64();
    rec.msg = msg;
    rec.w = w.ToInt64();
    long bits = l.ToInt64();
    int x = (int)(bits & 0xFFFF);
    int y = (int)((bits >> 16) & 0xFFFF);
    if (x >= 0x8000) x = x - 0x10000;
    if (y >= 0x8000) y = y - 0x10000;
    rec.x = x;
    rec.y = y;
    Messages.Add(rec);
    return true;
  }

@@DRAG@@
}
'@

$stub = $template.Replace('@@STEPS@@', [string]$steps).Replace('@@DRAG@@', $drag)
if ($stub.IndexOf('DllImport') -ge 0) { Fail 'stub-pinvoke' 'the stub must not import anything' }
try {
  Add-Type -TypeDefinition $stub -Language CSharp -ErrorAction Stop
} catch {
  Fail 'stub-compile' ([string]$_.Exception.Message)
}

$results = New-Object System.Collections.ArrayList

# Runs one drag through the real method and records what it asked to post, plus the points the sinks were told about.
function Run([string]$name, [int]$x, [int]$y, [int]$x2, [int]$y2, [bool]$right, [int]$hold, [int]$cancelAfterRest, [long]$child, [int]$childLeft, [int]$childTop) {
  [DragProbe]::Messages.Clear()
  [DragProbe]::Cursor.Clear()
  [DragProbe]::Progress.Clear()
  [DragProbe]::WasCancelled = $false
  [DragProbe]::Aborting = $false
  [DragProbe]::RestCalls = 0
  [DragProbe]::CancelAfterRest = $cancelAfterRest
  [DragProbe]::ChildHandle = $child
  [DragProbe]::ChildLeft = $childLeft
  [DragProbe]::ChildTop = $childTop
  [DragProbe]::ScreenLeft = 120
  [DragProbe]::ScreenTop = 80
  [DragProbe]::HasAct = $false
  [DragProbe]::HasAct2 = $false
  foreach ($value in @($x, $y, $x2, $y2, ($x + [DragProbe]::ScreenLeft), ($y + [DragProbe]::ScreenTop))) {
    if ($value -lt -32000 -or $value -gt 32000) { Fail 'coordinate-range' ($name + ' ' + [string]$value) }
  }
  [DragProbe]::CursorSink = [Action[int,int]]{ param($px, $py) [void][DragProbe]::Cursor.Add(@([int]$px, [int]$py)) }
  [DragProbe]::ProgressSink = [Action[int,int]]{ param($px, $py) [void][DragProbe]::Progress.Add(@([int]$px, [int]$py)) }
  [DragProbe]::Drag([long]4242, $x, $y, $x2, $y2, $right, $hold)
  $records = New-Object System.Collections.ArrayList
  foreach ($m in [DragProbe]::Messages) { [void]$records.Add(@([int64]$m.msg, [int]$m.x, [int]$m.y, [int64]$m.h, [int64]$m.w)) }
  $cursor = New-Object System.Collections.ArrayList
  foreach ($p in [DragProbe]::Cursor) { [void]$cursor.Add(@([int]$p[0], [int]$p[1])) }
  $progress = New-Object System.Collections.ArrayList
  foreach ($p in [DragProbe]::Progress) { [void]$progress.Add(@([int]$p[0], [int]$p[1])) }
  $case = [ordered]@{
    name = $name
    inputs = [ordered]@{
      hwnd = 4242
      x = $x
      y = $y
      x2 = $x2
      y2 = $y2
      right = $right
      hold = $hold
      cancelAfterRest = $cancelAfterRest
      child = [int64]$child
      childLeft = $childLeft
      childTop = $childTop
      screenLeft = [DragProbe]::ScreenLeft
      screenTop = [DragProbe]::ScreenTop
    }
    restCalls = [DragProbe]::RestCalls
    cancelled = [DragProbe]::WasCancelled
    act = [ordered]@{
      hasAct = [DragProbe]::HasAct
      sx = [DragProbe]::ActX
      sy = [DragProbe]::ActY
      hasAct2 = [DragProbe]::HasAct2
      sx2 = [DragProbe]::ActX2
      sy2 = [DragProbe]::ActY2
    }
    records = $records
    cursor = $cursor
    progress = $progress
  }
  [void]$results.Add($case)
}

# 1. A complete left drag whose two axes are a whole number of steps: it presses and lets go at the destination.
Run -name 'complete-left-forward-divisible' -x 100 -y 80 -x2 340 -y2 280 -right $false -hold 0 -cancelAfterRest (-1) -child ([long]0) -childLeft 0 -childTop 0
# 2. A complete right drag going backwards with a step that does not divide evenly: the intermediate points can only come
#    from the helper own integer stepping (it truncates toward zero), not from a re-implementation that rounds otherwise.
Run -name 'complete-right-backward-nondivisible' -x 600 -y 500 -x2 463 -y2 583 -right $true -hold 0 -cancelAfterRest (-1) -child ([long]0) -childLeft 0 -childTop 0
# 3. A complete left drag whose point lands in a child window: every message must go to that child handle, and the
#    coordinates are in the child client space while the drawn point stays in screen space.
Run -name 'complete-left-child-routed' -x 400 -y 300 -x2 263 -y2 217 -right $false -hold 0 -cancelAfterRest (-1) -child ([long]12648430) -childLeft 40 -childTop 25
# 4. A left drag stopped while it still holds at its start: it already pressed, so it has to let go there.
Run -name 'cancel-in-hold-left' -x 200 -y 150 -x2 440 -y2 350 -right $false -hold 250 -cancelAfterRest 1 -child ([long]0) -childLeft 0 -childTop 0
# 5. A left drag stopped after three moves.
Run -name 'cancel-after-three-moves-left' -x 300 -y 200 -x2 163 -y2 283 -right $false -hold 0 -cancelAfterRest 4 -child ([long]0) -childLeft 0 -childTop 0
# 6. A right drag stopped after seven moves, going forwards.
Run -name 'cancel-after-seven-moves-right' -x 500 -y 400 -x2 723 -y2 283 -right $true -hold 0 -cancelAfterRest 8 -child ([long]0) -childLeft 0 -childTop 0
# 7. A right drag stopped during its hold, going backwards.
Run -name 'cancel-in-hold-right-backward' -x 900 -y 700 -x2 763 -y2 617 -right $true -hold 300 -cancelAfterRest 1 -child ([long]0) -childLeft 0 -childTop 0

$payload = [ordered]@{
  schema = 'desktop-drag-cancellation/1'
  source = $Source
  signature = $signature
  dragChars = $drag.Length
  dragSteps = $steps
  stubPinvoke = $false
  dragText = $drag
  cases = $results
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $payload -Depth 8 -Compress))
[Console]::Out.WriteLine('DRAG_CANCELLATION_OK ' + [string]$results.Count)
exit 0
