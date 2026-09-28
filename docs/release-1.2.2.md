# Agent Desk 1.2.2

![中英文无边框额度栏 / Borderless allowance display, demo data](assets/allowance-preview.png)

## 中文

Windows x64 正式版。采用 Release 编译，按当前用户安装，未数字签名；不提供自动更新。

- 启动器通过已注册的官方 Store 包启动 Codex，沿用现有登录。每次手动启动重新发现
  安装包并验证签名，解决新版客户端的包身份启动问题。
- 小版本更新无需固定版本白名单；每个新文档仍须通过界面契约。无法确认正确挂载位置
  时停止注入。其他版本仅有结构模拟测试，不承诺任意未来版本都兼容。
- 工作台入口与额度栏可同时存在；修复新聊天与工作台切换、页头残留和侧栏重挂载。
- 额度栏嵌入侧栏底部，取消卡片边框，保留随剩余额度变化的颜色及重置倒计时。
- 辅助窗口拒绝不再覆盖已就绪主窗口的状态；拒绝探测有界，启动有超时，失败即停止。
- 正常退出 Codex 后停止观察和服务，不自动重启；再次手动启动使用新的进程和端口。
- 正式版保留脱敏的启动和错误日志。独立开发实验不是默认启动方式。

等价的 rc.6 已在 Codex **26.924.2738.0** 上完成安装、启动、工作台与额度栏显示、首次
正常退出和手动重开验收；此前已验收的界面行为不重复测试。稳定版仅改变产品版本信息
与发布文档，并重新构建、核对安装包。第二轮 Codex 退出码及托盘版本文字未记录，不能
算通过；安装文件哈希已核对。人工审批执行不在本次验收范围内。

启动前正常退出 Codex。启动器会开放 Codex 自己持有的随机 `127.0.0.1` 调试端口，
同机其他程序可以连接；它不受工作台 API 的认证保护。退出 Agent Desk 保留 Codex；
需要正常退出 Codex 才能关闭其调试端口。不修改官方安装包、ASAR 或登录资料。

已有数据不自动搬移、合并或删除；保留回退副本，不同时运行两套启动器。本地已保留
rc.6 用于诊断的用户无需为了此发布覆盖本地安装。

许可：适用的 Agent Desk 新增部分与改动使用 Apache-2.0 + Commons Clause 1.0，
属于源码可用许可；上游和第三方部分保留原有权利。详见 LICENSE、NOTICE 与许可说明。

## English

Stable Windows x64 release, compiled with the Release profile. The unsigned installer
installs for the current user; automatic updates remain disabled.

- Activate the registered official Store package using the existing login. Discover
  the package and validate signatures on every manual start.
- Accept minor-version changes without a fixed version allowlist, while requiring
  a renderer contract for each document. Ambiguous mounts reject injection. Other
  versions have fixture coverage only; future versions are not guaranteed compatible.
- Keep the workbench entry and quota display together, with new-chat navigation,
  header cleanup and sidebar remount compatibility fixes.
- Embed a borderless quota display in the sidebar footer, retaining threshold colors
  and reset countdowns.
- Keep auxiliary rejection from overwriting the ready main-window state. Bound
  rejected-target probing, enforce a startup deadline and stop on failure.
- Stop after normal Codex exit without automatically relaunching it. Manual restart
  discovers a fresh process and ports.
- Retain sanitized startup/error diagnostics. Standalone developer experiments are
  not the default launch path.

The equivalent rc.6 implementation passed installed startup, workbench/quota presence,
the first normal exit and manual restart on Codex **26.924.2738.0**. Previously accepted
UI behavior was not retested. Stable promotion changes version metadata and release
documentation only, followed by a rebuilt and verified package. The second Codex exit
code and tray version label were not recorded and are not counted as passed; installed
file hashes matched. Live human-approval execution is outside this acceptance.

Exit Codex normally before starting Agent Desk. The activated Codex owns a random
`127.0.0.1` debugging listener accessible to other local processes; Agent Desk API
authentication does not protect CDP. Quitting Agent Desk preserves Codex; normal
Codex exit is required to close its debugging listener. No official package, ASAR
or login profile is modified.

Existing stores are not automatically moved, merged or deleted. Preserve rollback
copies and run only one launcher. A locally retained rc.6 installation can remain
in place for diagnostics.

Covered Agent Desk changes are source-available under Apache-2.0 + Commons Clause
1.0. Upstream and third-party portions retain their original rights. See LICENSE,
NOTICE and the licensing documentation.
