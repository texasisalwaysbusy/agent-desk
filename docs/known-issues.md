# Known issues and release status / 已知问题与版本状态

Reviewed 2026-10-03. Public stable download: **v1.2.2**, published 2026-09-28. Local maintenance candidates are not that download. No new stable version is being declared by this documentation update.

核对日期2026-10-03。公开稳定下载仍为2026-09-28发布的 **v1.2.2**。本地维护候选与此下载不同，本次文档更新不宣布新的稳定版。

## Maintenance candidate findings / 维护候选结果

- Existing-conversation entry opened successfully in two recent field sessions; Scheduled/Settings/sidebar transitions were exercised.
- Three transient route/remount `load-failed` events remain; the following open restored the panel. Cancellation versus failed document startup still needs a precise resolution.
- The longer session ran approximately 5 hours 28 minutes without observed connection loss. That does not establish indefinite stability or cover every timeout-recovery branch.
- The first session recorded a real process-handle exit value of zero. The second recorded observer shutdown and cleanup; the Codex exit value remains unknown.
- Event logs record changes, not a periodic heartbeat. An unchanged log tail alone does not prove a stopped observer.

已有对话入口在两轮现场测试中均成功打开，相关切页已测试。但3次重挂加载错误尚未闭环，后续打开可恢复。5小时28分未断链是本次观察结果，不代表无限稳定或所有超时分支通过。第二轮只确认观察器关闭与清理，真实 Codex 退出值未知。事件日志按变化记录，不是周期心跳。

## Compatibility and setup / 兼容与配置

The public runtime's installed acceptance used Codex 26.924.2738.0. Later candidate testing used 26.928.3736.0. New client versions must pass the renderer contract; compatibility cannot be inferred from the version number alone. Approval-center execution needs the separate local receiver integration and its human approval flow. No complete security audit is claimed.

公开实现的安装验收环境为 Codex 26.924.2738.0，后续候选测试环境为26.928.3736.0。新客户端必须通过结构契约，不能只看版本号推断兼容。审批执行需要单独配置本地接收端及真人审批流程；本项目没有宣称完成全面安全审计。

## Reporting a problem / 问题反馈

Include app/Codex versions, reproducible actions, expected versus actual behavior and sanitized diagnostic fields. Mark unobserved results as unknown. Never include account responses, tokens, authentication databases or private conversations. [Startup diagnostics](startup-diagnostics.md) · [Privacy](../PRIVACY.md)
