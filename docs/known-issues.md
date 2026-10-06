# Known issues and release status / 已知问题与版本状态

Reviewed 2026-10-05. Public stable release: **v1.2.2**. Accepted **1.2.4** is being packaged for publication; the earlier unpublished v1.2.3 tag is preserved. No remaining user-visible failure was confirmed in the accepted observations.

核对日期 2026-10-05。公开正式版 **v1.2.2**；已接受的 **1.2.4** 正在准备发行，保留未发行的 v1.2.3 标签。已接受观察中未确认遗留的用户可见故障。

## Observed scope / 已接受范围

The updated Codex / Pro sidebar candidate passed its initial composite checks on Codex 26.930.3930.0. Six external phases completed approximately 5.5 hours / 3646 samples without recorded functional failure. The user confirmed workbench access and quota display before machine shutdown, accepted this scope and requested publication without another field test.

新版 Codex / Pro 侧栏候选在 Codex 26.930.3930.0 通过初始复合检查。六段外部监督完成约 5.5 小时、3646 次采样，无功能失败记录。用户确认机器关机前工作台可打开、额度正常，接受该范围并决定不再补测。

Workbench detail became partial after its trace cap. Sample boundaries between phases were about 27–28 seconds. Final composite wrap-up and this attempt's normal-exit check were not run; the post-supervision interval before shutdown was unobserved. Machine shutdown does not establish normal-exit success. Natural discovery timeout/recovery was not triggered in the field. [Full release scope](release-1.2.4.md).

工作台详情到达记录上限后为部分覆盖，阶段采样间隔约 27–28 秒。最后复合收尾及本次正常退出检查未执行；监督结束至关机未覆盖。机器关机不能当作正常退出通过，自然发现超时恢复未在现场触发。[完整范围](release-1.2.4.md)。

## Limits and setup / 范围与配置

- New Codex documents must pass the bundled renderer contract; version numbers alone do not establish compatibility.
- Approval execution needs the separately configured receiver and actual human approval. Archival never approves or executes a request.
- The installer is unsigned. Automatic updates are disabled; updates do not migrate data or configure the receiver automatically.
- Bounded observations do not establish indefinite stability or a complete security audit.

- 新客户端文档必须通过随包结构契约，版本号本身不能证明兼容。
- 审批执行需要独立配置接收端及真人批准；归档不代表批准或执行。
- 安装包未签名、自动更新关闭；更新不自动迁移数据或配置审批接收端。
- 有界观察不代表无限期稳定或全面安全审计。

## Reporting a problem / 问题反馈

Dependency audit retains four advisory entries (one high, two moderate, one low). The high [js-yaml merge-cost advisory](https://github.com/advisories/GHSA-2883-xcg3-v3hh) concerns merge processing; production metadata parsers use `JSON_SCHEMA`, which leaves merge keys literal and rejects explicit merge tags. The low [DOMPurify advisory](https://github.com/advisories/GHSA-p98j-92pf-mc4p) needs `IN_PLACE` with a removing after-sanitize hook; this product sanitizes SVG strings without either. The moderate entries concern the development Vitest server; checks use `vitest run`. These conditions were reviewed for this release, but dependency alerts remain open and are not described as fixed.

依赖审计仍有四项告警（高 1、中 2、低 1）。上述高等级 YAML 告警需要合并处理，而产品元数据解析使用 `JSON_SCHEMA`，合并键保持普通数据、显式合并标签被拒绝；上述 DOMPurify 告警需要原地清洗和移除节点的后置钩子，当前 SVG 字符串清洗不使用这些条件。中等级项目涉及开发用 Vitest 服务，验证使用 `vitest run`。本次已核对触发条件，但依赖告警保留，不标为已修复。

Include app/Codex versions, reproducible actions, expected versus actual behavior and sanitized diagnostic fields. Mark unobserved results as unknown. Never include account responses, tokens, authentication databases or private conversations. [Startup diagnostics](startup-diagnostics.md) · [Privacy](../PRIVACY.md)
