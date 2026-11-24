# 全量检查：后台模式到底是不是「全后台」

用户要求明确：后台模式必须真的不把被操作的窗口摆到显示屏上，也不能动用户真实的鼠标键盘。这份文档是检查方法，代码是 `scripts/verify-background.ps1`（Node 调用助手、逐项取样）。

## 结论要回答的问题

1. 被操作的窗口有没有在任何时刻变成前台窗口（`GetForegroundWindow() == hwnd`）。
2. 整屏截取的像素里有没有出现被操作窗口的画面（窗口被盖住时采不到，就是没露出来）。
3. 用户的鼠标指针坐标有没有变过（`GetCursorPos`），有没有真实键鼠注入（`SendInput` 只在 rclick/rdrag/前台模式使用）。
4. 窗口的 Z 序、最小化状态、可见性有没有被改动（`IsIconic`、`GetWindowLong` 的可见位）。
5. 有没有触发 UAC（后台模式的助手不是管理员启动；`ELEVATED` 错误只在前台模式出现）。
6. 操作本身有没有成功（点击后目标控件的状态变化、输入的文字进到目标窗口、截图内容变化）。

## 取样设计

- 目标程序：记事本（`notepad.exe`），由脚本自己启动并**不激活**（`Start-Process -WindowStyle Normal` 后由脚本立刻把前台还给原来的窗口；或用助手自己的 `launch`）。
- 覆盖窗口：让记事本窗口位于另一个最大化窗口之下（或把记事本移到副屏并让主窗口覆盖它），这样"露出来"是可检测的。
- 取样：以 25 ms 间隔取 `GetForegroundWindow`、`GetCursorPos`、`IsIconic(target)`、`IsWindowVisible(target)`；每次操作前后各 200 ms。
- 整屏截取：操作开始、中段、结束各一次，裁到目标窗口矩形，和操作前的同一区域比较；若目标窗口没有被其它窗口覆盖，则要求该区域始终是"被覆盖的样子"（即画面不变）。
- 断言：
  - `foregroundSamples == 0`（目标窗口从未成为前台）
  - `cursorMoved == false`（`GetCursorPos` 从取样到结束没变）
  - `zOrderChanged == false`、`minimized == false`、`visible == true`（可见但被盖住）
  - 没有 `ELEVATED` 错误、没有 UAC 进程（`consent.exe`）
  - 操作结果正确：`click` 后目标控件状态变化、`type` 后目标窗口文本变化（用 `WM_GETTEXT`/`PrintWindow` 前后对比）

## 反例（必须出现的对照）

同一个脚本在前台模式下跑一遍：`foregroundSamples > 0`（前台模式会真的把窗口带到最前）、`cursorMoved == true`（真实点击）。前台必须弹 UAC；脚本用 `--desktop foreground` 时会等到用户同意，未同意就记为"用户拒绝"，不算失败。

## 结果记录

脚本输出 JSON：`{ mode, app, samples, foregroundHits, cursorMoved, elevatedErrors, operations: [{name, ok, before, after}] }`，并打印一句结论。README 里写的是脚本跑出来的结论，不是设计意图。

## 已知的"看起来像前台"的情况

- `open` 打开一个原本没开（`launch`，desktop.ts:211）或收在托盘（`tray`，desktop.ts:197）的程序时，程序自己会冒到前台，随后 `giveBack`（desktop.ts:179-190）把焦点还给用户原来的窗口。这一段"程序自己跳出来"是程序的行为，后台模式只保证不给它 `SetForegroundWindow`。脚本因此对 `open` 与 `click/type/scroll` 分开取样。
- `restore`（desktop.ts:261）对最小化窗口调用 `ShowWindow(SW_SHOWNOACTIVATE)`（win32.ps1:336），不激活。
- 后台模式的 `click/type/scroll/press/drag` 走 `PostMessage`（win32.ps1:829-838），不碰真实鼠标键盘；`rclick/rdrag`（win32.ps1:839-840，`SendInput`）只有前台模式的桌面工具才会用到——脚本要确认后台模式下这两个命令从未被调用。
