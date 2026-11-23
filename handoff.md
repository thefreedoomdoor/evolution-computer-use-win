# Handoff — evolution-computer-use 改造（前后台切换 + 思考浮窗移植）

> 写给下一个 Agent（PTC 模式）。本文件是唯一权威交接，读完即可继续干活，不需要考古旧对话。
> 工作目录 `D:\evolution-computer-use`（本仓库即项目目录）。当前时间 2026-11-23 18:53。

---

## 0. 一句话现状

**当前活跃任务（m05561）**：把 [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win)（MIT）的「右上角思考/步骤浮窗」移植进 [evolution-computer-use](https://github.com/thefreedoomdoor/evolution-computer-use)（我们已改造过的 fork），做成“拥有进化功能的 dsh-computer-use-win”。

**进度（2026-11-23 22:40）**：**全部完成**。移植、门控、单实例锁、设置页控件修复、构建、测试（36/36）、文档、推送 fork 均已完成；DSH 重启后已实测：只有一个浮窗、只有一块锁、纯对话回合不显示、桌面调用时显示并带动作/意图。详见 §1.1。

---

## 1. 本会话已完成的工作（背景，不需要重做）

| 任务 | 交付物 | 状态 |
|---|---|---|
| 实验一报告 | `D:\实验\lab1\实验一_实验报告.docx` | ✅ 已交付 |
| 实验二报告 | `D:\实验\lab2\实验二_实验报告.docx` | ✅ 已交付 |
| fork 改造：运行时 desktop 模式切换 | 分支 `feat/desktop-mode-switch`，提交 `17decac`(三模式 API+desktop_mode 工具) → `627075d`(url ShellExecute) → `6fb355e`(url 改 CDP 后台) → `3726b41`(修 document.title) → `d7a1257`(cli 轮询 desktop-mode.json)，tag `v0.2.2`/`v0.2.3` 已推送 | ✅ 已推送 fork |
| DSH 设置页插件 | `D:\Plugins\dsh-evolution-desktop-mode`（v0.3.0，已 install_bundle），三段按钮控件 + host 路由 + 浮窗设置面板 | ✅ 已装；设置页控件与浮窗样式面板已修（无障碍、重试、回滚、并发） |
| 思考/步骤浮窗移植 | 读侧 `src/desktop/overlay.ts` + `scripts/windows-takeover.ps1`（提交 `1929d71`、`bccd8bb`）；写侧插件 `lib/activity.mjs` | ✅ 已交付；门控（只在操作电脑时出现）已实测生效 |
| 修「两个悬浮窗」（单实例锁） | `src/desktop/overlay.ts` 锁逻辑 + `tests/desktopOverlay.test.ts`（该文件共 9 个用例，含 5 个新增锁用例）；提交 `4580c3b`、`35a5914` 已推送 fork | ✅ 已重启实测：全系统只有 1 个助手、1 块浮窗、锁稳定归持锁者，见 §1.1 |

### 关键仓库/路径
- evolution 仓库（本地）：`D:\evolution-computer-use`，分支 `feat/desktop-mode-switch`，HEAD `13904a9`（overlay 读侧、门控文档、单实例锁修复、交付文档用例数修正均已提交并推送 fork）。
- 插件源码**不在任何 git 仓库**里，只有 `D:\Plugins\dsh-evolution-desktop-mode`（改动无版本备份）；备份 zip：`D:\Plugins\dsh-evolution-desktop-mode-0.3.0.zip`。
- fork 远端：`https://github.com/thefreedoomdoor/evolution-computer-use`（remote 名 `fork`）；上游 `https://github.com/chenkezhen480/evolution-computer-use`（PR compare：`.../compare/main...thefreedoomdoor:evolution-computer-use:feat/desktop-mode-switch`）。
- wcu 参考仓库（本地）：`D:\evolution-computer-use\repos\dsh-computer-use-win`（HEAD `acfb689`，v0.6.3，MIT）。
- 交付文档：`D:\evolution-computer-use\交付_evolution前台后台切换.md`（之前任务用，最后要追加浮窗段落）。

### 运行中的 MCP 连接
- `evolution-computer-use` / `evo-cu-local`：**两条连接各起一个** `node D:\evolution-computer-use\lib\cli.js --desktop background`（本地仓库构建产物）。改完 `src/` 并 `npm run build` 后，正在跑的进程仍用旧 `lib/`，必须重启 DSH 或重连连接才生效。两个进程靠 `~/.evolution-computer-use/overlay.lock` 单实例选主，只会画一块浮窗。
- 模式切换文件（唯一事实来源）：`C:\Users\freezingcold\.evolution-computer-use\desktop-mode.json` = `{"desktopMode":"background"}`，cli 每 800ms 轮询。**测试时别写 off**（desktop 工具会消失）。

### 浮窗单实例锁（「出现两个悬浮窗」）修复要点

- 根因 1：`refreshOverlayLock` 每秒 `writeFileSync` 重写 pid，会先把锁文件截成 0 字节；另一进程并发读到空串 → `NaN` → 判「持锁者已死」→ 抢锁。浮窗每隔一两分钟在两个进程间倒手（数据目录攒了 11 个 `overlay.lock.<hex>.stale`）。
- 根因 2：抢输的一方只把 `helper` 引用置空、不关助手；助手要 stdin EOF 才退出，于是窗口永久留在屏幕上（实测两个进程各泄漏 5 块）。
- 根因 3：助手意外退出后 `owner` 不清零，重开逻辑走不到，浮窗静默消失。
- 修法：刷新只 `utimesSync` 推 mtime；认领时躲开「刚创建未落盘」的空文件；新增 `retireHelper()`（`stdin.end()` → 2s 后 kill）；`exit` 时 `owner=false` 让下一轮重开；连续 3 次未正常应答才放弃。
- 测试：`tests/desktopOverlay.test.ts` 加 5 例（共 9 例，含并发读者读不到空内容）；旧写法同实验读到空 473/31946 次，新写法 0 次。`node --experimental-strip-types --test tests/desktopOverlay.test.ts` → 9/9 通过。

### 1.1 重启后实测记录（2026-11-23 22:22 起，GUI http://127.0.0.1:12764）

- 进程：cli 47728（parent 15852）、cli 50932（parent 34220，旧的第二个 DSH 实例）；助手只有 1 个：powershell 29996 / parent 47728。overlay.lock 内容 47728，mtime 每秒新鲜。
- 浮窗：全系统扫描 WindowsForms10.Window.8.* 可见窗口只有 1 个（pid 29996，360x240 @2180,70，exstyle 0x80900A8 = LAYERED|TOPMOST|TOOLWINDOW|NOACTIVATE）；DwmGetWindowAttribute(DWMWA_CLOAKED=14) 得到 cloaked=0。两个 DSH 实例并存也只画一块。
- 读侧闭环：POST /api/dsh-evolution-desktop-mode/set，body {"overlay":{"width":480}} → 助手窗口立刻变 480x240@2060,70，改回 360 → 360x240@2180,70；{"overlay":{"overlayEnabled":false}} → 窗口消失，改回 true 且 activity 下次变化后重现。说明线上进程确实把设置送进助手并生效。
- 门控：纯对话回合（未调用桌面工具）activity.json 的 active/indicator 为 false；调用 desktop 后变 true 且 progress.intent 接上该回合操作前的思考。
- 收起规则（2026-11-23 22:45 用户拍板后改）：只按「上一次真的操作电脑（桌面或网页工具）」计时——写代码、跑命令这类普通工具不续命；连续 30 秒（IDLE_MS）没有电脑操作就收起；回合结束 + 20 秒（LINGER_MS）也收起。网页工具（page_*）仍算操作电脑（用户确认保留）。实现：owner.lastDesktop 只在桌面/网页工具进出时刷新，expireIdle 用它而不是 lastActive。
- 该插件改动用假 ctx + 假时钟模拟验证过：desktop t+0 显示 → 普通工具到 t+31s 收起 → 再 desktop 立刻重现 → 28s 后仍显示、31s 后收起 → page_open 重现。改的是插件写侧，需重启 DSH 才加载。
- 测试：node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/desktopOverlay.test.ts tests/desktopMode.test.ts tests/desktop.test.ts → 36/36 通过（2026-11-23 22:39）。
- 截图限制（不要浪费时间）：System.Drawing CopyFromScreen、BitBlt+CAPTUREBLT、PrintWindow(2) 对 WinForms 分层窗口都抓成空白（真实助手与测试助手结果一致，914B 同一 sha），不能用截图判断浮窗在不在；改用 GetWindowRect/IsWindowVisible + test_render_progress（-TestMode 下生成 PNG）验证。
- 临时物已清理：.tmp-probe/、.tmp-*.png、.npm-cache/。
- 坑（会杀掉自己的 shell）：pwsh 命令文本里出现 windows-takeover 或 EVO-CU-OVERLAY 时，Get-CimInstance ... CommandLine -like 会匹配到自己的工具进程 → 输出为空。写法：特征串动态拼接（'windows-'+'takeover'+'.ps1'）并排除 $PID。
- 观察点：如果用户看到两块浮窗，先数 WindowsForms10.Window.8.* 可见窗口；若 >1，多半是旧 DSH 实例（如 34220）的助手没退，结束旧 DSH 即可。


---

## 2. 当前任务：浮窗移植 — 架构与已完成部分

### 2.1 架构（已定型，勿推翻）

evolution 是标准 stdio MCP，**拿不到** DSH 的 `agent/assistant-stream` 事件 → 采用**共享文件方案**：

```
DSH 宿主插件（写侧）                     evolution 进程（读侧）
┌────────────────────────────┐          ┌─────────────────────────────┐
│ dsh-evolution-desktop-mode │          │ src/desktop/overlay.ts      │
│ ctx.on('agent/assistant-   │ activity │ 每 1s 读 activity.json       │
│   stream')  思考/回复流     │──.json──▶│ 行 JSON RPC → stdin         │
│ ctx.on('session/event')    │  (原子写) │                             │
│ ctx.on('tools/execute')    │          │ scripts/windows-takeover.ps1│
│ → ~/.evolution-computer-   │          │ → WinForms 右上角浮窗        │
│   use/activity.json        │          │   (显示 思考/步骤/回复)      │
└────────────────────────────┘          └─────────────────────────────┘
```

### 2.2 已完成 ✅

1. **渲染脚本已复制**到 `D:\evolution-computer-use\scripts\`：
   - `windows-takeover.ps1`（1892B）、`windows-takeover.cs`（101257B，1349 行）、`native-loader.ps1`（2813B）、`native/manifest.json`（1403B）、`native/wcu-takeover-netfx.dll`（102400B）。
   - **注意**：manifest 里 `takeover.sourceHash=77bedd3e62e8cbbd` 是对原版 .cs 的哈希。**只要不改 .cs**，PS5.1 走 DLL 快路径；若改了 .cs，校验失败自动回落 `Add-Type`（慢 2-5s，功能一样）。manifest 里引用的 native/ocr/clipboard DLL 没复制，loader 只按名字查 `takeover` 条目，无影响。
2. **evolution 转发模块已写**：`D:\evolution-computer-use\src\desktop\overlay.ts`（115 行，已 read 复核）。导出 `startThoughtOverlay(options:{activityFile?,log?,enabled?}) → {stop,child,activityFile,getStderr}`。
   - spawn：`powershell.exe -NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File scripts\windows-takeover.ps1 -CancelEvent 'Local\EVO-CU-OVERLAY-<rand>'`，cwd=scripts 目录，windowsHide，stdio pipe×3。
   - 行 JSON RPC：写 `{...params,id,command}\n`，回包按 id 匹配（4s 超时即 resolve）。
   - 每 1s tick：读 activity.json（去 BOM）→ 组 payload → 内容变化才发 `configure`（`remoteIndicatorVisible:false, cursorIndicatorEnabled:false`）+ `progress`。enabled()=false 或文件缺失时发 `progress{enabled:false}` 隐藏浮窗。
   - payload 映射（读 activity.json 字段）：`active`→enabled；`sessionId:turn`→turnKey；`position/width/height/opacity`(默认 top-right/360/240/60)→settings；`progress.{status,step,startedAt,endedAt,action,reasoning,reply,steps}`→progress。
   - 环境变量 `EVOCU_ACTIVITY_FILE` 可覆盖 activity 文件路径（默认 `~/.evolution-computer-use/activity.json`）。

### 2.3 待办清单（按序执行）

1. **cli.ts 挂接**：`D:\evolution-computer-use\src\cli.ts`
   - `serve()` 启动块（desktop-mode 轮询附近）加：`const overlay = startThoughtOverlay({ log, enabled: () => overlayEnabledFlag })`；
   - `overlayEnabledFlag` 由 activity.json 的 `overlayEnabled` 字段或 CLI 参数 `--no-overlay` 控制（默认开）。建议简单做：读 activity.json 里 `overlayEnabled !== false`（在 tick 的 enabled() 里判断文件字段），CLI 只提供 `--no-overlay` 硬关（不启动 startThoughtOverlay）。
   - `end()` 里 `overlay.stop()`。HELP 文本加一行。
2. **package.json**：`files` 数组加 `"scripts"`；`version` 0.2.3 → **0.3.0**。
3. **DSH 插件写侧**（扩展 `D:\Plugins\dsh-evolution-desktop-mode`，v0.2.1 → 0.3.0；或按 overlay.ts 头注释命名新插件 `dsh-evolution-thought-overlay` —— **推荐扩展现有插件**，少一次安装）：
   - `lib/index.js` 增加活动采集（精简版 wcu `activity.mjs`）：
     - 订阅 `ctx.on('agent/assistant-stream', ({agent, frame}) => …)`：`frame.type==='chunk'` 时 `chunk.type==='reasoning-delta'→progress.reasoning`（首步同时存 `steps[0]`，作为 intent，≤300 字）；`'text-delta'→progress.reply`（≤1200）；`status='thinking'/'replying'`。
     - 订阅 `ctx.on('session/event', …, {global:true})`：turn start → 新 step、`startedAt=Date.now()`、`active=true`；turn end → `endedAt`、`status='done'/'stopped'`（按 outcome）、`lingerUntil=now+20000`。
     - 订阅 `ctx.on('tools/execute', async (exec, next) => …)` 中间件（DSH 侧能看到所有工具调用，包括 `mcp__evo-cu-local__desktop`、`mcp__evo-cu-local__page_open` 等）：push `{label,state:'running'}` 到当前 step.actions（超 6 丢旧，label 用人话动作名，**绝不包含**输入文本/URL/坐标）；执行后 state='done'/'error'；`status='acting'`。
     - 每 1s `atomicJson`（临时文件+rename，evolution 的 `src/shared/files.ts:durableWrite` 同款思路）写 `~/.evolution-computer-use/activity.json`。
   - schema 加浮窗设置项（照抄 wcu `mcp/settings-schema.mjs` 的键）：`progressOverlayEnabled`(默认 true)、`progressOverlayPosition`(top-right/top-left/bottom-right/bottom-left)、`progressOverlayWidth/Height/Opacity`；写进 activity.json 顶层的 `position/width/height/opacity/overlayEnabled` 字段（overlay.ts 已按这些字段读）。
   - 动作标签中文表从 `D:\evolution-computer-use\repos\dsh-computer-use-win\mcp\overlay-strings.mjs` 的 zh.labels 抄（click/double_click/drag/scroll/type_text/keypress/snapshot/screenshot/wait/page_open/page_read/page_type…，注意 evolution 工具名是 `desktop` 和 `page_*` 系）。
4. **构建**：`npm run build`（先 `npm install --no-audit --no-fund --cache .npm-cache` 若 node_modules 缺）。`npx tsc --noEmit` typecheck。
5. **测试**：`node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-isolation=none`（基线 162 tests/153 pass/2 skipped/7 fail——7 个全是沙箱 spawn EPERM 的既有环境性失败，别当成回归）。可新增 `tests/overlay.test.ts`：fake activity.json + 断言 payload 组装/stop 清理。
6. **实测浮窗**（两种方法）：
   - 快验渲染端：`powershell -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File scripts\windows-takeover.ps1 -CancelEvent 'Local\test-ovr' -TestMode`，然后从 stdin 发 test_* 命令（testMode 才收）看浮窗样式；或直接发 `begin` + `progress`（payload 见 §3.1）。
   - 全链路：rebuild 后 `mcp_connector_reconnect`（重载 lib/cli.js）→ 写一个测试 activity.json → 看 DSH 桌面右上角浮窗 → `mcp__evo-cu-local__desktop(action:'shot')` 截图验证（PrintWindow 截 DSH 窗口时浮窗是独立 WinForms 顶层窗口，需全屏 shot；注意 `remoteIndicatorVisible:false` 意味着**录屏/远程截图可能看不见**——实测如果截图看不到浮窗，把 configure 里 `remoteIndicatorVisible` 改 true 重试，或发 `configure` 前 `ApplyDisplayAffinity` 相关说明在 .cs 458 行）。
   - 浮窗被 `progressOverlayLocked:true` 锁定且鼠标穿透，用户看到后可用 progressLockShortcut 解锁拖动（wcu 默认锁，我们 settings 里也传了 Locked:true；如用户要拖动，把 activity.json 的 locked 改 false）。
7. **收尾**：NOTICE.md 追加 wcu 的 MIT 版权（Copyright (c) 2026 Yu-tao-Li; Copyright (c) 2026 cgissing）；README/README.zh-CN.md 加浮窗段；`D:\evolution-computer-use\交付_evolution前台后台切换.md` 追加浮窗章节；git commit（建议信息 `feat(overlay): thought/step overlay ported from dsh-computer-use-win (MIT)`）+ push fork + tag `v0.3.0`；present 交付文档。
8. **用户待确认**：DSH Desktop Ctrl+R 后三段按钮（电脑操作模式）是否出现；浮窗是否出现在右上角并显示思考/步骤。

---

## 3. 关键技术事实（实现直接依赖）

### 3.1 windows-takeover.cs 命令协议（stdin 行 JSON）
- 命令：`begin`/`configure`/`preview`/`progress`/`end`/`stop`/`resume`/`close`/`status`/`capture_begin`/`capture_end`/`test_*`(仅 TestMode)。每行 `{"command":"...","id":N,...}`；stdout 行 JSON 回 `{id,ok:true}`；启动先 Emit `{kind:'ready',...}`。
- **progress**（浮窗核心，cs :510-549 / UpdateProgress :988-1030）：
  ```json
  {"command":"progress","id":1,
   "enabled":true,"preview":false,"turnKey":"s:t","remoteIndicatorVisible":false,
   "settings":{"progressOverlayEnabled":true,"progressOverlayWidth":360,"progressOverlayHeight":240,
               "progressOverlayOpacity":60,"progressOverlayPosition":"top-right","progressOverlayLocked":true},
   "progress":{"status":"thinking|acting|replying|working|done|failed|stopped",
               "step":3,"startedAt":<epoch ms>,"endedAt":<epoch ms|0>,
               "action":"当前动作人话","reasoning":"思考文本","reply":"回复文本",
               "steps":[{"step":1,"actions":[{"label":"点击 开始菜单","state":"done|running|error"}],
                         "reasoning":"…","reply":"…","text":"…"}]}}
  ```
  - steps 最多显示最后 12 条；entry.actions 的 label 拼 step 行；`state:'error'` 红色。finished = `endedAt>0 && status∈{done,failed,stopped}`。
  - settings 键名大小写敏感照抄（`progressOverlayWidth` 等驼峰，cs 里按这些键读）。
- **configure/begin**：`{indicatorEnabled,remoteIndicatorVisible,cursorIndicatorEnabled,indicatorText,indicatorPosition,indicatorIdleMs,stopShortcut}`。我们不用 indicator（顶栏指示条），`configure` 里把两个 visible 都关了。
- **end**：`{hideAt:now+idleMs}` 隐藏；**close**：退出进程。

### 3.2 activity.json schema（我们自定义，写侧与读侧对齐）
```json
{"active":true,"sessionId":"…","turn":3,"locale":"zh",
 "overlayEnabled":true,"position":"top-right","width":360,"height":240,"opacity":60,"locked":true,
 "progress":{"status":"thinking","step":2,"startedAt":1732340000000,"endedAt":0,
             "tool":"mcp__evo-cu-local__desktop","action":"点击 插件",
             "reasoning":"…≤300 首步/当前步思考…","reply":"…≤1200…",
             "steps":[{"step":1,"actions":[{"label":"打开 VS Code","state":"done"}],"reasoning":"…"}]},
 "lingerUntil":0}
```
- wcu 原版上限参考：MAX_STEPS=24、MAX_ACTIONS=6、OLD_STEP_TEXT=400、CURRENT_TEXT=1200、INTENT_TEXT=300。
- 原子写：临时文件+rename（Windows EPERM/EBUSY 重试）——evolution 侧已有 `src/shared/files.ts:11 durableWrite(file,text)` 可直接复用思路；DSH 插件侧是 .mjs，自己写个 `atomicJson`（参考 wcu takeover.mjs 顶部）。

### 3.3 DSH 宿主插件事件（写侧订阅，来自 wcu activity.mjs 已验证用法）
- `ctx.on('tools/execute', async (exec, next) => { …; return next(); })` 中间件——exec 里有工具名/参数；桌面工具名匹配 `^(?:mcp__)?(?:evo-cu-local|evolution-computer-use)__(?:desktop|page_\w+|computer_use|procedure_\w+)$`。
- `ctx.on('session/event', handler, {global:true})`——turn start/end、step/start。
- `ctx.on('agent/assistant-stream', ({agent, frame}) => …)`——frame.type `start|chunk|end`；chunk.type `reasoning-delta|text-delta`；frame.outcome.kind `abandoned` 等。
- 插件安装：`plugin_manager remove_bundle target=dsh-evolution-desktop-mode` → `install_bundle target="link:D:\Plugins\dsh-evolution-desktop-mode"`。host 路由自检：`GET http://127.0.0.1:<当前端口>/api/dsh-evolution-desktop-mode/read`（端口随 DSH 重启变化，本次为 3408）。改 `lib/*.mjs`/`lib/client.js` 后**必须让宿主重载**（设置里停用再启用该插件，或重启 DSH）——`link:` 装的是源码目录，但模块已进宿主内存。
- wcu 里 activity 写侧还做了：DSH 停止按钮的 abort 错误转人话（`readableAbort`）、单会话锁 `COMPUTER_USE_BUSY`、idle 30s 过期、linger 20s。移植版现状：**idle 30s 过期已做**（`IDLE_MS`，等授权/等扫码不占屏幕）；**门控已照上游改**——owner 只在 `tools/execute` 命中电脑/网页工具时创建，回合开始与纯文本只写内存 `early` seed（上限 8），首次操作时 `startOwner()` 把思考开头接上；跨会话忙碌锁与 `readableAbort` 仍未做。`publish()` 已输出 `indicator`/`expiresAt`，读侧暂未消费。

### 3.4 许可证
wcu 全仓 **MIT**（Copyright (c) 2026 Yu-tao-Li; Copyright (c) 2026 cgissing）。复制的 ps1/cs/DLL 必须在 NOTICE.md 保留声明。cs 头部注释保留。

---

## 4. 环境与坑（务必遵守）

- **审批 never ask；沙箱 danger-full-access。不要传 `sandbox_permissions` 参数**（直接跑即可）。
- `pwsh` 工具 = Windows PowerShell **5.1**（无 pwsh.exe）。含中文的 .ps1 必须 UTF-8 **带 BOM**（`[System.IO.File]::WriteAllText($p,$t,(New-Object System.Text.UTF8Encoding($true)))`）。
- node v24.21.0 / npm 11.19.0；evolution 仓库 npm 装/打包必须 `--cache .npm-cache`（默认缓存盘被沙箱拒）。
- 测试：`npm test` 会 spawn EPERM → 用 `node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-isolation=none`。
- agentbox 的 run_command 访问不了 `D:\` —— Windows 文件操作全用 pwsh 工具；读写代码文件用 read/write/edit/glob/grep。
- `Tee-Object` 会把中文管道输出变乱码；验证程序输出用 `run_console.txt`（UTF-16LE）或直接看文件。
- DSH Web UI（127.0.0.1:4212 页面）要认证，专用浏览器 page_open 进不去；但插件注册的 **host API 路由**（`/api/dsh-evolution-desktop-mode/*`）无需认证，可用 Invoke-WebRequest 测。
- DSH Desktop 主窗口可用后台 PostMessage 点击（desktop 工具后台模式对 Electron 有效），窗口截图用 `D:\evolution-computer-use\tools\_dshshot.py`（EnumWindows 按标题 + PrintWindow）。**不要把操作目标选成用户正在用的前台窗口**（用户抱怨过）。
- VS Code 编辑器可能有 "9+" 脏缓冲（`D:\实验\lab1\run_experiment.py` 早就修好落盘），提醒用户别点保存。
- `~/.evolution-computer-use/` 下现有文件：`desktop-mode.json`（模式）、`activity.json`（浮窗，待插件写入）、`procedures/`（学会的操作）。

---

## 5. 常用命令速查

```powershell
# 构建 evolution（在 D:\evolution-computer-use）
npm install --no-audit --no-fund --cache .npm-cache
npm run typecheck
npm run build

# 测试
node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-isolation=none

# 手动快验浮窗渲染端（独立进程）
powershell -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File scripts\windows-takeover.ps1 -CancelEvent 'Local\ovr-test' -TestMode
# 然后 stdin 发（示例）：
# {"command":"begin","id":1,"indicatorEnabled":false}
# {"command":"progress","id":2,"enabled":true,"turnKey":"t1","settings":{"progressOverlayEnabled":true,"progressOverlayWidth":360,"progressOverlayHeight":240,"progressOverlayOpacity":60,"progressOverlayPosition":"top-right","progressOverlayLocked":true},"progress":{"status":"thinking","step":2,"startedAt":<ms>,"endedAt":0,"action":"点击 插件","reasoning":"测试思考…","reply":"","steps":[{"step":1,"actions":[{"label":"打开窗口","state":"done"}],"reasoning":"第一步"}]}}

# 重载连接器（rebuild 后）
# mcp_connector_reconnect key=<custom-evo-cu-local 的 key>（先 mcp_connector_status 查）

# git
git -C D:\evolution-computer-use status
git -C D:\evolution-computer-use push fork feat/desktop-mode-switch
```

---

## 6. 未决事项 / 风险

1. **remoteIndicatorVisible=false 时浮窗对截图/录屏可能不可见**（ApplyDisplayAffinity，cs :458）。实测验证：如果 desktop shot 看不到浮窗但用户说看得见，属正常；要给用户截图演示就把 configure 改成 `remoteIndicatorVisible:true`。
2. **DLL sourceHash**：不动 .cs 就走快路径；如果将来改 .cs（比如去掉 indicator、改文案），要么重算 manifest 的 sourceHash（`Get-NativeSourceHash` = SHA256(UTF8(CRLF→LF 内容)) 前 16 hex），要么接受 Add-Type 慢启动。
3. **DSH 插件事件接口**是照 wcu（同为 DSH 生态）用法抄的，理论上 DSH 支持；如果 `ctx.on('agent/assistant-stream')` 在宿主插件里不触发，退路：在 evolution 的 `src/mcp/server.ts` call 分发点（server.call :45 附近）记工具动作写 activity.json（只有 step/action/status，没有思考文本），并把架构降级为“步骤浮窗”。
4. 三段按钮控件（上一个任务）在用户 DSH Desktop 里还没刷新验证过；装浮窗插件版本时顺便一起验证。
5. goal 系统里旧 goal `goal-6c693a15-…` 已 complete，本任务（m05561）未建新 goal——PTC 模式可自行决定是否建。



