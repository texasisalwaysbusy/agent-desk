# Changelog / 更新日志

## [1.2.3](https://github.com/texasisalwaysbusy/agent-desk/releases/tag/v1.2.3) · 2026-10-03

- Recover the workbench and quota after Scheduled/Settings navigation. Park on unsupported routes and restore the native page before an explicit reopen.
- Open directly from existing conversations; keep the entry in its own aligned native sidebar row with matching type and a discreet arrow.
- Cancel stale asynchronous mounts, settle preceding frame loads and require host acknowledgement before reusing a ready frame. Separate document startup, bridge handshake and load confirmation.
- Keep real load failures visible; late blank-frame events cannot erase them. Improve bounded process observation and allow-listed diagnostics.
- Restore approval-channel heartbeat handling and add archival handling for stale or unverifiable approval requests.
- Add a continuous OKLab quota colour system and the selected static glass material. Length still means remaining percentage; the whole filled region has one state hue.
- Windows x64 Release build; unsigned current-user installer with SHA256SUMS.txt. No automatic updater or installation as a publication side effect.

- 修复定时任务/设置切换造成的工作台与额度恢复异常；不支持的路由安全停放，返回后由用户点击入口重开。
- 已有对话可直接打开工作台，入口独立成行、对齐原生字体和尺寸，并保留灰色小箭头。
- 取消过时的异步挂载、等待前一帧请求结算，复用前确认宿主已完成加载；分别检查模块启动、桥握手与宿主确认。
- 保留真实加载错误，迟到空白帧事件不能抹掉错误；改善有界进程观察与白名单诊断。
- 修复审批通道心跳处理，支持旧的失效或无法核验详情的审批申请归档。
- 采用连续 OKLab 额度状态颜色和选定的静态玻璃材质；长度仍表示剩余比例，整段填充使用同一状态主色。
- Windows x64 Release 编译、未签名按用户安装，提供 SHA-256 校验文件；不自动更新或覆盖本地安装。

Two field sessions on Codex 26.930.3930.0 passed the user-observed flows and normal exits. The earlier three route/remount failures did not recur. Approximately 20 minutes of idle use remained stable and the user accepted this scope. In-flight queue and natural process-observation timeout/recovery were not triggered. This is bounded acceptance, not an indefinite-stability or complete-security-audit claim. [Full bilingual notes](docs/release-1.2.3.md).

Codex 26.930.3930.0 两轮现场使用与正常退出通过，旧的三次切页重挂错误未再出现。约20分钟静置稳定，用户确认接受本次范围。在途排队及自然进程观察超时恢复未触发；不宣称无限期稳定或完成全面安全审计。[完整发行说明](docs/release-1.2.3.md)。

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
