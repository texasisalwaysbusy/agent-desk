# Agent Desk · 智能体工作台

**用于任务管理、智能体协作和人工审阅的本地工作台。**

**A local workspace for agent tasks, collaboration and human review.**

[English](README.md) · [架构与边界](docs/architecture.md) · [命名与兼容](docs/product-identity.md) · [发布说明](docs/publishing.md)

Agent Desk 在官方 Codex 桌面应用内提供项目任务管理、执行进展、交接审批、
自动化准备和额度信息。它是从 Dashi Taskboard 演进而来的独立维护产品，
不是 OpenAI 官方产品，也不是上游官方发行版。来源及署名见 [NOTICE](NOTICE)。

## 核心功能

- 仪表盘直接呈现待验收、受阻、逾期和正在推进的任务，不显示问候或首页聊天窗口。
- 项目看板、列表、甘特图、搜索、标签、评论与附件。
- 任务与会话关联、项目自动化准备、侧栏额度显示。
- 通过受验证的本地接收端集成交接审批；待验收不等于执行授权。

当前发行目标为 Windows x64。此版本是待验收源码；构建通过不等于已安装验收。
其他平台的遗留文件不代表支持承诺。尚未宣称存在公开下载或正式发布。

## 开发与验证

使用 Node.js 24、npm；Windows 打包还需要 Rust stable 1.88+、MSVC C++ 和 Windows SDK。

```powershell
npm ci
npm run check
npm run app:build:windows
```

`npm run dev` 启动本地开发界面与服务，`npm run agentdesk -- --help` 查看命令用法。
工作约定和验证命令见 [AGENTS.md](AGENTS.md)。安装包未签名、按当前用户安装，
默认不启用登录自启动，不提供自动更新。

## 数据与旧版兼容

新安装使用 `%LOCALAPPDATA%\AgentDesk`。存在旧数据时沿用旧目录；两份目录同时
存在时停止并提示核对，不自动复制、合并或删除。新安装身份不会静默覆盖旧应用，
具体切换边界见[命名与兼容](docs/product-identity.md)。

工作台使用已安装的签名 Codex 程序和现有登录，不建立第二份登录资料，不读取
认证数据库，不开放调试 TCP 端口。服务仅监听本机回环地址。

## 许可与公开发布

**源码可用：Agent Desk 有权授权的新增部分和改动采用 Apache-2.0 + Commons Clause 1.0。**
允许使用、学习、修改及免费分发，也允许公司内部使用、用此工具完成收费工作。
未经相关权利人另行授权，不允许出售软件本身、换名后收费分发，或提供价值完全或主要
来自其功能的收费托管或服务。具有实质独立价值的产品不一定受此限制，见条款定义。

上游 Dashi 代码保留 Apache-2.0；第三方组件保留各自许可证。这些部分原有的权利不受撤销。
具体范围及示例见 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和[许可说明](docs/licensing.md)。
此组合许可不属于 OSI 定义的开源许可，不应宣传为无限制商用的 Apache-2.0 项目。

只使用[发布说明](docs/publishing.md)中的精选源码导出，不直接推送包含本机操作记录的工作目录。
