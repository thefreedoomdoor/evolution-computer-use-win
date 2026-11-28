# cyble 分支实施清单（详细待办 · 计划文档）

> 版本 v1.4 ｜ 2026-11-26 ｜ 分支 cyble（基线 0e5841e，见 docs/design/multi-agent-virtual-pointers-spec.md:3）｜ 状态：已纠正演示验收口径；S0 仅局部代码与脚本渲染测试；真实多子 Agent 操控功能验收未通过；S1–S6 未实施
> 一句话结论：十指针轨迹由代码计算，不是真实子 Agent 通过操作工具产生，因此本次演示不能通过操控功能验收。已完成的仅为 **三角底边 +25% 与补间目标 60fps** 的局部代码及脚本渲染测试；真实 Agent 身份和实屏录像不能替代操作证据。正式输入闭环（可信身份逐请求绑定、窗口级跨进程 HWND 串行、目标上下文隔离、真实动作驱动的指针、可靠收尾、发布/安装）仍待实施和验收。

> 历史快照说明：本文件保留 2026-11-26 的计划及演示验收纠正，不代表后续生产实现仍未编写。后续分工、独立回归及未完成的真机验收见[当前实施账本](<cyble-multi-mouse-implementation-plan.md>)；其中 `artifacts/`、`reports/` 引用均为未提交的本机证据，未随仓库或 npm 包交付。

本文件按 system-impl-plan 技能组织：先冻结需求契约与现状证据，再给阶段化可执行清单、候选落点、依赖、完成标准、A1–A7 验收矩阵、风险/回退与推荐顺序。**不编造 API、不承诺工时**；所有对宿主/依赖的引用均来自工作区已有文档或代码，未能实查处标注「未验证」。本文的 R1–R12 是分支需求编号，并非 PROJECT-CARDS.md 中同名设置 ID；引用项目规则时均写「项目 R…」。代码行号为审查时快照，后续修改可能偏移，优先按文件与符号定位。

---

## 0. 作用域冻结与本轮局部实现

### 0.1 本轮唯一允许的实施范围（需求冻结）

| 项 | 内容 | 状态 |
|----|------|------|
| 本轮实施 1 | 三角指针底边 +25%，保持尖端与高度不变；入口 scripts/windows-takeover.cs 的 TrianglePoints / MinimalTrianglePath / DrawArrow | 子 Agent 编码、主 Agent 集成；顶点与 15 项像素回归已验证 |
| 本轮实施 2 | 补间目标 60fps：MultiPointerAnimator、绝对单调 deadline、MultiPointerFrame 与持久 DIB | 编码、离线回归和脚本驱动渲染实录已完成；不构成真实操控验收；严格逐像素每帧未通过 |
| 不实施 | 生产可信身份绑定、跨进程 HWND 仲裁、动作驱动指针、发布集成、A1–A7 真机验收等全部后续项 | **本轮为计划，不写代码** |

> 说明：绘制层区分调度目标与实际呈现；速率须由成功提交 trace 与实录像素分别核验。提交成功不等于硬件扫描，不能用理论值或视频元数据代替。

### 0.2 保留的历史成果（不得回退）

- **F1（仅绘制能力）**：多指针为白边半透明三角，尖端物理坐标锚定，支持跨屏裁剪、混合 DPI；入口 scripts/windows-takeover.cs 的 MinimalTrianglePath / DrawArrow / MultiPointerOverlay。tests/desktopPointerRender.test.ts 当前为 POINTER_RENDER_OK 15；verification.md 的 14 项是旧版历史。artifacts/multi-pointer-demo-20261126-1300/ 仅保存绑定真实 Agent 标签的脚本渲染实录，已撤回真实操控通过结论。
- 上述是**绘制与纯视觉演示**证据，**不等于**正式输入链完整；本清单所有后续阶段必须保住它，不得为做输入而破坏绘制/覆层行为。

---

## 1. 配置快照与假设（10 维归一化）

| 维度 | 取值 | 来源 / 说明 |
|------|------|-------------|
| 目标与验收 | 让同一 DSH Desktop 会话树的子 Agent 共享一台 Windows 电脑，各自可见虚拟指针；输入按窗口安全仲裁 | 用户需求 + spec.md:8-10 |
| 现状 | 绘制/视觉演示与身份探针已具备；生产输入未闭环 | 第 3 节证据台账 |
| 范围 | 见第 0 节本轮实施 + 第 2 节 R 表；其余为计划 | 任务描述 |
| 时间 | **无硬节点**（假设）；不承诺日历工期 | **假设** |
| 人力 | 主 Agent + 子 Agent 并行（假设）；不承诺人天 | **假设** |
| 预算 | 零 license，复用现有栈（假设） | **假设** |
| 技术约束 | Node>=22.16、ESM、TypeScript→lib（项目 R1/R2）；历史身份探针验收使用 DSH Desktop 0.2.2-rc.5，新正式验收须另记实际版本 | PROJECT-CARDS R1/R2、verification.md:10 |
| 平台 | Windows 上的 DSH Desktop，非 DSH Web；普通交互桌面，不含 UAC/安全桌面/独占全屏 | spec.md:27 |
| 必须集成 | 宿主原生工具上下文 tools/agents/subagents；现有 stdio MCP 桥 | plugin.ts:80-104 |
| 运维 | 隔离验收实例用完即停、清端口（R12/R15） | PROJECT-CARDS c3/c4 |

**需重点确认的假设**：
1. 无硬节点——若不成立，先按第 8 节关键路径重排，应重排交付批次并明确未完成项；不能删除 S5/S6 的必需验收门槛。
2. 人力为假设且不承诺人天——本文件只给顺序与依赖，不给工期数字；若需排期需另行评估。
3. 验收必须在真实隔离 Desktop（R13）——若无法获得一次性授权，只能做离线/源码核查，A1–A7 记为未验证。

---

## 2. 需求契约（冻结，覆盖 M 项为红线）

| ID | 要求 | 类型 | 验收标准 | 优先级 |
|----|------|------|----------|--------|
| R1 | 正式工具执行入口取得**可信 caller**，身份与每笔请求绑定后传到控制器；派出/终止/恢复经宿主生命周期识别同一 Agent（spec.md:34） | 功能/集成 | 真实隔离 Desktop 根/子/孙交错调用正确归属，无法确认身份 fail-closed 不回退根（A3） | M |
| R2 | 派出即登记、常驻、回收：直接与嵌套子 Agent 都登记，根不登记；出生采样真实鼠标，回收回当前真实位置（spec.md:35） | 功能 | A1/A2 通过 | M |
| R3 | 每个 Agent 独立持有窗口选择/截图/缩放/坐标基准，动作入队绑定目标，执行前复核句柄与视口（spec.md:37） | 功能 | A3 通过 | M |
| R4 | 窗口级仲裁：同一窗口按到达顺序串行（含前台/后台路径）；冲突范围合并（子控件/所有者/弹窗）；整段点击/组合键/拖动作完整体；仅证实隔离的后台可并行（spec.md:38） | 功能/非功能 | A4 通过；同窗不交错 | M |
| R5 | 全局排他与降级：前台/共享焦点/剪贴板/模式切换走共享排他；不确定即串行输入、指针仍显示（spec.md:39） | 功能 | A5 串行降级可证、指针仍可见 | M |
| R6 | 停止/拒绝/恢复：排队取消不发送；运行中安全收尾，超时不等于已停；未确认收尾不放行冲突输入；已投递或不确定不自动重放；重连拒绝旧代（spec.md:40） | 功能 | A6 通过 | M |
| R7 | 视觉与坐标：名称/颜色稳定、重叠可读、覆层点击穿透不抢焦点、多显示器/混合 DPI/负坐标同一转换（spec.md:36） | 功能 | A2 通过 | M |
| R8 | 不干扰与拒绝：后台不动真实鼠标/不抢焦点；不兼容应用失败即停；前台仅授权后执行（spec.md:44） | 非功能/合规 | A5 通过 | M |
| R9 | 结果与审计：区分排队/已执行确认/已投递未验证/拒绝/取消/不确定；审计归属正确 Agent 与目标窗口；动画不记成真实操作（spec.md:21-23） | 功能 | 各阶段结果与输入日志一致 | M |
| R10 | 回归：typecheck + build + npm test + DSH Desktop 覆层/单 Agent/思考窗/审计窗/策略不回退（spec.md:58 A7） | 交付物 | A7 通过 | M |
| R11 | 保留 F1 绘制/覆层能力与 10 Agent 视觉演示不回退 | 回归 | tests/desktopPointerRender.test.ts 通过、覆层可见 | S |
| R12 | 本轮局部：底边 +25%、补间目标 60fps（主 Agent 实测帧率） | 功能 | 真机肉眼与 trace 帧率、几何不破坏尖端锚定 | M（本轮） |

**明确不做**（防范围暗涨）：不实现多套 Windows 真实输入；不用动画驱动系统鼠标；后台失败不自行切前台、不改用 shell/CLI/脚本/DOM 兜底；不扩展到安全桌面/独占全屏；不改宿主安装/配置规避身份或审批；不硬编码凭据/不引入额外权限；不覆盖他人工作、不擅自提交/推送（spec.md:60-65）。

---

## 3. 现状证据台账（严格区分：已实际通过 / 仅离线或静态 / 未测）

### 3.1 已实际通过（真机或归档实测）

- **P1 可信身份（历史通过，但是只读身份探针，不是生产桌面工具）**：真实隔离 DSH Desktop 0.2.2-rc.5，3 直接子 + 1 嵌套孙，5/5 检查通过（docs/design/acceptance/2026-11-25-round8/README.md:4-7、24-27；verification.md:102-110）。权威边界见 round8/README.md:31 与 verification.md:110：**只证明原生命令在真实根/子/孙路径可见、exec.agent 经 agents.get(id)===caller 与实时 subagents.rootOf(caller) 核对；不证明生产桌面工具逐请求绑定、窗口级仲裁、指针常驻回收、审批/取消/结果投影。**
- **F1 三角绘制与十指针脚本渲染记录**：仅绘制层已验证，不能作为多 Agent 操控通过项；见第 0.2 节与 artifacts/multi-pointer-demo-20261126-1300/。
- **单驱动退休收尾（局部安全原语，非 FIFO）**：verification.md:86-91；代码 src/desktop/driver.ts:139-149（acquire 在 retiring 未完成时等待其真实 exit，retireMs 内未退出则拒绝「…还没有确认退出，暂不发送新的输入」）。**限制明确：只覆盖同一驱动实例内的退休收尾保护；跨驱动、多 Agent 共享同一窗口的互斥仍依赖 P1 身份与执行端排他，未验证（verification.md:91）。**

### 3.2 仅离线或静态证据（不构成 Desktop 实机验收）

- 身份探针单测 tests/desktopAgentIdentityProbe.test.mjs（mock 宿主成员/伪造对象/同 ID 新对象/树隔离/取消/卸载回滚）；verification.md:65 记录当时 8/8，后扩 14/14。该段记录的是早期离线阶段；后续真实 Desktop 探针验收见第 3.1 节。**离线测试本身不证明真实宿主注册、审批、投影或取消；后续探针通过也不等于生产输入链通过。**
- 退休单测 tests/desktopDriverRetirement.test.ts:43、64（mock spawn、60/40ms 超时、2000/80ms 退休等待），只 mock child_process.spawn，退出由测试显式触发——不证明真实 PowerShell helper 的 kill→exit 时延（verification.md:91）。
- 多指针单测 tests/desktopMultiPointer.test.mjs：root 筛选、直接+嵌套 origin、label 与脚本源码绘制断言，不是动作跟随 E2E。
- 离线验收脚本 tests/desktopMultiAgentAcceptance.test.mjs 是 fixture 包装，不代实机。

### 3.3 未测 / 未通过（正式输入闭环缺口）

- **生产可信身份逐请求绑定**：未通过。宿主确有 ToolExecutionInput.agent 与 tools.execute({...agent:this})（verification.md:11），但已安装 MCP 桥 @deepseek-ai/dsh-mcp-client@0.2.2-rc.5 只转发 name/arguments/signal/timeout，不传 execution.agent（verification.md:12）；src/plugin.ts:90-104 默认走 stdio 桥；src/mcp/server.ts:12 的 McpTools.call 形状为 (name,args,signal)，无 caller；src/desktop/driver.ts:38/:164 的驱动与 call 也没有 caller/AbortSignal 上下文，helper 只收 {id,op,args}（driver.ts:136）。**这是硬缺口，不能用模型参数/展示名/调用顺序/统一填根来补（spec.md:62）。**
- **窗口级跨进程 HWND 串行**：未通过，且有反例。docs/design/acceptance/2026-11-25-concurrency/README.md:34 记录：两个独立 stdio 服务附着同一记事本窗口、各写 300 个 A/B，UI Automation 读出 **599 个 A/B 连续段**（逐字符交错），:35 结论为「同一窗口的并发输入没有窗口级串行化…跨进程没有共享的 hwnd 级锁/仲裁器」。:25-28 的 1152ms 重叠是**不同窗口的键盘文本**并行（无鼠标、无同窗），:54-57 明确同窗串行不成立是本轮最重要风险。
- **目标上下文共享**：未通过。src/desktop/desktop.ts:76-80 注释与 :96 的单一 window/view/shots、:100 的单一 known/acted；src/computer.ts:76 单一 desktopUse、:80-82 单一 activeMode/activeFor——都是「一个当前目标、一次动作」，没有 per-Agent 目标/截图版本（spec.md:29、verification.md:19/22）。
- **动作驱动的指针**：未通过。probes/desktop-multi-pointer/index.mjs:1 明确「Read-only…never injects input」；:8-9 只注入 agents/subagents（无 tools）；:41-46 statePayload 只有 id/label/color/x/y；:94-106 新增 Agent 时 x:null,y:null；:125-128 只订阅 agent/created、agent/disposed；:129-140 卸载清理。**没有任何 desktop 动作/进度/结果事件驱动坐标的 hook，也没有出生采样真实 cursor、回收回当前 cursor 的正式状态机。**
- **生命周期/stop/权限/发布**：均未验收（verification.md:22、28、112-117；round8/README.md:31）。
- **driver 旧文档口径需更正**：verification.md:20 描述的是退休保护**修复前**「超时后不等待旧请求收尾」；当前代码 driver.ts:139-149 已等待真实 exit，务必以 :86-91 与代码为准，**且不得把此 guard 误写成 FIFO 或跨进程仲裁**。

---

## 4. 阶段化实施清单（按依赖顺序；每阶段给勾选项、候选落点、完成标准、验收、风险回退）

> 约定：候选「新建」文件是**计划落点，当前不存在**，实施前需复核命名与模块边界（PROJECT-CARDS R5 遵循现有边界）。每阶段完成标准都要求在隔离 Desktop 或对应离线测试中可判定，不接受「看起来对」。

### S0 · 本轮局部实现（底边 +25% / 补间目标 60fps）——仅代码与渲染层核验
- 依赖：无；只改几何、动画/调度、验收编排，不扩生产输入链。
- 当前落点：scripts/windows-takeover.cs 的 TrianglePoints / MinimalTrianglePath（几何）、MultiPointerAnimator.Sync / Advance（200ms 补间）、MultiPointerFrame.RequestFrame / Tick（调度）、EnsureSurface / Present（持久 DIB 与成功提交 trace）；演示编排 scripts/multi-pointer-showcase.mjs。
- 细化勾选项：
  - [x] 底边长度 +25%，尖端与底边中点/高度不变；15 项像素回归通过。
  - [x] 60fps 目标调度、持久 DIB、连续 retarget 前采样旧运动；动画回归 POINTER_ANIMATION_OK 15。
  - [x] 白边泛光/半透明、尖端锚定、跨屏裁剪与混合 DPI 离线回归通过；不冒充所有显示器实机均通过。
  - [x] 脚本驱动的实屏渲染提交节奏与像素分层核验；不挑快速片段，不将静止 hold 误报掉帧。运动提交 59.992fps；中心高速窗口每帧均产生不同画面，像素停顿最长2帧。仅是渲染证据；严格逐指针每帧像素检测未通过。
  - [ ] 真实多子 Agent 操控验收：每个 Agent 实际调用操作工具，保留应用响应及同一 Agent 指针/审计的关联证据；不能由统一脚本生成轨迹代替。本项记录未完成验收，不表示本次新增实施。
- 渲染层核验标准：目标 60fps，报告实测分布与限制；持续 retarget、像素/F1 回归均通过。提交与实录各有证据；54fps 是分析器拒绝下限，不把 54fps 宣称成 60fps。上述渲染检查不能关闭真实操控验收项；真实操控须有 Agent 操作工具调用 → 应用实际响应 → 该 Agent 指针与审计关联的完整证据。
- 验收：第 9 节逐轮记录，共同 wall 时钟对齐；旧数据缺锚点则标不确定。
- 风险/回退：不达标则定位实际运动间隔/冻结点，不放宽判据、不改变其他语义；保留失败轮次，不覆盖旧实录。

### S1 · 生产可信身份逐请求绑定 + 每 Agent 目标上下文（P0，后续全部依赖它）
- 依赖：S0 之外无（可并行立项，但必须先于 S2–S6）。
- 候选落点：
  - 身份入口：src/plugin.ts:80-104（当前 native-probe 只加载只读身份探针 return；MCP 分支无 caller）；src/mcp/server.ts:12（McpTools.call 无 caller）；src/desktop/driver.ts:38/:164（无上下文）、:136（helper 只收 id/op/args）。
  - 目标上下文：src/desktop/desktop.ts:76-100（单一 window/view/shots）；src/computer.ts:74-110（单一 desktopUse/activeMode）。
  - 新建候选（计划）：src/desktop/agentContext.ts（每活 Agent 的 window/view/shot 版本快照）；生产工具适配层（在原生工具注册处把 exec.agent 绑定为请求身份与 requestId）。
- 细化勾选项：
  - [ ] 生产桌面工具（非只读探针）获得宿主受支持的 exec.agent；未知/销毁 caller fail-closed，绝不回退根（spec.md:34）。
  - [ ] 每请求携带不可伪造身份 + requestId + signal 到控制器与 helper；不通过模型参数/展示名/顺序携带（spec.md:46）。
  - [ ] 建立 per-live-Agent 的窗口/视口/缩放/坐标快照，入队时绑定目标，执行前复核句柄复用与视口变化（spec.md:37 R3）。
  - [ ] 身份与目标不一致时明确拒绝并给 structured reason，不消费他人最近 open/shot。
- 完成标准：真实隔离 Desktop 至少 2 直接子 + 1 孙，生产 desktop 操作与 helper 日志逐请求对应；同名/ID 复用/伪造参数/销毁/取消均不能冒认；A/B 交替 open+shot 后并发坐标操作不串用目标。
- 验收点：A3（路由与隔离）；S1 自身回归：身份可见性复用第 8 轮 kit 的 launch/verify 但把对象从只读探针换成生产动作。
- 风险/回退：宿主无受支持身份扩展点 → 停止 S1 并报告契约缺口，不启用多 Agent 路由（spec.md:34、69）；不可用假实现代替。

### S2 · 窗口级跨进程 HWND FIFO 仲裁 + 全局排他 + 可靠收尾（P0）
- 依赖：S1（身份 + 目标上下文）。
- 候选落点：src/desktop/driver.ts:43（每实例 pending Map）、:123-138（send 立即 write）、:164-171（link 存在即 send）、:177-183（stop）；src/desktop/win32.ps1 单一 helper Run 循环（verification.md:19）。新建候选（计划）：src/desktop/arbiter.ts（按顶层 HWND + 窗口代际的权威队列/lease，跨 driver/stdio 进程共享）。
- 细化勾选项：
  - [ ] 受理时确定可追踪到达顺序；同窗（含前台/后台路径）按序执行，不被异步预检或优先级插队（spec.md:38）。
  - [ ] 冲突范围合并：子控件/所有者窗口/弹窗同一冲突范围；不因 HWND 数值不同就并行（spec.md:38）。
  - [ ] 整段点击、组合键、按下→释放拖动作完整动作串行；不同冲突范围且证实隔离的后台才并行（spec.md:38）。
  - [ ] 前台/共享焦点/剪贴板/模式切换走共享排他通道，与窗口级互斥，固定资源获取顺序（spec.md:39）。
  - [ ] 超时/断链不当作锁已释放：确认旧执行收尾后才放行；不能确认就拒绝且不重放（spec.md:40，driver.ts:139-149 仅单驱动原语，需扩展到跨进程）。
  - [ ] 所有能触发原生输入的入口（含 MCP stdio 与原生）都经过同一仲裁（spec.md:38 句末）。
- 完成标准：两个独立 stdio 进程/驱动对同一窗口长 type + click/drag 严格 FIFO、无逐字符交错（对照第 3.3 节 599 段反例归零）；异窗仅在证实隔离的后台路径展示真实执行端重叠。
- 验收点：A4（实际并行与顺序）；附回归：旧 helper 迟退出、SIGTERM 迟延、断链、句柄复用、目标销毁、模式切换。
- 风险/回退：跨进程仲裁器引入死锁或性能问题 → 先降级为「全局单服务串行」保底（spec.md:39 允许串行，指针仍可显示），再逐步放开已证实隔离的并行；不得为了并行牺牲同窗顺序（spec.md:64）。

### S3 · 真实动作驱动的指针 + 结果/审计投影（P1）
- 依赖：S1、S2（身份/目标/仲裁就绪才能把动作事件映射到指针）。
- 候选落点：probes/desktop-multi-pointer/index.mjs:1/:8-9/:41-46/:94-106/:115-140（当前只读、无 tools 注入、只 created/disposed）；scripts/windows-takeover.cs:2306-2437（MultiPointerFrame 呈现）。新建候选（计划）：src/desktop/pointerRuntime.ts（订阅正式动作的解析/执行/结果事件更新每 Agent 物理坐标；与 S1 目标转换共用一套映射）。
- 细化勾选项：
  - [ ] pointer store 接正式动作事件，区分排队预览 vs 执行中 vs 已确认 vs 已投递未验证 vs unknown（spec.md:21-23、R9）。
  - [ ] 视觉位置是绑定该 Agent/目标截图换算后的物理坐标；动画不冒充真实 input（spec.md:23、44）。
  - [ ] 输入排队时也能分别显示各 Agent 指向，但不表现成已点击（spec.md:36）。
  - [ ] 结果/审计关联 Agent lifetime/root/requestId/target 代际/queue-start-end/结果；日志只留排障所需，不写凭据或完整输入（spec.md:23、46）。
- 完成标准：真实 Agent 同时操作独立窗口时，指针与该 Agent 实际点击/drag 日志与截图对齐；未调用工具的活 Agent 仍可见；审计逐条可归属。
- 验收点：A3/A4 的指针侧、A1 的常驻；与 S4 合并出 A1/A2 真机。
- 风险/回退：动作事件粒度不足 → 至少做到「动作开始/结束」两态位置更新，明确标注未覆盖精确轨迹，不要伪造精确跟随。

### S4 · 生命周期 / 紧急停止 / 权限 闭环（P1）
- 依赖：S1（身份生命周期）、S3（指针状态）。
- 候选落点：src/computer.ts:89-101（stopForeground/stopDesktop）、:103-110（halt 通知）、:111 起 stop 事件→halt；src/desktop/driver.ts:177-183（stop failAll+end）；probes/desktop-multi-pointer/index.mjs:115-140（dispose/cleanup）。新建候选（计划）：pointerRuntime 的生命周期状态机（出生采样 cursor→登记→动作更新→dispose 回当前 cursor→移除）。
- 细化勾选项：
  - [ ] 派出即登记（不等首次工具调用、不阻塞创建）；直接+嵌套都登记，根不登记；思考/等待/空闲/普通工具不隐藏（spec.md:35）。
  - [ ] 出生采样真实鼠标分出指针；回收回回收时实时真实位置（鼠标在动用最新采样收尾），只移除该 Agent（spec.md:35）。
  - [ ] 排队取消不发送；运行中按取消点安全收尾，超时不等于已停；stop 撤销所有队列、禁止迟到回调复活/幽灵指针（spec.md:40）。
  - [ ] helper crash/重连拒绝旧代请求与标记，不接着跑旧队列（spec.md:40）。
  - [ ] 遵循按应用策略与紧急停止；前台仅授权后执行；后台不支持即停并说明（spec.md:40、44）。
  - [ ] 初始化失败/卸载/关闭/整覆层清理；重载与宿主存活核对不复活旧标记（spec.md:35）。
- 完成标准：A6 覆盖排队/执行中取消、紧急停止、超时、helper 重启、窗口失效，无错投/重复/残留按键/悬挂锁/成功误报；dispose 返回「当时」真实位置；stop 后无复活。
- 验收点：A6（停止与恢复）、A1/A2 生命周期部分、A5 权限/拒绝部分。
- 风险/回退：cursor 采样与覆层绘制竞态 → 采样与呈现解耦并加序，宁可不精确也不阻塞回收；权限路径不得绕过审批。

### S5 · 发布集成 / 安装卸载 / 打包（P2）
- 依赖：S1–S4 稳定后。
- 候选落点：package.json:27（已有 ./multi-pointer export）、:34-41（files 含 scripts、探针）；src/plugin.ts:80-104（仅 native-probe 身份或 MCP，无生产 desktop+pointer 统一接线）；src 中无对 probes/desktop-multi-pointer 的正式 import（已 grep）；verification.md:13（无正式安装/加载获批入口）。
- 细化勾选项：
  - [ ] 在正常安装/配置路径显式集成身份适配、仲裁、pointer runtime，避免只靠 profile 临时挂独立探针。
  - [ ] 保留 MCP 兼容路径，但明确其身份能力限制与拒绝规则（无 caller 时 fail-closed）。
  - [ ] 核对 npm tarball 实含 JS/脚本/资源；Windows Node>=22.16/ESM 与加载路径正确。
  - [ ] 安装/升级/热重载/停用/卸载均无重复工具/监听器/overlay/helper，不改主 profile（R12）。
- 完成标准：用用户授权的正式打包安装入口完成一次安装→启用→停用→卸载，工具/监听/覆层/helper 计数在每步前后一致，主 profile 未改。
- 验收点：A7 回归的打包/安装部分；版本与 SHA 记录进验收报告。
- 风险/回退：正式入口不可用 → 保持隔离 kit 验收但明确标注「未正式集成」，不得宣称已发布。

### S6 · A1–A7 隔离 Desktop 实机验收（P0 门槛，最后统一出表）
- 依赖：S1–S5（对应项）。
- 候选落点：复用 docs/design/acceptance/2026-11-25-round8/ 的 launch/verify/stop 脚本模式；新报告建议放 docs/design/acceptance/<新日期>/。
- 细化勾选项：
  - [ ] 环境：真实隔离 DSH Desktop，独立 DSH_HOME 与 --user-data-dir，未用主 profile/正式路径/生产路由；记录启动命令、端口、进程（R15）。
  - [ ] 逐项跑 A1–A7 并填「通过/失败/未验证 + 环境版本 + 关键观察 + 未覆盖限制」；自动化/源码核查/Desktop 实测分别标记（spec.md:71）。
  - [ ] 结束后 stop 并清理端口与临时实例；用户确认任务完成后删除临时实例（R12）。
- 完成标准：A1–A7 全 M 项有可判定结论；未验证项如实列出，不用推断代替实测（R16）。
- 验收点：A1–A7 全表（第 6 节）。
- 风险/回退：某轮失败（如 maxDepth 限制、stop 路径/斜杠比较等历史坑）→ 记录后修 kit 重跑，不改主安装（参考 verification.md:105-106）。

---

## 5. 模块与落点表（职责 / 边界「不做什么」）

| 模块/落点 | 职责 | 不做什么 | 现状 |
|-----------|------|----------|------|
| scripts/windows-takeover.cs:2076/2084/2202 | 三角路径、白边泛光、覆层呈现 | 不合成输入、不移动真实鼠标 | 已实现（F1） |
| scripts/windows-takeover.cs:2254（MultiPointerAnimator）/2341（MultiPointerFrame） | 补间动画、60Hz 帧调度与成功提交 trace | 不把目标帧率当作实测帧率；不注入输入 | 已实现：子 Agent 编码，主 Agent 集成验收 |
| probes/desktop-agent-identity/index.mjs | 只读身份核验探针（ecu_pointer_identity_probe） | 不做桌面输入、不注册生产工具 | 已实现（P1 用） |
| probes/desktop-multi-pointer/index.mjs | 生命周期视觉演示（created/disposed） | 不注入输入、不跟随动作 | 仅演示 |
| src/desktop/driver.ts:139-149 | 单驱动超时退休收尾 | 不是 FIFO、不跨进程仲裁 | 已实现（局部） |
| src/desktop/arbiter.ts（新建候选） | 按 HWND/代际的跨进程权威队列与 lease | 不做 UI、不决定权限 | 计划 S2 |
| src/desktop/agentContext.ts（新建候选） | 每活 Agent 目标/截图/坐标版本快照 | 不绘制、不注入 | 计划 S1 |
| src/desktop/pointerRuntime.ts（新建候选） | 动作事件→指针物理坐标 + 生命周期 | 不用动画驱动系统鼠标 | 计划 S3/S4 |
| src/plugin.ts:80-104 | 插件生命周期入口/桥接 | 不塞 caller 到参数、不绕审批 | 需扩生产链路 |
| src/mcp/server.ts:12 | 工具调用接口 | 目前无 caller 上下文 | 需评估扩展点 |
| src/desktop/desktop.ts:76-100 / src/computer.ts:74-110 | 控制器共享状态/停止 | 当前单目标单动作 | 需拆 per-Agent |

---

## 6. 验收矩阵（A1–A7，逐项状态可判定）

| 验收项 | 通过条件（摘要，见 spec.md:52-58） | 当前状态 | 关联阶段 |
|--------|-----------------------------------|----------|----------|
| A1 · 派出与常驻 | 同时≥2 直接子+1 嵌套孙、根无额外标记；首次工具调用前可见；从不操作电脑且空闲超思考窗收起仍可见；初始化失败/快速生灭/重载无残留重复 | 未验证（身份可见已有，指针常驻未测） | S1/S3/S4 |
| A2 · 视觉与回收 | 重叠/切换可读；覆层点击穿透；多显示器/DPI/负坐标；回收前后移动鼠标，结束标记回当前真实位置、只移除该标记 | 部分离线（绘制通过），真机回收未测 | S4 |
| A3 · 路由与隔离 | 根/直接/嵌套交错归属正确；模型传他人 ID 不改写；两 Agent 不同窗口/缩放/截图各自命中；窗口关闭替换后旧动作不发送 | 未验证 | S1 |
| A4 · 实际并行与顺序 | 两测试窗口：同窗按受理序完整不交错；独立获证窗口执行端证明重叠；不安全路径记录原因并串行降级、两指针仍可见 | 未通过（599 段反例） | S2 |
| A5 · 不干扰与拒绝 | 记录后台点击/拖动/移动/回收期间真实光标与前台窗口排除中途变化；前台仅授权后执行且排他；复验 Java/AWT 拒绝、审计一致、无前台/命令回退 | 正式拒绝/审计未验证；历史 Java Swing 真窗已证后台点击无效 | S2/S4 |
| A6 · 停止与恢复 | 排队/执行中取消、紧急停止、超时、helper 重启、窗口失效；无错投/重复/残留按键/悬挂锁/成功误报 | 未验证 | S4 |
| A7 · 回归 | npm run typecheck/build/test + Desktop 覆层/单 Agent/思考窗/审计窗/策略不回退；用桌面画面或窗口枚举验证覆层（只截目标窗口不算） | 绘制回归部分有；整体未验证 | S5/S6 |

> 红线：A1–A7 均为 M；任一未覆盖或被「后续迭代」代填即不合格（红线自检见第 2 节与第 10 节）。历史 P1（第 8 轮）只相当于 A3 的「身份可见」子集门槛，不等于 A3 通过。

---

## 7. 风险登记（含触发信号）

| 风险 | 概率 | 影响 | 应对 | 触发信号 |
|------|------|------|------|----------|
| 宿主无受支持的生产身份扩展点 | 中 | 阻断 S1 及以后 | 保留只读探针门槛，报告契约缺口，不启用路由 | 生产工具拿不到 exec.agent 或只能靠参数/顺序猜 |
| 跨进程仲裁器死锁/降吞吐 | 中 | 输入卡住 | 先全局单服务串行保底，再放开已证实隔离并行 | 同窗出现交错或队列长时间不前进 |
| 指针动作跟随事件粒度不足 | 中 | 跟随不精确 | 两态位置更新 + 明确标注未覆盖精确轨迹 | trace 里指针坐标与动作日志错位 |
| 退休/断链被误当锁释放 | 中 | 同窗冲突输入 | 确认旧执行收尾才放行，否则拒绝不重放 | 旧 helper 迟 exit 后新输入已注入 |
| 帧率不达标 | 中 | 视觉演示退化 | 以 trace 实测定位掉帧，不假设 60Hz | trace 实际间隔明显大于 1000/60 |
| 隔离验收授权/环境不可得 | 中 | A1–A7 无法真机 | 只用离线则记未验证，不冒充通过 | 无一次性授权或端口/进程不符 |

---

## 8. 推荐顺序与关键路径

推荐总顺序（硬依赖）：
S0（本轮几何/帧率）→ S1（可信身份 + per-Agent 目标上下文）→ S2（跨进程 HWND FIFO + 全局排他 + 可靠收尾）→ S3（动作驱动指针 + 结果审计）→ S4（生命周期/stop/权限）→ S5（发布集成/安装卸载）→ S6（A1–A7 隔离 Desktop 验收）。

关键路径与串行瓶颈：
- S1 是最大瓶颈——身份拿不到就没有后续；S1 内部「生产工具获得 exec.agent」是唯一硬前置。
- S2 依赖 S1；S3/S4 依赖 S1+S2（没有可信目标与仲裁，指针跟随与 stop 都无法正确归属）。
- S5 依赖 S1–S4 稳定；S6 统一在 S5 后出 A1–A7，但 A3/A4/A6 可在 S1/S2/S4 各自先做局部真机，最后汇总。
- 可并行：S0 与 S1 可并行立项；S3 的视觉映射与 S4 的生命周期状态机在接口确定后可并行；S5 打包清单核对可与 S6 准备并行。

> 不给出日历工期与人天（任务要求不承诺工时）；如需排期，按上述依赖另做评估。

---

## 9. 脚本驱动的渲染实测（真实操控未通过；原始失败留痕保留）

> 环境：真实 DSH、2560×1440 屏幕，实录 1920×1080；十个真实子 Agent 只等待，独立 input-free helper 绘制其虚拟指针；没有生产输入，也没有改主 profile。视频容器 60fps 不是指针 60fps 的验收证据。最终 take-06 使用复用的中性画布脚本，画布文字仍为 TAKE05；实际轮次以目录、采集日志与共同 wallMs 为准，未把旧录像重导出。

| 轮次 / 检查 | 观察与结论 | 证据 |
|-------------|------------|------|
| 底边几何 / F1 | 底边 +25%，顶点 (0,0)/(17.25,6.75)/(6.75,17.25)；中点 (12,12)、尖端与高度不变；白边/透明/锚定/DPI/裁剪 15 项像素回归通过 | tests/fixtures/pointer-render.cs、tests/desktopPointerRender.test.ts |
| take-01 | 提交间隔中位 30.736ms；逐帧视频有大量重复与大步跳跃，不通过 | artifacts/multi-pointer-60fps-20261126-1500/take-01/frame-trace-summary.json；artifacts/multi-pointer-60fps-20261126-1500/pixel-cadence-take-01.json |
| take-02 | 存活身份变化，旧 p45 被严格校验拒绝；未启动 helper，不是帧率测试 | artifacts/multi-pointer-60fps-20261126-1500/take-02-run-utf8.log；artifacts/multi-pointer-60fps-20261126-1500/identity-08-before.json；artifacts/multi-pointer-60fps-20261126-1500/identity-08-after.json |
| take-03 | 身份通过、helper 已呈现，但编排等待旧日志文字超时；未录视频，已修就绪解析 | artifacts/multi-pointer-60fps-20261126-1500/take-03/helper.log；artifacts/multi-pointer-60fps-20261126-1500/take-03-run.log |
| take-04 | 写入目标约 59.995fps，提交中位 16.667ms；但持续 retarget 同刻 Advance 得到 t=0，仍会冻结，不通过；已修为 Sync 入口先 Advance(nowMs) | artifacts/multi-pointer-60fps-20261126-1500/take-04/summary.json；tests/fixtures/pointer-animation.cs |
| take-05 | 录像与 trace 成功，报告最后一个拼写错误致 exit 1，已修；视频有真实连续运动，但亮背景使白边检测器无法单独完成严格像素判定 | artifacts/multi-pointer-60fps-20261126-1500/take-05-run.log；artifacts/multi-pointer-60fps-20261126-1500/take-05/video.mp4 |
| take-06 完整流水线 | exit 0；8秒、480帧；写入 59.999fps、无丢槽；运动提交 59.992fps，间隔中位17ms、P95 19ms、最大24ms，无 >2 帧的运动长间隔。自动 summary 仍保留 1 个跨 hold→低速移动边界的保守告警 | artifacts/multi-pointer-60fps-20261126-1500/take-06-run.log；artifacts/multi-pointer-60fps-20261126-1500/take-06/summary.json；artifacts/multi-pointer-60fps-20261126-1500/take-06/video.mp4 |
| take-06 像素分层复核 | 严格冻结检测器仍给 continuous_60fps_motion=false（逐指针逐帧像素改变不是本轮宣称）；但运动窗 28–318 共 290 帧中 289 帧唯一，中心 60–300 为 240/240 帧唯一，高速 90–240 为 150/150 帧唯一；trace 变而像素未变的候选最长仅 2 帧≈33ms，未见持续捕获停顿。结论：证明真实运动画面与近60Hz提交，不把整数坐标量化或逐扫描帧变化夸成“每帧都变” | artifacts/multi-pointer-60fps-20261126-1500/pixel-trace-layer-take-06.json；artifacts/multi-pointer-60fps-20261126-1500/pixel-cadence-take-06.json |
| 最终回归 | typecheck 通过；全量 310 项，308 通过、2 跳过、0 失败；绘制与动画各15项内部检查通过；git diff --check 通过 | artifacts/multi-pointer-60fps-20261126-1500/typecheck-final-take05.log；artifacts/multi-pointer-60fps-20261126-1500/test-final-take05.log |
| 常驻层重载 | 只重载绘图 helper：6660→35256；新日志 first present visuals=11（包含当时活跃的审计 Agent），主 DSH 32260 保持运行。没有重启主程序或修改 profile | C:/Users/freezingcold/AppData/Local/Temp/dsh-multi-pointer-32260/helper.log:214-218 |

**更正后的最终口径：真实多子 Agent 操控功能验收未通过。** 轨迹来源是 scripts/multi-pointer-showcase.mjs 的 positionAt / buildState（:319-351）按时间插值计算，调度循环（:1848-1855）把结果写入覆盖层状态；十个 Agent 只等待，没有用操作工具驱动这些轨迹。底边 +25%、补间/调度目标与实屏捕获数据仅保留为局部代码及渲染证据，撤回以此宣称真实操控通过的结论。trace 与像素分层证明屏幕上确有脚本动画，而非静止旧画面重复导出；严格“每个指针在每个采集帧都必须改变像素”检测仍未通过。日志证明成功提交，不证明硬件扫描器每次刷新，更不证明 Agent 操作、应用响应或输入仲裁有效。

动画语义：按指针 id 维护 200ms 线性补间；新 id 首帧就位、删除清理、重定向前先采样旧补间。调度用单调绝对 deadline，忙帧合并不积压，静止不重绘；持久 DIB 复用绘图表面。离线调度或提交日志的 60Hz 都不能单独代替最终实录结论。



---

## 10. 需求-阶段追溯矩阵（红线自检）

| ID | 主要落点 | 验证方式 | 覆盖 |
|----|----------|----------|------|
| R1 | S1（plugin.ts/身份适配） | A3 + 隔离真机逐请求对应 | 待实施（已有计划） |
| R2 | S4（生命周期状态机） | A1/A2 | 待实施（已有计划） |
| R3 | S1（agentContext） | A3 | 待实施（已有计划） |
| R4 | S2（arbiter） | A4（逐字符交错归零） | 待实施（已有计划） |
| R5 | S2（全局排他通道） | A5 串行降级 | 待实施（已有计划） |
| R6 | S4（stop/取消/收尾） | A6 | 待实施（已有计划） |
| R7 | 现有 F1 + S3/S4 | A2 | 绘制已验证；正式动作/生灭待验 |
| R8 | S2/S4（拒绝/不干扰） | A5 | 待实施（已有计划） |
| R9 | S3（结果/审计） | 各阶段结果与日志一致 | 待实施（已有计划） |
| R10 | S5/S6 | A7 | 待实施（已有计划） |
| R11 | 保留 F1 | tests/desktopPointerRender + 覆层可见 | 已具备，继续回归 |
| R12 | S0 | 脚本渲染 FPS + 像素分层回归；真实操作另行验收 | 仅渲染提交与像素分层有证据；严格逐像素每帧未通过，真实操控验收未通过 |

---

## 11. 关键技术决策（ADR，含反转条件）

| # | 决策点 | 备选 | 选择 | 理由 | 反转条件 |
|---|--------|------|------|------|----------|
| 1 | 身份来源 | MCP 参数/展示名/顺序 vs 宿主原生 exec.agent | 用宿主原生可信 exec.agent | 现有 MCP 桥不传 caller，参数可伪造（verification.md:12、spec.md:62） | 若宿主提供受支持的身份扩展点且能在生产工具拿到，则可在该点实现而非重造 |
| 2 | 仲裁粒度 | 全局单锁 vs HWND 窗口级 | HWND 窗口级 + 全局排他兜底 | 599 段反例证明无窗口级串行即冲突（concurrency README:34） | 若跨进程窗口级锁无法兼顾性能，降级为单服务全局串行（spec.md:39） |
| 3 | 指针坐标来源 | 演示动画 vs 真实动作事件 | 真实动作事件驱动 | 动画不得冒充真实操作（spec.md:23） | 若动作事件粒度实在不足，退到动作开始/结束两态并标注 |
| 4 | 退休 guard 定位 | 当作 FIFO vs 当作单驱动原语 | 单驱动超时收尾原语 | 只覆盖同实例（verification.md:91） | 若扩展到跨进程 lease 后，才可作为仲裁的一部分 |
| 5 | 发布方式 | 只挂 profile 探针 vs 正式集成 | 正式集成 + 保留 MCP 兼容 | 探针不是正式功能（verification.md:13、plugin.ts:80-104） | 若正式安装入口不可用，保持隔离验收并标注未集成 |

---

## 12. 独立完成自审报告

- **需求冻结**：第 2 节 R1–R12 覆盖 spec.md:34-40 功能 1–7 + 非功能 + A 项 + 本轮 R12；明确不做照抄 spec.md:60-65。无「后续迭代」代填 M 项。
- **证据分层**：第 3 节严格分「已实际通过 / 仅离线或静态 / 未测」，并显式否认两处常见误读——P1 只读身份探针 ≠ 生产逐请求绑定；driver 退休 guard ≠ FIFO/跨进程仲裁（verification.md:91）。
- **反例引用**：同窗 599 个 A/B 连续段（concurrency README:34）、异窗 1152ms 重叠仅键盘文本（:25-28）均按原文口径引用，未夸大为真实鼠标并行。
- **本轮范围与纠正**：只实施 S0 的底边 +25% 与 60fps 补间/呈现改造；其余是待办。第 9 节保留脚本渲染数据、失败项与限制；不把真实身份、实屏录像、元数据或提交率写成真实操控通过。后续必须核验 Agent 操作工具调用、应用响应及对应指针/审计，不重跑动画充当功能验收。
- **不编造 API/工时**：候选新文件标「计划，未存在」；全文不承诺人天/日历工期/具体新 API。
- **F1 保留**：第 0.2 节与 R11、追溯矩阵均要求不复退绘制/覆层与 10 Agent 视觉演示。
- **可执行性**：每阶段有候选落点（file:line）、勾选项、完成标准、验收点、风险回退；第 8 节给依赖顺序与瓶颈。
- **待确认**：无硬节点、人力、隔离授权为假设，已在第 1 节列出，不自行降级 M 项。

> 本清单由子 Agent 只读审计起稿、主 Agent 复核集成。本轮另有几何/动画局部代码、回归及新实录证据；没有实施 S1–S6，没有修改主 DSH profile，也没有覆盖旧演示证据。
