# Appearance, audit and app-policy files

Three surfaces read the same files: the MCP server (TypeScript), the desk driver's
banner (`src/desktop/win32.ps1`), and the thought/audit helper
(`scripts/windows-takeover.cs`, spawned by `src/desktop/overlay.ts`). The DSH
plugin `dsh-evolution-desktop-mode` is the settings UI and the only writer.

All files live in `~/.evolution-computer-use/` (the data directory is fixed for
these files; `--data` does not move them). Every read tolerates a missing file,
missing keys, wrong types and out-of-range numbers by falling back to the
default below.

## appearance.json

```json
{
  "version": 1,
  "banner": {
    "text": "DSH正在操作{app}",
    "hint": "连按两下 Esc 停下",
    "stop": "停下",
    "stopped": "已停下",
    "width": 0,
    "height": 38,
    "opacity": 100,
    "position": "top-center",
    "x": null,
    "y": null,
    "colors": {
      "bg": "#EC181A20",
      "text": "#F5F7FA", "hint": "#969CA8",
      "dot": "#408CFF", "stopBg": "#22FFFFFF", "stopText": "#F0F2F6",
      "border": "#00000000"
    },
    "fonts": {
      "main": { "family": "Microsoft YaHei UI", "size": 14, "bold": true },
      "hint": { "family": "Microsoft YaHei UI", "size": 12.5, "bold": false },
      "stop": { "family": "Microsoft YaHei UI", "size": 12.5, "bold": false }
    },
    "layout": { "align": "center", "offsetX": 0, "offsetY": 6, "gap": 10, "padding": 16 }
  },
  "audit": {
    "enabled": true,
    "width": 420, "height": 340, "opacity": 88, "locked": true,
    "position": "left-of-thought", "x": null, "y": null,
    "colors": {
      "bg": "#EB0B0D12", "border": "#2A3140",
      "text": "#E6EAF2", "muted": "#8A93A3",
      "accent": "#4ADE80", "reason": "#C7B26B", "shot": "#5B8DEF"
    },
    "fonts": {
      "title": { "family": "Microsoft YaHei UI", "size": 13, "bold": true },
      "body": { "family": "Microsoft YaHei UI", "size": 12.5, "bold": false }
    },
    "layout": { "rows": 12, "showTime": true, "showReason": true, "showThumb": false,
                "padding": 12, "gap": 6 }
  },
  "thought": {
    "width": 360, "height": 240, "opacity": 60, "locked": true,
    "position": "top-right", "x": null, "y": null,
    "colors": {
      "bg": "#99191D26", "border": "#75A1DA",
      "text": "#F6F7FA", "muted": "#B9C6D8", "accent": "#5B8DEF"
    },
    "fonts": {
      "title": { "family": "Microsoft YaHei UI", "size": 14, "bold": true },
      "body": { "family": "Microsoft YaHei UI", "size": 14.667, "bold": false }
    }
  },
  "auditLog": {
    "enabled": true,
    "screenshots": true,
    "retentionDays": 7,
    "maxScreenshotsMB": 500,
    "maxEntries": 5000
  }
}
```

* `banner.width = 0` means "as wide as the words need"; a positive width fixes it.
* `banner.height` is the capsule height in 96-DPI pixels (28-120).
* `banner.opacity` and `audit.opacity`, `thought.opacity` are 20-100 (%).
  Opacity is the whole window, not just its background.
* `position`: banner `top-left|top-center|top-right|custom`;
  audit `left-of-thought|top-left|top-right|bottom-left|bottom-right|custom`;
  thought `top-left|top-right|bottom-left|bottom-right|custom`.
  `custom` uses `x`, `y` (screen pixels). `left-of-thought` places the audit
  panel immediately left of the thought panel, top edges aligned.
* Colors are `#RRGGBB`; `bg` is `#AARRGGBB` (alpha first, .NET order). Font sizes are 96-DPI pixels. A family
  that is not installed falls back to Microsoft YaHei UI, then Segoe UI.
* Fonts uploaded in the plugin are copied to `~/.evolution-computer-use/fonts/`
  (`*.ttf`, `*.otf`); helpers load them with a PrivateFontCollection, so a
  family that only exists there still works.
* `{app}` is replaced by the program name (the window's `exe` without `.exe`,
  or the Start-menu name the agent opened). Empty `{app}` leaves
  `DSH正在操作`.

## app-policies.json

```json
{
  "version": 1,
  "apps": [
    { "match": "exe:Weixin.exe", "label": "微信", "mode": "foreground" },
    { "match": "exe:notepad.exe", "label": "记事本", "mode": "background" }
  ]
}
```

`match` is `exe:<process name with .exe>`, `title:<window title>` or
`app:<name the agent opened>`; the first match wins. `mode` overrides the
global desktop mode for operations on that program: `foreground` means the
server asks for the administrator helper (UAC) before the operation and fails
the operation if the user declines; `background` means it drops to background
mode for the operation. Operations on programs without a policy use the global
mode. The global mode itself stays whatever the user picked.

## audit-YYYY-MM-DD.jsonl (one JSON object per line, written by the server)

```json
{"at":"2026-11-24T13:02:11.482+08:00","session":"...","turn":4,"tool":"desktop","action":"click","app":"微信","exe":"Weixin.exe","title":"微信","x":412,"y":238,"x2":null,"y2":null,"double":false,"right":false,"key":"","modifiers":[],"text":"","direction":"","seconds":0,"ok":true,"result":"点击了微信的窗口，截图附在结果里。","reason":"点开设置","shot":"shots/20261124-130211-482-3.png"}
```

* `shot` is a path relative to the audit directory, or `""` when no picture was
  kept. Screenshots are deleted by retention, never by the tool that made them.
* `reason`: the `reason` the agent supplied for this step when present,
  otherwise the last reasoning text from `activity.json`, trimmed to 500 chars.

## audit-live.tsv (written by the server for the audit window)

One entry per line, newest last, at most 40 lines, tab-separated, no tabs or
newlines inside fields (replace with spaces). Columns:

```
at<TAB>ok<TAB>action<TAB>app<TAB>detail<TAB>reason<TAB>shot
```

`at` is `HH:mm:ss`; `ok` is `1` or `0`; `detail` is a human phrase such as
`点击 (412,238)`, `双击 (412,238)`, `右键 (412,238)`, `拖动 (12,34)→(90,120)`,
`按键 Ctrl+S`, `输入 12 个字`, `滚动 ↓`, `打开 微信`, `关闭 记事本`, `截图`;
`shot` is the path relative to the audit directory (empty allowed). The file is
rewritten atomically (write `.tmp` then rename) after every entry.

## Stop and failure semantics (unchanged)

The banner stays while the agent works and for its linger; the audit window
shows alongside the thought window whenever the thought overlay is enabled.
Neither window is ever captured (SetWindowDisplayAffinity 0x11).

## Helper settings keys

`overlay.ts` forwards a flat `settings` object in its `progress` command; the
helper reads these keys. Same names as `appearance.json`, flattened.

Thought window: `progressOverlayEnabled`, `progressOverlayPosition`,
`progressOverlayWidth`, `progressOverlayHeight`, `progressOverlayOpacity`,
`progressOverlayLocked`, `progressOverlayBg` (AARRGGBB), `progressOverlayBorder`,
`progressOverlayText`, `progressOverlayMuted`, `progressOverlayAccent`,
`progressOverlayFontFamily`, `progressOverlayTitleSize`,
`progressOverlayBodySize`.

Audit window: `auditOverlayEnabled`, `auditOverlayPosition`,
`auditOverlayWidth`, `auditOverlayHeight`, `auditOverlayOpacity`,
`auditOverlayLocked`, `auditOverlayX`, `auditOverlayY`, `auditOverlayGap`,
`auditOverlayRows`, `auditOverlayShowTime`, `auditOverlayShowReason`,
`auditOverlayShowThumb`, `auditOverlayBg` (AARRGGBB), `auditOverlayBorder`,
`auditOverlayText`, `auditOverlayMuted`, `auditOverlayAccent`,
`auditOverlayReason`, `auditOverlayShot`, `auditOverlayFontFamily`,
`auditOverlayTitleSize`, `auditOverlayBodySize`, `auditOverlayData` (the
absolute path of `audit-live.tsv`).

The banner receives the whole `banner` object from `appearance.json` as the
`style` field of the `sign` command (`style.position`, `style.colors.bg`, …).
