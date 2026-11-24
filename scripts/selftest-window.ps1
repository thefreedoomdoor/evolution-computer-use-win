<#
.SYNOPSIS
  computer-use 自测用的临时 WinForms 窗口。

.DESCRIPTION
  纯 WinForms、无外部依赖。创建一个唯一标题的小窗口（一个输入框 + 一个“回读”按钮），
  点按钮时把输入框内容写进 -ResultFile，然后关闭窗口；窗口默认 15 秒后自关。
  进程可以被自动化安全终止（taskkill / kill 都行）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/selftest-window.ps1 -Title "Evolution CU Selftest 1234" -ResultFile "$env:TEMP\out.txt"
#>
[CmdletBinding()]
param(
  [string]$Title = "Evolution CU Selftest",
  [string]$ResultFile = (Join-Path $env:TEMP "evolution-cu-selftest-$PID.txt"),
  [int]$LifeSeconds = 15
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:clicked = $false
$script:wrote = $false

function Write-Result([string]$Text) {
  $script:wrote = $true
  try {
    [System.IO.File]::WriteAllText($ResultFile, $Text, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    # 写不了结果文件也不该让窗口崩掉：自测会按失败处理。
  }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.ClientSize = New-Object System.Drawing.Size(400, 120)
$form.StartPosition = 'CenterScreen'
$form.MinimizeBox = $false
$form.MaximizeBox = $false

$label = New-Object System.Windows.Forms.Label
$label.Text = '输入一段文字（会自动回读）：'
$label.Location = New-Object System.Drawing.Point(20, 15)
$label.AutoSize = $true
$form.Controls.Add($label)

$box = New-Object System.Windows.Forms.TextBox
$box.Name = 'InputBox'
$box.Location = New-Object System.Drawing.Point(20, 40)
$box.Width = 360
$form.Controls.Add($box)

# 输入框内容一变就写结果文件：按钮在后台模式下可能收不到 PostMessage 的鼠标消息，
# 而文字变化事件在窗口不激活时也会触发，能稳定证明“点击 + 输入”整条链路。
$box.Add_TextChanged({
  if ($box.Text.Length -gt 0) { Write-Result $box.Text }
})

$button = New-Object System.Windows.Forms.Button
$button.Name = 'ReadBack'
$button.Text = '回读'
$button.Location = New-Object System.Drawing.Point(20, 75)
$button.Width = 100
$button.Add_Click({
  $script:clicked = $true
  Write-Result $box.Text
  # 不在这里关窗：desktop 的“点击/回车”动作后会补一张截图，
  # 窗口当场关闭会被判定为“窗口不见了”。由定时器或自测在最后关闭。
})
$form.Controls.Add($button)
$form.AcceptButton = $button

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1000, $LifeSeconds * 1000)
$timer.Add_Tick({
  $timer.Stop()
  if (-not $script:wrote) { Write-Result '__TIMEOUT__' }
  $form.Close()
})

$form.Add_Shown({
  $box.Focus() | Out-Null
  $box.SelectAll()
  $timer.Start()
})

# 被外部终止时（CloseMainWindow / kill）也留下一个可判定的结果，方便自动化确认。
$form.Add_FormClosing({
  if (-not $script:wrote) { Write-Result '__CLOSED__' }
})

[void]$form.ShowDialog()
$timer.Dispose()
$form.Dispose()
