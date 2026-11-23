# evolution-computer-use-win

English | [简体中文](README.zh-CN.md)

Self-evolving computer use, built for DeepSeek Harness.

> Extracted from **[dsh-world](https://github.com/chenkezhen480/dsh-world)** 0.8, where it was "her own browser and the operations she learned", and freed from the DSH host. How procedures are stored, replayed and repaired was chosen by two controlled experiments run while building dsh-world; see [Experiments](#experiments).

**This repository is the merger of two projects.** [evolution-computer-use](https://github.com/chenkezhen480/evolution-computer-use) — the browser of its own, the procedure library, the stop switch — and [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) — the Windows desktop mode and the thought/step overlay in the top-right corner — are now one MCP server, published here as `evolution-computer-use-win`. Both are MIT: the merged license is [LICENSE](LICENSE), and third-party code ported from dsh-world and dsh-inner-browser-use is listed in [NOTICE](NOTICE.md).

- **A browser of its own**: the system's Edge (or Chrome) on a separate profile, driven over the DevTools Protocol (CDP). It never uses your mouse or keyboard and never touches your everyday browser.
- **The user's computer** (Windows, only when the user turns it on):
  - background mode posts input to one window, without moving the mouse or taking the focus;
  - foreground mode works the whole screen with the real mouse and keyboard.
- **A procedure library**: once the agent has done something with page primitives or desktop actions, it saves it as a *procedure*. Next time it replays it without the model, with no step-by-step exploration.
  - When a site redesign breaks a procedure, the replay stops at the failing step and says why. The agent finishes the task by hand and saves a new version under the same name.
  - When the new version fails, the old ones are tried automatically.
  - Every agent using this plugin can share the same library.

The plugin contains no code for any particular platform (Bilibili, WeChat, …). How a site or program is used is for the agent to find out, and it is saved only once it works.

No runtime dependencies: the browser side uses only Node's built-in `WebSocket` and `fetch`. The desktop side is one PowerShell script (`src/desktop/win32.ps1`) using Windows' own APIs.

**Language:** the agent-facing text (tool descriptions, results, error messages, the usage instructions sent at initialization) is in Chinese, as in dsh-world. Current models follow it fine whatever language the user speaks; the documentation is in English first.

## Setup

Requires Node.js 22.16 or later. There is nothing to download or build by hand: the command below runs the [npm package](https://www.npmjs.com/package/evolution-computer-use-win) through `npx`, which fetches it on first use.

> The npm name is new: if `evolution-computer-use-win` is not on npm yet, use [From source](#from-source) (or run `npm publish` from a clone). The old `evolution-computer-use` package is the pre-merger release.

`--desktop` defaults to `off` (the agent's own browser only); to let the agent use your computer, pass `background` or `foreground`, as described in [The user's computer](#the-users-computer). It is only the initial state: while running, the agent can switch between off, background and foreground with the `desktop_mode` tool, no restart needed.

On Windows, `npx` is a batch file (`npx.cmd`) which some hosts cannot start directly, so the Windows command goes through `cmd /c`. On macOS and Linux, drop `cmd /c` and make `npx` the command.

### DeepSeek Harness

This server is built for DeepSeek Harness (DSH) and adapted for it only. Two halves make it work there: the stdio MCP server in this repository, and the companion DSH plugin `dsh-evolution-desktop-mode`, which exposes the desktop-mode setting and writes `activity.json` for the thought/step overlay.

Add it in DSH as a stdio MCP connection:

- **Command (Windows):** `cmd /c npx -y evolution-computer-use-win --desktop background`
- **Command (macOS, Linux):** `npx -y evolution-computer-use-win --desktop background`
- **Protocol versions:** 2025-06-18, 2025-03-26 and 2024-11-05.
- **Instructions:** the usage guide is sent in `instructions` at initialization.
- **Images:** screenshots come back as MCP `image` content; `page_shot` and `desktop` are only useful if the host passes images to the model.

### From source

For development, or to run changes not yet published:

```powershell
git clone https://github.com/thefreedoomdoor/evolution-computer-use-win.git D:\tools\evolution-computer-use-win
cd D:\tools\evolution-computer-use-win
npm install
npm run build        # builds lib/
```

Then use `node D:/tools/evolution-computer-use-win/lib/cli.js` in place of `cmd /c npx -y evolution-computer-use-win`.

### Not adapted for other agent apps

This project is adapted for DeepSeek Harness only. Claude Code, Codex CLI, Cursor, Cline, Windsurf, Claude Desktop and other MCP clients can start the same command — the server itself speaks plain stdio MCP — but they are neither tested nor supported:

- the desktop-mode switch in the settings page, and the writer half of the thought/step overlay, come from the DSH plugin;
- the panel's settings page (position, size, opacity, click-through) is a DSH plugin settings page;
- without them the panel never appears, and any idle helper left behind is yours to clean up; `--no-overlay` skips the overlay half entirely.

The `--desktop` default, the `desktop_mode` tool and the rest of the MCP contract described below still hold, but nothing here is promised to work outside DSH.

### Embedding in JS/TS

Hosts that do not speak MCP (your own agent loop, a DSH plugin) use the library directly:

```powershell
npm install evolution-computer-use-win
```

```ts
import { createComputerUse, INSTRUCTIONS } from 'evolution-computer-use-win';

const computer = createComputerUse({
  dataDir: 'D:/agent-data/computer',      // holds procedures/, browser/ and messages.jsonl
  name: 'Helper',                         // the name on the banner while it acts on the user's computer
  onToolsChanged: () => { /* desktop control was switched: register the tools again */ },
});
computer.setDesktopMode('background');      // only once the user agreed: off, background or foreground

// 1. Put INSTRUCTIONS in the system prompt. 2. Give the tools to the model:
const tools = computer.tools().map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema }));
// 3. When the model calls a tool:
const result = await computer.call(name, args, signal);   // { text, images?: [{ data: Buffer, mediaType, caption? }] }
```

Other methods:

- `setDesktopMode(mode)`: switch between `off`, `background` and `foreground`; foreground shows a UAC prompt, and a refusal leaves you in background with the reason returned.
- `setForeground(on)`: just the foreground switch; shows a UAC prompt.
- `halt()` / `release()`: stop the agent and release it, for hosts with a stop button of their own.
- `routines()`: run the routine procedures.
- `status()`.
- `show()`: brings the browser window forward.
- `stop()`.

The `messages` option takes your own `MessageSink`, to file the messages procedures read into the host's storage.

## Command line

```text
evolution-computer-use-win [serve] [options]   run as an MCP server over stdio
evolution-computer-use-win resume [options]    release the agent after the user pressed "stop"
evolution-computer-use-win routines [options]  run the routine procedures once and print the results (for schedulers)
evolution-computer-use-win status [options]    list learned procedures and anything broken
```

Without a global install (`npm install -g evolution-computer-use-win`), put `npx -y` in front, for example `npx -y evolution-computer-use-win resume`.

| Option | Meaning |
| --- | --- |
| `--data <dir>` | Data folder, default `~/.evolution-computer-use` |
| `--procedures <dir>` | Procedure library, default `<data>/procedures` |
| `--profile <dir>` | Browser profile, default `<data>/browser` |
| `--desktop off\|background\|foreground` | Desktop control, default `off` |
| `--name <name>` | The name on the banner while the agent acts, default `AI` |
| `--inbox-ignore <list>` | Programs the inbox does not report, comma-separated |
| `--no-inbox` | Do not watch the taskbar even with desktop control on |
| `--no-messages` | Do not file what procedures read into `messages.jsonl` |
| `--no-overlay` | Do not start the thought/step overlay at the top right (it starts by default; its look is set in the DSH plugin) |

Faults and recoveries go to stderr (MCP hosts usually keep it in their own logs). The agent also sees them when it calls `computer_use` without arguments.

## Tools

| Tool | What it does |
| --- | --- |
| `page_open` | Opens an address in the agent's browser and returns the page (as `page_read`); http/https only |
| `page_read` | Reads the page: one line per actionable element, `[ref] role name`, then the visible text; `page` pages through, `ref` looks inside one element |
| `page_click` | Clicks an element by ref; refuses when something covers it |
| `page_type` | Types into an input by ref, replacing its content; `submit` presses Enter afterwards |
| `page_press` | Presses one key |
| `page_scroll` | Scrolls about a screen up or down, optionally inside an element |
| `page_wait` | Waits for some text (up to 60 s), or checks that a ref still exists |
| `page_shot` | A screenshot of the page, for when the text is not enough |
| `page_eval` | Runs JS in the page; 10 s timeout, result cut to 2000 characters |
| `computer_use` | Names the program or site about to be used (`target`) and returns that category's notes, procedure names and folder; without arguments, lists the modules available, the categories, and faults |
| `procedure_run` | Runs a learned procedure: `path` is `category/name`, `args` its declared parameters |
| `procedure_save` | Saves working steps as a procedure; without `json`, returns the full format description |
| `procedure_note` | Writes a category's notes (which program or site, addresses and aliases, caveats), up to 1000 characters |
| `procedure_routines` | Runs every `onAlarm` web procedure once, in a tab of its own |
| `desktop_mode` | Switches desktop control between `off`, `background` and `foreground` at runtime; foreground needs `confirm: true` and shows a UAC prompt |
| `desktop` | Acts on the user's computer (only while desktop control is on); see below |
| `inbox_read` | Reads the inbox (only while the inbox is on) |

The tool list is fixed: learning something new never changes it, so saving a procedure never invalidates the host's prompt cache. Only the user's switches make `desktop` and `inbox_read` appear or disappear; the server then sends `notifications/tools/list_changed`. `desktop_mode` is always there, even while desktop control is off, so it can be used to turn it on. Results are short: page reads are paged, script results cut, and screenshots never attached unasked.

## How it evolves

1. **Find**: `computer_use("微信")`.
   - The target is matched only against category names and their notes, word by word and case-insensitively.
   - One word containing the other counts as a match, and so do words sharing at least 60% of their letter pairs ("bilbili" finds "bilibili").
   - Procedure names do not take part: a "send message" for Bilibili and one for WeChat are different things.
   - One category comes back at a time. When several match equally well, the agent is asked which one; when none matches, it is told so and asked to add this name to the right category's notes.
2. **Run**: `procedure_run("wechat/发朋友圈", { text })`, replayed step by step without the model.
3. **Learn**: when nothing fits, the agent does the task with `page_*` or `desktop`, then calls `procedure_save` and `procedure_note`.
4. **Repair**: a replay that meets a missing anchor or an unmet `check` stops there.
   - It reports the step, what it expected and a snapshot of the page, and tells the agent to finish the task by hand now and save it as a new version under the same name.
   - A failed `outward` step is always reported as "may already have been sent" and is never retried.
5. **Empty means broken**: an `extract` with no rows, a field empty in every row, or an empty `script` value kept with `as` is reported as a failure at that step.
   - After a redesign, a selector that finds nothing most often looks like "nothing new". Without this the agent would conclude "no new messages".
   - Steps that may legitimately be empty are marked `allowEmpty: true`.
6. **Fall back when the newest fails**: when the newest version fails before anything outward happened, the two most recent old versions (`<name>.v<n>.json`) are tried, newest first.
   - Sites roll out redesigns gradually and run A/B tests, so a version repaired for the new page may fail on the old one.
   - When an old version works, its result is used, followed by a note saying which step of the newest version failed and which version ran instead.

In dsh-world's experiments on a mock site:

- With empty results counted as failures, silent failures fell from 105 replays to 0.
- With the fallback, repairs that broke the old page fell from 9 to 0.
- Procedures that survived learning, a redesign and a repair rose from 9/25 to 16/25.

See [Experiments](#experiments).

## Procedure files

`<library>/<category>/<name>.json`, with each category's notes in `<category>/目录.md`.

- **Editing by hand:** the agent can also read and edit these with its own file tools; changes take effect at the next lookup or run.
- **Checked on save:** saving validates the file and refuses it with the reason when it is wrong. An unknown key is refused too, so a typo can never quietly turn into "any link".
- **Kept versions:** before a save overwrites a procedure, the old one is kept as `<name>.v<n>.json`, the two most recent per name.
- **Invalid files:** malformed files, a file name that does not match `name`, and a `category` that does not match the folder are skipped and recorded as faults, without affecting other procedures.

| Field | Meaning |
| --- | --- |
| `name` | Procedure name and file name: letters (Chinese too), digits, `_` and `-`, 1–40 characters, not `目录` |
| `category` | Category and folder name, same rules; defaults to `未分类` (unsorted) |
| `description` | What it does |
| `params` | `{ name: { type: string｜number｜boolean, required?, description? } }` |
| `where` | Omitted for web procedures; `desktop` for background mode, `screen` for foreground mode |
| `steps` | 1–40 steps, one action each |
| `onAlarm` | A routine: run by `procedure_routines` or `evolution-computer-use-win routines`; no required parameters, no outward steps |
| `summary` | Template for the routine's result line; may use `{{count}}` and values kept by `script` with `as` |
| `messages` | Files the rows of `extract` as messages; see [Message log](#message-log) |

Web steps (`{{param}}` in text is filled in):

| Action | Form |
| --- | --- |
| `open` | an address |
| `click` | an anchor |
| `type` | `{ into: anchor, text }` |
| `press` | a key name (as in `page_press`) |
| `wait` | `{ text｜anchor｜url, seconds? }`, up to 60 s |
| `check` | `{ text｜anchor｜url }`, waits up to 3 s, then stops the run |
| `extract` | `{ list: anchor, fields: { name: anchor, optionally attr }, limit? }`, `limit` 8 by default, at most 20 |
| `script` | JS that may `return`; `as` keeps the result as a value |

**Anchors:**

- An anchor is `{ role?, name?, text?, css?, nth? }`, with at least one of them given.
- `role` and `name` are as `page_read` shows them.
- Procedures store neither coordinates nor snapshot refs.
- `click`, `type`, `press` and `script` may take `outward: true`: this step sends something out.

**Desktop steps:**

- The actions: `open` (program name or window title), `click {x,y,double?,right?,hold?}`, `drag {x,y,x2,y2,right?,hold?}`, `type {text,x?,y?}`, `press` (optionally with `hold`), `scroll {direction,x?,y?}` and `wait {seconds}`.
- `x` and `y` are pixels of a screenshot.
  - For `desktop`, the screenshot is of the window, so they follow the window's size, not its position.
  - For `screen`, it is of the whole screen.
- A replay does not pause between steps. Wherever a person waited (a window that appears a moment after a click) the procedure needs a `wait`. Saving points out where one may be missing, and a replay that stops there says so.

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

## The user's computer

Windows only. Elsewhere, turning it on records a fault and no `desktop` tool appears.

Nothing to install: underneath is the plugin's own `win32.ps1`. It takes window pictures with `PrintWindow`, posts mouse and keyboard messages with `PostMessage`, clicks tray icons through UI Automation, and starts programs from the Start menu (`Get-StartApps`).

### Background mode (`--desktop background`)

The agent sees one window's screenshots, and input is posted straight to that window. Your mouse pointer never moves and the focus stays yours, so the agent can work while you use the computer. A window covered by others can still be pictured and clicked.

`open` finds the program in this order:

1. An open window. A minimized one is restored in place.
2. A tray icon, which it clicks.
3. The Start menu, which launches the program and then gives the focus back to your window.

A program that is running with neither a window nor a tray icon is not launched again, since WeChat 4.x would open a second copy.

Browser pages are the one thing posted input cannot reach: Chromium throws away `WM_CHAR`/`WM_KEYDOWN` sent to its window, so typing into the address bar or clicking inside a page does nothing. Use `open` with a `url` instead: the page is opened by the agent's own browser over CDP, behind every other window — your browser is not started and nothing is brought to the front — and the shot is a window capture of that background window. For what is inside the page, use `page_open`/`page_read`/`page_click`; foreground mode is only needed to drive your own browser by hand.

Programs running as administrator (many games) are out of reach; the agent is told to ask you for foreground mode.

### Foreground mode (`--desktop foreground`)

- **Approval:** at startup Windows asks once for administrator rights. Once approved, an elevated helper runs for the rest of this session. If you decline, or do not answer within 2 minutes, the plugin stays in background mode and records the reason as a fault.
- **What changes:** the agent sees the whole screen and uses the real mouse and keyboard, so games and administrator programs work. Your mouse moves with it, so this is for when you hand the computer over.
- **Limits of the elevated helper:**
  - It only takes pictures, moves the mouse, types, and draws the banner.
  - Listing windows and starting programs stay with the ordinary helper, so nothing the agent opens runs as administrator.
  - It talks to the plugin over a pipe whose name only this session knows, after proving a one-time key.
- **Games:** their terms usually forbid automation, and long unattended play risks a ban. That is your call.

### Switching at runtime (`desktop_mode` / `setDesktopMode()`)

No restart needed: switch between `off`, `background` and `foreground` while the plugin is running. Switching to foreground shows a UAC prompt; when the agent calls the tool it must pass `confirm: true`, otherwise it only gets a reminder and no prompt appears. If you decline, you stay in background and the reason is recorded as a fault. Switching back to background stops the elevated helper; switching to `off` stops both helpers and the `desktop` tool disappears. A host that wants its own switch can call `computer.setDesktopMode('background')`; `onToolsChanged` tells it to register the tools again.

**From the DSH settings page**: the companion DSH plugin `dsh-evolution-desktop-mode` exposes `desktopMode` as a plugin setting (`off` / `background` / `foreground`) and writes `~/.evolution-computer-use/desktop-mode.json`; this MCP server rereads that file every 0.8 s, so a choice takes effect without restarting anything.

`desktop` actions:

| action | What it does |
| --- | --- |
| `open` | `app` is a program name, window title or Start-menu name; without it, lists open windows. Add `url` to hand a web address to the browser (Chromium drops posted keys inside the page, so this is how a page gets opened in background mode) |
| `shot` | Another screenshot |
| `click` | `x`, `y` (screenshot pixels); `double`, `right`; `hold` seconds for a long press (at most 10) |
| `drag` | From `x`, `y` to `x2`, `y2`; `hold` seconds before moving, `right` for the right button |
| `type` | `text`; with `x`, `y` clicks there first; `submit` presses Enter |
| `press` | `key`: Enter, Tab, Esc, Space, Backspace, Delete, Home/End, Page Up/Down, arrows, F1–F12, a single letter or digit, with `ctrl+`, `shift+`, `alt+`; `hold` seconds |
| `scroll` | `direction` up/down/left/right, optionally at `x`, `y` |
| `zoom` | The area from `x`, `y` to `x2`, `y2`, at full resolution, enlarged up to 4× |
| `record` | Records something that moves (a video): `seconds` up to 600, `every` seconds per frame, `pause: false` to not pause it afterwards |
| `stop` | Stops a recording under way |
| `review` | Looks at the recording: no arguments for an overview sheet, `from`/`to` for a stretch, `at` for one moment |

Every action is followed by a fresh screenshot, and after a click a red circle marks where it actually landed, so the agent checks its own work. Each screenshot also says which other windows the program has open, and which appeared or closed after the last input.

### You can see it act, and stop it any time

While the agent acts, a dark capsule floats at the top centre of the screen: "<name>正在操作" ("<name> is operating"), with "press Esc twice to stop" and a stop button. A soft blue glow surrounds the window it works in, or the whole screen in foreground mode.

To stop it, press Esc twice within half a second, or click the capsule's button:

- The step under way is void. The agent is told the user pressed stop, not to retry, and to ask the user first. A recording stops where it is, and no further keys are sent to that window.
- If no step was under way, the agent's next tool result carries the same message.
- Until you release it, every action on the computer is refused; looking at a finished recording still works.
  - The stop is kept in `<data>/desktop-stopped`, so restarting the agent does not lift it.
  - When you are satisfied, run `npx -y evolution-computer-use-win resume` in a terminal, adding `--data` if the data folder is not the default.

## Thought overlay (top right)

While the agent works, a dark panel floats at the top right of the screen: the state of this turn ("Step 2 · acting"), what each step did ("open the page, read the settings", "click the Settings button"), and below that the live reasoning and the reply. It is read-only, does not take the mouse ("locked" = click-through by default), and never appears in screenshots or recordings.

The overlay is two halves joined by one file, `activity.json`:

| Half | Where | What it does |
| --- | --- | --- |
| Writer | the DSH host plugin `dsh-evolution-desktop-mode` | subscribes to DSH's `agent/assistant-stream`, `session/event` and `tools/execute`, and atomically writes the reasoning, the reply and the steps into `<data>/activity.json` |
| Reader | this plugin, `src/desktop/overlay.ts` | reads `activity.json` once a second and feeds it as line JSON to the WinForms overlay drawn by `scripts/windows-takeover.ps1` |

The split exists because this plugin is a plain stdio MCP server and cannot see the host's session events. Any other host only has to supply the writer half.

- **When it shows**: only while the agent is actually working on this machine — never a permanent fixture. A turn starting, plain thinking or plain coding shows nothing; the panel appears on the first call to a computer/page tool (`desktop`, `page_*`, `computer_use`, `procedure_*`, `inbox_read`, `desktop_mode`), and the reasoning that streamed before that first call is stitched back in. It retracts after 30 s with no action and no text, so waiting on an approval or a QR code never leaves it on screen.
- **Show and style**: in the DSH plugin settings (under this plugin in the plugin list) — on/off, position (top-right, top-left, bottom-right, bottom-left), width 240-1600, height 160-1600, opacity 20-100%, locked (click-through). Changes apply at once and are stored in `<data>/activity-settings.json`, which the writer copies into `activity.json`.
- **Language**: follows the DSH interface language (Chinese/English); the header, the step lines and the action names are all localized.
- **End of turn**: the panel closes with the turn; failures and "stopped by the user" are marked before it goes.
- **Only one panel**: when several copies of this plugin run on the same machine (two connections in DSH, for instance), only the one that first claims `<data>/overlay.lock` draws the overlay; the rest stand by and take over next round if the holder dies or exits.
- **Without a writer**: started outside DSH, without the companion plugin, there is no `activity.json`, so the panel never shows and one idle PowerShell helper process is left over; pass `--no-overlay` to skip it.
- **If you edit the renderer**: changing `scripts/windows-takeover.cs` breaks the hash check of the prebuilt DLL, so the loader falls back to compiling with `Add-Type` (2-5 s slower to start, same behaviour).

Ported from [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) 0.6.3 (MIT); see [NOTICE](NOTICE.md).

## Inbox

While desktop control is on, the plugin watches the taskbar for the agent: flashing buttons, and system notifications with a short excerpt (at most 60 characters).

- **When it tells:** signals come in bursts. Once 10 s pass with nothing new, the burst is gathered into the inbox, and the agent's next tool result carries a one-line note that the inbox has news. The content waits for the agent to read it with `inbox_read`; nothing is pushed into the middle of its work.
- **What it reads:** a program is named by its own description, never its window title, which may contain message text.
- **What it keeps:** nothing is written to disk. Notifications already present at startup count as old.
- **Exclusions:** programs that already reach the agent another way can be excluded with `--inbox-ignore`.
- **Permissions:** if notifications cannot be read, that is recorded as a fault. Allow access in Windows Settings › Privacy & security › Notifications.

## Message log

A procedure can declare with `messages` which rows of an `extract` are messages:

- **Fixed values:** `channel` and `conversationType` (`private` or `group`).
- **Templates:** every other field is a `{{field}}` template.
  - Required: `accountId`, `conversationId`, `messageId`, `speakerId` and `content`.
  - Optional: `speakerName`, `conversationName`, `occurredAt` and `outgoing`; `outgoing` evaluating to `true` marks the agent's own messages.

When the agent runs such a procedure with `procedure_run`, what it read is appended to `<data>/messages.jsonl`:

- Records are de-duplicated by the platform's message id, so reading again adds nothing.
- Rows missing an identity field are skipped.
- A failed write never fails the procedure.
- Routine runs are not logged.

Embedding hosts can plug in their own `MessageSink`.

## Multiple agents

- **Share what they learn**: point several agents at the same `--procedures`; the default data folder already is the same one. What one agent learns, the others find with `computer_use`. Changes are picked up by file time, with no restart.
- **One browser each**: a browser profile suits one agent at a time, since the queue lives in one process. Give each concurrent agent its own `--profile`, and log in once in each.
- **One agent on the desktop at a time**: two agents on the same computer would interrupt each other.

## Migrating from dsh-world

- **Procedures:** the file format is identical. Copy `<world>/procedures/` to `<data>/procedures/`; kept versions and `目录.md` notes work as before, and dsh-world's flat legacy files are still read as `未分类`.
- **Logins:** to keep your site logins, also copy `<world>/browser/` to `<data>/browser/`, with that browser closed.
- **Routines:** `onAlarm` procedures ran before the alarm in dsh-world. Here they run through `procedure_routines` or a scheduled `evolution-computer-use-win routines`.
- **Messages:** they are written to `messages.jsonl` instead of `archive.sqlite`.

## Files

| Location | What it is |
| --- | --- |
| `<data>/browser/` | The agent's browser profile, **including site logins**. Do not share it, sync it to cloud storage, or commit it |
| `<data>/procedures/` | Learned procedures, kept versions and category notes; the plugin writes here only on save |
| `<data>/messages.jsonl` | Messages that procedures read |
| `<data>/desktop-stopped` | Present only while a stop is in force |
| `<data>/activity.json` | Overlay activity: written by the DSH plugin, read by this plugin |
| `<data>/activity-settings.json` | Overlay show and style settings, written by the DSH plugin |
| `<data>/overlay.lock` | Single-instance lock for the overlay; it holds the PID of the process drawing it |

Screenshots and recording frames pass through the system temp folder and are deleted after use.

## Risks

- **Platform rules:** automating websites may trip a platform's risk controls or break its terms, and accounts may be limited or banned.
  - Use a dedicated secondary account in the agent's browser.
  - The plugin does not promise to go undetected, and there is no reliably "safe rate".
  - Nothing limits whom the agent talks to: it can do anything your account can, including private messages and comments. Put any limits in the agent's own prompt.
- **Your computer:** with desktop control on, the agent sees everything in the windows it opens and can use every account signed in on this computer. Restart without `--desktop` to take it back.
- **Your browser profile:** any program on this machine can read `<data>/browser/DevToolsActivePort` and drive the logged-in browser. Do not run untrusted programs as the same Windows user.

## Verification

`npm test` runs every offline test: 154, of which 2 live tests are skipped by default. `ECU_EDGE_TEST=1` launches a real Edge; `ECU_DESKTOP_TEST=1` takes read-only screenshots of a desktop with WeChat open. `npm run typecheck` checks types.

On Windows 11 Home (Chinese, 10.0.26200) with Node 22.16, the built `lib/cli.js` was exercised over MCP:

- initialization and the tool list;
- listing windows in background mode, through the real PowerShell helper;
- `page_open` and `page_shot`, in real Edge;
- saving and replaying a procedure;
- breaking the procedure on purpose, after which it fell back to the old version.

The desktop checks done on real hardware in dsh-world use the same code but were not repeated here: background clicks, typing, bringing WeChat up from the tray, and foreground mode.

Not yet verified:

- the browser side on macOS and Linux;
- machines with Chrome but no Edge;
- any host other than DSH: this server is adapted for DSH only, as described in [Setup](#setup).

## Experiments

How procedures are stored, replayed and repaired was settled by two controlled experiments during dsh-world's development: a real DSH container, `deepseek-flash`, a mock site in three redesigns, five tasks, and decision rules written before the results.

| Round | Question | Outcome |
| --- | --- | --- |
| 1 (2026-11-12) | Pure JSON, JSON + in-page scripts, or a whole script? | End-to-end success tied (9 / 8 / 9 of 25). Pure JSON cost far more on the paging task. By the "simpler wins a tie" rule: JSON + in-page scripts |
| 2 (2026-11-13) | How much do three replay algorithms help, and does saving procedures beat doing the task fresh every time? | **K**, empty results count as failures: silent failures 105 → 0. **V**, fall back to kept versions: end-to-end success 9/25 → 16/25. **F**, fingerprint self-heal: uncertain. Doing it fresh was more reliable but cost about 4× as much |

This plugin implements K and V. F, and a save-time check for class selectors (which the reports name as the most promising next step), are not implemented.

The full write-ups and the mapping to this code are in [docs/experiments/](docs/experiments/README.md). The original Chinese reports and pre-registered designs are in [docs/experiments/zh-CN/](docs/experiments/zh-CN/).

## Credits

The core is ported from [dsh-world](https://github.com/chenkezhen480/dsh-world) 0.8, `src/ecosystem/computer/` (MIT). The browser discovery and launch, the minimal CDP session and the in-page element registry were ported from [dsh-inner-browser-use](https://www.npmjs.com/package/dsh-inner-browser-use) 0.47.28 (MIT) by way of dsh-world, with attribution and license kept; see [NOTICE](NOTICE.md).

The thought/step overlay (`scripts/`, `src/desktop/overlay.ts`, `src/desktop/overlay-strings.ts`) was ported from [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) 0.6.3 (MIT), likewise with attribution and license kept.
