# Agent Desk 1.2.4 · 2026-10-05

## 中文

本版汇总已验收的工作台、审批与额度修复，并兼容新版 Codex / Pro 的侧栏结构。

- 识别含 Your dot 等原生入口的侧栏，不依赖按钮文字或单行布局；工作台入口和额度栏恢复正常注入。
- 定时任务、设置及已有对话之间切换时，安全停放并恢复工作台与额度栏。已有对话可直接打开工作台，入口独立成行并沿用原生字体、对齐和灰色箭头。
- 区分模块启动、宿主加载与桥握手，取消过时代次并等待前一请求结算；迟到事件不能覆盖真实错误或重新挂载已关闭的面板。
- HTTP 目标发现遇到短暂超时或网络错误时进行有界恢复；保留已有有效连接，身份、所有权或协议校验失败仍立即停止，不切换调试通道。
- 修复审批通道心跳，支持失效或无法核验详情的旧申请归档；归档不代表批准或执行。
- 额度采用连续 OKLab 状态颜色和选定的静态玻璃材质。蓝/青表示充沛，绿表示健康，橙/红表示预警；整段填充采用当前状态主色，长度表示剩余比例。

**本版接受范围：**Codex 26.930.3930.0 的候选通过初始复合检查；外部监督连续完成六段、合计约 5.5 小时，3646 次采样未记录功能失败。用户确认关机前工作面板可打开、额度栏正常，接受该观察范围并决定发布，不再补测。

工作台详细诊断到达记录上限后为部分覆盖；阶段之间采样间隔约 27–28 秒。最后复合收尾和本次正常退出检查未执行，监督结束至机器关机的时段未覆盖；机器关机不能当作正常退出通过。自然发现超时分支未在现场触发。这些缺口保留，不扩大成无限期稳定或全面安全审计结论。新客户端文档仍须通过随包结构契约。旧 v1.2.3 标签保留，正式发行采用 v1.2.4。

Windows x64 **Release** 编译，安装包**未签名**，按当前用户安装，自动更新关闭。下载后使用同页 `SHA256SUMS.txt` 校验。正常退出 Codex 和旧托盘后再安装，保留原安装与数据用于回滚，勿同时运行两个启动器。发布不会自行更新本地测试安装，也不会自动迁移数据或配置审批接收端。

审批执行需要独立配置接收端及真人批准。沿用已有登录和受支持的应用数据目录。启动器随机 `127.0.0.1` 调试监听可被同机进程访问，并非工作台 API 的认证通道；正常退出 Codex 才关闭其监听。

## English

This release combines accepted workbench, approval and allowance fixes with compatibility for the updated Codex / Pro sidebar.

- Recognize structural native headers containing entries such as Your dot, without depending on labels or a single-row layout. Restore workbench and quota injection.
- Park and recover safely across Scheduled, Settings and existing conversations. Open directly from existing conversations, using an independently aligned entry with native typography and a discreet arrow.
- Separate document startup, host load acknowledgement and bridge handshake. Cancel stale generations and settle earlier requests; late events cannot erase actual failures or remount a closed panel.
- Recover bounded HTTP target discovery from transient timeouts/network failures while preserving existing valid connections. Identity, ownership and protocol failures remain terminal, with no transport fallback.
- Restore approval heartbeat handling and archive stale or unverifiable requests without approving or executing them.
- Keep continuous OKLab state colours and the selected static glass material: blue/cyan abundant, green healthy, orange/red warning. One current state hue covers the entire fill; length means remaining allowance.

**Accepted scope:** the candidate passed its initial composite checks on Codex 26.930.3930.0. Six externally supervised phases completed approximately 5.5 hours with 3646 samples and no recorded functional failures. The user confirmed the workbench opened and the quota remained visible before shutdown, accepted this scope and chose publication without another field test.

Workbench detail became partial after its trace limit; sample boundaries between phases were approximately 27–28 seconds. The final composite wrap-up and this attempt's normal-exit check were not run. The interval after supervision and before machine shutdown was not covered; shutdown is not a successful normal-exit test. Natural discovery timeout was not triggered in the field. These limits remain explicit, without an indefinite-stability or complete-security-audit claim. New Codex documents must still pass the bundled renderer contract. The earlier v1.2.3 tag is preserved; this release uses v1.2.4.

Windows x64 **Release** build, **unsigned** current-user installer, with automatic updates disabled. Verify using `SHA256SUMS.txt`. Exit Codex and the old tray normally before installation; retain rollback data and run one launcher. Publishing does not update the local test installation, migrate data or configure the approval receiver.

Approval execution needs the separate receiver and real human approval. Existing login and supported stores are reused. The random loopback Codex debugging listener is reachable by other same-machine processes and is not authenticated by the workbench API; normal Codex exit closes it.

Covered Agent Desk changes remain source-available under Apache-2.0 with Commons Clause 1.0. Upstream and third-party rights are retained. [LICENSE](../LICENSE) · [NOTICE](../NOTICE) · [Licensing](licensing.md)
