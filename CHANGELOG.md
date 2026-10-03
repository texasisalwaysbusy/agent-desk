# Changelog / 更新日志

## Unreleased maintenance candidate / 未发布维护候选

Status reviewed 2026-10-03. These changes are in local maintenance candidates; **they are not included in the public v1.2.2 installer or public application source**.

2026-10-03 核对状态：以下属于本地维护候选，**不包含在公开 v1.2.2 安装包或应用源码中**。

### Candidate improvements / 候选改进

- Recover the workbench entry and native sidebar quota after Scheduled/Settings navigation; improve existing-conversation mounting and entry alignment.
- Separate child-document startup, bridge handshake and host acknowledgement during panel loading.
- Replace blocking process observation with a bounded asynchronous check; a single observation timeout no longer immediately becomes permanent connection failure.
- Add archival handling for stale approval requests, including requests whose original detail can no longer be verified.
- Introduce a continuous OKLab quota colour curve and the selected static glass material; keep one state hue across the filled bar.

- 改善定时任务/设置切页后的入口与额度恢复、已有对话挂载及入口对齐。
- 分开检查子页面模块启动、桥握手和宿主确认。
- 进程观察改为有界异步检查，单次观察超时不立即判定永久断链。
- 为无效或无法再核验详情的旧审批申请补充归档处理。
- 额度采用连续 OKLab 状态颜色和已选定的静态玻璃材质，整段填充保持同一状态主色。

### Remaining validation / 尚未闭环

The latest candidate opened the workbench from existing conversations in two field-test sessions and ran approximately 5 hours 28 minutes without a connection loss in the longer session. Three route/remount `load-failed` events still occurred and recovered on the following open. Their exact cancellation/remount cause is under investigation. The process-observation timeout/recovery branch was not naturally triggered; the second session's Codex exit value was not observed. This is not a claim of a fully fixed or audited release.

最新候选两轮已有对话入口均能打开，较长一轮运行约5小时28分未断链。但切页重挂仍记录3次 `load-failed`，随后恢复，取消与重挂的确切原因仍待处理。进程观察超时恢复分支未自然触发，第二轮 Codex 退出值未观察到。因此暂不发布新的稳定安装包。

## Documentation update / 产品展示更新 · 2026-10-03

- Expanded bilingual product introduction, feature/use-case table and first workflow.
- Added four screenshots of the published v1.2.2 UI using fictional demo tasks: dashboard, board, list and Gantt.
- Added screenshot provenance, known issues and an explicit separation between stable downloads and unreleased candidate work.
- 完善中英文介绍、功能场景和使用流程；增加仪表盘、看板、列表、甘特图4张真实组件演示图；补充例图来源、已知问题和稳定版/候选边界。

Documentation only. No installer, application version, release tag or runtime code was changed by this update.

本次仅更新公开文档和例图，不替换安装包、不更改产品版本、发行标签或运行代码。

## [1.2.2](https://github.com/texasisalwaysbusy/agent-desk/releases/tag/v1.2.2) · 2026-09-28

- Registered Store activation using the existing login and executable signature checks.
- Per-document renderer contracts, without a fixed minor-version allowlist.
- Workbench/quota coexistence, new-chat navigation and sidebar remount improvements.
- Borderless native-sidebar allowance display with reset countdowns.
- Bounded startup/rejected-target handling; normal exit without automatic relaunch.
- Windows x64 Release build, unsigned current-user installer, sanitized diagnostics.

- 已注册 Store 激活、沿用登录并校验签名；逐文档检查界面契约；改善工作台/额度共存、新聊天跳转与侧栏重挂；无边框额度和重置倒计时；有界启动与拒绝目标处理，正常退出后不自动重启；Windows x64 Release 编译、未签名按用户安装。

See [full bilingual release notes](docs/release-1.2.2.md) for accepted scope and limitations.
