# Changelog

## 0.1.0 (2026-11-08)

Initial release.
The extension wraps the `agent-desktop` CLI so the agent can read and act on any window that exposes an accessibility tree.

### Features

- One `agent_desktop` tool with an action enum: `snapshot`, `click`, `type`, `press`, `set_value`, `select`, `scroll`, `hover`, `drag`, `list_apps`, `list_windows`, `screenshot`.
- Every acting action answers with its own fresh snapshot, so refs from an older snapshot are never reused.
- Background by default: every action goes through the accessibility tree and leaves the cursor alone. `hover` and `drag` are the only pointer movements and are opt-in per call with `headed`.
- A cursor overlay marks where a pointer action lands, without replacing the OS pointer.
- Prefers a source checkout when it answers, and falls through to the `agent-desktop` on `PATH`; re-probes on a call if neither answered at session start.
- One session id per Pi session on `agent_start`, `agent_settled` and `session_shutdown`, so a subagent or a second window is a distinct session and does not release the apps another is driving.
- The upstream skill is bundled, so the documented CLI and the invoked one match.