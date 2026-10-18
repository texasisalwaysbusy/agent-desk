# Agent Desk 1.2.5 · 2026-10-18

## 中文

本版重点修复长时间使用后，Codex仍在运行、工作台入口和额度却因归属观测失效而被清理的问题。

- 生产归属检查改用随启动器打包的原生只读助手：持有目标进程句柄，每次直接查询IPv4/IPv6监听归属，避免反复创建PowerShell/CIM进程。没有新服务、依赖、传输或登录配置。
- 保留5秒请求上限、连续三次超时停止、严格监听归属及渲染器结构契约。迟到结果按序号隔离，不缓存归属、不自动重启助手、不自动切换调试通道。
- 诊断区分助手失效、真实Codex退出和注入后的运行期错误，记录固定阶段、耗时与受限原生错误码，不记录页面/账号/认证内容。
- 审批中心按文件路径和声明摘要合并共用差异，标明关联操作，区分预览截断、缺失、无法核验与冲突。材料不完整时保留退回/拒绝，禁止批准；原接收端的实际输入检查、真人审批和逐项风险复核不变。
- 恢复并扩充中英文额度栏说明，更新连续状态颜色/玻璃材质的实际组件演示；补充任务视图和审批材料的双语图解。

**接受范围：**同一原生观测候选在Codex 26.1007.9446.0完成六段约55分钟监督，3,649次采样、322条原生成功观测记录，无观测失败、详细证据缺口或记录封顶。2026-10-18用户补充确认：四天内累计数十小时实际使用未再发生问题，并要求发布。这是用户使用反馈，不写成96小时连续仪器监督。

原复合任务的受控故障步骤因测试脚本UTC/本地时间混用在动作前被拒绝；受控助手故障、其后20分钟恢复和该轮真实正常退出未执行。保留这些缺口，不把脚本失败当成产品故障，也不把用户长期使用反馈补写成这些分支通过。新版审批材料前端另有定向/完整离线与合成界面验证；未将旧候选的现场结果扩称为新前端真人审批验收。

Windows x64优化Release编译、未签名、按当前用户安装，自动更新关闭。使用发行页SHA256SUMS.txt校验；安装前正常退出Codex和托盘，保留原数据及回滚材料。发布不自动替换本地测试安装、不迁移配置或安装审批接收端。

## English

This release addresses long-session loss of the workbench entry and usage card when ownership observation failed while Codex remained running.

- One bundled, read-only native observer retains the target process handle and checks fresh IPv4/IPv6 listener ownership. Repeated PowerShell/CIM process creation is removed from the production observation loop.
- The five-second request deadline, three-consecutive-timeout stop policy, strict ownership and renderer contract remain. Sequence numbers isolate late results; ownership is never cached and no observer restart or transport fallback is added.
- Bounded diagnostics distinguish helper failure, actual Codex exit and post-injection runtime failure without recording private page, account or authentication content.
- Shared approval diffs are grouped by path and declared hash, with linked operations and explicit preview/missing/unavailable/conflict states. Incomplete material blocks approval while return/reject remain available. Receiver input checks, human decisions and per-operation risk review remain required.
- Restore the bilingual allowance feature section and refresh the actual-component glass/continuous-colour illustrations, with task-view and approval-material explainers.

**Accepted scope:** on Codex 26.1007.9446.0, the native-observer candidate completed six roughly 55-minute supervised phases: 3,649 samples, 322 native verified records and no recorded observation failure or detail gap. On October 18 the user reported tens of hours of actual use over four days without recurrence and requested publication. This is user feedback, not 96 hours of continuous instrumented supervision.

The controlled-fault step was refused before execution by a UTC/local-time error in the test harness. Controlled helper failure, subsequent 20-minute recovery and that run's real normal exit were not tested. Those limits remain explicit. The new approval-material frontend has separate offline and synthetic UI validation, not a claim of live human approval acceptance from the older candidate.

Windows x64 optimized Release build; unsigned current-user installer, automatic updates disabled. Verify SHA256SUMS.txt. Exit Codex and the tray normally before installing and retain rollback data. Publication does not replace the local test installation, migrate configuration or install the approval receiver.

Covered Agent Desk changes are source-available under Apache-2.0 with Commons Clause 1.0; upstream and third-party rights remain. [License](../LICENSE) · [Attribution](../NOTICE)
