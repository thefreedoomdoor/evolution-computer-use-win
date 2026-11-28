# 多子 Agent 桌面指针 — 验证状态记录（2026-11-25 历史快照）

> 本文件保留第 5–9 轮的历史观察与限制，不代表后续生产实现仍未编写，也不代表本轮真实多 Agent 输入已通过。后续实现、独立回归与当前未完成验收以[当前实施账本](<cyble-multi-mouse-implementation-plan.md>)为准。文中本机截图、日志、验收包和 profile 路径仅用于追溯，未随仓库或 npm 包交付。

**当时状态：离屏多指针绘制已实现，并已接入真实活动 DSH Desktop 的点击穿透覆层（第 9 轮：3 个直接子 Agent 显示真实矢量鼠标箭头与名称/颜色，非文字标签）；原生插件也已在真实隔离 DSH Desktop 完成严格多 Agent 身份 P1（第 8 轮：3 个直接子 Agent 加 1 个嵌套孙 Agent，5/5 检查通过）。多 Agent 输入、每个指针随各自桌面动作移动、真实鼠标回收和多显示器实屏仍待验证，A1–A7 其余项未验收。** 本记录只汇总当前可证实的结果，不将离线原语测试或 CLI/Mock 视作 Desktop 证据。依据规格：[multi-agent-virtual-pointers-spec.md](./multi-agent-virtual-pointers-spec.md)。

## 当前门槛

### 可信身份：严格 P1 已通过（第 8 轮）；生产工具逐请求绑定仍未验收

- 第 8 轮在真实隔离 Desktop 中完成 3 个直接子 Agent 加 1 个嵌套孙 Agent 的并发身份验收，5/5 检查通过（证据见下文“第 8 轮”）。以下关于 MCP 桥和原生入口的限制保留为设计与证据背景，说明为什么必须走原生路径。
- 已安装 DSH Desktop 为 0.2.2-rc.5；已解析的活动包路径 C:\Users\freezingcold\.dsh\profiles\desktop\node_modules\evolution-computer-use-win 是指向工作区 D:\evolution-computer-use 的 Junction。没有在活动目录 build、install、reload 或运行探针。
- DSH 工具契约存在 ToolExecutionInput.agent?: Agent 与 signal: AbortSignal（D:\harness-desktop\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-tools\src\contracts.ts:175-202）；Agent loop 调用 tools.execute({ calls: toolCalls, signal, agent: this, ... })（D:\harness-desktop\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-loop\src\agent.ts:592-599）。这证明上游 host 有 caller 字段，不证明本 MCP 插件能收到它。
- 已安装 MCP 桥 @deepseek-ai/dsh-mcp-client@0.2.2-rc.5 在 D:\harness-desktop\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-mcp-client\src\tools.ts:152-158 转发为 client.callTool({ name: tool.name, arguments: args }, { signal: AbortSignal.any([execution.signal, opts.signal]), timeout: opts.toolCallTimeoutMs, toolDefinition: tool })，没有传 execution.agent。本插件实际注册为 stdio MCP 服务（D:\evolution-computer-use\lib\plugin.js:45-64）。因此当前已证明路径里，stdio server 没有可信 caller 字段；不能以工具参数、展示名、调用顺序或根 Agent 代填。
- 运行时可见的 pluginManager Inspector 仅暴露 installBundle、waitForInstall、cancelInstall 等方法签名；Inspector 查询是只读，不能调用业务方法。当前会话无正式安装/加载的已获批执行入口。官方规则要求用 install_bundle 或 GUI Plugins > Add plugin，不手改 profile。未尝试绕过审批、复制凭据、改 DSH 安装或主 profile。
- 第 8 轮前，可信 caller、`agent/created` / `agent/disposed` / `subagents.rootOf` 时序与归属在真实 Desktop 中尚未验证，故当时停止多 Agent 输入实现与路由启用。该结论已被第 8 轮实测解除：原生路径在真实根/子/孙 Agent 调用中取得可信 caller，并完成严格 P1。取消、审批与结果投影仍未验证。
- 第 7 轮已证实插件在真实隔离 Desktop 中加载并完成原生工具注册（唯一回执 + `verify.ps1` pass:true）；第 8 轮在此基础上创建了真实根/子/孙 Agent 并完成身份验收。

### 输入并发：未证明安全，只能按串行与全局排他设计

- 现有桌面控制器共享当前窗口、视图与输入状态。单个 [helper 的请求循环](../../src/desktop/win32.ps1#L1307) 会等当前 `Run` 返回才读下一笔；这只证明同一 helper 内串行，不证明多个 helper 之间互斥，也不证明应用处理了投递的事件。并行 Promise 不是窗口级并行的证据。
- [驱动超时路径](../../src/desktop/driver.ts#L117) 先报告结果不明，然后尝试结束子进程或关闭提权 helper 的连接，不等待旧请求收尾。不能以超时或断链作为释放冲突输入的依据；后续仲裁须等到确认旧执行结束，否则保持拒绝，不自动重放。
- 既有 Java Swing 对照试验中，截图红圈落在按钮中心约 (140,48)，后台 PostMessage click 返回，但 Swing 日志没有 BUTTON_A_ACTION；这证明此路径不可拿“已投递”冒充应用执行，并支持不兼容时拒绝停止。它不是新的 DSH Desktop 多 Agent 实测。
- 未开启新的桌面输入。未验证每窗口隔离、焦点/剪贴板/模式切换排他、排队及运行中取消、窗口句柄代际、helper 重启和中断后的不确定结果。身份门槛虽已在第 8 轮通过，但上述输入安全项未验证前仍不得启用并行输入或生产 caller 路由。

## 可行性结论（截至第 8 轮：身份门槛已通过，多 Agent 输入仍未实现）

- **具体契约缺口：** 现有 stdio MCP 桥（`dsh-mcp-client/src/tools.ts:152-158`）只转发工具名与参数，不传 `execution.agent`，因此本插件经 MCP 路径拿不到可信 caller——这是硬缺口，不能用展示名、调用顺序或模型传参补。仓库已提供原生挂载路径（`src/plugin.ts:80-88` 的 `toolTransport: 'native-probe'`），可取得宿主注册的 `tools/agents/subagents` 上下文；该路径已于第 8 轮在真实 DSH Desktop 证实加载并完成严格身份 P1。
- **受影响项：** 身份门槛已解除，但 A1（派出/常驻）、A3（身份绑定与审计归属）、A4（跨 Agent 输入仲裁）、A6（取消与不确定结果）仍未实现或未验收；A2（离屏绘制）已离线通过、真机未验收；A5/A7 仅有部分离线证据（见 A1–A7 表）。
- **结论：** 第 8 轮仅通过身份 P1；生产桌面工具逐请求可信绑定、窗口级仲裁与真实多指针覆层仍未验收，因此不实现多 Agent 路由或并行输入，仅保留“视觉可同时、输入串行”设计。单 Agent 的安全收尾已加固（见下“输入收尾门槛”）。这不是多 Agent 能力已具备的声明。

## 已做工作与离线证据

- `scripts/windows-takeover.cs` 实现纯数据 `PointerVisual` 与离屏 `DrawVisuals`：每个标记携带屏幕物理坐标、所属显示器边界与 DPI 缩放；传入的画布矩形指定全局原点，支持负坐标。靠边时向所在屏幕内翻并限制标签宽度，不移动尖端。第 9 轮新增 `MultiPointerOverlay`/`MultiPointerFrame`，通过 `UpdateLayeredWindow` 把同一组矢量箭头/光晕/标签呈现在整块虚拟屏上，扩展样式含分层、点击穿透、工具窗和不激活，不读取也不移动真实鼠标。
- `tests/desktopPointerRender.test.ts` 与 `tests/fixtures/pointer-render.cs` 通过 Windows PowerShell 5.1 编译并调用纯绘制函数，不运行 helper。14 个像素用例覆盖负原点、同帧不同 DPI、贴边尖端、同点标签、逐屏裁剪/显示器接缝、窄屏长标签、短屏箭头与无效屏幕等；实跑输出 `POINTER_RENDER_OK 14`。另在本轮用独立 PowerShell 进程对照旧单指针基线 `0e5841e`：4 档缩放 × 4 个翻转方向 × 2 种尺寸的位图大小和原始 PArgb 像素共 32 组一致；这是一次性比较，未做成仓库内可重复自动测试。
- tests/mcp.test.ts 修改 CLI 子进程使用临时用户目录，清除继承的 EVOCU_AUDIT_DIR、EVOCU_ACTIVITY_FILE、EVOCU_APPEARANCE_FILE、EVOCU_POLICIES_FILE、DSH_PROFILE_DIR，并以 --no-overlay --no-inbox 启动。隔离副本中的该 MCP 文件单测此前为 7/7 通过。
- 在独立临时副本执行 `npm run typecheck`、`npm run build` 和 `npm test`，未在活动 Junction 构建：typecheck/build 均退出 0；全量 223 项中 221 通过、0 失败、2 跳过。跳过项为需真实 Edge 和微信窗口的 opt-in 测试（`ECU_EDGE_TEST` / `ECU_DESKTOP_TEST`）。调整后的录屏单项测试通过 8 次重复复跑。首轮全量曾因 `tests/desktopRecording.test.ts` 把异步录屏首帧精确断言为 1 而失败（实得 3）；夹具使用 1ms 虚拟秒，录屏会在返回后继续采帧。现仅断言已采到至少一帧；后续“仍在录制”状态检查与最终 61 帧检查仍覆盖及时返回和完整录制，避免依赖并行负载下的帧数时序。
- `git diff --check` 通过。当前分支 cyble，HEAD 0e5841e；本记录不提交变更。

## 第 9 轮：真实活动 Desktop 多指针视觉覆层（2026-11-25）

- 旧实现是 180×30 的彩色 WinForms 文字标签；本轮完全移除。`scripts/multi-pointer.ps1` 现在编译同目录 `windows-takeover.cs` 并调用 `[DshTakeover.MultiPointerOverlay]::Run(statePath, logPath)`。
- 覆层入口 `MultiPointerOverlay.Run` 创建 `MultiPointerFrame`：按 `SystemInformation.VirtualScreen` 建一个与虚拟屏同尺寸的 32bppPArgb 分层窗口，扩展样式 `0x80000 | 0x20 | 0x80 | 0x08000000`（分层、点击穿透、工具窗、不激活）。每次状态变化用 `PointerFrame.DrawVisuals(visuals, screen)` 画全部指针，再 `UpdateLayeredWindow` 呈现；空列表隐藏。它不读取或移动真实鼠标，也不接收输入。
- 真实 DSH Desktop（主进程 10800，GUI http://127.0.0.1:6958，profile `C:\Users\freezingcold\.dsh\profiles\desktop\cordis.patch.yml`）加载活动插件 `D:\evolution-computer-use\probes\desktop-multi-pointer\index.mjs`。本轮派出 `cursor-demo-1/2/3` 三个直接子 Agent，state 文件出现 p4/p5/p6（Agent 4/5/6，粉/紫/青）；helper PID 16348 日志依次记录 `items=3 visuals=3 allowCapture=False`、`presented 3 visuals visible=True`，结束后 `items=2 → 1 → 0` 并隐藏。
- 截图证据：`docs/design/acceptance/2026-11-25-round9/real-dsh-three-cursors.png`（2560×1440 全屏，三枚矢量鼠标箭头和 Agent 4/5/6 标签压在实际桌面之上；为让 CopyFromScreen 能拍到分层窗口，本次截图 helper 临时以 `DSH_MULTI_POINTER_CAPTURE=1` 启动，生产 helper 保持截图排除）。helper 日志与状态摘录见同目录 `helper.log`。
- 验证命令：`npm run typecheck` 退出 0；`npm test` 245 项、243 通过、0 失败、2 跳过（skip 为需真实 Edge/微信的 opt-in 项）；`npm test -- tests/desktopMultiPointer.test.mjs` 5/5；`npm test -- tests/desktopPointerRender.test.ts` 输出 `POINTER_RENDER_OK 14`。
- 仍未验证：指针尚未随各 Agent 的桌面动作更新坐标（当前空闲锚点围绕真实鼠标分开展示）；未接多 Agent 输入路由、窗口级仲裁、真实鼠标回收、混合 DPI/多显示器/负坐标实屏，也没有嵌套孙 Agent 覆层证据。

## A1–A7 验收状态

| 项 | 状态 | 依据 / 尚缺 |
| --- | --- | --- |
| A1 派出与常驻 | 身份通过，常驻/回收部分通过 | 第 8 轮真实隔离 Desktop 已派出 3 个直接子 Agent 与 1 个嵌套孙 Agent，全部核对到同一根身份；第 9 轮在真实活动 Desktop 中 3 个直接子 Agent 存活期间各登记一枚指针，Agent 结束依次从 3 减到 0，但真实鼠标采样、嵌套孙 Agent 覆层与完整回收仍待验证。 |
| A2 视觉与回收 | 真机覆层部分通过 | 第 9 轮真实活动 Desktop 截图确认三枚矢量鼠标箭头、光晕和名称/颜色标签（非文字标签），窗口点击穿透、不激活；仍缺每个指针随各自桌面动作移动、真实鼠标回收、混合 DPI 实屏和多显示器/负坐标证据。 |
| A3 路由与隔离 | 身份绑定部分通过，路由未通过 | 第 8 轮原生工具调用已取得并核对可信 caller；stdio 仍不接收 caller，且无 per-Agent 窗口、截图、坐标及句柄代际隔离。 |
| A4 实际并行与顺序 | 未通过 | 仅已知单控制器串行；没有独立窗口的执行端重叠证据。未证明时只能串行。 |
| A5 不干扰与拒绝 | 未完成 | 旧 Java Swing 后台点击不生效的事实支持拒绝而不回退；本轮没有 Desktop 实鼠标/前台窗口验收。 |
| A6 停止与恢复 | 未验证 | 未对多 Agent 队列/取消/超时/重启实施测试。 |
| A7 回归与 Desktop | 部分通过 | 第 9 轮活动 Desktop 覆层实跑；typecheck 退出 0，全量 245 项中 243 通过、0 失败、2 个 live 环境 opt-in skip，多指针测试 5/5、离屏像素测试 `POINTER_RENDER_OK 14`。单 Agent 桌面操作、思考窗/审计窗及策略仍待回归。 |

## 隔离 Desktop P1 候选探针

主包根入口（`evolution-computer-use-win`）接受 `toolTransport: native-probe`，让宿主在插件作用域内加载同一份[原生探针](../../probes/desktop-agent-identity/index.mjs)，不加载 MCP 桥、不启动 stdio 子进程、不接入输入或覆层。默认 bundle 与 MCP 兼容行为不变。隔离验收配置只加载包根入口，不加载设置页插件，也不同时加载同名工具的独立探针包。

探针通过宿主原生工具注册 `ecu_pointer_identity_probe`（空对象参数），不用现有 stdio 桥，不接输入或覆层。仅以宿主的 `exec.agent`、`agents.get(id) === agent` 以及实时核验的 `subagents.rootOf(caller)` 为依据。匿名编号只在本次加载内有效；创建与销毁按同一活对象关联，销毁列表只回显同一 Agent 树最近已核验的 32 项。根 Agent 若在加载前已创建，不能以 `callerCreatedObserved: false` 推断事件丢失。

[离线测试](../../tests/desktopAgentIdentityProbe.test.mjs) 当时 8/8 通过（第 7 轮扩为探针+插件入口 14/14），覆盖原生契约形状的夹具、伪造/过期对象、同 ID 新对象、树隔离、取消、卸载和激活失败回滚。独立 `node --check` 与离线包清单检查通过。探针未装载进任何 Desktop 会话；离线测试不证明真实宿主注册、审批、投影或取消生效。 主包入口测试 5/5 通过；typecheck、build、npm 打包清单检查，以及编译后入口的只读分支冒烟测试均通过。

实际主包归档（`evolution-computer-use-win-0.4.3.tgz`，SHA256 `D62CD996AEB389D4604AAABA08838322F0F2C230FFEE0E7EA6BBE4A1D7672E6E`）解包后通过入口冒烟；在 Desktop 随附的 Electron 纯 Node 模式内，使用 Cordis 4.1.0 和模拟服务验证挂载、原生注册、同根区分、卸载清理以及旧工具拒绝调用。相关回归 46/46 通过。该归档仍带默认 bundle，不能直接启用作隔离验收。

## 真机隔离启动记录（2026-11-25）

- 真实 Electron Desktop 0.2.2-rc.5 使用独立 `DSH_HOME` 和 `--user-data-dir` 启动；通过进程树和监听 PID 核对，桌面窗口及回环后端未复用活动实例。未修改活动 profile 或 DSH 安装，未发送鼠标键盘输入。
- 本版 Desktop 后端读取 `$DSH_HOME/profiles/desktop/cordis.patch.yml`，不会从 `$DSH_HOME` 根目录读取这次的 profile patch。把指向构建入口的 `file:` URL 和 `toolTransport: native-probe` 放进隔离 profile 后，宿主能启动；启动成功不是原生注册的证据。
- 插件清单请求未发出：查询时未能从增量作业输出重新取得当次启动记录。因此第 3 轮没有取得 Loader 已激活、工具已注册或真实 Agent 调用的回执，当时 P1 未通过（第 8 轮已通过）。这次实验停止在只读阶段，没有接入生产路由。
- 第 4 轮只更新[原生探针](../../probes/desktop-agent-identity/index.mjs)：两个生命周期监听和原生工具成功注册后，向标准输出写 `[ecu-native-probe] registered tool=ecu_pointer_identity_probe schemaVersion=2 pid=<后端 PID>`。回执不含凭据、Agent ID 或会话数据，不依赖清单请求。核对 Desktop 0.2.2-rc.5 的后端启动器源码确认其转发子进程标准输出（`lib/main.js:11808`）；尚未在真实 Desktop 捕获这条回执。探针测试 9/9、插件入口测试 5/5：注册抛错不发回执，成功只发一条。使用旧归档的编译入口和更新后的探针，在 Desktop 随附 Cordis 的纯 Node 环境离线复测，确认回执、调用及注销均通过；服务仍是模拟的。此次没有重启隔离 Desktop。

## 第 7 轮：真实隔离 Desktop 注册验收（2026-11-25）

- 用户明确授权一次性隔离 Desktop 后，使用第 6 轮验收包运行；全程未发送鼠标或键盘输入，未修改活动 profile、DSH 安装或生产路由。
- 前三次启动均停在 `stopped-after-no-receipt`。逐步追踪定位到真实宿主 schema 校验拒绝：`EFFECT ERROR JsonSchemaError: unsupported JSON schema: schema.properties.recentDisposedOrdinals.maxItems is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`，位置 `@deepseek-ai/dsh-tools/lib/shared-DGx6D7zk.js:340` / `lib/index.js:437`。根因是探针输出 schema 使用了宿主不支持的 `maxItems`；旧测试的 mock `tools.register` 不校验 schema，故离线全绿。
- 修复：[原生探针](../../probes/desktop-agent-identity/index.mjs) 删除该字段（代码仍以 `RECENT_DISPOSALS = 32` 截断）；[探针测试](../../tests/desktopAgentIdentityProbe.test.mjs) 增加宿主子集关键字白名单并递归检查 `parameters` 与 `output.schema`。探针与插件入口测试 14/14 通过，`npm run build` 通过。
- 重新 `npm pack`：`evolution-computer-use-win-0.4.3.tgz`，SHA256 `4C9C327E23F00F236678DBDD74A7D5F12D28310F27F68EF64755B2B1555D9592`，124 个文件；用它重建 `isolated/` 后干净启动（无追踪补丁）。
- 启动结果：`status=registered`，childPid 35588，backendPid 40380；日志中唯一回执为 `[ecu-native-probe] registered tool=ecu_pointer_identity_probe schemaVersion=2 pid=40380`。`verify.ps1` 输出 `pass:true`：recordStatus=registered、有 backendPid、backend 属于本次进程树、回执恰好 1 条、唯一回环监听端口 10446。随后 `stop.ps1` 确认进程已结束并记录为 `already-stopped`；脚本原先在给 `ConvertFrom-Json` 对象新增属性时抛错，已改为显式构造记录并重跑通过。
- 证据边界：这条回执证明插件入口在真实 Desktop 中加载并完成原生工具注册，不等于工具已对任何 Agent 可见；本轮没有创建根/子/孙 Agent，未验证 `exec.agent`、`agents.get`、`subagents.rootOf` 的真实归属、审批、取消或结果投影。第 7 轮 P1 身份门槛仍未通过（第 8 轮已通过），不能据此启用多 Agent 路由。
- 验收包 README 已把“不含任何凭据”修正为“不含主 profile 凭据；应用启动自动生成匿名标识与本地凭据文件”，并记录本次运行结果。

## 输入收尾门槛（第 5 轮，离线）

- 发现：`src/desktop/driver.ts` 的调用超时后立即 `target.end(); lost(...)`，下一笔会启动新 helper 并写入请求，不等旧 helper 的退出事件。用内存流替身替换 `child_process.spawn` 的离线诊断（不启动任何进程）复现顺序：`terminate-requested` → `spawn 2` → `received 2` → `exit-observed 1`，即新 helper 在旧 helper 确认退出前就收到了同窗口请求。这违反规格第 7 条“未确认旧操作收尾前，不放行冲突输入”。
- 修复：超时后记录旧连接的真实退出 Promise（`retiring`）；`call()` 在 `retiring` 未完成时不走快速路径，而由 `acquire()` 等待退出；`deps.retireMs`（默认 `RETIRE_MS = 5000`）内仍未退出则拒绝该笔（`…还没有确认退出，暂不发送新的输入`），既不发送也不替换；退出事件到达后下一笔才启动新 helper。`running()` 仍在超时后立即为 false，fault 照旧记录。
- 回归：`tests/desktopDriverRetirement.test.ts` 2 例（退出后才替换；永不退出则拒绝且不替换），沿用内存流替身，只 mock `child_process.spawn`，退出由测试显式触发；连同 `tests/desktopDriver.test.ts` 5 例共 7/7。全量 `npm test` 234 pass / 2 skipped / 0 fail，`npm run typecheck` 通过。
- 限制：只覆盖同一驱动实例内的串行收尾；跨驱动、多 Agent 共享同一窗口的互斥仍依赖 P1 可信身份与执行端排他，未验证。真实 PowerShell helper 从 `kill()` 到 `exit` 的时延本轮未实测（未启动真实 helper）。

## 隔离验收包（第 6 轮准备，离线）

- 在工作区 `.tmp-isolated-accept-<时间戳>/` 生成可直接执行的验收包，未启动任何 Desktop、未发送输入、未改主 profile 或安装：
  - `isolated/`：由最新 `npm pack`（`evolution-computer-use-win-0.4.3.tgz`）解包，含 `lib/`、`probes/desktop-agent-identity/index.mjs`、`src/desktop/win32.ps1`。
  - `home/`：最小 DSH_HOME（无凭据），`profiles/desktop/{cordis.yml,package.json,pnpm-workspace.yaml,cordis.patch.yml}` 与顶层 `cordis.patch.yml`；仅插入 native-probe 入口，指向本包 `isolated/lib/index.js`。
  - `launch.ps1`：`-DryRun` 只打印 exe/参数/目录/日志路径；正式运行先写 `launch-record.json`，再启动并轮询日志等待唯一注册回执；超时无回执会自动结束本包启动的进程树。`stop.ps1` 先校验 exe 路径与启动时间再结束进程树。`verify.ps1` 核对 status=registered、backendPid、回执仅 1 条、backend 属于本次进程树、仅 1 个回环监听。
  - `cordis-smoke.cjs`：Electron 纯 Node 加载本包 isolated 入口。
- 离线已通过：三份脚本 `Parser::ParseFile` 语法解析、`launch.ps1 -DryRun` 输出正确、`cordis-smoke.cjs` 打印 `[ecu-native-probe] registered tool=ecu_pointer_identity_probe schemaVersion=2 pid=<pid>` 并通过挂载/同根/卸载断言。tarball SHA256 `D8ECE15D70A4A9757752E43B7C96190AD1D2B0B6CD717738CD7CB87DB22F685D`。**尚未运行真实 Desktop，等待一次性授权。**

## 第 8 轮：严格多 Agent 身份 P1 通过（2026-11-25）

- 用户选定严格验收口径（m17165）：必须在真实隔离 Desktop 中同时派出至少两个直接子 Agent 与一个嵌套孙 Agent，根不额外标记（R13）。本次沿用隔离 kit `.tmp-isolated-accept-2026-11-25T2018/`，只改 kit 内 `home/` 与 `profiles/desktop/cordis.patch.yml`，未改主 profile、安装路径或生产路由，未发送鼠标键盘输入。
- 首轮因宿主 `@deepseek-ai/dsh-subagent` 默认 `maxDepth: 1` 失败，唯一未过项为 `nested-grandchild-verified`；agent-gamma 原文输出 `Delegation depth for 'subagent': current 1, maximum 1, remaining levels 0. Do not call 'subagent' at this depth.` 在 kit 两份 patch 中为该插件增加 `maxDepth: 3`、`maxActiveSubagents: 8`，组合检查（Cordis `composeEntries`）无警告且配置生效后才重试。
- 首轮 `stop.ps1` 因把记录中的正斜杠 exe 与 `Get-Process.Path` 的反斜杠直接比较而拒绝结束；改为 `[System.IO.Path]::GetFullPath` 后按 `OrdinalIgnoreCase` 比较，旧实例正常停止并释放端口。`launch.ps1` 拒绝复用“有启动记录但无报告”的 kit，归档首轮记录后重新启动。
- 第二轮真实运行：childPid 7556，backendPid 22636，注册回执 `[ecu-native-probe] registered tool=ecu_pointer_identity_probe schemaVersion=2 pid=22636`，唯一回环监听端口 4837，启动 12:30:18Z、注册 12:30:22Z，报告 `status=pass`（12:30:21.995Z–12:30:30.979Z）。
- 身份结果：根 `f9c0468e-f4ea-4dc4-a967-5b630076b63a`，`origin=null`、`delegationDepth=0`、`parentSession=null`、`live=true`。直接子 Agent：`agent-alpha` `d8a9f5c0-233b-49a7-a2b5-7a69c94b9458`（callerOrdinal 3）、`agent-beta` `d789885b-e15f-4ec0-8918-d1e2dca42aaa`（ordinal 2）、`agent-gamma` `7751c4c1-93ce-42f4-b53c-4c3424a87d5f`（其自身探针 ordinal 4），三者均 `depth=1`、`origin=subagent`、`parentSession=rootId`、`verdict=verified`、`rootIsCaller=false`。嵌套孙 `agent-delta` callerId `70e70db8-2bd0-4610-8e4c-7fb39cb4632c`，`delegationDepth=2`、`parentSession=agent-gamma`、`verdict=verified`。
- 检查项 5/5 通过：`root-is-top-level`、`two-direct-children`（实为 3 个直接子）、`direct-children-verified`、`nested-grandchild-verified`、`all-calls-share-root`；`identity.jsonl` 共 4 条记录（callerOrdinal 2/3/4/5，rootOrdinal 1），所有 `rootId` 相同。`verify.ps1` 退出 0、`pass:true`，核对 recordStatus=accepted、backend 属于本次进程树、回执恰好 1 条、唯一回环监听 4837、报告存在且全部检查通过。
- 证据边界：本轮只证明原生工具在真实根/子/孙 Agent 调用路径可见，且 `exec.agent` 已通过 `agents.get(id) === caller` 与实时 `subagents.rootOf(caller)` 核对；不证明生产桌面工具已逐请求绑定 caller、窗口级输入仲裁、指针常驻与回收、审批/取消/结果投影。用户确认完成后已由 `stop.ps1` 停止（status=stopped，12:35:33Z），端口 4837 与进程均已释放。归档报告、身份证据、启动记录、脱敏日志与运行脚本见 [acceptance/2026-11-25-round8](./acceptance/2026-11-25-round8/README.md)。

## 下一步与停止条件

1. （第 8 轮已完成：严格多 Agent 身份 P1 通过，见上节。）重跑时直接使用本 kit 的 `launch.ps1` 与 `verify.ps1`；`verify.ps1` 须以 `pass:true` 退出，并核对 `accept-report.json` 的 5/5 检查。单次 `verdict: verified` 只证明当次活对象与根身份，不单独构成 P1 完成。
2. P1 后续：A1 仍需验证常驻指针、真实鼠标位置采样与子 Agent 回收；A3/A4/A6 仍需验证生产工具逐请求可信绑定、窗口级串行仲裁、取消与不确定结果；A2/A5/A7 仅有部分离线证据，仍需真机验收。
3. 停止已调用探针的 Agent，确认根下一次调用观察到相同编号被回收；如宿主支持恢复，再证明新活对象拿到新编号。分别核对审批拒绝、取消与 Native/PTC 结果投影；卸载后确认工具和监听不再生效。
4. 未达成上述条件前，不启用并行输入，不接入生产多指针覆层；隔离实例在用户确认任务完成后由 `stop.ps1` 停止，并清理端口与临时目录。
