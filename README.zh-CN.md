# evolution-computer-use-win

[English](README.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.16-informational)](package.json)
[![Windows](https://img.shields.io/badge/desktop-Windows%2010%2F11-0078D4)](package.json)
[![MCP](https://img.shields.io/badge/protocol-stdio-6E4AFF)](https://modelcontextprotocol.io)

面向 **DeepSeek Harness** 的电脑操作能力，通过模型上下文协议（stdio）提供：Agent 先自己摸索出某个网站或桌面程序怎么用，把过程存成操作，之后直接重放，不必每次都重新探索。

- 网页操作，以及在 Windows 上的后台桌面操作。
- 学会的操作是普通 JSON 文件：有版本、可修补、多个 Agent 之间可共享。
- 一个 Node 进程，零运行时依赖，不需要另装任何东西。

## 目录

- [功能](#功能)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [配置](#配置)
- [工具](#工具)
- [操作](#操作)
- [桌面控制](#桌面控制)
- [思考浮窗](#思考浮窗)
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
| **会自愈的修补** | 重放失败时退回最近两个保存过的版本；结果会做检查，失效的选择器会当场报错，而不是显示「已完成」。 |
| **可审计** | 每个操作都是可读的文件，每次改动都留下旧版本，每个桌面动作都经过一条可见、可停的通道。 |

## 环境要求

| 要求 | 说明 |
| --- | --- |
| **系统** | Windows 10 或 11。两部分都依赖它：找浏览器是在 Windows 安装目录里找 `msedge.exe` / `chrome.exe`，桌面控制也只有 Windows 版。 |
| **Node.js** | 22.16.0 或更高。除本包以外不需要装任何东西。 |
| **浏览器** | 默认安装在 Windows 上的 Microsoft Edge 或 Google Chrome。Agent 会用独立配置启动自己的实例。 |
| **宿主** | 任何 stdio MCP 宿主都能跑通协议，但只为 **DeepSeek Harness** 做了适配。配套插件 `dsh-evolution-desktop-mode` 提供桌面模式开关和思考浮窗。 |
| **权限** | 后台桌面操作不需要；前台模式需要管理员权限，会弹出 UAC。 |

## 安装

### 从源码（当前可用的方式）

```powershell
git clone https://github.com/thefreedoomdoor/evolution-computer-use-win
cd evolution-computer-use-win
npm install
npm run build
```

npm 包 `evolution-computer-use-win` 尚未发布；发布之后 `npx -y evolution-computer-use-win` 可以替代上面的 clone 步骤。

### DeepSeek Harness

把服务加到 DSH 的 MCP 配置里，`command` 指向编译后的 CLI：

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "node",
      "args": ["C:/path/to/evolution-computer-use-win/lib/cli.js", "--desktop", "background"]
    }
  }
}
```

要看思考浮窗，再装配套插件 `dsh-evolution-desktop-mode`（见 [思考浮窗](#思考浮窗)）。不带 `--desktop` 时桌面控制默认关闭，Agent 之后可以用 `desktop_mode` 打开。

> **未适配其他 Agent 应用。** MCP 服务本身与宿主无关，但只有 DSH 真正驱动它：浮窗的写侧是一个 DSH 插件，其它宿主都未验证。

## 快速开始

1. 按上面的配置加好服务，重启宿主。
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
evolution-computer-use-win [serve|resume|routines|status] [选项]
```

| 命令 | 作用 |
| --- | --- |
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
| `--name <文本>` | `AI` | 浮窗和停止胶囊上显示的名字。 |
| `--inbox-ignore <名单>` | 无 | 不在信箱里提示的程序名。 |
| `--no-inbox` | 关 | 不监视任务栏与通知。 |
| `--no-messages` | 关 | 不写 `messages.jsonl`。 |
| `--no-overlay` | 关 | 完全不启动浮窗助手。 |
| `-h`、`--help` | | 打印用法。 |

首次运行后的数据目录：

```text
~/.evolution-computer-use/
├─ browser/                 浏览器配置；登录态在这里
├─ procedures/
│  ├─ bilibili/看未读.json
│  ├─ bilibili/看未读.v2.json   保留的上一版
│  └─ bilibili/目录.md          该分类的说明，≤ 1000 字符
├─ messages.jsonl            抽取出的消息，一行一条
├─ desktop-mode.json         DSH 插件写入，每 0.8 秒读取一次
├─ activity.json             浮窗内容，由 DSH 插件写入
├─ activity-settings.json    浮窗的位置、大小、不透明度、锁定
└─ overlay.lock              单实例锁，含助手进程的 PID
```

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
| 桌面 | `desktop` | 操作用户的电脑：`open`、`shot`、`click`、`drag`、`type`、`press`、`scroll`、`zoom`、`record` / `stop` / `review`。仅在桌面控制开启时可用。 |
| | `desktop_mode` | 运行时在 `off`、`background`、`foreground` 之间切换。始终存在，因此可以用它打开桌面控制；切前台需要 `confirm: true`。 |
| 操作 | `computer_use` | 说明这次要用哪个程序或网站，返回该分类的说明、操作名和目录；不带参数时列出可用模块、分类和故障。 |
| | `procedure_run` | 重放学会的操作；`path` 为 `分类/操作`。 |
| | `procedure_save` | 把跑通的步骤存成操作；不带 `json` 时返回完整格式说明。 |
| | `procedure_note` | 写某个分类的说明：对应哪个程序或网站、网址与别称、注意事项。 |
| | `procedure_routines` | 把每个 `onAlarm` 网页操作各跑一次，各用单独的标签页。 |
| 信箱 | `inbox_read` | 报告有什么在等着：任务栏闪烁与系统通知。仅在信箱开启时可用。 |

工具清单是固定的。学会新操作不会改变清单，因此存操作不会让宿主的 prompt cache 失效。只有用户的开关会让 `desktop` 和 `inbox_read` 出现或消失，此时服务会发 `notifications/tools/list_changed`。

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

写了 `where` 的操作操作用户的电脑而不是网页，步骤是本机截图上像素：`x`、`y` 取 0–4000，要么都写要么都不写。

| 步骤 | 写法 | 说明 |
| --- | --- | --- |
| `open` | `{"open": "微信"}` | 按名字打开程序：它的窗口、托盘图标或开始菜单。 |
| `click` | `{"click": {"x": 120, "y": 240, "double": true, "right": true, "hold": 2}}` | `double`、`right`、`hold` 可选。 |
| `drag` | `{"drag": {"x": 10, "y": 20, "x2": 300, "y2": 400}}` | 在 `x`,`y` 按下，拖到 `x2`,`y2` 松开；`right`、`hold` 可选。 |
| `type` | `{"type": {"text": "你好", "x": 100, "y": 200}}` | 坐标可选；写了就先点那里。 |
| `press` | `{"press": "return", "hold": 0.5}` | 桌面按键名；`hold` 秒数可选。 |
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

**停止。** 连按两下 Esc，或点浮窗胶囊上的停止按钮。之后数据目录里会留下 `desktop-stopped` 文件，所有桌面操作都被拒绝，直到执行 `evolution-computer-use-win resume` 才恢复。运行中的调用被叫停后，会在下一步生效。

## 思考浮窗

Agent 在这台电脑上干活时，屏幕右上角会出现一块深色浮窗：当前是第几步、正在做什么，下面是实时的思考与回复。它只读、默认鼠标穿透；窗口截图里没有它，前台模式的整屏截图则可能带上。

**什么时候出现。** 只在 Agent 真的在操作这台电脑时出现：回合开始、单纯思考或写代码都不会显示。第一个电脑或网页工具调用（`desktop`、`page_*`、`computer_use`、`procedure_*`、`inbox_read`、`desktop_mode`）才让它出现，并把在那之前流出的思考接上。30 秒没有动作、或回合结束，就自动收起。

**设置。** 在 DSH 插件设置页：开关、位置（四个角）、宽 240–1600、高 160–1600、不透明度 20–100%、鼠标穿透锁。改完立即生效。

浮窗由两半组成，靠一个文件对接，即 `activity.json`：

| 半边 | 在哪 | 作用 |
| --- | --- | --- |
| 写侧 | DSH 插件 `dsh-evolution-desktop-mode` | 订阅 DSH 的 `agent/assistant-stream`、`session/event`、`tools/execute`，把思考、回复、步骤原子写入。 |
| 读侧 | 本包 `src/desktop/overlay.ts` | 每秒读一次 `activity.json`，喂给 `scripts/windows-takeover.ps1` 画出的 WinForms 浮窗。 |

之所以拆成两半，是因为单纯的 stdio MCP 服务看不到宿主的会话事件。换别的宿主，只需要自己补上写侧。`--no-overlay` 会跳过整块子系统。

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
| `<data>/desktop-mode.json`、`activity-settings.json` | 由 DSH 插件写入，服务读取。 |
| `<data>/activity.json`、`overlay.lock` | 浮窗内容与它的单实例锁。 |
| `<data>/desktop-stopped` | 仅在紧急停止生效时存在。 |
| 截图与录制帧 | 系统临时目录，调用结束即删除。 |

## 安全与风险

- **平台规则依然适用。** 自动化可能触发风控或违反网站条款。在意的话用专用小号，也不要以为学会的操作不会被识别出来。
- **账号的权限就是操作的权限。** 账号能发消息、能评论，操作就能。把这类限制写进 Agent 的提示，并把会外发的步骤标成 `outward`。
- **桌面控制看得见屏幕。** 开启期间，Agent 能读它打开的任意窗口，也能用这台电脑上已登录的账号。关掉并重启即可收回。
- **浏览器配置就是凭据库。** 本机任何能读到 `<data>/browser/DevToolsActivePort` 的程序都能驱动已登录的浏览器。不要以同一个 Windows 用户运行不可信的程序。
- **操作文件与代码相邻。** `script` 步骤在页面源下、以 Agent 的会话执行。跑别人分享的操作之前，先读一遍。

## 多个 Agent

- 共享 `--procedures`，让多个 Agent 往同一个库里学。
- 同时运行的 Agent 各用各的 `--profile`；两个浏览器不能共用同一份配置。
- 同一时刻只能有一个 Agent 操作桌面。一次 `desktop` 调用期间，这台电脑归它。
- **从 dsh-world 迁移：** 复制 `procedures/` 与 `browser/`（浏览器需先关闭）。`onAlarm` 操作从归档数据库改为 `procedure_routines` 或定时执行 `evolution-computer-use-win routines`；抽取到的消息写进 `messages.jsonl`，不再是 `archive.sqlite`。

## 开发

```powershell
npm install          # 只需一次
npm run typecheck    # tsc --noEmit
npm test             # node --test
npm run build        # 输出到 lib/
```

测试共 172 个用例（170 通过、2 跳过），覆盖 MCP 协议、操作格式与操作库，以及用假 shell 测的桌面驱动。`npm run prepack` 会在发布前跑类型检查与构建。

## 设计说明

操作格式由两组实验定下来；两份报告都只给汇总数据，实验脚本从未提交：

- **JSON + 页面脚本胜出。** 纯 JSON、JSON + 脚本、整段脚本三种形式在存活率上差不多（端到端成功 9 / 8 / 9，满分为 25），但 JSON + 脚本修补效果最好（20/20），分页任务也更省。现在 `procedure_save` 写的就是这种形式。（[报告](docs/experiments/2026-11-12-procedure-format.md)）
- **真正的开销是静默失败，而不是崩溃。** 失效的选择器什么都没抽到、却报告「已完成」，第一轮里出现了 105 次。把空结果当成指名到步骤的失败、再用 `allowEmpty` 显式放行，这个数字降到 0。
- **修补会弄坏旧页面。** 第一轮里约一半的修补弄坏了上一个页面，因为网站是逐步灰度改版的。在任何 `outward` 步骤之前退回两个保留版本，把这类事故从 9 降到 0，端到端成功率从 9/25 提到 16/25。（[报告](docs/experiments/2026-11-13-procedure-algorithms.md)）

## 许可与致谢

MIT。上游两个项目也都是 MIT，`NOTICE.md` 记录了两者的合并：

- [chenkezhen480/evolution-computer-use](https://github.com/chenkezhen480/evolution-computer-use) —— 桌面接管、操作格式、网页层。
- [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) —— Windows MCP 布局、原生助手、DSH 打包。

本仓库是两者的 DSH 版本，未适配其他 Agent 应用。
