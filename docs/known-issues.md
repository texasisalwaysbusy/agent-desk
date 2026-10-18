# Known issues and release scope / 已知问题与发行范围

Reviewed 2026-10-18 for **1.2.5**. The accepted observations have no confirmed remaining recurrence of the long-session injection failure. This is bounded evidence, not a claim that every bug or security issue has been eliminated.

2026-10-18 核对 **1.2.5**。已接受观察中未确认长时间使用后的注入故障再次发生；这不代表所有缺陷或安全风险均已消除。

## Accepted observations / 已接受观察

On Codex 26.1007.9446.0, the native-observer candidate completed six roughly 55-minute phases with 3,649 samples and 322 native verified records, without recorded observation failure, detail gaps or a trace cap. The user subsequently reported tens of hours of actual use across four days without recurrence and accepted publication. This feedback is not 96 hours of continuous instrumented supervision.

原生观测候选在 Codex 26.1007.9446.0 完成六段约 55 分钟监督，3,649 次采样、322 条原生成功观测，无观测失败记录、详情缺口或封顶。用户随后反馈跨四天累计数十小时日常使用无复发，接受发行；不写成 96 小时连续仪器监督。

The controlled-fault step was refused before execution due to a UTC/local-time error in the test harness. Controlled helper failure, recovery and that round's actual normal exit remain untested. The additional approval-material frontend has offline/component/synthetic UI checks, not live human approval acceptance from the earlier candidate. [Full release notes](release-1.2.5.md).

受控故障因测试脚本 UTC/本地时间混用在执行前被拒绝；受控助手失效、恢复及该轮真实正常退出仍未测。新增审批材料前端通过离线、组件和合成界面检查，不冒称旧候选现场已验收。[完整说明](release-1.2.5.md)。

## Dependency alerts / 依赖告警

The unchanged dependency versions report **eight affected package entries: two high, three moderate and three low** in the October 18 npm audit. These entries include transitive rollups, not eight distinct exploits. They remain open; no dependency upgrade is included in 1.2.5.

依赖版本未升级。10 月 18 日 npm 审计报告 **8 个受影响包条目：高 2、中 3、低 3**，包含传递依赖汇总，不等于八个独立漏洞。告警保留，不标为已修复。

| Entry / 条目 | Applicability reviewed / 已核对触发条件 |
| --- | --- |
| [js-yaml merge cost](https://github.com/advisories/GHSA-2883-xcg3-v3hh) | Product metadata parsing uses `JSON_SCHEMA`, leaving merge keys literal and rejecting explicit merge tags. / 元数据使用 JSON_SCHEMA，不处理合并键。 |
| [source-map-js indexed offsets](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | Build/development dependency; not included in the packaged Node service, and no source-map upload endpoint. / 构建开发依赖，不随 Node 服务打包，没有源码映射上传接口。 |
| [DOMPurify hooks](https://github.com/advisories/GHSA-p98j-92pf-mc4p), [rawtext root](https://github.com/cure53/DOMPurify/security/advisories/GHSA-6688-9rhm-gjv2) | Product sanitizes SVG strings without `IN_PLACE` or a removing after-sanitize hook. / 清洗 SVG 字符串，不使用原地清洗或移除节点的后置钩子。 |
| [KaTeX / Mermaid](https://github.com/KaTeX/KaTeX/security/advisories/GHSA-238p-pmpm-9mq7) | Advisory requires existing prototype pollution; this review does not establish that every pollution path is absent. / 需要已有原型污染，本次不声称排除所有污染路径。 |
| [smol-toml parse cost](https://github.com/advisories/GHSA-r4xh-jqrq-34v2) | Local agent TOML configuration is parsed synchronously without a dedicated size cap. A very large crafted local configuration can stall catalogue loading. This remains a known limitation. / 本地代理 TOML 同步解析没有专门大小上限；恶意超大本地配置可能阻塞目录加载，保留为已知限制。 |
| [Vitest / mocker](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) | Development test server issue; verification uses `vitest run`, not an exposed test server. / 开发测试服务问题，本次使用 run，不对外开放测试服务。 |

## Setup and reporting / 配置与反馈

Every new Codex document must pass the renderer contract. Future client compatibility is not guaranteed. Approval execution needs a separately configured receiver and actual human approval. The Windows x64 installer is unsigned; automatic updates are disabled. Preserve the previous installation/data for rollback and exit Codex/the tray normally before updating.

每个新 Codex 文档须通过结构契约，不保证未来客户端均兼容。审批执行需已配置接收端与真人批准。Windows x64 包未签名、自动更新关闭；保留旧安装和数据以便回滚，更新前正常退出 Codex 与托盘。

Include app/Codex versions, reproduction steps, expected/actual behavior and sanitized diagnostics. Mark unknown results explicitly; never include tokens, account responses, authentication databases or private conversations. [Diagnostics](startup-diagnostics.md) · [Privacy](../PRIVACY.md)
