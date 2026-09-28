# Agent Desk 启动诊断接口

Agent Desk 的工作台仍应出现在 Codex 内部侧边栏。启动诊断命令是独立于该界面的只读控制台：即使 Codex 没有建窗，Hermes 也能从另一个终端实时观察本次启动，无须用户口述每个状态。

在已安装的 Windows 版本中，先打开一个终端运行：

```powershell
& "$env:LOCALAPPDATA\Agent Desk\bin\agentdesk.cmd" diagnostics --follow
```

需要逐行结构化输出时加 `--json`；`--last 50` 可调整启动时显示的历史事件数（1–200）。按 Ctrl+C 结束观察。命令不启动、不关闭、不附加 Codex，也不修改工作台数据。当前兼容旧数据目录的安装会自动读取 `%LOCALAPPDATA%\DashiTaskboard\logs\agent-desk-startup.jsonl`；新目录安装读取 `%LOCALAPPDATA%\AgentDesk\logs\agent-desk-startup.jsonl`。两个数据目录同时存在时遵循现有的冲突保护并报错。

Hermes 可以先运行观察命令。随后用户从 Codex 菜单正常退出，再执行一次受控启动。观察者能直接看到每次尝试的 `attemptId`、官方 Codex 版本、管道握手、页面目标数量、注入结果、等待里程碑和超时。若注入器失败退出，托盘启动器还会在退出后第 0、2、5 秒检查它自己启动的 Codex 主进程是否仍存在。进程检查仅使用已记录的 PID；不采集命令行、窗口标题、页面 URL 或账户内容。正式验收仍需在出现窗口后检查内部侧边栏、额度卡和任务跳转。

这一路径只读取固定字段的 `agent-desk-startup.jsonl`，不会展示旧版 `agent-desk-launcher.log` 中可能含页面细节的历史行。输出只包含白名单事件和整数、布尔值、版本及时间；额外字段会被丢弃。它使用现有本地日志文件，不开放端口、网络共享、服务、计划任务或第二登录配置。文件跟随只在命令运行期间进行，不会后台轮询或向 Hermes 自动发送消息。

1.2.2-rc.5 的直接启动实验已被 rc.6 的已注册 Store 包激活路线替代。rc.6 会记录 `activation-started`、`activation-ready` 及实际进程退出码；Node 服务和观察辅助进程保持隐藏。注册路线使用随机本机 CDP 端口，诊断命令本身仍只读取日志、不开放端口。源码路线的界面验收与新安装包的启动验收应分别记录。若仍无窗口，保留一次结构化事件记录并停止，不重复启动或换一个 selector 猜测。
