# evolution-computer-use

[English](README.md) | 简体中文

会自己进化的电脑操作插件，给任何 Agent 用。

> 从 **[dsh-world](https://github.com/chenkezhen480/dsh-world)** 0.8 的「她自己的浏览器与她学会的操作」独立出来，去掉了对 DSH 宿主的依赖。操作的存储、回放和修复方式由 dsh-world 开发期间的两轮对照实验选定，见 [实验](#实验)。

- **专用浏览器**：系统自带的 Edge（或 Chrome），独立配置目录，通过 DevTools 协议（CDP）控制，不用你的鼠标键盘，也碰不到你日常的浏览器。
- **用户的电脑**（Windows，要用户打开）：后台模式往某个窗口投递输入，不动鼠标、不抢焦点；前台模式用真的鼠标键盘操作整个屏幕。
- **操作目录**：Agent 用页面原语或桌面动作把一件事走通后存成「操作」，下次直接回放，不调模型、不再一步步摸索。网站改版把操作弄坏了，回放会停在出错那一步并说明原因，Agent 当场手动做完、用原名存成新版；新版不行时自动退回旧版。所有用这个插件的 Agent 可以共用同一个操作目录。

插件不含任何平台（B 站、微信等）的代码。某个网站或程序怎么用，由 Agent 自己摸索，学会了才存下来。

没有运行时依赖：浏览器部分只用 Node 自带的 `WebSocket` 和 `fetch`，桌面部分是一个 PowerShell 脚本（`src/desktop/win32.ps1`），用 Windows 自己的接口。

## 接入

需要 Node.js 22.16 或更高。不用手动下载或 build：下面的配置都通过 `npx` 运行 [npm 上的包](https://www.npmjs.com/package/evolution-computer-use)，第一次用时自动下载。

`--desktop` 默认是 `off`（只有专用浏览器），要让 Agent 操作你的电脑就写 `background` 或 `foreground`，见「用户的电脑」。它只是启动时的初始状态：运行中 Agent 可以用 `desktop_mode` 工具在关闭、后台、前台之间切换，不用重启。

Windows 上的 `npx` 是个批处理文件（`npx.cmd`），有的客户端不能直接启动它，所以下面的例子都用 `cmd /c` 包一层。macOS 和 Linux 上去掉 `cmd /c`，直接把 `npx` 当命令。

### Claude Code

```powershell
claude mcp add --scope user evolution-computer-use -- cmd /c npx -y evolution-computer-use --desktop background
```

`--scope user` 让所有项目都能用；不写就只加到当前项目。

也可以当插件装，Claude Code 会用 git 从 GitHub 拉下来，直接从源码跑：

```text
/plugin marketplace add chenkezhen480/evolution-computer-use
/plugin install evolution-computer-use
```

插件启动时桌面控制是关的；要传 `--desktop`，就用上面的 `claude mcp add`。

### Codex CLI

`~/.codex/config.toml`：

```toml
[mcp_servers.evolution-computer-use]
command = "cmd"
args = ["/c", "npx", "-y", "evolution-computer-use", "--desktop", "background"]
# 录 2 分钟以内的视频、等浏览器排队都可能超过默认的 60 秒
tool_timeout_sec = 180
```

### Cursor、Cline、Windsurf、Claude Desktop 等

这些客户端都认 `mcpServers` 这种写法（Cursor 是 `.cursor/mcp.json`，Claude Desktop 是 `claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "evolution-computer-use": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "evolution-computer-use", "--desktop", "background"]
    }
  }
}
```

### 其他支持 MCP 的 Agent

任何 stdio 方式的 MCP 客户端都能用：命令是 `npx -y evolution-computer-use [选项]`。服务器支持协议版本 2025-06-18、2025-03-26、2024-11-05，初始化时会把用法说明放在 `instructions` 里。截图以 MCP 的 `image` 内容返回，客户端要能把图片交给模型，`page_shot` 和 `desktop` 才有用。

### 从源码运行

开发时，或者要用还没发布的改动：

```powershell
git clone https://github.com/chenkezhen480/evolution-computer-use.git D:\tools\evolution-computer-use
cd D:\tools\evolution-computer-use
npm install
npm run build        # 生成 lib/
```

然后把上面配置里的 `cmd /c npx -y evolution-computer-use` 换成 `node D:/tools/evolution-computer-use/lib/cli.js`。本地 clone 也能当 Claude Code 插件装：`/plugin marketplace add` 后面写本地路径。

### 在 JS/TS 里直接嵌入

不走 MCP 的宿主（比如自己写的 Agent 循环、DSH 插件）直接用库：

```powershell
npm install evolution-computer-use
```

```ts
import { createComputerUse, INSTRUCTIONS } from 'evolution-computer-use';

const computer = createComputerUse({
  dataDir: 'D:/agent-data/computer',      // procedures/、browser/、messages.jsonl 都在这里
  name: '小助手',                          // 操作时屏幕顶上提示里的名字
  onToolsChanged: () => { /* 桌面控制开关变了，重新注册工具 */ },
});
computer.setDesktopMode('background');      // 用户同意后再开：off、background、foreground

// 1. 把 INSTRUCTIONS 放进系统提示词；2. 把工具交给模型：
const tools = computer.tools().map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema }));
// 3. 模型调用工具时：
const result = await computer.call(name, args, signal);   // { text, images?: [{ data: Buffer, mediaType, caption? }] }
```

其他接口：`setDesktopMode(mode)`（`off` / `background` / `foreground` 之间切换，前台会弹 UAC；被拒时留在后台并返回原因）、`setForeground(on)`（只切前台开关，会弹 UAC）、`halt()` / `release()`（叫停与解除，宿主有自己的「停下」按钮时用）、`routines()`（跑例行操作）、`status()`、`show()`（把浏览器窗口提到前面）、`stop()`。`messages` 选项可以换成自己的 `MessageSink`，把操作读到的消息记进宿主自己的存储。

## 命令行

```text
evolution-computer-use [serve] [选项]   以 MCP（stdio）方式运行
evolution-computer-use resume [选项]    用户按了「停下」之后解除
evolution-computer-use routines [选项]  跑一遍例行操作并打印结果，给计划任务用
evolution-computer-use status [选项]    列出学会的操作和有问题的地方
```

没有全局安装（`npm install -g evolution-computer-use`）的话，前面加 `npx -y`，比如 `npx -y evolution-computer-use resume`。

| 选项 | 说明 |
| --- | --- |
| `--data <目录>` | 数据目录，默认 `~/.evolution-computer-use` |
| `--procedures <目录>` | 操作目录，默认 `<数据目录>/procedures` |
| `--profile <目录>` | 浏览器配置目录，默认 `<数据目录>/browser` |
| `--desktop off\|background\|foreground` | 桌面控制，默认 `off` |
| `--name <名字>` | 操作时屏幕顶上提示里的名字，默认 `AI` |
| `--inbox-ignore <名单>` | 信箱不报的程序，逗号分隔 |
| `--no-inbox` | 桌面控制开着也不看任务栏 |
| `--no-messages` | 操作读到的消息不记进 `messages.jsonl` |
| `--no-overlay` | 不启动右上角的思考/步骤浮窗（默认开，显示与样式由 DSH 插件设置） |

故障和恢复都写到 stderr（MCP 客户端一般会记进它自己的日志），Agent 调 `computer_use` 不带参数时也会看到。

## 工具

| 工具 | 作用 |
| --- | --- |
| `page_open` | 在专用浏览器当前标签页打开地址，返回页面内容（同 `page_read`）；只接受 http/https |
| `page_read` | 读页面：每个可操作元素一行 `[编号] 角色 名称`，之后附可见文字；`page` 翻页，`ref` 只看某元素里面 |
| `page_click` | 点编号对应的元素；被别的东西挡住会拒绝 |
| `page_type` | 在编号对应的输入框里整段输入，替换原有内容；`submit` 为真时再按回车 |
| `page_press` | 按一个键 |
| `page_scroll` | 向上或向下滚一屏左右，可指定元素 |
| `page_wait` | 等某段文字出现（最多 60 秒），或检查某个编号还在不在 |
| `page_shot` | 当前页面的截图，只在读文字看不明白时用 |
| `page_eval` | 在当前页面里执行一段 JS，十秒超时，结果截到 2000 字 |
| `computer_use` | 用之前说要用的程序或网站（`target`），返回这一类的说明、操作名和文件夹；不带参数就列出能用的模块、分类和故障 |
| `procedure_run` | 跑一个学会的操作：`path` 写 `分类/操作`，`args` 是它声明的参数 |
| `procedure_save` | 把走通的步骤存成操作；不带 `json` 调用时返回完整的格式说明 |
| `procedure_note` | 写某一类的说明（对应的程序或网站、网址和别称、注意事项），最多 1000 字 |
| `procedure_routines` | 把所有 `onAlarm` 的网页操作各跑一次，在单独的标签页里 |
| `desktop_mode` | 在 `off`、`background`、`foreground` 之间切换桌面控制，不用重启；切前台要 `confirm: true`，会弹 UAC |
| `desktop` | 操作用户的电脑（只在桌面控制开着时有），见下文 |
| `inbox_read` | 看信箱（只在信箱开着时有） |

工具列表固定，不随 Agent 学会新东西而变（保存操作不会让宿主的提示词缓存失效）；只有用户的开关会让 `desktop`、`inbox_read` 出现或消失，这时服务器发 `notifications/tools/list_changed`。`desktop_mode` 一直在，桌面控制关着也能用它打开。返回都很短：页面读取按页截断，脚本结果截断，截图不会自动附带。

## 自进化是怎么回事

1. **找**：`computer_use("微信")`。只和分类名、这一类的说明比，逐词比、大小写不论；一个词包含另一个就算对上，相邻两字有六成以上相同也算（「bilbili」对上「bilibili」）。操作名不参与：同叫「发送消息」，B 站的和微信的是两回事。一次只返回一类；好几类对得一样好时让 Agent 说具体哪一类；一个都对不上时照实说没有，并提醒它在已有分类的说明里补上这个叫法。
2. **跑**：`procedure_run("wechat/发朋友圈", { text })`，逐步回放，不调模型。
3. **学**：没有合适的，用 `page_*` 或 `desktop` 自己做，走通了 `procedure_save`，再 `procedure_note` 写这一类的说明。
4. **修**：回放遇到找不到的锚点、不满足的 `check` 就停，返回第几步、期望什么、当前页面的快照，并要 Agent 现在就手动做完、用原名存成新版。带 `outward` 的步骤失败一律报"可能已经发出"，不自动重试。
5. **空的也算没跑通**：`extract` 一条都没有、某个字段每条都空、带 `as` 的 `script` 结果为空，都按失败报出第几步。网站改版后选择器找不到东西，最常见的样子就是"什么都没有"，不报错的话 Agent 会以为"没有新私信"。本来就可能为空的那一步标 `allowEmpty: true`。
6. **新版不行就退回旧版**：最新版没跑通、而且还没有任何向外的动作时，按从新到旧再试最近 2 个旧版本（`<名字>.v<n>.json`）。网站灰度或 A/B 测试时新旧页面同时存在，为新页面修的版本到旧页面上可能跑不通。旧版本跑通了就用它的结果，后面附一句"最新版第几步没跑通，这次退回第几版"。

dsh-world 在模拟站点上的对比实验：空结果算失败后，不报错的失败从 105 次回放降到 0；退回旧版后，修复把旧页面修坏的从 9 次降到 0，学会、改版、修复全程走通的操作从 9/25 升到 16/25。详见 [实验](#实验)。

## 操作文件

`<操作目录>/<分类>/<名字>.json`，每类的说明是 `<分类>/目录.md`。Agent 也可以用自己的文件工具直接读和改，改了下次查目录、跑操作时就生效。保存时先校验，不合格不落盘并说明哪里不对（写了不认识的键也会被拒绝，免得一个拼写错误悄悄变成"任意链接"）；同名覆盖前，旧版本存成 `<名字>.v<n>.json`，每个名字只留最近 2 个。格式不合格的文件、文件名和 `name` 对不上的、`category` 和所在文件夹对不上的，都跳过并记为故障，不影响其他操作。

| 字段 | 说明 |
| --- | --- |
| `name` | 操作名，也是文件名：文字（中文也行）、数字、下划线、连字符，1 到 40 个字，不能是「目录」 |
| `category` | 分类，也是文件夹名，规则同 `name`；不写时存进「未分类」 |
| `description` | 说明 |
| `params` | `{ 名字: { type: string｜number｜boolean, required?, description? } }` |
| `where` | 不写是网页操作；`desktop` 是后台模式走通的，`screen` 是前台模式走通的 |
| `steps` | 1 到 40 步，每步只有一个动作 |
| `onAlarm` | 为真时是例行操作，`procedure_routines` 或 `evolution-computer-use routines` 时自动跑；不能有必填参数和向外发出的步骤 |
| `summary` | 例行结果那一行的模板，可用 `{{count}}` 和脚本 `as` 存下的值 |
| `messages` | 把 `extract` 的行记成消息，见「消息记录」 |

网页步骤（文字里的 `{{参数}}` 会代入）：

| 动作 | 写法 |
| --- | --- |
| `open` | 地址 |
| `click` | 锚点 |
| `type` | `{ into: 锚点, text }` |
| `press` | 键名（与 `page_press` 相同） |
| `wait` | `{ text｜anchor｜url, seconds? }`，最多 60 秒 |
| `check` | `{ text｜anchor｜url }`，最多等 3 秒，还不满足就停 |
| `extract` | `{ list: 锚点, fields: { 名: 锚点, 可加 attr }, limit? }`，`limit` 默认 8、最多 20 |
| `script` | JS，可 `return`；`as` 把结果存成值 |

锚点是 `{ role?, name?, text?, css?, nth? }`，`role`、`name` 取 `page_read` 里看到的，至少给一个；操作里不存坐标，也不存快照编号。`click`、`type`、`press`、`script` 可加 `outward: true`，表示这一步会向外发出东西。

桌面步骤：`open`（程序名或窗口标题）、`click {x,y,double?,right?,hold?}`、`drag {x,y,x2,y2,right?,hold?}`、`type {text,x?,y?}`、`press`（可加 `hold`）、`scroll {direction,x?,y?}`、`wait {seconds}`。`x`、`y` 是截图上的像素：`desktop` 是那个窗口的截图（窗口挪了不影响，大小变了按比例跟着变），`screen` 是整个屏幕的截图。回放时步与步之间不停，手动做时等过的地方（点完才弹出的窗口）要写 `wait`；保存时插件会指出可能漏了 `wait` 的地方，回放停在那里时也会提醒。

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

## 用户的电脑

只支持 Windows，别的系统上打开会记一条故障，`desktop` 工具不出现。不装任何东西：底下是插件自带的 `win32.ps1`，用 `PrintWindow` 截窗口、`PostMessage` 投鼠标和键盘消息、UI Automation 点托盘图标、开始菜单（`Get-StartApps`）启动程序。

**后台模式**（`--desktop background`）：Agent 看某一个窗口的截图，输入直接投给那个窗口，不移动你的鼠标指针、不抢焦点，你用着电脑它也能用；被别的窗口挡住也照样截得到、点得到。`open` 先找开着的窗口；最小化的原地还原；没有窗口就去托盘点它的图标；托盘里也没有才从开始菜单启动，并把焦点还给你原来的窗口。程序已经在跑却既没窗口也没托盘图标时不再启动（微信 4.x 再启动会多开一个）。够不着以管理员权限运行的程序（很多游戏），遇到时 Agent 会被告知请你切到前台模式。

浏览器页面是投递输入唯一进不去的地方：Chromium 会丢掉发到它窗口的 `WM_CHAR`/`WM_KEYDOWN`，所以往地址栏打字、点页面里面都没反应。改用带 `url` 的 `open`：页面由 agent 自己的浏览器经 CDP 打开，压在其它窗口后面——不会启动你的浏览器，也不会把任何窗口带到前台——截图是对那个后台窗口的窗口捕捉。页面里的操作（读、点链接、滚动）用 `page_open`/`page_read`/`page_click`；只有要手动操作你自己的浏览器时才需要前台模式。

**前台模式**（`--desktop foreground`）：启动时弹一次 Windows 的管理员权限确认，确认后起一个以管理员权限运行的助手，这次运行一直有效；拒绝或 2 分钟内没确认就留在后台模式，原因记为故障。Agent 看整个屏幕，用真的鼠标和键盘操作，游戏和管理员程序都能用；你的鼠标会跟着动，所以这是你把电脑交给它的时候用的。管理员助手只做截图、鼠标、键盘和画提示；列窗口、启动程序仍由普通权限的助手做，Agent 打开的程序不会以管理员身份运行。它和插件之间走一条只有这次知道名字的管道，先对一次性的口令。游戏的用户协议通常禁止自动化操作，长时间代打有封号风险，由你自己决定。

**运行中切换**（`desktop_mode` 工具 / `setDesktopMode()`）：不用重启就能在 `off`、`background`、`foreground` 之间换。切到前台会弹 UAC 确认，Agent 调工具时必须带 `confirm: true`，没带就只返回一句提醒、不会弹窗；你拒绝了就留在后台，原因记进故障。切回后台会停掉管理员助手，切到 `off` 会把两个助手都停掉、`desktop` 工具消失。宿主想自己做个开关，直接调 `computer.setDesktopMode('background')` 这类方法即可，`onToolsChanged` 会通知你重新注册工具。

**在 DSH 设置界面里切换**：配套的 DSH 插件 `dsh-evolution-desktop-mode` 把 `desktopMode` 做成设置页里的插件配置项（`off` / `background` / `foreground`），并写入 `~/.evolution-computer-use/desktop-mode.json`；这个 MCP 服务器每 0.8 秒读一次该文件，选完立即生效，不用重启。

`desktop` 的 `action`：

| action | 作用 |
| --- | --- |
| `open` | `app` 写程序名、窗口标题或开始菜单里的名字；不写就列出开着的窗口。带 `url` 就用 agent 自己的浏览器在后台打开并截它的窗口（不碰你的浏览器、不抢焦点） |
| `shot` | 再截一张 |
| `click` | `x`、`y`（截图上的像素）；`double`、`right`；`hold` 长按秒数（最多 10） |
| `drag` | 从 `x`、`y` 拖到 `x2`、`y2`；`hold` 先按住几秒，`right` 用右键 |
| `type` | `text`；先给 `x`、`y` 就先点那里；`submit` 再回车 |
| `press` | `key`：回车、Tab、Esc、空格、退格、Delete、Home/End、翻页、方向键、F1–F12、单个字母或数字，可加 `ctrl+`、`shift+`、`alt+`；`hold` 按住秒数 |
| `scroll` | `direction` 为 up/down/left/right，可加 `x`、`y` |
| `zoom` | 截图上 `x`、`y` 到 `x2`、`y2` 的一块，按原分辨率放大（最多 4 倍） |
| `record` | 录会动的东西（视频）：`seconds` 最多 600，`every` 每几秒一帧，`pause: false` 录完不暂停 |
| `stop` | 停下正在录的 |
| `review` | 看录好的：不带参数看全片拼图，`from`、`to` 细看一段，`at` 看某一秒 |

每次操作完都给一张新截图，点击之后的截图上用红圈标出实际点到的位置，让 Agent 自己确认做对了没有。截图后会告诉它这个程序还开着哪些别的窗口、上一次输入之后出现或关掉了哪些。

### 操作时你看得到，也随时能叫停

Agent 动手时屏幕顶部正中浮出一个深色胶囊「<名字>正在操作」，旁边是「连按两下 Esc 停下」和「停下」按钮，它操作的窗口四周有一圈蓝色柔光边（前台模式是整个屏幕）。半秒内连按两下 Esc，或点「停下」：

- 正在做的那一步作废，Agent 收到「用户按了停下……别重试，先问问用户」；正在录的立刻停在那里，之后不再给那个窗口发任何按键。
- 按下时它没有正在做的一步，它的下一个工具结果后面会附上这句话。
- 在你解除之前，所有动电脑的操作都会被拒绝（回看录好的还可以）。停下会记在 `<数据目录>/desktop-stopped`，Agent 重启也不会自动解除。确认没问题后在终端运行 `npx -y evolution-computer-use resume`（数据目录不是默认的就加 `--data`）。

## 思考浮窗（右上角）

Agent 动手时，屏幕右上角浮出一块深色面板：这一回合的状态（「第 2 步 · 执行中」）、每一步做过哪些动作（「打开页面、读取设置」「点击「设置」按钮」），以及下面的思考原文和回复原文。它是只读的，不接鼠标（默认「锁定」= 鼠标穿透），也不进截图和录屏。

浮窗由两部分拼成，中间隔着 `activity.json`：

| 半边 | 在哪 | 干什么 |
| --- | --- | --- |
| 写侧 | DSH 宿主插件 `dsh-evolution-desktop-mode` | 订阅 DSH 的 `agent/assistant-stream`、`session/event`、`tools/execute`，把思考、回复、步骤原子写进 `<数据目录>/activity.json` |
| 读侧 | 本插件 `src/desktop/overlay.ts` | 每 1 秒读 `activity.json`，把内容用行 JSON 发给 `scripts/windows-takeover.ps1` 画出的 WinForms 浮窗 |

这样拆是因为本插件是标准 stdio MCP，拿不到宿主的会话事件；换任何宿主都只要补写侧。

- **显示与样式**：在 DSH 的插件设置页（插件列表里这一条下面）改——开关、位置（右上/左上/右下/左下）、宽度 240–1600、高度 160–1600、不透明度 20–100%、锁定（鼠标穿透）。改动立即生效，存进 `<数据目录>/activity-settings.json`，由写侧抄进 `activity.json`。
- **语言**：跟随 DSH 界面语言（中文/英文），面板上的标题、步骤行、动作名都是本地化的。
- **回合结束**：面板停留 20 秒再收起，好让你看到最后的结果；失败和「被用户停下」也照样标出来。
- **只有一块**：同一台机器上同时跑几个本插件（比如 DSH 里挂了两条连接），也只有先认领 `<数据目录>/overlay.lock` 的那个画浮窗，其余待命；持有者崩了或退出，待命的下一轮接管。
- **没有写侧时**：只跑本插件（Claude Code、Codex 等）就没有 `activity.json`，浮窗一直不显示，只多一个空转的 PowerShell 助手进程；不想启动它加 `--no-overlay`。
- **改了渲染脚本**：`scripts/windows-takeover.cs` 一旦改动，DLL 快路径的哈希校验失败，会自动回落到 `Add-Type` 现编（启动慢 2–5 秒，功能一样）。

移植自 [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) 0.6.3（MIT），见 [NOTICE](NOTICE.md)。

## 信箱

桌面控制开着时，插件替 Agent 看任务栏：按钮在闪，和系统通知（带一小段原话，最多 60 字）。动静一阵一阵来，最后一个动静之后 10 秒内没有新的，就合成一段放进信箱，Agent 的下一个工具结果后面附一句「信箱有新动静」，内容等它用 `inbox_read` 自己看，不在它做事做到一半时塞进来。程序名取它自己的说明，不读窗口标题（标题里可能有消息内容）。不落盘；启动时已经在通知列表里的算旧的。已经有自己通道的程序用 `--inbox-ignore` 排除。读不到通知时（没有权限）记为故障：在 Windows 设置 › 隐私和安全性 › 通知 里允许应用访问通知。

## 消息记录

操作可以用 `messages` 声明 `extract` 出来的哪些行是消息：`channel`、`conversationType`（`private` 或 `group`）写死；`accountId`、`conversationId`、`messageId`、`speakerId`、`content` 必填，`speakerName`、`conversationName`、`occurredAt`、`outgoing` 可选，都是 `{{字段}}` 模板，`outgoing` 算出 `true` 表示是 Agent 自己发的。Agent 用 `procedure_run` 跑操作时读到的消息追加进 `<数据目录>/messages.jsonl`，按平台消息 ID 去重，再读一遍不会重复；身份字段缺失的行跳过；写失败不会让操作失败。例行操作读到的不记。嵌入时可以换成自己的 `MessageSink`。

## 多个 Agent

- **共用学会的操作**：几个 Agent 指向同一个 `--procedures`（默认数据目录本来就是同一个）。一个 Agent 学会的，别的 Agent 用 `computer_use` 就能找到；文件按修改时间判断有没有变，不用重启。
- **浏览器各用各的**：同一个浏览器配置同一时间只适合一个 Agent 操作（排队只在一个进程里）。几个 Agent 同时跑时给每个一个 `--profile`，登录各自做一次。
- **桌面同一时间只给一个**：两个 Agent 同时操作同一台电脑会互相打断。

## 从 dsh-world 迁移

操作文件格式完全相同。把 `<世界目录>/procedures/` 整个复制到 `<数据目录>/procedures/` 就能用，旧版本文件和 `目录.md` 也照样认；想保留各网站的登录，再把 `<世界目录>/browser/` 复制到 `<数据目录>/browser/`（复制前关掉那个浏览器）。dsh-world 里平铺在 `procedures/` 下的旧文件同样读成「未分类」。`onAlarm` 的操作在 dsh-world 里是闹钟前跑，这里改成 `procedure_routines` 或计划任务里的 `evolution-computer-use routines`。消息不再写进 `archive.sqlite`，而是 `messages.jsonl`。

## 文件位置

| 位置 | 是什么 |
| --- | --- |
| `<数据目录>/browser/` | 专用浏览器的配置，**含各网站的登录态**，不要外传、不要放进云盘或仓库 |
| `<数据目录>/procedures/` | 学会的操作、旧版本、每类的说明；插件只在保存时写 |
| `<数据目录>/messages.jsonl` | 操作读到的消息 |
| `<数据目录>/desktop-stopped` | 用户按了停下、还没解除时才有 |
| `<数据目录>/activity.json` | 浮窗的活动数据，DSH 插件写、本插件读 |
| `<数据目录>/activity-settings.json` | 浮窗的显示与样式设置，DSH 插件写 |
| `<数据目录>/overlay.lock` | 浮窗的单实例锁，里面是正在画它的那个进程的 PID |

截图和录制的帧只经过系统临时目录，用完就删。

## 风险

- 让程序操作网页，可能触发平台的风控，也可能违反服务条款，账号可能被限制或封禁。建议用专门的小号登录专用浏览器。插件不保证不被识别为自动化，也没有可靠的"安全频率"。对谁开口不设限：Agent 能用这个浏览器做你的账号做得到的事，需要约束就写进 Agent 自己的提示词。
- 桌面控制开着时，Agent 能看到它打开的窗口里的一切，能用你在这台电脑上登录着的所有账号。随时关掉（不带 `--desktop` 重启）就收回。
- 本机上任何程序都能读 `<数据目录>/browser/DevToolsActivePort`，据此驱动已登录的专用浏览器，所以不要以同一个系统用户运行不可信的程序。

## 验证

`npm test` 跑全部离线测试（154 个，其中 2 个真机测试默认跳过：`ECU_EDGE_TEST=1` 打开真的 Edge，`ECU_DESKTOP_TEST=1` 在开着微信的桌面上只读地截图）。`npm run typecheck` 做类型检查。

已在 Windows 11 家庭中文版（10.0.26200）、Node 22.16 上用构建好的 `lib/cli.js` 走过一遍 MCP：初始化、列工具、后台模式列窗口（真的 PowerShell 助手）、`page_open` 和 `page_shot`（真的 Edge）、保存并回放操作、把操作改坏后自动退回旧版。dsh-world 里做过的桌面真机验证（微信的后台点击、输入、托盘唤起、前台模式）是同一份代码，这里没有重做。尚未验证：macOS 和 Linux 上的浏览器部分；只有 Chrome 没有 Edge 的机器；Codex、Cursor 等客户端里的实际接入。

## 实验

操作用什么形式存、怎么回放、怎么修，是 dsh-world 开发期间两轮对照实验定下来的（真 DSH 容器、`deepseek-flash`、带三个改版的模拟站点、五个任务，判定规则先于结果写定）：

| 轮次 | 问题 | 结论 |
| --- | --- | --- |
| 第一轮（2026-11-12） | 纯 JSON、JSON + 页面内脚本、全脚本，哪种形式好 | 全程走通三组打平（9 / 8 / 9），纯 JSON 在翻页任务上贵得多，按"打平选更简单的"选 JSON + 页面内脚本 |
| 第二轮（2026-11-13） | 三种回放算法各有多少用；存操作比每次现做划不划算 | 空结果算失败（K）把不报错的失败从 105 降到 0；退回旧版（V）让全程走通从 9/25 升到 16/25；指纹自愈（F）不确定；现做更稳但贵约 4 倍 |

本插件实现了 K 和 V；F 和"保存时检查 class 选择器"（报告认为收益最大的下一步）还没有做。英文说明和对照表见 [docs/experiments/](docs/experiments/README.md)，中文原文（报告和事先写定的设计）在 [docs/experiments/zh-CN/](docs/experiments/zh-CN/)；设计文档的副本去掉了实验所用机器的几处本机细节，方法和结果没有删改。

## 来源

核心代码移植自 [dsh-world](https://github.com/chenkezhen480/dsh-world) 0.8 的 `src/ecosystem/computer/`（MIT）。浏览器的查找与启动、最小 CDP 会话、页面内元素登记表又移植并改写自 [dsh-inner-browser-use](https://www.npmjs.com/package/dsh-inner-browser-use) 0.47.28（MIT），保留署名与许可，见 [NOTICE](NOTICE.md)。

右上角的思考/步骤浮窗（`scripts/` 与 `src/desktop/overlay.ts`、`src/desktop/overlay-strings.ts`）移植自 [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) 0.6.3（MIT），同样保留署名与许可。
