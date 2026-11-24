# 全后台验证的取样器：每 25 ms 记一次前台窗口、鼠标坐标、目标窗口的最小化/可见状态、
# 目标窗口中心那个像素上到底是哪个窗口（被盖住时就不是目标窗口），
# 以及它在「可见顶层窗口」里的 Z 序位置（越小越靠前）和它有没有跑到参照窗口前面。
param(
  [Parameter(Mandatory = $true)][int]$Hwnd,
  [int]$Ref = 0,
  [int]$Milliseconds = 8000,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$EveryMs = 25
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BgProbe {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr parent);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
}
'@
$target = [IntPtr]$Hwnd
$reference = [IntPtr]$Ref
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# everyMs=' + $EveryMs)
$watch = [Diagnostics.Stopwatch]::StartNew()
while ($watch.ElapsedMilliseconds -lt $Milliseconds) {
  $fg = [BgProbe]::GetForegroundWindow()
  $cursor = New-Object BgProbe+POINT
  [void][BgProbe]::GetCursorPos([ref]$cursor)
  $rect = New-Object BgProbe+RECT
  $valid = [BgProbe]::GetWindowRect($target, [ref]$rect)
  $atCenter = 0
  if ($valid -and $rect.Left -gt -30000 -and $rect.Right -gt $rect.Left) {
    $probe = New-Object BgProbe+POINT
    $probe.X = [int](($rect.Left + $rect.Right) / 2)
    $probe.Y = [int](($rect.Top + $rect.Bottom) / 2)
    $atCenter = [BgProbe]::GetAncestor([BgProbe]::WindowFromPoint($probe), 2).ToInt64()
  }
  # Z 序：只数真正可见、有面积的顶层窗口（隐藏的辅助窗口会来回出现，数进去只会制造噪声）。
  $rank = -1
  $refRank = -1
  $walk = [BgProbe]::GetTopWindow([IntPtr]::Zero)
  $index = 0
  while ($walk -ne [IntPtr]::Zero -and $index -lt 600) {
    $box = New-Object BgProbe+RECT
    $shape = [BgProbe]::GetWindowRect($walk, [ref]$box)
    if ([BgProbe]::IsWindowVisible($walk) -and $shape -and $box.Right -gt $box.Left -and $box.Bottom -gt $box.Top) {
      $index++
      if ($walk -eq $target) { $rank = $index }
      if ($walk -eq $reference) { $refRank = $index }
    }
    if ($rank -gt 0 -and ($refRank -gt 0 -or $reference -eq [IntPtr]::Zero)) { break }
    $walk = [BgProbe]::GetWindow($walk, 2)
  }
  $above = -1
  if ($rank -gt 0 -and $refRank -gt 0) { if ($rank -lt $refRank) { $above = 1 } else { $above = 0 } }
  $lines.Add(('{0}|{1}|{2},{3}|{4}|{5}|{6}|{7}|{8}|{9}|{10}' -f $watch.ElapsedMilliseconds, $fg.ToInt64(), $cursor.X, $cursor.Y,
    [BgProbe]::IsIconic($target), [BgProbe]::IsWindowVisible($target), $atCenter, $valid, $rank, $refRank, $above))
  Start-Sleep -Milliseconds $EveryMs
}
[IO.File]::WriteAllLines($Out, $lines, (New-Object Text.UTF8Encoding($false)))
