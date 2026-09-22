# Agent Desk identity and compatibility

Confirmed product name: **Agent Desk / 智能体工作台**. Repository slug: **agent-desk**.
Agent Desk is maintained as an independent product derived from Dashi Taskboard;
source ancestry and applicable notices are retained in LICENSE and NOTICE.
Covered Agent Desk changes use Apache-2.0 with Commons Clause 1.0; upstream
portions remain Apache-2.0. See licensing.md for the distinct scopes.

## Canonical names

| Surface | Name |
| --- | --- |
| Repository and npm package | agent-desk |
| Desktop app and installer | Agent Desk |
| Rust launcher | agent-desk-launcher |
| Desktop application identifier | app.agentdesk.desktop |
| Command | agentdesk (taskctl remains a compatibility alias) |
| New Windows data root | %LOCALAPPDATA%\AgentDesk |
| Version of this transition | 1.2.0 |

## Compatibility is deliberate

An existing %LOCALAPPDATA%\DashiTaskboard store is reused in place. Nothing is
copied, merged, or deleted automatically. If both roots exist, startup refuses
to choose silently. The runtime descriptor remains in runtime/; databases and
logs retain their stricter permissions. The plugin checks only the permitted
runtime descriptors, never either database.

The taskboard-activity plugin registration, taskctl entry point, taskboard: bridge
messages, database schema, storage keys, API headers, CODEX_TASKBOARD_* environment
variables and bundled injection filename remain versioned compatibility contracts.
They are not the product name. Changing these requires a coordinated migration,
not a global search-and-replace.

The independent installer has a new identity; it is not an in-place updater for
the old installation. Exit the old launcher normally before acceptance testing.
Do not run both launchers, remove old data, or remove the rollback installation
until the new version has passed real host acceptance. Autostart remains opt-in.
The existing single-store lock also protects reused legacy data.

## Source location

The canonical checkout directory is agent-desk. A local junction at the former
checkout name may be retained to preserve existing task and automation paths.
This alias is machine-local and is never part of a GitHub source export.
