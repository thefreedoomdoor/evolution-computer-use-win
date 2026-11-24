# evolution-computer-use-win

English | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.16-informational)](package.json)
[![Windows](https://img.shields.io/badge/desktop-Windows%2010%2F11-0078D4)](package.json)
[![MCP](https://img.shields.io/badge/protocol-stdio-6E4AFF)](https://modelcontextprotocol.io)

Computer use for **DeepSeek Harness** over the Model Context Protocol (stdio): the agent learns how to use a website or a desktop program, saves that as a procedure, and replays it later without spending model steps on discovery again.

- Browser control and, on Windows, background desktop control.
- A software index built by `init`: where every program lives, stored encrypted, refreshed on every start, so "open WeChat" never needs a pasted path.
- Learned procedures are plain JSON files: versioned, repairable, shareable between agents.
- One DSH plugin installs both halves — the MCP server and the settings UI — on one Node process with zero runtime dependencies.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Tools](#tools)
- [Procedures](#procedures)
- [Desktop control](#desktop-control)
- [Overlays and appearance](#overlays-and-appearance)
- [Inbox](#inbox)
- [Message log](#message-log)
- [Files](#files)
- [Security and risks](#security-and-risks)
- [Multiple agents](#multiple-agents)
- [Development](#development)
- [Design notes](#design-notes)
- [License and credits](#license-and-credits)

## Features

| Capability | What you get |
| --- | --- |
| **Learn once, replay forever** | A working session is saved as a procedure; the next run executes it directly, and a repair updates the same file in place. |
| **Browser control** | Nine `page_*` tools drive Edge or Chrome on a dedicated profile, so the agent's logins stay its own and your browser is never touched. |
| **Background desktop control** | The agent sees one window's screenshots and posts input straight to that window. Your mouse pointer, focus and clipboard stay yours; a covered window can still be read and clicked. |
| **Visible while it works** | A banner at the top of the screen says `DSH正在操作{app}` and carries a stop button for as long as the agent operates this computer. Wording, size, position, colors, fonts and spacing are yours to set. |
| **Actions with reasons** | A second panel beside the thought panel lists every click, scroll, double or right click, key combination, program open or close and screenshot, each with the reason the agent gave. The same rows are kept in daily audit files. |
| **Per-app foreground rules** | One program can be sent to foreground while everything else stays in background. A window picker fills the rule, and a background rule avoids whole-screen captures for that program. |
| **Knows where your programs are** | `init` scans the Start menu, App Paths, uninstall entries and Program Files, keeps the result in an encrypted `apps-index.enc`, and refreshes it on every DSH start. `open WeChat` no longer needs a path from you. |
| **Tested on first run** | The first start also drives a local page through the browser tools and a temporary WinForms window through the desktop tools, then writes `init-report.json` and a readable `.md` with a screenshot per step. Run it again any time with `evolution-computer-use-win init`. |
| **One install, both halves** | Installing the DSH bundle registers the stdio MCP server and the settings UI together; there is no separate companion plugin. |
| **Self-repair that keeps working** | Failed replays fall back to the last two saved versions, and results are checked so a broken selector fails loudly instead of reporting "done". |
| **Auditable by design** | Every operation is a readable file, every change leaves an old version behind, and every desktop action passes through one visible, stoppable channel. |

## Requirements

| Requirement | Notes |
| --- | --- |
| **OS** | Windows 10 or 11. Both halves depend on it: browser discovery looks for `msedge.exe` / `chrome.exe` under the Windows install roots, and desktop control is Windows-only. |
| **Node.js** | 22.16.0 or newer. No package is installed beyond this one. |
| **Browser** | Microsoft Edge or Google Chrome, with a default Windows install. The agent starts its own instance on its own profile. |
| **Host** | **DeepSeek Harness** with plugin support. This project is a DSH plugin bundle: the same install adds the settings page and registers its own MCP server. Not adapted for other agent apps. |
| **Privileges** | None for background desktop control. Foreground mode needs administrator rights and raises a UAC prompt. |

## Install

### As a DSH plugin (recommended)

Install the published package into a folder:

```powershell
npm install evolution-computer-use-win
```

Then install `node_modules/evolution-computer-use-win` as a DSH plugin bundle: open **Settings → Plugins → Install from folder** and choose that folder. From an agent session, `plugin_manager` with `action: "install_bundle"` and the absolute folder does the same. One install adds the settings page and registers the MCP server automatically — there is no separate `mcpServers` entry and no companion plugin.

To work from source instead, build the checkout once and choose the checkout folder:

```powershell
git clone https://github.com/thefreedoomdoor/evolution-computer-use-win
cd evolution-computer-use-win
npm install
npm run build
```

If an older standalone `dsh-evolution-desktop-mode` plugin is still installed, remove it first: this package now contains that settings page, and the two use the same plugin id, so they cannot coexist.

The first start after installing runs `init` in the background: it scans program locations into an encrypted index and runs the computer-use self-test, writing a report (see [Configuration](#configuration)). Run `evolution-computer-use-win init` any time you want a full check.

> **Not adapted for other agent apps.** The MCP server itself is host-agnostic, but only DSH drives it: the plugin half, the overlay writer and the settings page are DSH-specific, and no other host has been tested.

## Quick start

1. Install the plugin as above and restart the harness. The first start scans your programs and runs the self-test; ask the agent to run `init` at any time to repeat it.
2. Ask for something in plain words, for example `看看我 B 站有没有新私信` ("check my new messages on Bilibili").
3. The agent calls `computer_use("B站")` to load that category's notes, works the page with `page_*` tools, answers, and saves what worked:

```text
computer_use("B站")                     → category notes + learned procedures
page_open("https://message.bilibili.com/")
page_read()                              → 3 unread, one from 小明
page_shot()                              → screenshot
procedure_save({ ... })                  → bilibili/看未读.json
```

Next time the same request replays that file in one `procedure_run` call.

## Configuration

```text
evolution-computer-use-win [init|serve|resume|routines|status] [options]
```

| Command | Purpose |
| --- | --- |
| `init` | Scans program locations and runs the computer-use self-test, then prints a Markdown report (`--json` for JSON). A full scan; the plugin also does this on first start. |
| `serve` | Default. Runs the MCP server on stdio. |
| `resume` | Clears the emergency stop and lets desktop control work again. |
| `routines` | Runs every `onAlarm` procedure once, for use from a scheduler. |
| `status` | Lists learned procedures and categories. |

| Option | Default | Meaning |
| --- | --- | --- |
| `--data <dir>` | `~/.evolution-computer-use` | Data folder: procedures, browser profile, message log. |
| `--procedures <dir>` | `<data>/procedures` | Where learned procedures live; point several agents here to share them. |
| `--profile <dir>` | `<data>/browser` | Browser profile, including its logins. |
| `--desktop off\|background\|foreground` | `off` | Desktop control mode at startup. |
| `--name <text>` | `AI` | Companion name in the on-screen operation banner (`AI is operating`). The thought overlay never shows it. |
| `--inbox-ignore <a,b>` | none | Program names never to report in the inbox. |
| `--no-inbox` | off | Do not watch the taskbar or notifications. |
| `--no-messages` | off | Do not write `messages.jsonl`. |
| `--no-overlay` | off | Do not start the overlay helper at all. |
| `--skip-selftest` | off | With `init`, scan only. |
| `--network` | off | With `init`, let the self-test reach the internet; the default uses local pages only. |
| `--json` | off | With `init`, print the report as JSON. |
| `-h`, `--help` | | Print usage. |

`EVOLUTION_CU_NO_AUTO_INIT=1` skips the automatic scan and self-test on server start, for hosts that want to run `init` themselves.

The data folder after a first run:

```text
~/.evolution-computer-use/
├─ browser/                  browser profile; logins live here
├─ procedures/
│  ├─ bilibili/看未读.json
│  ├─ bilibili/看未读.v2.json   kept previous version
│  └─ bilibili/目录.md          notes for the category, ≤ 1000 chars
├─ messages.jsonl            extracted messages, one record per line
├─ apps-index.enc            encrypted program-location index
├─ init-report.json          last full init report (plus init-report.md)
├─ startup-report.json       last startup scan/self-test result
├─ selftest/                 self-test screenshots
├─ desktop-mode.json         written by the DSH plugin, read every 0.8 s
├─ activity.json             overlay content, written by the DSH plugin
├─ activity-settings.json    overlay position, size, opacity, lock
├─ appearance.json           banner, thought and audit panel appearance
├─ app-policies.json         per-program foreground/background rules
├─ audit/                    audit-YYYY-MM-DD.jsonl, audit-live.tsv, shots/
├─ fonts/                    uploaded fonts for the banner and panels
└─ overlay.lock              single-instance lock held by the server process
```

The plugin-written paths — `desktop-mode.json`, `activity.json`, `activity-settings.json`, `appearance.json`, `app-policies.json`, `audit/` and `fonts/` — always live at `~/.evolution-computer-use/`, whatever `--data` says.

## Tools

| Group | Tool | Description |
| --- | --- | --- |
| Browser | `page_open` | Opens a URL in the agent's own browser. |
| | `page_read` | Lists the actionable elements of the current page, paged. |
| | `page_click` | Clicks an element by the number `page_read` returned. |
| | `page_type` | Types into an input, optionally submitting. |
| | `page_press` | Presses Enter, Tab, Escape and the like. |
| | `page_scroll` | Scrolls the page or one element. |
| | `page_wait` | Waits for text or an element. |
| | `page_shot` | Screenshots the page. |
| | `page_eval` | Runs a short script in the page and returns JSON. |
| Desktop | `desktop` | Acts on the user's computer: `open`, `shot`, `click`, `drag`, `type`, `press`, `scroll`, `zoom`, `record` / `stop` / `review`. Only while desktop control is on. An optional `reason` is what the audit panel and log show for the call. |
| | `desktop_mode` | Switches between `off`, `background` and `foreground` at runtime. Always present, so it can turn control on; foreground needs `confirm: true`. |
| Procedures | `computer_use` | Names the program or site about to be used and returns its notes, procedure names and folder. Without arguments, lists modules, categories and faults. |
| | `procedure_run` | Runs a learned procedure; `path` is `category/name`. |
| | `procedure_save` | Saves working steps as a procedure; without `json` it returns the full format description. |
| | `procedure_note` | Writes a category's notes: the program or site, its addresses and aliases, caveats. |
| | `procedure_routines` | Runs every `onAlarm` web procedure once, each in its own tab. |
| Setup | `init` | Scans program locations into the encrypted index and runs the computer-use self-test; returns the report. Runs automatically on first start. |
| Inbox | `inbox_read` | Reports what is waiting: taskbar flashes and notifications. Only while the inbox is on. |

The tool set is fixed once the server starts, with one exception: switching the desktop mode adds or removes the `desktop` tool, and the server then sends `notifications/tools/list_changed`. Whether `inbox_read` exists is decided at startup by `--no-inbox`. Learning a procedure never changes the list, so saving one cannot invalidate the host's prompt cache.

## Procedures

A procedure is one JSON file. The agent learns by exploring (`computer_use` → `page_*` → `procedure_save`), and later runs it with `procedure_run`.

| Field | Meaning |
| --- | --- |
| `name`, `category` | File location: `<procedures>/<category>/<name>.json`. |
| `description` | One line telling the agent when to use it. |
| `params` | Optional parameters: a map from each parameter's name to `type` (`string`, `number` or `boolean`), `required` and `description`. An `onAlarm` procedure cannot declare required parameters. |
| `where` | `"desktop"` or `"screen"` for a procedure that works the user's computer — background mode or foreground mode. Such a procedure cannot set `onAlarm`, `summary` or `messages`. A web procedure omits it. |
| `steps` | The operations, executed in order; at most 40. |
| `onAlarm` | Marks a routine for `procedure_routines` and scheduled runs. |
| `summary` | Optional template used in routine reports, e.g. `私信 {{count}} 条`. |
| `messages` | Optional mapping that writes extracted messages to `messages.jsonl`. |

Step kinds, all in the same declarative shape:

| Step | Shape | Notes |
| --- | --- | --- |
| `open` | `{"open": "https://…"}` | Opens a page in the agent's browser. |
| `click` | `{"click": <anchor>}` | Anchor: `role`, `name`, `text`, `css`, or `nth`. |
| `type` | `{"type": {"into": <anchor>, "text": "…"}}` | Replaces the field's content. |
| `press` | `{"press": "Enter"}` | A single key. |
| `wait` | `{"wait": <condition>}` | Condition: `text`, `anchor` or `url`. |
| `check` | `{"check": <condition>}` | Like `wait`, but waits up to 3 s and fails the step if not met. |
| `extract` | `{"extract": {"list": <anchor>, "fields": {…}, "limit": n}}` | Collects rows; an empty result is a failure unless the step has `allowEmpty: true`. |
| `script` | `{"script": "…", "as": "name"}` | In-page script for what declarative steps cannot reach. |

Two flags per step: `outward: true` marks a step that sends something (a message, a comment); it is never retried automatically. `allowEmpty: true` marks a step that may legitimately come back empty.

A procedure with `where` set works the user's computer instead of a page, and its steps are pixels on the screenshot (coordinates are 0–4000; a `type` step takes `x` and `y` together or not at all):

| Step | Shape | Notes |
| --- | --- | --- |
| `open` | `{"open": "微信"}` | Opens a program by name, from its window, tray icon or the Start menu. |
| `click` | `{"click": {"x": 120, "y": 240, "double": true, "right": true, "hold": 2}}` | `double`, `right` and `hold` are optional. |
| `drag` | `{"drag": {"x": 10, "y": 20, "x2": 300, "y2": 400}}` | Press at `x`,`y`, release at `x2`,`y2`; `right` and `hold` are optional. |
| `type` | `{"type": {"text": "你好", "x": 100, "y": 200}}` | The coordinates are optional: given, the field is clicked first. |
| `press` | `{"press": "return", "hold": 0.5}` | A desktop key: `return`, `tab`, `escape`, `space`, `backspace`, `delete`, `home`, `end`, `pageup`, `pagedown`, the arrow keys, `f1`–`f12`, a single letter or digit. `hold` seconds are optional. |
| `scroll` | `{"scroll": {"direction": "down", "x": 500, "y": 300}}` | Direction `up`, `down`, `left` or `right`. |
| `wait` | `{"wait": {"seconds": 2}}` | Seconds only, more than 0 and at most 60. |

```json
{
  "name": "看未读",
  "category": "bilibili",
  "description": "看 B 站消息页的未读",
  "onAlarm": true,
  "summary": "私信 {{count}} 条",
  "steps": [
    { "open": "https://message.bilibili.com/" },
    { "wait": { "text": "我的消息" } },
    { "extract": { "list": { "role": "listitem" }, "fields": { "who": { "role": "link" }, "text": { "role": "paragraph" } }, "limit": 8 }, "allowEmpty": true }
  ]
}
```

**Versioning.** Saving under an existing name stores the old file as `<name>.v<n>.json` and keeps the two most recent versions. When the newest version fails before any `outward` step ran, the kept versions are tried, newest first, and the successful one is reported as the version that worked.

**Category notes.** Each category has a `目录.md` of at most 1000 characters: which site or program it is, aliases the agent should recognise, and what to watch out for. This is what `computer_use` returns: a target is matched word by word against category names and notes, never against procedure names.

**Sharing.** Point several agents at the same `--procedures` folder and they share everything learned. The folder is plain text, so it versions cleanly in git.

## Desktop control

| Mode | What the agent can do | Your mouse and focus |
| --- | --- | --- |
| `off` | Nothing; the `desktop` tool is not offered. | Unaffected. |
| `background` | Screenshot one window and post input to it. | Unaffected. The agent works while you use the computer. |
| `foreground` | The whole screen, with the real mouse and keyboard. | Follows the agent. Needs administrator rights (UAC). |

Background mode in detail:

1. The agent sees the screenshot of one window. Input is posted directly to that window, so it works even when the window is covered by others.
2. `open` finds the program in this order: an open window (a minimized one is restored in place), then a tray icon, then the Start menu. A program running with neither a window nor a tray icon is not launched again, so WeChat 4.x does not get a second copy.
3. Pages are the exception: Chromium discards posted `WM_CHAR`/`WM_KEYDOWN`, so typing into an address bar or clicking inside a page does nothing. Use `open` with a `url` instead; the agent's own browser is opened behind every other window over CDP.
4. Windows of programs running as administrator cannot be reached from background mode. Switch to foreground if a program needs it.

Foreground mode takes the real mouse and keyboard for the whole session and brings the program it works in to the front; that window stays in front afterwards. It is meant for programs that refuse anything else.

**Stopping.** Press Esc twice within half a second, or click the stop button on the banner the agent shows while it works. The `desktop-stopped` file then stays in the data folder, every desktop operation is refused, and nothing resumes until `evolution-computer-use-win resume` clears it. A stop during a running call takes effect at the next step.

### Per-app policies

The three modes above are the global setting. `app-policies.json` — edited under "Per-app" in the plugin settings — adds rules for single programs. A rule matches one of:

| `match` | Matches |
| --- | --- |
| `exe:Weixin.exe` | The program's executable, case-insensitive; `exe` and `exe.exe` are treated as the same name. |
| `app:微信` | The program name the agent passes to `open`. |
| `title:无标题 - Notepad` | The window title, for documents that share one executable. |

The first matching rule wins; programs without a rule follow the global mode. `mode: "foreground"` starts the administrator helper (UAC) before that program is touched — refusing the prompt fails that operation, and the global mode stays where you put it. `mode: "background"` keeps that program's operations in background even when the global mode is foreground, so only its own window is captured instead of the whole screen. Leaving a program that borrowed the foreground helper stops the helper again.

The settings page lists visible windows with thumbnails, OBS-style: pick one and the rule is filled with its `exe:` name (or `title:` for a document window).

A saved procedure replays in the mode it was recorded with (`where: "desktop"` is background, `"screen"` is foreground); per-app rules do not reroute procedure runs.

## Overlays and appearance

Three windows can appear while the agent works on this machine: a banner at the top, a thought panel in the top right and an audit panel to its left. All three are drawn by a small WinForms helper and are click-through unless unlocked. Windows is asked to keep them out of captures (`SetWindowDisplayAffinity` with `WDA_EXCLUDEFROMCAPTURE`): a window screenshot never contains them, though a full-screen capture may still include them on some systems. Configure them on the DSH plugin settings page or by hand in `~/.evolution-computer-use/appearance.json`; every field falls back to its default, so a missing or broken file changes nothing.

### Banner

The capsule at the top says `DSH正在操作{app}`: `{app}` is the program's executable without `.exe`, or the name the agent passed to `open`; with neither, the text is just `DSH正在操作`. Beside it are the hint `连按两下 Esc 停下` and a stop button. It appears with the first desktop or page tool call and fades after 30 seconds without an action and 20 seconds after the turn ends.

Settings: the four labels; width (`0` fits the text) and height 28–120; opacity 20–100 %; position `top-left`, `top-center`, `top-right` or `custom` with `x` and `y`; colors for background, text, hint, dot, stop button, stop label and border (`#AARRGGBB`, picked from a palette); three fonts with family, size and bold; and layout `align`, `offsetX`, `offsetY`, `gap` and `padding`. Any installed family works, or upload `.ttf`/`.otf` files in the settings — they are copied to `~/.evolution-computer-use/fonts/`. An unknown family falls back to Microsoft YaHei UI, then Segoe UI.

### Thought panel

The dark panel in the top right shows the current step, what it is doing, and the live reasoning and reply below. It is read-only and click-through by default.

**When it shows.** Only while the agent is actually working on this machine: a turn starting, or plain thinking and coding, shows nothing. The panel appears on the first computer or page tool call (`desktop`, `page_*`, `computer_use`, `procedure_*`, `inbox_read`, `desktop_mode`), with the reasoning that streamed before that call stitched back in. It retracts after 30 seconds without an action, and 20 seconds after the turn ends.

**Settings.** On/off, position (four corners or custom with x/y), width 240–1600, height 160–1600, opacity 20–100 %, click-through lock, colors and fonts. Changes apply immediately.

### Audit panel

A second panel sits to the left of the thought panel, top edges aligned, and lists the last 40 actions: time, success or failure, action, program and detail — `点击 (412,238)`, `双击 (412,238)`, `右键 (412,238)`, `拖动 (12,34)→(90,120)`, `按键 Ctrl+S`, `输入 12 个字`, `滚动 ↓`, `打开 微信`, `关闭 记事本`, `截图` — followed by the reason the agent gave for that step.

Settings: on/off; position (`left-of-thought` by default, four corners or custom with x/y); width, height and opacity; click-through lock; visible row count (default 12); show time, reason and screenshot toggles; colors for background, border, text, muted text, accent, reason and the screenshot tag; and two fonts. The panel reads `audit-live.tsv` once a second; that file keeps the newest 40 rows, newest last.

### Audit log

Every desktop action appends one JSON line to `~/.evolution-computer-use/audit/audit-YYYY-MM-DD.jsonl`: `at`, `session`, `turn`, `tool`, `action`, `app`, `exe`, `title`, coordinates, flags, key and modifiers, text, direction, seconds, `ok` and result, the reason, and the relative screenshot path. The reason is the `reason` parameter of the tool call or procedure step; without one, the last paragraph of the agent's thinking in `activity.json` is used, cut at 500 characters.

Retention defaults: 7 days, 500 MB of screenshots, 5,000 entries. Screenshots can be switched off. The folder can be deleted at any time while the server is stopped.

The thought and audit panels are two halves joined by one file, `activity.json`:

| Half | Where | Role |
| --- | --- | --- |
| Writer | this package's built-in DSH plugin (`plugin/lib/index.js`) | Subscribes to DSH's `agent/assistant-stream`, `session/event` and `tools/execute`, and writes the reasoning, reply and steps atomically. |
| Reader | this package, `src/desktop/overlay.ts` | Reads `activity.json` once a second and feeds it to the WinForms overlay drawn by `scripts/windows-takeover.ps1`. |

The split exists because a plain stdio MCP server cannot see the host's session events; this package's plugin half supplies the writer. `--no-overlay` skips the whole subsystem.

## Inbox

Every two seconds the server checks for flashing taskbar buttons and notifications, keeps an excerpt of at most 60 characters, and after ten seconds of quiet reports one line per program. It never reads message contents: `inbox_read` does that when the agent decides to look. Programs are named by their own description, not by the window title. Nothing is written to disk, `--inbox-ignore` silences chosen programs, and without the Windows notification permission the inbox records a fault instead.

## Message log

When a procedure declares a `messages` mapping, every extracted row becomes one record in `messages.jsonl`. The mapping names, for each slot, the row field or template that fills it: `accountId`, `conversationId`, `messageId` and `content` are always needed, `speakerId` except when `outgoing` is true, and `speakerName`, `conversationName` and `occurredAt` are optional; `channel` and `conversationType` (`private` or `group`) are fixed on the mapping itself. A row missing an identity field, or holding a value that is not a plain single line, is skipped and counted; `content` is truncated, and an `occurredAt` that does not parse becomes the current time. Records are de-duplicated by channel, conversation and platform message id, including ids already in the file; a failed write never fails the procedure, and routine runs are not logged. `--no-messages` turns the log off.

## Files

| Path | Contents |
| --- | --- |
| `<data>/browser/` | Browser profile, including the agent's logins. Never share, sync or commit it. |
| `<data>/procedures/` | Learned procedures and category notes. |
| `<data>/messages.jsonl` | Extracted messages. |
| `<data>/apps-index.enc` | Encrypted program-location index (`apps-index.enc` header, AES-256-GCM). Deleted or corrupt files are rebuilt on the next scan. |
| `<data>/init-report.json` / `.md` | The last full `init` report. |
| `<data>/startup-report.json` | The last automatic startup scan and self-test result. |
| `<data>/selftest/` | Screenshots taken by the self-test. |
| `<data>/desktop-mode.json` | Written by the DSH plugin at the fixed path `~/.evolution-computer-use/desktop-mode.json`, so `--data` does not move it; the server reads it every 0.8 s. |
| `<data>/activity.json` | What the overlay shows; the plugin writes it at that fixed path. Set `EVOCU_ACTIVITY_FILE` if the server must read another file. |
| `<data>/activity-settings.json` | Overlay position, size, opacity and lock; written and read by the plugin at the fixed path. |
| `<data>/appearance.json` | Banner, thought panel and audit panel appearance; plugin-written at the fixed path. Missing keys fall back to defaults. |
| `<data>/app-policies.json` | Per-program foreground/background rules; plugin-written at the fixed path. |
| `<data>/audit/` | `audit-YYYY-MM-DD.jsonl`, `audit-live.tsv` and `shots/`; at the fixed path `~/.evolution-computer-use/audit/`. |
| `<data>/fonts/` | Uploaded `.ttf`/`.otf` fonts used by the banner and the panels. |
| `<data>/overlay.lock` | Single-instance lock held by the server process; the file holds its PID. |
| `<data>/desktop-stopped` | Present only while the emergency stop is engaged. |
| Screenshots | System temporary folder; deleted as soon as the model has read them. |
| Recording frames | System temporary folder (`evolution-cu-record-*`); kept until the next recording starts or desktop control is turned off, because `review` still reads them. |

## Security and risks

- **Platform rules still apply.** Automation can trip risk controls or violate a site's terms. Use a dedicated account where that matters, and do not assume a learned procedure cannot be detected.
- **An account's permissions are the procedure's permissions.** A procedure can send messages or comments if the account can. Put those limits in the agent's instructions, and mark sending steps `outward`.
- **Desktop control sees what is on screen.** While it is on, the agent can read any window it opens and use accounts already signed in on this PC. Turning it off and restarting withdraws that.
- **The audit log records what the agent did and typed.** `~/.evolution-computer-use/audit/` keeps JSONL entries and screenshots for up to 7 days by default. Screenshots can be turned off in the settings, and the whole folder can be deleted while the server is stopped.
- **The browser profile is a credential store.** Any local program that can read `<data>/browser/DevToolsActivePort` can drive the signed-in browser. Do not run untrusted programs as the same Windows user.
- **A procedure is code-adjacent.** `script` steps run in the page's origin with the agent's session. Read a shared procedure before running it.

## Multiple agents

- Share `--procedures` to let several agents learn into one library.
- Give each concurrently running agent its own `--profile`; two browsers cannot share a profile at once.
- The desktop has no cross-process lock, so run one agent against it at a time. Two agents' calls would interleave real mouse and keyboard input, and nothing in the system stops either of them.
- **Coming from dsh-world:** copy `procedures/` and `browser/` (with the browser closed). `onAlarm` procedures move from the archive database to `procedure_routines` or a scheduled `evolution-computer-use-win routines`, and extracted messages land in `messages.jsonl` instead of `archive.sqlite`.

## Development

```powershell
npm install          # once
npm run typecheck    # tsc --noEmit
npm test             # node --test
npm run build        # emit lib/
```

The test suite has 220 cases (218 pass, 2 skipped) and covers the MCP protocol, the procedure format and library, appearance and policy parsing, the audit log, and the desktop driver against a fake shell. `npm run prepack` runs typecheck and build before publishing.

## Design notes

Two experiments decided the procedure format; both report summary data, and the scripts were never committed:

- **JSON plus in-page scripts won.** Pure JSON, JSON + scripts, and whole scripts all survived equally often (9 / 8 / 9 of 25 end-to-end), but JSON + scripts repaired best (20/20) and kept paging cheap. That form is what `procedure_save` writes. ([report](docs/experiments/2026-11-12-procedure-format.md))
- **Silent failures, not crashes, were the costlier problem.** In the first round the three formats reported "done" on a wrong replay 90, 110 and 90 times; in the second round's base branch, 105. Treating an empty result as a named failure, with an explicit `allowEmpty` opt-out, took the second-round count to zero.
- **Repairs broke old pages.** About half of the repairs in the first round broke the previous page, because sites roll out redesigns gradually. Falling back to the two kept versions before anything outward ran cut that from 9 to 0 and raised end-to-end success from 9/25 to 16/25. ([report](docs/experiments/2026-11-13-procedure-algorithms.md))

## License and credits

MIT. Both upstream projects are MIT too, and `NOTICE.md` records the merge:

- [chenkezhen480/evolution-computer-use](https://github.com/chenkezhen480/evolution-computer-use) — the desktop takeover, the procedure format, the browser layer.
- [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) — the Windows MCP layout, the native helper, the DSH packaging.

This repository is the DSH edition of both. It is not adapted for other agent applications.
