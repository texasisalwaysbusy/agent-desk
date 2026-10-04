# Agent Desk 1.2.3 · 2026-10-03

## 中文

本版集中修复 Codex 切页、已有对话入口和工作台加载的回归，并更新额度条视觉系统。

- 工作台打开时切换到定时任务或设置，安全停放并恢复原生内容；回到首页后点击入口可重新打开，额度栏恢复。
- 已有对话可直接打开工作台。入口独立成行，字体、尺寸、对齐和灰色小箭头与原生侧栏协调。
- 加载流程分别确认模块启动、宿主加载与桥握手；取消过时代次，等待前一请求结算，防止切页后的迟到事件错误重挂或抹掉真实错误。
- 修复审批通道心跳，支持无效或无法核验详情的旧申请归档；归档不代表批准或执行。
- 改善有界异步进程观察与脱敏诊断，保留真实退出来源。
- 额度条采用连续 OKLab 状态颜色与静态玻璃材质：蓝/青代表充沛，绿代表健康，橙/红代表预警。整段填充保持当前状态主色，长度继续表示剩余比例。

**验收范围：**已验收的同运行实现，在 Codex 26.930.3930.0 两轮现场覆盖已有对话首次打开、新聊天对照、定时/设置返回、侧栏布局和额度恢复。旧的三次切页重挂加载失败未再出现，两次正常退出均有真实进程句柄退出码0。约20分钟静置表现稳定，用户确认接受现有记录及观察范围。

诊断记录有预算上限，外部机器采样没有覆盖完整提交区间；这些范围说明保留，不否定已接受的现场使用结果。在途排队及自然进程观察超时恢复未在本轮触发，不宣称无限期稳定或完成全面安全审计。新的 Codex 文档仍须通过随包结构契约。

Windows x64 **Release** 编译，安装包**未签名**，按当前用户安装，自动更新关闭。下载后用同页的 `SHA256SUMS.txt` 校验。正常退出 Codex 和旧托盘后再安装，保留旧安装及数据用于回滚，勿同时运行两个启动器。本次发布不会自行更新你的本地测试安装。

审批执行需要独立配置接收端及真人批准。沿用已有登录和受支持的应用数据目录，不自动迁移或合并数据。启动器打开的随机 `127.0.0.1` 调试监听可被同机进程访问，不是经工作台API认证的通道；正常退出 Codex 才关闭其监听。

## English

This release fixes workbench regressions around Codex navigation, existing conversations and asynchronous frame loading, and updates the allowance bar appearance.

- Park safely when navigating to Scheduled or Settings, restore native content, and recover the quota display and workbench entry on return.
- Open directly from existing conversations, with a separately aligned sidebar entry, native typography and a discreet arrow.
- Verify document startup, host load acknowledgement and bridge handshake separately. Cancel stale generations and settle earlier requests before opening a new frame; late events cannot erase a real failure.
- Restore approval-channel heartbeat handling and archive stale or unverifiable requests without approving or executing them.
- Improve bounded asynchronous process observation and sanitized diagnostics with actual exit-code sources.
- Add continuous OKLab quota colours and the selected static glass material. Blue/cyan means abundant, green healthy, orange/red warning. The entire fill uses one current state hue; length still means remaining allowance.

**Accepted scope:** the same runtime implementation passed two field sessions on Codex 26.930.3930.0 covering existing-conversation entry, New Chat comparison, Scheduled/Settings return, sidebar layouts and quota recovery. The previous three route/remount loading failures did not recur. Both normal exits have real process-handle exitCode=0. Approximately 20 minutes of idle use remained stable; the user accepted the existing records and observed scope.

Diagnostics are bounded and external machine sampling did not cover the entire submission interval. Those limits remain documented without negating the accepted user observations. In-flight queueing and natural process-observation timeout/recovery were not triggered. No indefinite stability or complete security audit is claimed. New Codex documents still require the bundled renderer contract.

Windows x64 **Release** build, **unsigned** current-user installer, with automatic updates disabled. Verify the download using `SHA256SUMS.txt`. Exit Codex and the old tray normally before installation; preserve rollback data and run only one launcher. Publishing does not update the retained local test installation.

Approval execution needs the separate receiver integration and real human approval. Existing login and supported stores are reused without automatic data migration or merging. The random `127.0.0.1` Codex debugging listener is reachable by other same-machine processes and is not authenticated by the workbench API; normal Codex exit closes it.

Covered Agent Desk changes remain source-available under Apache-2.0 with Commons Clause 1.0. Upstream and third-party rights are retained. [LICENSE](../LICENSE) · [NOTICE](../NOTICE) · [Licensing](licensing.md)
