# Offline assertions for the read-only geometry query (Desk.Content in src/desktop/win32.ps1).
# Run by tests/desktopWindowContent.test.ts. It compiles the helper's own C# block, creates two windows of its own
# process that are never shown (no WS_VISIBLE, no activation, no input) and measures them: nothing here touches another
# program's window, the pointer, or the foreground.
# A passing run prints "DESKTOP_WINDOW_CONTENT_OK <caseCount>"; any failed assertion throws.
param([Parameter(Mandatory = $true)][string]$Source)
$ErrorActionPreference = 'Stop'

$text = [System.IO.File]::ReadAllText($Source)
$match = [regex]::Match($text, "(?s)-TypeDefinition @'\r?\n(.*?)\r?\n'@")
if (-not $match.Success) { throw 'the helper C# block was not found in ' + $Source }
Add-Type -ReferencedAssemblies System.Drawing, UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition $match.Groups[1].Value

# Probe windows of this process: a top-level popup and one child inside it, both never shown.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Probe {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
  [DllImport("user32.dll", SetLastError = true)] static extern bool DestroyWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr value);
  static int GetAwareness() {
    try { return GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()); } catch { return -1; }
  }
  /**
   * Per-monitor DPI aware before any window exists, so every rectangle measured below is a real pixel on a scaled
   * screen instead of a virtualized one. A process sets its awareness only once and powershell.exe's own manifest has
   * usually done so before this runs, so the process call is attempted and the thread context is set after it - the
   * same mechanism the helper uses, and the one that actually decides how a rectangle is measured.
   */
  public static void Aware() {
    // 2 is DPI_AWARENESS_PER_MONITOR_AWARE. System aware (1) still gets virtualized rectangles on a scaled display, so
    // the fixture fails loudly rather than asserting virtualized numbers.
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { } catch (DllNotFoundException) { }
    if (GetAwareness() != 2) {
      try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { } catch (DllNotFoundException) { }
    }
    if (GetAwareness() != 2) throw new Exception("the probe could not measure in per-monitor DPI awareness (awareness " + (GetAwareness()) + "); the exact pixels below would be virtualized");
  }
  /** The thread's DPI awareness right now (2 per-monitor, 1 system, 0 unaware); -1 when Windows cannot say. */
  public static int AwarenessNow() { return GetAwareness(); }
  /**
   * Put this thread in one documented awareness value, so a case can leave the thread in a context other than the one
   * the query needs and prove the query puts it back. 2 per-monitor, 1 system, 0 unaware.
   */
  public static void ThreadAwareness(int awareness) {
    IntPtr context;
    if (awareness == 2) context = new IntPtr(-4); else if (awareness == 1) context = new IntPtr(-2);
    else if (awareness == 0) context = new IntPtr(-1);
    else throw new Exception("the probe has no DPI awareness context for " + awareness);
    if (SetThreadDpiAwarenessContext(context) == IntPtr.Zero) throw new Exception("the probe could not set thread DPI awareness " + awareness + ", error " + Marshal.GetLastWin32Error());
  }
  /** WS_POPUP only: no WS_VISIBLE, so it is never shown, never activated, never takes input. */
  public static IntPtr Top(int x, int y, int w, int h) {
    var made = CreateWindowExW(0, "STATIC", "dsh-content-probe", 0x80000000u, x, y, w, h, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    if (made == IntPtr.Zero) throw new Exception("the probe window could not be created, error " + Marshal.GetLastWin32Error());
    return made;
  }
  /** WS_CHILD | WS_VISIBLE: a real child surface inside an invisible parent. */
  public static IntPtr Child(IntPtr parent, int x, int y, int w, int h) {
    var made = CreateWindowExW(0, "STATIC", "dsh-content-child", 0x40000000u | 0x10000000u, x, y, w, h, parent, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    if (made == IntPtr.Zero) throw new Exception("the probe child could not be created, error " + Marshal.GetLastWin32Error());
    return made;
  }
  public static void Kill(IntPtr h) { if (h != IntPtr.Zero) { DestroyWindow(h); } }
}
'@

$cases = 0
function Require([bool]$condition, [string]$message) {
  if (-not $condition) { throw 'desktop window content assertion failed: ' + $message }
}
function Box($rect, [string]$name) {
  if ($null -eq $rect) { return $null }
  foreach ($k in @('x', 'y', 'width', 'height')) {
    if (-not $rect.ContainsKey($k)) { throw ('desktop window content assertion failed: ' + $name + ' has no ' + $k) }
  }
  return $rect
}

$me = [System.Diagnostics.Process]::GetCurrentProcess().Id
# Before the probes exist: otherwise a scaled display would virtualize their rectangles and the exact pixels below
# would be measuring DPI virtualization instead of the query.
[Probe]::Aware()
$top = [Probe]::Top(-1, -40, 300, 200)
$child = [IntPtr]::Zero
try {
  $child = [Probe]::Child($top, 5, 7, 20, 10)
  $topHwnd = $top.ToInt64()
  $childHwnd = $child.ToInt64()

  # 1. Asking about one window answers about that window, and the unit space is the one Windows was measured in: the
  # rectangles are only called physical when the thread really is per-monitor DPI aware (DPI_AWARENESS = 2).
  $r = [Desk]::Content(0, $topHwnd)
  $awareness = $r['dpiAwareness']
  # The exact pixels asserted below are only real pixels when this thread is per-monitor DPI aware. Probe.Aware() made
  # the process so before any window existed; if that did not hold, the numbers here would be measuring virtualization,
  # so the case fails loudly instead of passing on virtualized rectangles.
  Require (($awareness -eq 2)) (('these assertions need a per-monitor DPI aware measurement (DPI_AWARENESS 2), got ' + $awareness))
  Require (($r['units'] -eq 'physical-screen-pixels')) ('a per-monitor aware measurement is physical pixels and must say so')
  Require (($r['windows'].Count -eq 1)) (('one hwnd must answer about one window, got ' + $r['windows'].Count))
  $w = $r['windows'][0]
  Require (([long]$w['hwnd'] -eq $topHwnd)) ('the answer must be about the window that was asked for')
  Require (([long]$w['pid'] -eq $me)) (('the window must report its real owning pid, got ' + $w['pid']))
  Require (($w['className'] -eq 'Static')) (('the class name must be measured, got ' + $w['className']))
  $cases++

  # 2. The outer frame is what was asked for, and a monitor left of the primary one keeps its negative pixels.
  $frame = Box $w['windowRect'] 'windowRect'
  Require (($null -ne $frame)) ('a real window has an outer frame')
  Require (([int]$frame['x'] -eq -1)) (('windowRect.x must be -1, got ' + $frame['x']))
  Require (([int]$frame['y'] -eq -40)) (('windowRect.y must be -40, got ' + $frame['y']))
  Require (([int]$frame['width'] -eq 300)) (('windowRect.width must be 300, got ' + $frame['width']))
  Require (([int]$frame['height'] -eq 200)) (('windowRect.height must be 200, got ' + $frame['height']))
  $cases++

  # 3. The client area is measured on the same screen, not at a made-up origin.
  $client = Box $w['clientRect'] 'clientRect'
  Require (($null -ne $client)) ('a live window has a client area')
  Require ((([int]$client['width']) -gt 0) -and (([int]$client['height']) -gt 0)) ('the client area must have a size')
  Require (([int]$client['x'] -eq -1)) (('a borderless popup draws from its own origin, got x ' + $client['x']))
  Require (([int]$client['y'] -eq -40)) (('a borderless popup draws from its own origin, got y ' + $client['y']))
  $cases++

  # 4. The seen frame is either measured or absent; it is never a fabricated 0x0.
  $seen = $w['frameRect']
  if ($null -ne $seen) {
    $seen = Box $seen 'frameRect'
    Require ((([int]$seen['width']) -gt 0) -and (([int]$seen['height']) -gt 0)) ('a reported frame must have a size')
  }
  $cases++

  # 5. DPI is reported for the audit trail, or as unknown; never assumed to be 96.
  $dpi = $w['dpi']
  if ($null -ne $dpi) {
    Require ((($dpi -is [int]) -and ($dpi -ge 48) -and ($dpi -le 960))) (('dpi must be a plausible measurement, got ' + $dpi))
  }
  $cases++

  # 6. The child surface is found, with the parent that was verified, and its own client origin.
  $found = $null
  foreach ($item in $r['renderer']) { if ([long]$item['hwnd'] -eq $childHwnd) { $found = $item } }
  Require (($null -ne $found)) ('the child surface must be enumerated')
  Require (([long]$found['parent'] -eq $topHwnd)) ('the child must name its verified top-level parent')
  Require (([long]$found['pid'] -eq $me)) ('the child must report its pid')
  Require (($found['className'] -eq 'Static')) ('the child class must be measured')
  $kid = Box $found['clientRect'] 'child clientRect'
  Require (([int]$kid['x'] -eq 4)) (('the child sits at its parent client origin + 5, got ' + $kid['x']))
  Require (([int]$kid['y'] -eq -33)) (('the child sits at its parent client origin + 7, got ' + $kid['y']))
  Require ((([int]$kid['width']) -eq 20) -and (([int]$kid['height']) -eq 10)) ('the child keeps its own size')
  $cases++

  # 7. A child hwnd resolves to its top-level window instead of answering about the child as if it were a window.
  $up = [Desk]::Content(0, $childHwnd)
  Require (($up['windows'].Count -eq 1)) ('a child hwnd must answer about one top-level window')
  Require (([long]$up['windows'][0]['hwnd'] -eq $topHwnd)) (('a child hwnd must resolve to its root, got ' + $up['windows'][0]['hwnd']))
  $cases++

  # 8. By pid: every window of this process is reported, and nothing of another process.
  $byPid = [Desk]::Content($me, 0)
  $mine = $false
  foreach ($item in $byPid['windows']) {
    Require (([long]$item['pid'] -eq $me)) (('a pid query must not report another process, got ' + $item['pid']))
    if ([long]$item['hwnd'] -eq $topHwnd) { $mine = $true }
  }
  Require ($mine) ('the pid query must include the probe window')
  $cases++

  # 9. Both given and agreeing is accepted; both given and disagreeing is refused, not silently ignored.
  $both = [Desk]::Content($me, $topHwnd)
  Require (([long]$both['windows'][0]['hwnd'] -eq $topHwnd)) ('an agreeing pid and hwnd must be answered')
  $refused = $false
  $why = ''
  try { [Desk]::Content(4, $topHwnd) | Out-Null } catch { $refused = $true; $why = $_.Exception.Message }
  Require ($refused) ('a pid that is not the window owner must be refused')
  Require (($why -match 'belongs to pid')) (('the refusal must say whose pid the window is, got ' + $why))
  $cases++

  # 10. Flags are reported rather than used to filter, so a caller can tell a hidden window from a missing one.
  Require (($w['visible'] -eq $false)) ('the probe was never shown, so visible must be false')
  Require (($w['minimized'] -eq $false)) ('the probe is not minimized')
  Require (($w['cloaked'] -is [bool])) ('cloaked must be reported as a fact')
  $cases++

  # 11. The stdin loop serializes this reply deep enough: a rectangle stays an object of numbers.
  $line = @{ id = 1; data = $r } | ConvertTo-Json -Compress -Depth 8
  $back = $line | ConvertFrom-Json
  $again = $back.data.windows[0].clientRect
  Require (($again.width -isnot [string])) ('at depth 8 the client rectangle must not collapse to a string')
  Require (([int]$again.width -gt 0)) (('the round trip must keep the client width, got ' + $again.width))
  Require (([int]$again.x -eq [int]$client['x'])) (('the round trip must keep the client origin, got ' + $again.x))
  $cases++

  # 12. Nothing is invented when there is nothing to answer about.
  $bad = 0
  try { [Desk]::Content(0, 0) | Out-Null } catch { $bad++ }
  try { [Desk]::Content(-1, 0) | Out-Null } catch { $bad++ }
  try { [Desk]::Content(0, -1) | Out-Null } catch { $bad++ }
  Require (($bad -eq 3)) (('no id, a negative pid and a negative hwnd must all be refused, got ' + $bad))
  $cases++
}
finally {
  [Probe]::Kill($child)
  [Probe]::Kill($top)
}

# 13. A window that is gone is reported as gone, not measured at 0,0.
$dead = [Probe]::Top(10, 10, 100, 100)
$deadHwnd = $dead.ToInt64()
[Probe]::Kill($dead)
$gone = $false
try { [Desk]::Content(0, $deadHwnd) | Out-Null } catch { $gone = ($_.Exception.Message -match 'is gone') }
Require ($gone) ('a destroyed window must be reported as gone')
$cases++

# 14. The per-monitor context the query needs is scoped to the query, not left on the caller's thread: asking a
# question must not change how the caller measures its own coordinates afterwards.
$scopedWindow = [Probe]::Top(0, 0, 60, 40)
$scopedHwnd = $scopedWindow.ToInt64()
try {
  [Probe]::ThreadAwareness(1)
  Require ((([Probe]::AwarenessNow()) -eq 1)) ('the probe must be able to put its thread in system DPI awareness')
  $scopedAnswer = [Desk]::Content(0, $scopedHwnd)
  Require (($scopedAnswer['units'] -eq 'physical-screen-pixels')) ('the query measures in per-monitor awareness even when its caller does not')
  Require ((([Probe]::AwarenessNow()) -eq 1)) (('the query must put the thread back in the awareness it found, got ' + [Probe]::AwarenessNow()))
  $cases++
}
finally {
  [Probe]::ThreadAwareness(2)
  [Probe]::Kill($scopedWindow)
}

Write-Output ('DESKTOP_WINDOW_CONTENT_OK ' + $cases)
