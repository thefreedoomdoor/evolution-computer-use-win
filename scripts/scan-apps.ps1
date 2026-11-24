# scripts/scan-apps.ps1
# 只读扫描 Windows 上“能启动的软件”的来源，输出单个 JSON 对象。
# 只用系统自带的 PowerShell：不写注册表、不删文件、不安装任何东西。
# 输出形状（与 src/apps/library.ts 的 RawScanOutput 对应）：
#   { startApps:[{name,appId}], startMenu:[{name,target,arguments}],
#     appPaths:[{name,exe}], uninstall:[{name,displayIcon,installLocation}] }

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

function Clean([object]$value) {
  if ($null -eq $value) { return $null }
  $text = [string]$value
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  return $text.Trim()
}

$result = [ordered]@{
  startApps = @()
  startMenu = @()
  appPaths  = @()
  uninstall = @()
}

# 1) Get-StartApps：Win10/11 开始菜单应用（含 UWP 的 AUMID）
try {
  foreach ($app in @(Get-StartApps)) {
    $name = Clean $app.Name
    if (-not $name) { continue }
    $result.startApps += [ordered]@{ name = $name; appId = (Clean $app.AppID) }
  }
} catch { }

# 2) 开始菜单 .lnk：用 WScript.Shell 解析 TargetPath / Arguments
try {
  $shell = New-Object -ComObject WScript.Shell
  $menuDirs = @(
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
  )
  foreach ($dir in $menuDirs) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    Get-ChildItem -LiteralPath $dir -Recurse -Filter *.lnk -File | ForEach-Object {
      try {
        $shortcut = $shell.CreateShortcut($_.FullName)
        $target = Clean $shortcut.TargetPath
        if ($target) {
          $result.startMenu += [ordered]@{
            name      = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
            target    = $target
            arguments = (Clean $shortcut.Arguments)
          }
        }
      } catch { }
    }
  }
} catch { }

# 3) 注册表 App Paths（HKLM 32/64 位 + HKCU）
try {
  $appPathRoots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths'
  )
  foreach ($root in $appPathRoots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    Get-ChildItem -LiteralPath $root | ForEach-Object {
      $exe = Clean $_.GetValue('')
      if ($exe) {
        $result.appPaths += [ordered]@{
          name = [System.IO.Path]::GetFileNameWithoutExtension($_.PSChildName)
          exe  = $exe
        }
      }
    }
  }
} catch { }

# 4) 卸载表：DisplayIcon / InstallLocation
try {
  $uninstallRoots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  foreach ($root in $uninstallRoots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    Get-ChildItem -LiteralPath $root | ForEach-Object {
      $name = Clean $_.GetValue('DisplayName')
      if (-not $name) { continue }
      $result.uninstall += [ordered]@{
        name            = $name
        displayIcon     = (Clean $_.GetValue('DisplayIcon'))
        installLocation = (Clean $_.GetValue('InstallLocation'))
      }
    }
  }
} catch { }

$result | ConvertTo-Json -Depth 6 -Compress
