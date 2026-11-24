# evolution-computer-use-win

[English](README.en.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.16-informational)](package.json)
[![Windows](https://img.shields.io/badge/desktop-Windows%2010%2F11-0078D4)](package.json)
[![MCP](https://img.shields.io/badge/protocol-stdio-6E4AFF)](https://modelcontextprotocol.io)

面向 **DeepSeek Harness** 的电脑操作能力，通过模型上下文协议（stdio）提供：Agent 先自己摸索出某个网站或桌面程序怎么用，把过程存成操作，之后直接重放，不必每次都重新探索。

- 网页操作，以及在 Windows 上的后台桌面操作。
- `init` 生成的软件位置表：每个程序装在哪，加密保存，每次启动刷新，说「打开微信」不再需要你给路径。
- 学会的操作是普通 JSON 文件：有版本、可修补、多个 Agent 之间可共享。
- 一次安装 DSH 插件，同时装上 MCP 服务与设置界面，一个 Node 进程、零运行时依赖。

## 目录

- [功能](#功能)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [配置](#配置)
- [工具](#工具)
- [操作](#操作)
- [桌面控制](#桌面控制)
- [浮窗与外观](#浮窗与外观)
- [信箱](#信箱)
- [消息记录](#消息记录)
- [文件](#文件)
- [安全与风险](#安全与风险)
- [多个 Agent](#多个-agent)
- [开发](#开发)
- [设计说明](#设计说明)
- [许可与致谢](#许可与致谢)

## 功能

| 能力 | 说明 |
| --- | --- |
| **学一次，之后重放** | 一次成功的操作流程被存成操作文件；下次直接执行，修补时更新同一个文件。 |
| **网页操作** | 9 个 `page_*` 工具驱动独立配置下的 Edge 或 Chrome，Agent 用自己的登录态，不碰你的浏览器。 |
| **后台桌面操作** | Agent 只看一个窗口的截图，输入直接投给那个窗口。你的鼠标、焦点、剪贴板都不受影响；被其它窗口遮住的窗口照样能读、能点。 |
| **工作时看得见** | Agent 在这台电脑上操作期间，屏幕顶部有一条横幅写着「DSH正在操作{app}」并带「停下」按钮。文字、大小、位置、颜色、字体、排版都可以改。 |
| **每个动作都有理由** | 思考浮窗左边还有一块审计浮窗，逐条列出点击、滚动、双击、右键、键盘组合、开关程序与截图，后面跟着 Agent 给这一步的理由；同样的记录还会按天写进审计文件。 |
| **按应用的前后台策略** | 可以只让某个程序走前台，其余仍留在后台。窗口选择器帮你填好规则，后台规则还能让这个程序不再需要整屏截图。 |
| **知道你程序在哪** | `init` 扫开始菜单、App Paths、卸载表与 Program Files，结果加密存进 `apps-index.enc`，每次 DSH 启动刷新。`打开微信` 不再需要你提供路径。 |
| **第一次启动就自测** | 第一次启动会先用浏览器工具跑一个本地页面，再在一块科幻 HUD 上做 13 项动作诊断：左键、双击、右键、滚动、拖动、无点击移动、流式与非流式输入、键盘快捷键、打开/关闭应用、打开/关闭文档。随后写下 `init-report.json` 和一份带逐项矩阵与截图的 `.md`。随时可以 `evolution-computer-use-win init` 重跑。 |
| **一次安装，两半都有** | 装 DSH 插件时同时注册 stdio MCP 服务与设置界面，不需要再装配套插件。 |
| **会自愈的修补** | 重放失败时退回最近两个保存过的版本；结果会做检查，失效的选择器会当场报错，而不是显示「已完成」。 |
| **可审计** | 每个操作都是可读的文件，每次改动都留下旧版本，每个桌面动作都经过一条可见、可停的通道。 |

## 环境要求

| 要求 | 说明 |
| --- | --- |
| **系统** | Windows 10 或 11。两部分都依赖它：找浏览器是在 Windows 安装目录里找 `msedge.exe` / `chrome.exe`，桌面控制也只有 Windows 版。 |
| **Node.js** | 22.16.0 或更高。除本包以外不需要装任何东西。 |
| **浏览器** | 默认安装在 Windows 上的 Microsoft Edge 或 Google Chrome。Agent 会用独立配置启动自己的实例。 |
| **宿主** | **DeepSeek Harness**，需要支持插件。本项目本身就是一个 DSH 插件包：同一次安装同时加上设置页并注册自带的 MCP 服务。未适配其他 Agent 应用。 |
| **权限** | 后台桌面操作不需要；前台模式需要管理员权限，会弹出 UAC。 |

## 安装

### 作为 DSH 插件（推荐）

把已发布的包安装到一个目录：

```powershell
npm install evolution-computer-use-win
```

然后把 `node_modules/evolution-computer-use-win` 作为 DSH 插件包装上：打开 **设置 → 插件 → 从文件夹安装**，选择这个目录。在 Agent 会话里，也可以用 `plugin_manager` 的 `action: "install_bundle"` 并传绝对路径。一次安装就同时加上设置页并自动注册 MCP 服务——不需要再写 `mcpServers`，也不需要配套插件。

如果想改源码，先编译一份 checkout，再选择 checkout 目录：

```powershell
git clone https://github.com/thefreedoomdoor/evolution-computer-use-win
cd evolution-computer-use-win
npm install
npm run build
```

如果之前装过独立的 `dsh-evolution-desktop-mode` 插件，请先在插件管理里移除它：本包已经内置同一套设置页，两者使用相同的插件 id，不能并存。

安装后的第一次启动会在后台跑 `init`：扫描软件位置进加密表，并跑电脑操作自测、写报告（见[配置](#配置)）。随时可以运行 `evolution-computer-use-win init` 做一次完整检查。

> **未适配其他 Agent 应用。** MCP 服务本身与宿主无关，但只有 DSH 真正驱动它：插件这一半、浮窗写侧和设置页都是 DSH 专用的，其它宿主都未验证。

## 快速开始

1. 按上面的说明装好插件，重启 DSH。第一次启动会扫描软件并跑自测；之后随时可以让 Agent 运行 `init` 重跑。
2. 用日常说法提要求，例如「看看我 B 站有没有新私信」。
3. Agent 调 `computer_use("B站")` 取这个分类的说明，用 `page_*` 工具操作页面，回答，并把跑通的步骤存下来：

```text
computer_use("B站")                     → 分类说明 + 已学会的操作
page_open("https://message.bilibili.com/")
page_read()                              → 3 条未读，其中一条来自 小明
page_shot()                              → 截图
procedure_save({ ... })                  → bilibili/看未读.json
```

下次同样的要求，一次 `procedure_run` 就能重放这个文件。

## 配置

```text
evolution-computer-use-win [init|serve|resume|routines|status] [选项]
```

| 命令 | 作用 |
| --- | --- |
| `init` | 扫描软件位置并跑电脑操作自测，然后打印 Markdown 报告（`--json` 输出 JSON）。这是完整扫描；插件第一次启动时也会自动做。 |
| `serve` | 默认。以 stdio 运行 MCP 服务。 |
| `resume` | 解除紧急停止，让桌面控制重新可用。 |
| `routines` | 把每个 `onAlarm` 操作跑一遍，供定时任务调用。 |
| `status` | 列出学会的操作与分类。 |

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `--data <目录>` | `~/.evolution-computer-use` | 数据目录：操作、浏览器配置、消息记录。 |
| `--procedures <目录>` | `<data>/procedures` | 操作库位置；多个 Agent 指向同一目录即可共享。 |
| `--profile <目录>` | `<data>/browser` | 浏览器配置，含登录态。 |
| `--desktop off\|background\|foreground` | `off` | 启动时的桌面控制模式。 |
| `--name <文本>` | `AI` | 只在屏幕上的操作横幅里显示（「AI 正在操作」）；思考浮窗不显示这个名字。 |
| `--inbox-ignore <名单>` | 无 | 不在信箱里提示的程序名。 |
| `--no-inbox` | 关 | 不监视任务栏与通知。 |
| `--no-messages` | 关 | 不写 `messages.jsonl`。 |
| `--no-overlay` | 关 | 完全不启动浮窗助手。 |
| `--skip-selftest` | 关 | `init` 时只扫描，不跑自测。 |
| `--network` | 关 | `init` 自测允许访问外网；默认只用本地页面。 |
| `--json` | 关 | `init` 以 JSON 打印结果。 |
| `-h`、`--help` | | 打印用法。 |

`EVOLUTION_CU_NO_AUTO_INIT=1` 会跳过服务启动时的自动扫描与自测；宿主想自己管理 `init` 时用。

首次运行后的数据目录：

```text
~/.evolution-computer-use/
├─ browser/                 浏览器配置；登录态在这里
├─ procedures/
│  ├─ bilibili/看未读.json
│  ├─ bilibili/看未读.v2.json   保留的上一版
│  └─ bilibili/目录.md          该分类的说明，≤ 1000 字符
├─ messages.jsonl            抽取出的消息，一行一条
├─ apps-index.enc            加密的软件位置表
├─ init-report.json          最近一次完整 init 报告（另有 init-report.md）
├─ startup-report.json       最近一次启动扫描与自测结果
├─ selftest/                 自测截图
├─ desktop-mode.json         DSH 插件写入，每 0.8 秒读取一次
├─ activity.json             浮窗内容，由 DSH 插件写入
├─ activity-settings.json    浮窗的位置、大小、不透明度、锁定
├─ appearance.json           操作横幅、思考浮窗、审计浮窗的外观
├─ app-policies.json         按程序的前后台规则
├─ audit/                    audit-YYYY-MM-DD.jsonl、audit-live.tsv、shots/
├─ fonts/                    上传的字体，供横幅与浮窗使用
└─ overlay.lock              单实例锁，由服务器进程持有
```

插件写入的这些路径——`desktop-mode.json`、`activity.json`、`activity-settings.json`、`appearance.json`、`app-policies.json`、`audit/`、`fonts/`——始终在 `~/.evolution-computer-use/`，`--data` 改了也不移动。

## 工具

| 分组 | 工具 | 说明 |
| --- | --- | --- |
| 网页 | `page_open` | 在 Agent 自己的浏览器里打开网址。 |
| | `page_read` | 分页列出当前页面上的可操作元素。 |
| | `page_click` | 按 `page_read` 给出的编号点击元素。 |
| | `page_type` | 往输入框里输入，可选择同时回车。 |
| | `page_press` | 按 Enter、Tab、Escape 等单个按键。 |
| | `page_scroll` | 滚动页面或某个元素。 |
| | `page_wait` | 等某段文字或某个元素出现。 |
| | `page_shot` | 截取页面。 |
| | `page_eval` | 在页面里跑一小段脚本并返回 JSON。 |
| 桌面 | `desktop` | 操作用户的电脑：`open`、`shot`、`click`、`drag`、`type`、`press`、`scroll`、`zoom`、`record` / `stop` / `review`。仅在桌面控制开启时可用。可选的 `reason` 会作为这次调用的理由显示在审计浮窗与审计记录里。 |
| | `desktop_mode` | 运行时在 `off`、`background`、`foreground` 之间切换。始终存在，因此可以用它打开桌面控制；切前台需要 `confirm: true`。 |
| 操作 | `computer_use` | 说明这次要用哪个程序或网站，返回该分类的说明、操作名和目录；不带参数时列出可用模块、分类和故障。 |
| | `procedure_run` | 重放学会的操作；`path` 为 `分类/操作`。 |
| | `procedure_save` | 把跑通的步骤存成操作；不带 `json` 时返回完整格式说明。 |
| | `procedure_note` | 写某个分类的说明：对应哪个程序或网站、网址与别称、注意事项。 |
| | `procedure_routines` | 把每个 `onAlarm` 网页操作各跑一次，各用单独的标签页。 |
| 初始化 | `init` | 扫描软件位置进加密表，并跑电脑操作自测，返回报告。第一次启动时自动运行。 |
| 信箱 | `inbox_read` | 报告有什么在等着：任务栏闪烁与系统通知。仅在信箱开启时可用。 |

工具清单在服务启动后固定，只有一个例外：切换桌面模式会让 `desktop` 工具出现或消失，此时服务发 `notifications/tools/list_changed`。`inbox_read` 是否存在由启动时的 `--no-inbox` 决定。学会新操作不会改变清单，因此存操作不会让宿主的 prompt cache 失效。

## 操作

一个操作就是一个 JSON 文件。Agent 先探索（`computer_use` → `page_*` → `procedure_save`）把它学会，之后用 `procedure_run` 重放。

| 字段 | 含义 |
| --- | --- |
| `name`、`category` | 文件位置：`<procedures>/<category>/<name>.json`。 |
| `description` | 一行说明，告诉 Agent 什么时候该用它。 |
| `params` | 可选参数：参数名到 `type`（`string`、`number`、`boolean`）、`required`、`description` 的映射。`onAlarm` 操作不能声明必填参数。 |
| `where` | 要操作用户电脑的操作写 `"desktop"`（后台模式）或 `"screen"`（前台模式）；这类操作不能设 `onAlarm`、`summary`、`messages`。只在网页上做的操作不写。 |
| `steps` | 按顺序执行的步骤，最多 40 步。 |
| `onAlarm` | 标记为定时操作，供 `procedure_routines` 与定时任务使用。 |
| `summary` | 可选模板，用于定时报告，例如 `私信 {{count}} 条`。 |
| `messages` | 可选映射，把抽取到的消息写进 `messages.jsonl`。 |

步骤都是同一种声明式写法：

| 步骤 | 写法 | 说明 |
| --- | --- | --- |
| `open` | `{"open": "https://…"}` | 在 Agent 的浏览器里打开页面。 |
| `click` | `{"click": <定位>}` | 定位可用 `role`、`name`、`text`、`css` 或 `nth`。 |
| `type` | `{"type": {"into": <定位>, "text": "…"}}` | 替换输入框内容。 |
| `press` | `{"press": "Enter"}` | 按单个按键。 |
| `wait` | `{"wait": <条件>}` | 条件可用 `text`、`anchor` 或 `url`。 |
| `check` | `{"check": <条件>}` | 与 `wait` 类似，但最多等 3 秒，不满足则步骤失败。 |
| `extract` | `{"extract": {"list": <定位>, "fields": {…}, "limit": n}}` | 抽取多行；结果为空算失败，除非该步骤带 `allowEmpty: true`。 |
| `script` | `{"script": "…", "as": "名字"}` | 声明式步骤够不到时，在页面里执行脚本。 |

每个步骤可带两个标记：`outward: true` 表示这一步会往外发东西（消息、评论），永远不会被自动重试；`allowEmpty: true` 表示这一步本来就可能没有结果。

写了 `where` 的操作操作用户的电脑而不是网页，步骤是本机截图上像素：坐标取 0–4000；`type` 的 `x`、`y` 要么都写要么都不写。

| 步骤 | 写法 | 说明 |
| --- | --- | --- |
| `open` | `{"open": "微信"}` | 按名字打开程序：它的窗口、托盘图标或开始菜单。 |
| `click` | `{"click": {"x": 120, "y": 240, "double": true, "right": true, "hold": 2}}` | `double`、`right`、`hold` 可选。 |
| `drag` | `{"drag": {"x": 10, "y": 20, "x2": 300, "y2": 400}}` | 在 `x`,`y` 按下，拖到 `x2`,`y2` 松开；`right`、`hold` 可选。 |
| `type` | `{"type": {"text": "你好", "x": 100, "y": 200}}` | 坐标可选；写了就先点那里。 |
| `press` | `{"press": "return", "hold": 0.5}` | 桌面按键：`return`、`tab`、`escape`、`space`、`backspace`、`delete`、`home`、`end`、`pageup`、`pagedown`、方向键、`f1`–`f12`、单个字母或数字。`hold` 秒数可选。 |
| `scroll` | `{"scroll": {"direction": "down", "x": 500, "y": 300}}` | `direction` 取 `up`、`down`、`left`、`right`。 |
| `wait` | `{"wait": {"seconds": 2}}` | 只等秒数，大于 0、不超过 60。 |

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

**版本。** 用已有名字保存时，旧文件存为 `<name>.v<n>.json`，只保留最近两个版本。最新版本在任何 `outward` 步骤执行前就失败时，会从新到旧试保留的版本，并报告实际生效的那一版。

**分类说明。** 每个分类有一个 `目录.md`，最多 1000 字符：对应哪个网站或程序、Agent 该认得的别称、要当心什么。`computer_use` 返回的就是它：目标只按分类名和分类说明逐词匹配，操作名不参与。

**共享。** 让多个 Agent 指向同一个 `--procedures` 目录，它们就共享学会的一切。目录是纯文本，适合用 git 管理。

## 桌面控制

| 模式 | Agent 能做 | 你的鼠标与焦点 |
| --- | --- | --- |
| `off` | 什么都不做；不提供 `desktop` 工具。 | 不受影响。 |
| `background` | 截取一个窗口并向它投递输入。 | 不受影响。你用电脑的同时 Agent 也能干活。 |
| `foreground` | 整块屏幕，用真实的鼠标键盘。 | 跟着 Agent 走。需要管理员权限（UAC）。 |

后台模式的细节：

1. Agent 只看一个窗口的截图。输入直接投给那个窗口，所以被别的窗口遮住也能操作。
2. `open` 找程序的顺序：已开窗口（最小化的就地还原）→ 托盘图标 → 开始菜单。程序在运行但既没窗口也没托盘图标时不会再次启动，避免微信 4.x 开出第二份。
3. 网页是例外：Chromium 会丢弃投递进去的 `WM_CHAR` / `WM_KEYDOWN`，所以往地址栏输入或在页面里点击都没反应。改用带 `url` 的 `open`：Agent 自己的浏览器经 CDP 在其它所有窗口之后打开。
4. 以管理员权限运行的程序，后台模式够不到。遇到这类程序请切前台。

前台模式在整个会话里接管真实鼠标键盘，并把它操作的程序带到最前，回合结束后那个窗口仍在最前；只适合不接受其它方式的程序。

**停止。** 在半秒内连按两下 Esc，或点 Agent 工作时屏幕上横幅里的「停下」按钮。之后数据目录里会留下 `desktop-stopped` 文件，所有桌面操作都被拒绝，直到执行 `evolution-computer-use-win resume` 才恢复。运行中的调用被叫停后，会在下一步生效。

### 按应用策略

上面三种模式是全局设置。`app-policies.json`（在插件设置页的「按应用」里编辑）可以为单个程序加规则，匹配方式三选一：

| `match` | 匹配什么 |
| --- | --- |
| `exe:Weixin.exe` | 程序的 exe 文件名，不分大小写；`exe` 与 `exe.exe` 视为同一个。 |
| `app:微信` | Agent 传给 `open` 的程序名。 |
| `title:无标题 - Notepad` | 窗口标题，用于同一个 exe 打开多个文档的情况。 |

首条命中生效；没有规则的程序按全局模式走。`mode: "foreground"` 表示动这个程序之前先申请管理员助手（UAC）——用户在弹窗里拒绝，这一步就失败，全局模式保持用户所选不变。`mode: "background"` 表示即使全局是前台，这个程序也按后台来做，只截它自己的窗口，不截整屏。离开那个借用前台助手的程序后，助手会自动关掉。

设置页会用缩略图列出可见窗口，像 OBS 的窗口捕捉那样：点一个窗口，规则里就填好它的 `exe:` 名（文档窗口则用 `title:`）。

已保存的操作按它记录时的 `where` 重放（`"desktop"` 是后台、`"screen"` 是前台），按应用策略不会改变操作的重放方式。

## 浮窗与外观

Agent 在这台电脑上干活时最多会出现三块窗口：顶部一条操作横幅、右上角的思考浮窗、以及它左边的审计浮窗。三块都由同一个 WinForms 小助手绘制，默认鼠标穿透。后台操作时，同一个助手还会在每次鼠标动作的位置画一个 DSH 指针；它压在目标窗口之上、盖住目标窗口的前台应用之下。并请 Windows 把这些浮层排除在捕获之外（`SetWindowDisplayAffinity` 的 `WDA_EXCLUDEFROMCAPTURE`）：窗口截图里不会有它们，整屏截图在部分系统上仍可能带上。可以在 DSH 插件设置页里调，也可以手改 `~/.evolution-computer-use/appearance.json`；每个字段都有默认值，文件缺了或写坏了都不影响使用。

### 操作横幅

顶部那条横幅写着「DSH正在操作{app}」：`{app}` 是程序 exe 去掉 `.exe`，或者 Agent 传给 `open` 的名字；都没有时就只剩「DSH正在操作」。旁边是提示「连按两下 Esc 停下」和「停下」按钮。第一个电脑或网页工具调用让它出现，连续 30 秒没有电脑操作、或回合结束后 20 秒收起。

可调：四段文字；宽（`0` 表示按文字自适应）与高 28–120；不透明度 20–100%；位置 `top-left`、`top-center`、`top-right` 或 `custom` 配 `x`/`y`；背景、文字、提示、圆点、停止按钮、停止文字与边框六处颜色（`#AARRGGBB`，从调色板里选）；主文字、提示、停止三段字体（family、字号、加粗）；以及排版 `align`、`offsetX`、`offsetY`、`gap`、`padding`。字体可以用系统已装的，也可以在设置页上传 `.ttf`/`.otf`——上传的文件会复制到 `~/.evolution-computer-use/fonts/`；family 找不到时依次退回 Microsoft YaHei UI 与 Segoe UI。

### 思考浮窗

右上角的深色浮窗显示当前是第几步、正在做什么，下面是实时的思考与回复。它只读、默认鼠标穿透。

**什么时候出现。** 只在 Agent 真的在操作这台电脑时出现：回合开始、单纯思考或写代码都不会显示。第一个电脑或网页工具调用（`desktop`、`page_*`、`computer_use`、`procedure_*`、`inbox_read`、`desktop_mode`）才让它出现，并把在那之前流出的思考接上。连续 30 秒没有电脑操作就收起；回合结束后再停留 20 秒收起。

**设置。** 开关、位置（四个角或自定义 x/y）、宽 240–1600、高 160–1600、不透明度 20–100%、鼠标穿透锁，以及颜色与字体。改完立即生效。

### 审计浮窗

第二块浮窗贴在思考浮窗左边，顶边对齐，逐行列出最近 40 个动作：时间、成功或失败、动作、程序与细节——`点击 (412,238)`、`双击 (412,238)`、`右键 (412,238)`、`拖动 (12,34)→(90,120)`、`按键 Ctrl+S`、`输入 12 个字`、`滚动 ↓`、`打开 微信`、`关闭 记事本`、`截图`——后面是 Agent 给这一步的理由。

可调：开关；位置（默认 `left-of-thought`，也可四个角或自定义 x/y）；宽、高、不透明度；鼠标穿透锁；显示行数（默认 12）；是否显示时间、理由、缩略图；背景、边框、文字、次要文字、强调色、理由与截图标签的颜色；以及标题与正文两段字体。浮窗每秒读一次 `audit-live.tsv`，这个文件只保留最新 40 行，最新的在最后。

### 审计记录

每个桌面动作还会往 `~/.evolution-computer-use/audit/audit-YYYY-MM-DD.jsonl` 追加一行 JSON：`at`、`session`、`turn`、`tool`、`action`、`app`、`exe`、`title`、坐标、各类标志、按键与修饰键、文本、方向、秒数、`ok` 与结果、理由，以及截图的相对路径。理由优先用工具调用或操作步骤里的 `reason`；没给就用 `activity.json` 里 Agent 最后一段思考，截到 500 字。

保留策略默认 7 天、截图最多 500 MB、最多 5,000 条；截图可以关掉。服务器停着的时候，整个目录随时可以删。

思考浮窗与审计浮窗由两半组成，靠一个文件对接，即 `activity.json`：

| 半边 | 在哪 | 作用 |
| --- | --- | --- |
| 写侧 | 本包内置的 DSH 插件（`plugin/lib/index.js`） | 订阅 DSH 的 `agent/assistant-stream`、`session/event`、`tools/execute`，把思考、回复、步骤原子写入。 |
| 读侧 | 本包 `src/desktop/overlay.ts` | 每秒读一次 `activity.json`，喂给 `scripts/windows-takeover.ps1` 画出的 WinForms 浮窗。 |

之所以拆成两半，是因为单纯的 stdio MCP 服务看不到宿主的会话事件；写侧由本包的插件部分提供。`--no-overlay` 会跳过整块子系统。

## 信箱

服务每 2 秒检查一次任务栏闪烁与系统通知，只留最多 60 字符的摘要，安静 10 秒后按程序合并成一行告诉 Agent。它从不读取消息内容：要看内容得由 Agent 调 `inbox_read`。程序按自己的描述命名，不读窗口标题。信箱不落盘，`--inbox-ignore` 可以排除指定程序；拿不到 Windows 通知权限时记为故障。

## 消息记录

操作里声明了 `messages` 映射时，抽取到的每一行会变成 `messages.jsonl` 里的一条记录。映射写明每个位置取哪一行的字段或模板：`accountId`、`conversationId`、`messageId`、`content` 必须有，`speakerId` 在 `outgoing` 为真时不需要，`speakerName`、`conversationName`、`occurredAt` 可选；`channel` 与 `conversationType`（`private` 或 `group`）直接写在映射上。缺身份字段、或值不是单行纯文本的行会被跳过并计数；`content` 会截断，`occurredAt` 解析不了时记为当前时间。记录按渠道、会话与平台消息编号去重，包括文件里已有的编号；写入失败不影响操作本身；定时运行不记录。`--no-messages` 关闭该记录。

## 文件

| 路径 | 内容 |
| --- | --- |
| `<data>/browser/` | 浏览器配置，含 Agent 的登录态。不要共享、同步或提交。 |
| `<data>/procedures/` | 学会的操作与分类说明。 |
| `<data>/messages.jsonl` | 抽取出的消息。 |
| `<data>/apps-index.enc` | 加密的软件位置表（`apps-index.enc` 文件头，AES-256-GCM）。文件被删或损坏时，下次扫描会重建。 |
| `<data>/init-report.json` / `.md` | 最近一次完整 `init` 的报告。 |
| `<data>/startup-report.json` | 最近一次自动启动扫描与自测的结果。 |
| `<data>/selftest/` | 自测过程中截的图。 |
| `<data>/desktop-mode.json` | DSH 插件固定写到 `~/.evolution-computer-use/desktop-mode.json`，`--data` 不会移动它；服务每 0.8 秒读一次。 |
| `<data>/activity.json` | 浮窗显示的内容，插件写到同一个固定目录；要让服务读别处，设 `EVOCU_ACTIVITY_FILE`。 |
| `<data>/activity-settings.json` | 浮窗的位置、大小、不透明度与锁定，由插件在固定目录里读写。 |
| `<data>/appearance.json` | 操作横幅、思考浮窗、审计浮窗的文字、颜色、字体与排版；插件写到固定目录。 |
| `<data>/app-policies.json` | 按程序的前后台规则；插件写到固定目录，服务每 0.8 秒读一次。 |
| `<data>/audit/` | `audit-YYYY-MM-DD.jsonl`（每个动作一行）、`audit-live.tsv`（审计浮窗读的最新 40 行）、`shots/`（截图）。 |
| `<data>/fonts/` | 从设置页上传的字体。 |
| `<data>/overlay.lock` | 单实例锁，由服务器进程持有，文件里是它的 PID。 |
| `<data>/desktop-stopped` | 仅在紧急停止生效时存在。 |
| 截图 | 系统临时目录，模型读过后立即删除。 |
| 录制帧 | 系统临时目录（`evolution-cu-record-*`）；留到下次开始录制或关闭桌面控制时整目录删除，因为 `review` 还要读。 |

## 安全与风险

- **平台规则依然适用。** 自动化可能触发风控或违反网站条款。在意的话用专用小号，也不要以为学会的操作不会被识别出来。
- **账号的权限就是操作的权限。** 账号能发消息、能评论，操作就能。把这类限制写进 Agent 的提示，并把会外发的步骤标成 `outward`。
- **桌面控制看得见屏幕。** 开启期间，Agent 能读它打开的任意窗口，也能用这台电脑上已登录的账号。关掉并重启即可收回。
- **浏览器配置就是凭据库。** 本机任何能读到 `<data>/browser/DevToolsActivePort` 的程序都能驱动已登录的浏览器。不要以同一个 Windows 用户运行不可信的程序。
- **操作文件与代码相邻。** `script` 步骤在页面源下、以 Agent 的会话执行。跑别人分享的操作之前，先读一遍。
- **审计记录会留下痕迹。** `audit/` 记下 Agent 动了哪个程序、点了哪里、输入了什么，默认保留 7 天。不想留截图就在设置里关掉；服务器停着的时候可以直接删掉整个目录。

## 多个 Agent

- 共享 `--procedures`，让多个 Agent 往同一个库里学。
- 同时运行的 Agent 各用各的 `--profile`；两个浏览器不能共用同一份配置。
- 桌面本身没有跨进程锁，同一时刻只让一个 Agent 操作桌面。两个 Agent 的调用会把真实的鼠标键盘输入交错在一起，系统不会拦住任何一个。
- **从 dsh-world 迁移：** 复制 `procedures/` 与 `browser/`（浏览器需先关闭）。`onAlarm` 操作从归档数据库改为 `procedure_routines` 或定时执行 `evolution-computer-use-win routines`；抽取到的消息写进 `messages.jsonl`，不再是 `archive.sqlite`。

## 开发

```powershell
npm install          # 只需一次
npm run typecheck    # tsc --noEmit
npm test             # node --test
npm run build        # 输出到 lib/
```

测试共 221 个用例（219 通过、2 跳过），覆盖 MCP 协议、操作格式与操作库、外观与策略解析、审计记录，以及用假 shell 测的桌面驱动。`npm run prepack` 会在发布前跑类型检查与构建。

## 设计说明

操作格式由两组实验定下来；两份报告都只给汇总数据，实验脚本从未提交：

- **JSON + 页面脚本胜出。** 纯 JSON、JSON + 脚本、整段脚本三种形式在存活率上差不多（端到端成功 9 / 8 / 9，满分为 25），但 JSON + 脚本修补效果最好（20/20），分页任务也更省。现在 `procedure_save` 写的就是这种形式。（[报告](docs/experiments/2026-11-12-procedure-format.md)）
- **真正的开销是静默失败，而不是崩溃。** 第一轮里三种形式分别出现 90、110、90 次「报告已完成但重放结果不对」；第二轮 base 分支是 105 次。把空结果当成指名到步骤的失败、再用 `allowEmpty` 显式放行，第二轮的次数降到 0。
- **修补会弄坏旧页面。** 第一轮里约一半的修补弄坏了上一个页面，因为网站是逐步灰度改版的。在任何 `outward` 步骤之前退回两个保留版本，把这类事故从 9 降到 0，端到端成功率从 9/25 提到 16/25。（[报告](docs/experiments/2026-11-13-procedure-algorithms.md)）

## 许可与致谢

MIT。上游两个项目也都是 MIT，`NOTICE.md` 记录了两者的合并：

- [chenkezhen480/evolution-computer-use](https://github.com/chenkezhen480/evolution-computer-use) —— 桌面接管、操作格式、网页层。
- [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) —— Windows MCP 布局、原生助手、DSH 打包。

本仓库是两者的 DSH 版本，由 [thefreedoomdoor](https://github.com/thefreedoomdoor) 维护（Copyright (c) 2026 thefreedoomdoor），未适配其他 Agent 应用。
