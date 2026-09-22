# Privacy and local-data policy

Agent Desk is designed for one Windows user on one device.

- The Taskboard API listens only on a random `127.0.0.1` port and has no cloud, LAN, telemetry, analytics, or automatic-update connection.
- UI resources are bundled locally. User-entered Markdown links may be opened only after an explicit user action; remote images and active Mermaid resources are rejected by the renderer and CSP.
- The launcher verifies the Microsoft Store Codex package and its signed executables. It does not read, copy, back up, or transmit Cookies, Login Data, browser profiles, Codex tokens, or session databases.
- Quota-aware automation asks the signed-in Codex renderer bridge for current rate-limit metadata and stores only a sanitized availability state plus check/reset timestamps. It does not start a second authenticated CLI or retain the account response.
- The embedded quota card asks the same renderer bridge for current rate-limit metadata and sends only an allow-listed display snapshot to the injected card. It does not retain raw account responses, email addresses, tokens, credit balances, conversations, or DOM content.
- Taskboard data, attachments, application AI state, logs, and runtime descriptors remain under `%LOCALAPPDATA%\AgentDesk (or the selected legacy DashiTaskboard directory)` unless the user explicitly exports or migrates them.
- The personal plugin reads only the short-lived runtime descriptor and the minimum fields returned by the authenticated local API. It has no direct SQLite access.
- AI requests are executed by the signed `codex.exe` from the installed official package with an application-owned runtime configuration and only `read-only` or `workspace-write` sandboxing.

Uninstalling the application does not automatically delete retained Taskboard data. Remove it only after verifying backups and migration rollback requirements.
