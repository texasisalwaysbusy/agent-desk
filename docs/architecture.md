# Architecture and boundaries

Agent Desk has a React/TypeScript frontend, local Node service, Windows Tauri
launcher, and a thin stdio plugin. All UI assets are local. The launcher validates
the installed official Codex package and a renderer capability contract before
loading the bundled interface. The Windows launcher candidate uses registered
Store activation with a random `127.0.0.1` CDP listener, verified against the
activated process PID. Other same-machine processes can reach this listener;
the separate API authentication does not protect CDP. It does not modify the
Codex package or copy an authentication profile. Unknown renderer structures
fail closed; minor version numbers are not an unconditional support promise.

The HTTP service binds only to a random 127.0.0.1 port with instance authentication,
Origin/Host validation and launcher challenge. Persistent data, logs and the runtime
descriptor have separate permissions; the plugin reads only the runtime descriptor.

Tasks, project selection, conversation bindings and automation user intent persist.
The dashboard is a navigation and overview surface: review, blockers, deadlines,
work in progress, recent task updates and collapsible statistics. Task status does
not prove a conversation is running. Failed or unqueried sources are not displayed
as zero. The dashboard does not mount visible AI Chat UI or request project summaries.
The legacy summary service still exists independently; hiding the dashboard summary
does not disable that service or prove that background model calls stopped.

Handoff approval lists use the existing authenticated bridge. Approval decisions
remain in the review center; listing, claiming and task review do not grant approval.
Decisions bind to the displayed project, request revision, receiver and risks. No
ordinary task API gains approval authority. A separately configured handoff receiver
is required; unavailable integration is shown as unavailable, not empty. Native host
approval/execution acceptance remains a separate release gate.

Agent automation uses official scheduling and preserves enablement, controller identity
and per-task conversation bindings. No custom scheduler, telemetry, remote UI assets,
LAN listener, automatic updater or second Codex profile is introduced.
