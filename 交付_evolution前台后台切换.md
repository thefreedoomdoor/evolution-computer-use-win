# evolution-computer-use：前台 / 后台运行时切换（改造交付说明）

## 一句话

在 `evolution-computer-use` 里加了**运行中切换桌面模式**的能力：`off`（只用自己的浏览器）、`background`（往窗口投递输入，不动用户鼠标、不抢焦点）、`foreground`（真鼠标键盘，整个屏幕）。不用重启，Agent 用 `desktop_mode` 工具切换，宿主也可直接调 `setDesktopMode()`。切前台必须显式 `confirm: true`，仍会弹 UAC；被拒绝就留在后台并记录原因。

## 代码位置

- 仓库：`D:\实验\repos\evolution-computer-use`（基于 `chenkezhen480/evolution-computer-use` 的 main，commit `d11bd4b`）
- 分支：`feat/desktop-mode-switch`（本地与 fork 一致，最新 commit `627075d`；前一个 `17decac` 是模式切换）
- Fork：https://github.com/thefreedoomdoor/evolution-computer-use/tree/feat/desktop-mode-switch
- 向上游提 PR 的链接（未自动创建，点开即可提）：
  https://github.com/chenkezhen480/evolution-computer-use/compare/main...thefreedoomdoor:evolution-computer-use:feat/desktop-mode-switch?expand=1
- 版本：`0.2.1`（`package.json` / `package-lock.json`）

## 改了什么

| 文件 | 改动 |
| --- | --- |
| `src/desktop/mode.ts`（新增） | `DesktopMode = 'off' \| 'background' \| 'foreground'`、`DESKTOP_MODES`、`isDesktopMode()`，CLI、工具参数、status 共用同一组词 |
| `src/computer.ts` | 把原来的 `setDesktop` / `setForeground` 提成内部函数；新增 `desktopMode()` 与 `setDesktopMode(mode)`；`status().desktop` 增加 `mode`；`stop()` 清理 `foreground-mode` 故障 |
| `src/tools.ts` | 新增 `desktop_mode` 工具（参数 `mode` 必填、`confirm` 可选）；前台无 `confirm: true` 时只返回提醒、不弹 UAC；`modules()` 里显示当前模式 |
| `src/cli.ts` | `--desktop` 不再手写两步，直接走 `setDesktopMode(mode)`，拒绝原因照旧打印 |
| `src/instructions.ts` | 系统提示词里补一句：可用 `desktop_mode` 切换、切前台要 `confirm: true` |
| `tests/desktopMode.test.ts`（新增） | 8 个用例：默认 off、后台幂等、后台→前台、前台→后台、off 全停、UAC 被拒留后台、工具 confirm 守卫、非法 mode |
| `tests/computerModule.test.ts`、`tests/desktopScreen.test.ts` | 期望值跟随新增的 `mode` 字段与 `desktop_mode` 模块说明 |
| `src/desktop/desktop.ts` | `open` 增加可选 `url`：交给 `deps.browse` 用 agent 自己的浏览器在后台打开，找到该窗口（`browseWindow`/新窗口/标题前缀）后 `PrintWindow` 截图 |
| `src/desktop/screen.ts` | 前台模式同样支持 `open(app?, url?)`，走 helper 的 `url` 动作 |
| `src/computer.ts` | `setDesktop` 给 `createDesktop` 注入 `browse: url => browser.run(page => page.open(url) → document.title)`（CDP，不动前台） |
| `src/tools.ts` | `desktop` 工具参数增加 `url`；说明改为“用 agent 自己的后台浏览器打开并截它的窗口” |
| `README.md`、`README.zh-CN.md` | 工具表与「用户的电脑」章节改为：带 `url` 的 `open` 用自带后台浏览器开页并窗口截图，不激活用户浏览器 |

### 安全默认

- 默认仍是 `off`；`--desktop` 只决定启动时的初始模式。
- 后台模式**从不移动鼠标、不抢焦点**，只向目标窗口 `PostMessage`。
- 前台切换要过两道门：Agent 调工具必须带 `confirm: true`，且 Windows 会弹 UAC；任一道没过都留在后台，并写进 `status().faults`。
- 切回后台会停掉管理员助手；切到 `off` 两个助手都停，`desktop` 工具消失，`desktop_mode` 仍在（用于再打开）。

## 怎么用

### 1）从 fork 源码跑 MCP（不装 npm 包）

```powershell
# 直接跑源码
npx -y github:thefreedoomdoor/evolution-computer-use#feat/desktop-mode-switch --desktop background
```

客户端配置（Claude Code / Codex / Cursor 等）：

```jsonc
// 例：Cursor .cursor/mcp.json
{
  "mcpServers": {
    "evolution-computer-use": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "github:thefreedoomdoor/evolution-computer-use#feat/desktop-mode-switch", "--desktop", "background"]
    }
  }
}
```

> 参数只决定初始模式；之后让 Agent 调 `desktop_mode`，或在宿主里调 `setDesktopMode()`。

### 2）在 JS/TS 宿主里嵌入

```ts
import { createComputerUse, INSTRUCTIONS } from 'evolution-computer-use';

const computer = createComputerUse({
  dataDir: 'D:/agent-data/computer',
  onToolsChanged: () => { /* 模式变了，重新注册工具 */ },
});

computer.setDesktopMode('background');        // off / background / foreground
// 前台：await computer.setDesktopMode('foreground') —— 会弹 UAC，被拒会返回原因并留在后台
console.log(computer.status().desktop?.mode); // 'background' | 'foreground'
```

### 3）Agent 侧（工具）

```jsonc
// 切后台
{ "mode": "background" }
// 切前台（必须确认）
{ "mode": "foreground", "confirm": true }
// 关掉
{ "mode": "off" }
```

返回值是短句：`已切换到后台模式：只向目标窗口投递输入，不动用户的鼠标、不抢焦点。` / `已切换到前台模式…` / `已关闭桌面控制。`；没带 confirm 则返回 `还没有切换：前台模式会接管用户的鼠标键盘…`。

## 后台模式打开网页（`open` 的 `url`）

Chromium 会丢弃 `PostMessage` 投递到它窗口的 `WM_CHAR`、`WM_KEYDOWN`、`WM_LBUTTONDOWN`，所以在后台模式下往地址栏打字、点网页内容都没有反应（真实实测过 `ctrl+l`、`type`、`WM_PASTE`、`keybd_event` 全部无效，地址栏一直是空的）。

改法：`desktop` 工具的 `open` 支持 `url` 参数。页面由 **agent 自己的浏览器**（系统 Edge/Chrome 的独立 profile，经 CDP `Page.navigate`）在后台打开并压在其它窗口后面；截图为该后台窗口的 `PrintWindow` 窗口捕捉，全程不动鼠标、不抢焦点，也不会启动或激活用户自己的浏览器。页面里的读/点/滚动用 `page_open`、`page_read`、`page_click`。

```jsonc
{ "action": "open", "app": "Microsoft Edge", "url": "https://www.bilibili.com/" }
```

（早期版本用 helper 的 `Start-Process <url>` 走 ShellExecute，会把用户的 Edge 激活到前台，已改掉；`win32.ps1` 的 `url` 动作保留给前台模式。）

实测（2026-11-23 14:36，本机）：用本地构建的 MCP 服务器、`--desktop background`，调用 `desktop {action:"open", app:"Microsoft Edge", url:"https://www.bilibili.com/"}`，返回“已在后台浏览器打开 https://www.bilibili.com/（标题：哔哩哔哩 …），前台窗口没有变；看截图确认”，截图为该后台窗口的 `PrintWindow`（1172×1280），页面完整加载（轮播、推荐视频、登录弹窗都在）。用户的 Edge 与前台窗口均未被激活。截图：`D:\实验\shots\background_bilibili_cdp.png`。

## 验证

在 `D:\实验\repos\evolution-computer-use` 下：

```powershell
npm install --no-audit --no-fund --cache .npm-cache
npm run typecheck      # 通过
npm run build          # 通过
npm pack --dry-run --cache .npm-cache   # 72 个文件，含 lib 与 src/desktop/win32.ps1
```

测试（Windows 沙箱下 `node --test` 会因 `spawn EPERM` 起不了子进程，需在本机普通终端跑）：

```powershell
npm test
# 或在受限环境里本进程跑：
node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-isolation=none
```

本次结果：**162 个测试，153 通过，7 失败、2 跳过**；7 个失败全是沙箱 `spawn EPERM`（`tests/desktopDriver.test.ts` 启动 PowerShell 助手、`tests/mcp.test.ts` 启动 CLI 子进程），属环境限制，与本次改动无关；新增的 `tests/desktopMode.test.ts` **8/8 通过**。

## 已知限制

- 沙箱内无法真正启动桌面助手（子进程被拦），真实前后台行为需在普通桌面终端验证：`--desktop background` 下应不动鼠标；`--desktop foreground` 应弹 UAC，拒绝后 `status` 里出现“前台模式没有打开…”。
- 向上游 PR 未自动创建（需要你的授权与 GitHub 登录），上面给了 compare 链接。

## 在 DSH 设置界面切换前后台（2026-11-23 新增）

- 新增 DSH 插件包 `D:\Plugins\dsh-evolution-desktop-mode`，已用 plugin_manager 以 `link:` 方式安装到 desktop profile（全局生效）。
- 位置：DSH「设置 → 插件 → 电脑操作模式（前台/后台）」，字段 `desktopMode`，取值 `off` / `background` / `foreground`。
- 插件把选择写入 `~/.evolution-computer-use/desktop-mode.json`；MCP 服务器（0.2.3+）每 0.8 秒轮询该文件并调用 `setDesktopMode`，无需重启，`desktop` 工具会自动出现/消失。
- 实测：文件写 `off` 后数秒内 `desktop` 工具消失（调用返回 unknown tool）；写回 `background` 后工具恢复且可截图。
- 代码提交：`d7a1257 feat(cli): follow the desktop mode chosen in the DSH settings plugin`，tag `v0.2.3`，已推送到 fork。

## 右上角思考/步骤浮窗（2026-11-23 追加）

目标：把 [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win)（MIT，本地 `repos/dsh-computer-use-win`，HEAD `acfb689` v0.6.3）右上角那块「Agent 在想什么、做到哪一步」的浮窗移植进本 fork，做成"拥有进化能力的 dsh-computer-use-win"。

### 架构：共享文件（定型，勿推翻）

本插件是标准 stdio MCP 服务器，**拿不到** DSH 宿主的会话事件，所以拆两半，中间只隔一个文件：

```
DSH 宿主插件（写侧）                        evolution 进程（读侧）
dsh-evolution-desktop-mode  ──activity.json──▶  src/desktop/overlay.ts
  agent/assistant-stream  思考/回复流             每 1s 读文件 → 行 JSON RPC
  session/event  回合/步骤/结束                        → scripts/windows-takeover.ps1
  tools/execute  动作标签                              → WinForms 右上角浮窗
```

换别的宿主（Claude Code、Codex）只需补写侧；读侧不动。

### 改了什么

| 文件 | 改动 |
| --- | --- |
| `scripts/`（新增，复制自 wcu） | `windows-takeover.ps1`、`windows-takeover.cs`（1349 行，未改，DLL 快路径哈希 `77bedd3e62e8cbbd` 仍有效）、`native-loader.ps1`、`native/manifest.json`、`native/wcu-takeover-netfx.dll` |
| `src/desktop/overlay.ts`（新增） | `startThoughtOverlay(options) → { stop, child, owning, activityFile, lockFile, getStderr }`；spawn PowerShell 助手，每 1s 读 `activity.json`，内容变了才发 `configure`（`remoteIndicatorVisible:false`，浮窗不进截图）+`progress`；`overlayEnabled===false` 时发空 progress 收起；**单实例锁** `overlay.lock`（PID + mtime，5s 内算新鲜）保证同机多个进程只画一块浮窗，持有者崩了待命的接管，助手连起 3 次失败就放弃并放锁 |
| `src/desktop/overlay-strings.ts`（新增） | 31 个界面键的中英文案 + `overlayLocale()` + `helperStrings()`；随 `activity.json` 的 `locale` 切换，缺了会显示键名 |
| `src/cli.ts` | `serve()` 里挂 `startThoughtOverlay`（`--no-overlay` 硬关），`end()` 里 `overlay?.stop()`；HELP 补一行 |
| `package.json` | version `0.2.3`→`0.3.0`；`files` 加 `scripts`（渲染脚本必须随包发出去） |
| 插件 `lib/activity.mjs`（新增） | 写侧采集：`installActivity(ctx, file, {getSettings,getLocale}) → {publish}`；非桌面工具只在 owner 会话加一行，桌面工具置 `status:'acting'`；上限 MAX_STEPS=24 / MAX_ACTIONS=6 / 旧步骤文本 400 / 当前文本 1200 / 意图 300；`atomicJson` 临时文件 + rename 原子写 |
| 插件 `lib/index.js` | Config 加 6 个浮窗设置项；`activity-settings.json` 落盘 + 内存热值 `overlayLive`；GET `/read` 返回 `{desktopMode, overlay}`，POST `/set` 支持只改 overlay 并立即 `publish()` |
| 插件 `lib/client.js` | 设置页新增「思考浮窗」块：开关、位置、锁定、宽/高/不透明度，改动即时 POST（数字输入 500ms 去抖） |
| 插件 `package.json` / `cordis.patch.yml` / `README.md` / `locale/` | 版本 `0.2.1`→`0.3.0`，config 补 6 个默认值，说明补浮窗 |
| `tests/desktopOverlay.test.ts`（新增） | 锁的 5 个用例：首次认领、同 PID 重复认领、活着的持有者不被抢、死 PID 可接管、mtime 过期可接管、refresh/release 只动自己那份 |
| `NOTICE.md`、`README.md`、`README.zh-CN.md` | 追加 wcu 的 MIT 署名与许可；README 新增「思考浮窗」章节与 `--no-overlay`、`activity*.json`、`overlay.lock` 文件位置 |

### activity.json 约定（两侧唯一接口）

`{ active, sessionId, turn, locale, overlayEnabled, position, width, height, opacity, locked, progress:{ status, step, startedAt, endedAt, action, reasoning, reply, intent, steps:[{ step, actions:[{label,state}], reasoning, reply, text }] }, lingerUntil }`

`status` ∈ `waiting\|thinking\|acting\|replying\|done\|failed\|stopped`；浮窗只显示最后 12 条步骤；`endedAt>0` 且状态为 done/failed/stopped 视为收尾，再停留 `lingerUntil`（20s）。

### 验证

- `npm run typecheck` / `npm run build`：exit 0。
- 单测：`node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-isolation=none` 全绿（沙箱里 `npm test` 会 spawn EPERM）。
- 渲染端独立跑通：`scripts/ovr-test-driver.ps1` 直发 begin/progress，截屏确认「DSH · 第 2 步 · 执行中」「第 1 步 · 打开页面、读取设置」+ 思考文本 + 锁图标都正常（第一轮显示键名与豆腐块，分别由缺 `strings` 块与 PowerShell stdin 编码导致，已修）。
- node 真实链路：`lib/desktop/overlay.js` 起助手 → 4s 存活、stderr 空、`stop()` 后无孤儿进程。
- 写侧假 ctx E2E 11 项断言全绿：思考流、桌面工具、回复、非桌面工具、跨步骤 error、回合结束 + linger、abandoned 重试清文本、别的会话不抢显示、abort→stopped。
- 单实例锁：DSH 里两条 evolution 连接（`custom-evo-cu-local` + `custom-evolution-computer-use`）会起两份 `lib/cli.js`，实测各带一个助手 → 右上角会叠两块浮窗；加锁后只有一个 owning，另一个待命（`tests/desktopOverlay.test.ts` 覆盖）。

### 已知限制

- `remoteIndicatorVisible:false` 是刻意的：截图与录屏里看不到浮窗，属正常。
- 写侧要 DSH 宿主重新加载插件（`link:` 依赖，改动需 host 重启或重装 bundle）才生效；本会话没有 plugin_manager 工具，需你在 DSH 里刷新/重装一次。
- 首版没做「智能收尾」（readableAbort、跨会话忙碌锁），按约定留到后续；idle 过期已在第二轮补上（见下节）。
- 锁只认「5 秒内刷新过 + PID 还活着」；机器休眠或时钟跳变时可能短暂出现两块或零块浮窗，下一轮（1s）自愈。

## 浮窗改为「只在操作电脑时出现」（2026-11-23 第二轮）

需求（原话）：「右上角的思考悬浮窗应该和 computer-use-win 一样，只在 agent 进行电脑操作的时候出现，而不是常驻」。

### 根因

移植版 `lib/activity.mjs` 的 `current(sessionId, turn)` 只要被调用就认领 owner，而 `session/event` 的 `turn/start` 分支和 `acceptText` 都会调它 —— 于是**任何会话的任何回合**（包括纯写代码、纯聊天）一开始就写 `active:true`，浮窗自然常驻。

### 改法（照上游 `repos/dsh-computer-use-win/mcp/activity.mjs` 的门控语义）

- 删掉 `current()` 与 `turn/start` 分支；owner **只在 `tools/execute` 命中电脑/网页工具时创建**（`DESKTOP_TOOL` 加了 `desktop_mode`、`inbox_read` —— 切模式和看信箱也算在操作这台电脑）。
- 新增 `early` Map（上限 8 条）：回合里第一次电脑操作**之前**流出的思考/回复只留在内存，不写文件；真开始操作时 `startOwner()` 把这份 seed 灌进 `progress`（含 `intent`/`intentStep`），所以开头不会丢。
- 新增 `stepStarted()` / `clearStepText()`：无 owner 时更新 early seed，有 owner 时才推进 `progress.step`。
- 新增 `expireIdle()` + `export const IDLE_MS = 30000`：30 秒既无工具调用也无文本就自动收起（等 UAC 授权、等扫码时不占屏幕）。
- owner 结构补 `pending` / `otherPending` / `lastActive` / `desktop`；非桌面工具只在 owner 匹配的会话+回合上追加一行动作并计入 `otherPending`，不认领显示。
- 新增 1 秒 `setInterval` 兜底刷新 + `dispose` 清理（`clearInterval`、清 owner/lingering/early 后再写一次）。
- `publish()` 的 body 补 `indicator`（这一回合是否真动过鼠标键盘：纯 `page_*` 为 false）与 `expiresAt`（owner 在时 `Date.now()+5000`）。**读侧目前不消费这两个字段**，留给以后的接管提示。
- 不做跨会话忙碌锁：别的会话抢显示时直接 `return next()`，不抛 `COMPUTER_USE_BUSY`。

### 同时修掉的 UI 问题（`lib/client.js`）

评审提的 P0×2 与 P1 全部落地：数字框并发（`draft`/`seq` 请求序号，旧定时器不再回头覆盖）、保存失败回滚到 `lastGood`、清空数字不再被夹成下限值、旧宿主缺 `overlay` 字段时提示「版本太旧」而不是渲染假默认值、读取失败可「重试」且文案改中文、模式按钮补 `role=radio`/`aria-checked`/方向键、状态行 `role=status`+`aria-live`、硬编码颜色换成 `--dsw-alias-*` 主题令牌（带原值兜底）。

### 验证

- `node --check` 三个文件全过（activity.mjs / client.js / index.js）。
- 假 ctx 单元脚本（已用完删除）跑通：纯思考回合 `active:false`；无浮窗时非桌面工具 `active:false`；回合结束 `active:false`；桌面工具执行中 `active:true status=acting indicator=true` 且思考开头被接上；完成后 `status=waiting`；同回合非桌面工具只追加一行；`page_*` 认领但 `indicator=false`；dispose 后 `active:false` 且无 `progress`。
- 尚未做真机端到端：宿主里仍是旧的 `activity.mjs`，需你在 DSH 里停用再启用该插件（或重启 DSH）后，让我跑一次 `desktop` 截图来确认浮窗只在操作时出现。

### 文档与版本

- 插件 `README.md`：新增「只在 Agent 真的操作这台电脑时出现」条目；「回合结束保留 20 秒」改为「随即收起（写侧保留 `lingerUntil`，读侧不消费）」；上游链接改为 `https://github.com/Yu-tao-Li/dsh-computer-use-win`。
- 仓库 `README.zh-CN.md` / `README.md`：浮窗小节补同样的「什么时候出现」说明，英文同步。
- 插件 `package.json` 版本 `0.3.0`。
