# evolution-computer-use-win 内置设置插件

本目录是 evolution-computer-use-win 自带的 DSH 设置插件（原独立包 dsh-evolution-desktop-mode），在 DSH 设置界面里提供「电脑操作模式」与「思考浮窗」设置项。入口为 plugin/lib/index.js（Host 半边）与 plugin/lib/client.js（浏览器半边）。

## 电脑操作模式

- `off`：关闭电脑操作。
- `background`：后台模式，只向目标窗口投递输入，不动用户的鼠标、不抢焦点。
- `foreground`：前台模式，使用真实鼠标键盘；切换时会弹出管理员授权。

设置项写入 `~/.evolution-computer-use/desktop-mode.json`，运行中的 evolution-computer-use MCP 服务器每 0.8 秒同步一次，选择后立即生效，无需重启。

## 思考浮窗

屏幕右上角的小窗，实时显示 Agent 正在想什么、正在做哪一步（打开网页、点击、输入……）。

- **只在 Agent 真的操作这台电脑时出现**，不是常驻：回合开始、纯思考、纯写代码都不显示；只有本轮调用命中 evolution-computer-use 的电脑/网页工具（`desktop`、`page_*`、`computer_use`、`procedure_*`、`inbox_read`、`desktop_mode`）才画出来。第一次操作之前已经流出的思考文字会接上，不会丢掉开头。30 秒没有任何动作和文本就自动收起（等授权、等扫码不会一直占着屏幕）。

- 本插件是**写侧**：订阅 DSH 的 `agent/assistant-stream`、`session/event`、`tools/execute`，把当前回合的思考、回复与工具步骤原子写入 `~/.evolution-computer-use/activity.json`；样式设置另存到 `~/.evolution-computer-use/activity-settings.json`（网页上的改动优先于插件配置项）。
- **读侧**在 evolution-computer-use 里（`src/desktop/overlay.ts`）：每 1 秒读一次该文件，通过 PowerShell + WinForms 画出浮窗。浮窗本身不进截图、不抢焦点（`remoteIndicatorVisible: false`）。
- 设置项：显示开关、位置（右上/左上/右下/左下）、宽度 240–1600、高度 160–1600、不透明度 20–100%、锁定（鼠标穿透）。
- 回合结束浮窗就收起（写侧保留 20 秒的 `lingerUntil`，读侧目前不消费它）；用 `--no-overlay` 启动 evolution-computer-use 时不画浮窗，这里的改动只存下设置。

浮窗移植自 [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win)（MIT）。
