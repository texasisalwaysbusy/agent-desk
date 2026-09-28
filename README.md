# Agent Desk · 智能体工作台

**用于任务管理、智能体协作和人工审阅的本地工作台。**

**A local workspace for agent tasks, collaboration and human review.**

[简体中文](README.zh-CN.md) · [Architecture](docs/architecture.md) · [Identity and compatibility](docs/product-identity.md) · [Publishing](docs/publishing.md)

Agent Desk brings project and task management, agent progress, handoff review,
automation preparation and usage information into the official Codex desktop app.
It is an independently maintained product derived from Dashi Taskboard, not an
OpenAI product or an official upstream release. See [NOTICE](NOTICE) for ancestry.

Agent Desk 面向 Windows 上的官方 Codex 桌面应用，提供项目与任务管理、智能体执行进展、
交接审批、自动化准备和额度信息。它是从 Dashi Taskboard 演进而来的独立维护产品，
不是 OpenAI 官方产品，也不是上游官方发行版。完整中文说明见 [README.zh-CN.md](README.zh-CN.md)。

**许可 / Licensing:** 源码可用；适用的新增部分与改动采用 Apache-2.0 + Commons Clause 1.0。
Source-available; covered additions and modifications use Apache-2.0 + Commons Clause 1.0.

## What it does

- An action-focused dashboard: reviews, blockers, deadlines and work in progress.
- Project boards, lists, Gantt views, search, labels, comments and attachments.
- Task-to-conversation navigation and project automation preparation.
- Handoff approval review through an authenticated local receiver integration.
- A compact allowance card in the native sidebar.

## Preview / 效果示例

![Agent Desk borderless sidebar allowance display in Chinese and English, using demo data](docs/assets/allowance-preview.png)

The allowance card shows the remaining 5-hour and weekly usage percentages and reset
countdowns. This preview renders the actual borderless component (1.0.6) with
synthetic data in illustrative sidebars, retaining threshold colors. It is not
a full Codex screenshot or a substitute for installed-host acceptance.

额度卡展示 5 小时与每周使用额度及重置倒计时。上图使用演示数据，不包含真实账户信息；
它使用实际的 1.0.6 无边框组件渲染，不代表完整 Codex 界面或安装验收结果。

## Download / 下载

**[Download Agent Desk 1.2.2 for Windows x64 / 下载 Windows x64 安装包](https://github.com/texasisalwaysbusy/agent-desk/releases/download/v1.2.2/Agent-Desk-1.2.2-Windows-x64-setup.exe)**

[Release notes and SHA-256 / 中英文发行说明与校验文件](https://github.com/texasisalwaysbusy/agent-desk/releases/tag/v1.2.2)

Windows x64 is the supported distribution target. The installer is unsigned and
installs for the current user. The equivalent rc.6 build passed installed startup,
sidebar/quota presence, normal exit and manual restart on Codex 26.924.2738.0;
1.2.2 promotes that implementation with stable version metadata and a Release build.
The second session's Codex exit code and tray version label were not observed;
installed executable/resource hashes matched. Live receiver-approval execution
is not certified by this acceptance. Other platforms are not supported.

安装前请正常退出 Codex 与旧版 Taskboard 托盘程序，保留旧版安装及数据作为回退点，
不要同时运行两套启动器。安装包未签名；本次已验证 rc.6 的安装、启动、侧栏、首次
正常退出和手动重开。第二轮 Codex 退出码与托盘版本文字未确认，安装文件哈希已核对；
此次验收不代表人工审批执行流程已认证。

## Development

For a Codex startup failure, [live startup diagnostics](docs/startup-diagnostics.md)
can be followed from a separate terminal without opening the workbench.

Codex 启动失败时，可在另一个终端使用[实时启动诊断](docs/startup-diagnostics.md)，
无需等待工作台窗口出现。

Use Node.js 24 and npm. For Windows packaging, install Rust stable 1.88 or newer,
the MSVC C++ workload and Windows SDK.

```powershell
npm ci
npm run check
npm run app:build:windows
```

`npm run dev` starts the local development frontend and service. `npm run agentdesk -- --help`
opens CLI usage. See [AGENTS.md](AGENTS.md) for validation and security rules.
Installers built here are unsigned and install for the current user. Automatic
updates are disabled. Enabling login autostart is a separate user action.

## Data and compatibility

New installations use `%LOCALAPPDATA%\AgentDesk`; existing legacy stores are reused
without an automatic move. Ambiguous stores cause an explicit error. The independent
installer does not silently replace the old application. Follow the [compatibility
notes](docs/product-identity.md) before local acceptance or migration.

The Windows launcher uses registered Store activation and the
existing login profile. It validates the package and executable signatures on
every manual start, then checks the renderer structure before injection. Minor
version numbers do not require an allowlist update; an unknown structure fails
closed. Future versions are not guaranteed compatible.

This route opens a random `127.0.0.1` debugging port owned by the activated Codex
process. Other same-machine processes can reach it; CDP is not authenticated by
Agent Desk's API credentials. The launcher reads no authentication database and
never attaches to an ordinary running Codex. Exit Codex normally before starting
Agent Desk. See [PRIVACY.md](PRIVACY.md). The stable installer is compiled in Release
mode. It retains sanitized diagnostic/error logs; standalone developer experiments
are not the default launch path. A locally retained rc.6 installation need not be
replaced by the public stable build.

## Source and license

**Source-available: Apache-2.0 + Commons Clause 1.0 for covered Agent Desk changes.**
You may use, study, modify and redistribute the covered software free of charge,
including internal business use. Selling the software itself or charging for a
product or service whose value derives entirely or substantially from its
functionality requires separate permission from the relevant rights holders.
This includes repackaged paid downloads and paid hosted access. It does not
ban ordinary paid work performed using the tool or independent value-added products.

Upstream Dashi Taskboard portions retain Apache-2.0; third-party components retain
their own licenses. These restrictions cannot remove their existing rights.
See [LICENSE](LICENSE), [NOTICE](NOTICE), and [licensing examples](docs/licensing.md).
Do not describe the combined project as OSI-approved open source.

Use the curated source export described in [Publishing](docs/publishing.md),
not the private working checkout or its local operational records.
