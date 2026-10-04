# Known issues and release status / 已知问题与版本状态

Reviewed 2026-10-03. Stable release: **v1.2.2**. Version **1.2.3** is undergoing CI verification and has not been published. No remaining user-visible regression was confirmed in the accepted field matrix. This is not a guarantee that no bugs exist.

核对日期2026-10-03，正式版 **v1.2.2**；**1.2.3** 正在进行 CI 验证，尚未发布。已验收矩阵中没有确认仍存在的用户可见回归，不等于保证不存在任何bug。

## Observed scope / 已验收范围

Two sessions on Codex 26.930.3930.0 exercised existing-conversation entry, New Chat comparison, Scheduled/Settings return, sidebar/layout changes and quota recovery. The previous three route/remount load failures did not recur. Both normal exits have real process-handle exitCode=0. Approximately 20 minutes of idle use remained stable; the user accepted the observed period and existing records.

Codex 26.930.3930.0 两轮覆盖已有对话入口、新聊天对照、定时任务/设置返回、侧栏布局与额度恢复。此前三次重挂加载失败本轮未出现，两次正常退出均有真实进程句柄退出码0。约20分钟静置稳定，用户接受这段观察及现有记录。

## Limits and setup / 范围与配置

- Diagnostics are bounded change records, not continuous heartbeats. One session reached the workbench trace limit; external machine recording did not cover the entire final submission interval. Preserve those limits when interpreting the accepted user observations.
- In-flight queued loading and natural process-observation timeout/recovery were not triggered in this matrix. No indefinite stability or full security audit is claimed.
- New Codex documents and versions must pass the bundled renderer contract. Version numbers alone do not establish compatibility.
- Approval execution requires the separately configured local receiver and actual human approval. Archiving a stale request never approves or executes it.
- The installer is unsigned. Automatic updates are disabled; updating does not migrate data or configure the receiver automatically.

- 诊断是有界的状态变化记录，不是连续心跳。一轮到达工作台记录上限；外部机器采样没有覆盖完整最终提交区间。解释已验收的用户观察时保留这些边界。
- 本矩阵未自然触发在途排队加载或进程观察超时恢复，不宣称无限期稳定或完成全面安全审计。
- 新客户端/文档必须通过随包结构契约，不能仅凭版本号推断兼容。
- 审批执行需要独立配置接收端及真人批准；归档失效申请不代表批准或执行。
- 安装包未签名，自动更新关闭；更新不会自动迁移数据或配置审批接收端。

## Reporting a problem / 问题反馈

Include app/Codex versions, reproducible actions, expected versus actual behavior and sanitized diagnostic fields. Mark unobserved results as unknown. Never include account responses, tokens, authentication databases or private conversations. [Startup diagnostics](startup-diagnostics.md) · [Privacy](../PRIVACY.md)
