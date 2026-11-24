<#
  字体助手：列系统字体、读字体文件的家族名。

  用法（输出都是 UTF-8 JSON）：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fonts.ps1 -Mode installed
      -> {"families":["Microsoft YaHei UI", ...]}
    powershell ... -Mode family -File C:\...\x.ttf
      -> {"family":"思源黑体"}
    powershell ... -Mode list -Files a.ttf b.otf
      -> {"fonts":[{"file":"a.ttf","family":"..."}, ...]}

  家族名用 PrivateFontCollection 直接读字体文件；解析失败就回空串，由调用方兜底。
#>
param(
  [string]$Mode = 'installed',
  [string]$File = '',
  [string[]]$Files = @()
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Drawing

# 只为了把字符串安全地放进 JSON：引号、反斜杠、控制字符都转义。
$source = @'
using System.Text;

public static class EvocuJson
{
    public static string String(string value)
    {
        if (value == null) return "\"\"";
        StringBuilder sb = new StringBuilder(value.Length + 2);
        sb.Append('"');
        foreach (char c in value)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
'@

Add-Type -TypeDefinition $source

function Get-FamilyName([string]$path) {
  try {
    $collection = New-Object System.Drawing.Text.PrivateFontCollection
    $collection.AddFontFile($path)
    if ($collection.Families.Count -gt 0) {
      return $collection.Families[0].Name
    }
  } catch {
    # 字体损坏或不是有效字体，交给调用方用文件名兜底
  }
  return ''
}

if ($Mode -eq 'installed') {
  $names = New-Object System.Collections.Generic.List[string]
  $installed = New-Object System.Drawing.Text.InstalledFontCollection
  foreach ($family in $installed.Families) {
    $name = $family.Name
    if ($name -and $name.Trim().Length -gt 0) {
      $names.Add($name.Trim())
    }
  }
  $parts = @()
  foreach ($name in ($names | Sort-Object -Unique)) {
    $parts += [EvocuJson]::String($name)
  }
  Write-Output ('{"families":[' + ($parts -join ',') + ']}')
  return
}

if ($Mode -eq 'family') {
  $family = ''
  if ($File) { $family = Get-FamilyName $File }
  Write-Output ('{"family":' + [EvocuJson]::String($family) + '}')
  return
}

if ($Mode -eq 'list') {
  $parts = @()
  foreach ($path in $Files) {
    $family = ''
    if ($path) { $family = Get-FamilyName $path }
    $parts += ('{"file":' + [EvocuJson]::String($path) + ',"family":' + [EvocuJson]::String($family) + '}')
  }
  Write-Output ('{"fonts":[' + ($parts -join ',') + ']}')
  return
}

Write-Error ('未知模式：' + $Mode)
exit 2
