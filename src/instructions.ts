/**
 * How an agent is meant to use these tools: find what it learned, replay it, learn by hand what it has not, save it,
 * and mend it when it breaks. Sent once (MCP `instructions`, or a host's system prompt), never with every step.
 */
export const INSTRUCTIONS = `这是一套会自己进化的电脑操作工具：你有一个专用浏览器（page_*），用户打开桌面控制时还能操作用户的电脑（desktop）；要换桌面模式，用 desktop_mode 在关闭、后台、前台之间切换（切前台必须带 confirm: true，会弹 UAC）。学会的操作存在操作目录里，下次直接回放，不用再一步步摸索；所有用这个插件的 Agent 共用同一个操作目录。

用法：
1. 用某个程序或网站之前，先 computer_use 说出对象（target 只写「微信」「B站」这类名字，不写要做的事），看这一类的说明和学会的操作。
2. 有合适的操作就 procedure_run("分类/操作", 参数) 直接跑：不调模型、逐步回放，又快又省。
3. 没有合适的，就用 page_*（网页）或 desktop（桌面）自己做。走通了用 procedure_save 存成操作（第一次先不带 json 调一次拿格式说明），再用 procedure_note 给这一类写说明：对应的程序或网址、别称、要注意什么，computer_use 靠它找到这一类。
4. procedure_run 没跑通时会说第几步、为什么。还没有向外的动作时，现在就修：用 page_* 或 desktop 把这件事做完，再用原来的名字 procedure_save 成新版（旧版会留着，新版不行时自动退回）。有向外的动作（发送、发表）时，先看页面确认有没有发出去，不要直接重跑。
5. 会向外发出东西的步骤标 outward:true；本来就可能是空的提取标 allowEmpty:true，否则空结果算没跑通（网站改版最常见的样子就是"什么都没有"）。
6. 标了 onAlarm 的网页操作是例行操作，procedure_routines 一次全跑。

用户的电脑：
- 每一步之后都有新截图，自己看做对了没有；没反应就换个办法，别重复同一下。
- 用户可以随时连按两下 Esc 或点屏幕顶上的「停下」叫停。停下之后所有动电脑的操作都会被拒绝，别重试，先问用户；用户要在终端运行 npx -y evolution-computer-use resume 才会解除。
- 后台模式够不着以管理员权限运行的程序（很多游戏），遇到了就请用户换成前台模式，不要换别的办法硬做。`;
