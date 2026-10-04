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

本地维护候选新增激活拒绝、实例冲突、进程检查失败和观察器停止记录；CLI 现在保留激活事件及 Windows 崩溃退出码。`codex-exited` 只记录观察到的退出值及来源。`codex-exit-unobserved` 和 `codex-observation-stopping` 都不表示正常退出。

用 `--attempt UUID` 指定启动轮次，或 `--latest-attempt --follow --json` 固定观察最新一轮；先筛选，再应用 `--last`。最新轮次选择不会在 follow 中自动跳到新启动。日志读取仍限于最后 256 KiB，没有轮转，找不到旧轮次时不得当作未发生。上述新增能力在已安装 rc.6 中尚不可用，须在本地维护候选更新后使用。

## 额度切页状态记录（本地诊断候选）

quota 1.0.9 增加 `quota-trace`。只在本次托管连接通过原有只读契约后读取自有组件的结构状态；不新增发现、附加、修复或任意 RPC。每秒独立采样，不等待另一页面的契约探测，不参与审批心跳。读取失败只留下固定错误类别，不能撤销已验证能力、关闭连接或改动挂载条件。

组件保留最近 128 次不同状态，采样间发生的短暂停放/恢复也可回读。每轮所有 renderer 共用 96 条额度记录预算，另有一条 `trace-limit`；日志不是全量轨迹。溢出、`lostEvents`、传输失败或缺少 API 时必须标记证据缺口，不能推断没有清理。renderer 为本轮本地序号，documentGeneration 由执行上下文清空事件递增，侧栏/导航/父层身份也是组件内序号，均非原生 ID、路径或 URL。

记录包含固定停放原因、连接/隐藏/清理状态、侧栏和导航数量、原生分支数量、末尾节点固定标签类别、自有卡片尺寸位置、祖先隐藏或裁剪标志、事件时间与序号。`mounted` 只表示连接且自身未 hidden；祖先隐藏、裁剪、零尺寸仍可能使用户看不见。结构未知继续安全停放，记录不会放宽契约或修改原生节点。

不记录 DOM 文本、任意属性/类名、列表与聊天内容、页面 URL、账号原始响应、额度快照、实例密钥或认证信息。写入及 CLI 读取两端都执行字段白名单。正常 detach 的既有清理响应一并读取组件轨迹，观察器随后销毁，不新增阻塞清理的 CDP 请求。详细复合取证方案见 `maintenance-quota-lifecycle-trace.md`。

## 工作台加载状态（复合恢复候选）

workbench 0.6.16 在同一已验证连接的只读采样中补充 `workbench-trace` 和 `workbench-health`。前者记录自有面板的 idle/loading/frame/error、连接和握手就绪布尔值、打开代次，以及固定失败类别 none/frame-timeout/load-failed；不采集页面、项目、对话、地址、frame capability 或 challenge。组件保留 64 次变化，每轮所有 renderer 共用 48 条轨迹预算和一条 trace-limit，丢失数量另行标记。

后者仅记录 ready/loading/error/inactive 的变化，用于托盘显示面板实际加载状态。状态通知不受轨迹预算截断影响；预算耗尽以后不能把诊断信息完整性视为通过，但仍需显示真实面板错误。读取失败不触发重启、重新激活或改变审批权限。quota API 不存在时仍可读取自有工作台状态，子 frame 和非 app 文档不能供应宿主状态。详细新版复合方案见 `maintenance-composite-recovery.md`。

workbench 0.6.18 沿用 entryConnected、entryHidden、entrySeparateRow、entrySharesNativeRow，另记录自有入口 entryHeight（整数0–32768）、entryOversized、entryVisible，以及 listUsable、pageVisible、frameVisible 布尔值。列表可用表示已验证滚动分支至少80px高且没有被祖先隐藏/裁剪；这不验证具体原生列表内容。可见检查限制64层，未知按不可见，区分“连接且ready”和实际显示；frame阶段但page/frame不可见时托盘health为error。只输出自有高度和判断结果，不记录原生文字、属性、CSS、矩形原值、URL或截图；不新增RPC、发现或附加。quota 1.0.12立即记录挂载/隐藏/裁剪/结构身份等语义变化，仅几何变化最多每秒一次，既有heartbeat读取最终稳定几何；128状态环/96写入预算不扩张，缺口仍明确报告。详见 `maintenance-bounded-entry-recovery.md`。

workbench 0.6.19 增加 frameLoadEvents（0–1000）、frameAwaitingChallenge、frameLoadAcknowledged 和 frameOccluded。后三项是收到合法子文档等待握手、宿主 load-frame 已确认、以及自有 frame 中心点击区域被遮住的布尔事实。frameOccluded 只在当前活动、可见 frame 上检查，不输出命中元素、原生 CSS、文字或坐标；中心无遮挡不能证明整个面板可用，仍需实际交互验收。就绪而中心被拦截的面板 health 为 error。沿用已有只读连接、字段白名单和日志预算，没有任意 DOM/JS/RPC 调试接口；challenge/capability 本身仍不记录。

workbench 0.6.20 增加 mountState（parked/mounted/unavailable）、pageHidden、pageVisibility/frameVisibility（visible/disconnected/hidden/native-hidden/zero-size/depth-limit/suppressed/clipped/offscreen）与 mount-unavailable 失败类。活动且 ready 但不可见，与 inactive 的正常隐藏分开；不因 frameOccluded=false 推断可见。挂载失败拒绝复用旧隐藏 frame，在自有入口给出原因；加载新一代先清除旧失败。主通道确认安全初始化后才显示面板。仅枚举值与布尔值，不输出原生 DOM/CSS 或位置信息。

固定 frame-bootstrap 事件只记录 ready/timeout/invalidated/contract-refused/frame-refused/failed，每个 renderer 最多24条；ready 表示受控文档模块启动、策略恢复及宿主确认已完成，仍不能代替完整现场交互。加载先重新通过当前顶层契约及自有空白直接子 frame 检查；在最多8秒的临时 CSP 窗口内仅重建自有 iframe 并写入 HMAC 验证的本地文档，成功、失败或顶层导航都恢复宿主 CSP。隔离文档使用仅允许本地应用资源的策略与一次性 bootstrap nonce，窗口结束后重新施加该策略。若精确的自有 frame ID 对应 OOPIF，临时协议会话仅发送 Page.setBypassCSP(false)，随后分离；不在子 target 启用 bypass、注入宿主脚本、读取账户/原生页面或开放任意 RPC。恢复失败不确认加载成功。

process-observation 只记录 timeout/recovered/failed 与0–3的 observationFailures。注册 PID/监听检查改为异步、隐藏窗口、5秒超时及4KiB输出上限；单次超时仅是观察未知，保留已验证通道的独立心跳，不允许任何新的发现/连接绕过重新验证。三次连续超时、错误响应、观察器停止、进程退出或监听归属改变仍停止；恢复只观察同一已注册 PID/端口，不重启、不重新激活、不切换传输。恢复/未知都不伪造退出码，不输出 PowerShell 原文或命令。

工作台写入预算48（第49条 trace-limit）与额度条写入预算96属于不同记录流。trace-limit 不等于运行状态失去监控；独立 health 继续更新。但缺少事件顺序时不可判定原因，也不以扩大日志预算来伪造覆盖。
