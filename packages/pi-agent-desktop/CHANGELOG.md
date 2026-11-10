# Changelog

## 0.1.0 (2026-11-08)

Initial release.
The extension wraps the `agent-desktop` CLI so the agent can read and act on any window that exposes an accessibility tree.

### Features

- One `agent_desktop` tool with an action enum: `snapshot`, `click`, `type`, `press`, `set_value`, `select`, `scroll`, `hover`, `drag`, `list_apps`, `list_windows`, `screenshot`, `get`, `is`.
- Every result is plain text: the CLI's `data` envelope is unwrapped and rendered, so no command answers with a JSON object — an acting action's follow-up snapshot included.
- `get` and `is` read one property or state of a ref, so `get bounds` gives exact points without estimating from a screenshot; `is` says _not applicable_ rather than a false `result`.
- Both answer as `<property>: <value>`, and a `get` is never clamped, so it really is the way to read whole what a snapshot line abbreviates.
- A ref-less node drops an `acts` line that only offers `RightClick`, `ScrollTo` and `SetFocus` — the actions that do not earn a ref — because no ref could address it.
- An ambiguous-target failure names the candidate window ids it already knows, rather than only telling the agent to go and list them.
- The how-to-read legend prints only on a tree big enough to pay for it, so a small drilled region stays shorter than the JSON it came from.
- Every acting action answers with its own fresh snapshot, so refs from an older snapshot are never reused.
- Background by default: every action goes through the accessibility tree and leaves the cursor alone. `hover` and `drag` are the only pointer movements and are opt-in per call with `headed`.
- A cursor overlay marks where a pointer action lands, without replacing the OS pointer.
- Prefers a source checkout when it answers, and falls through to the `agent-desktop` on `PATH`; re-probes on a call if neither answered at session start.
- One session id per Pi session on `agent_start`, `agent_settled` and `session_shutdown`, so a subagent or a second window is a distinct session and does not release the apps another is driving.
- `screenshot` returns the pixels as an image, not base64 the model cannot see; the text names the pixel-to-point ratio, and an unreadable or unsupported shot stays text.
- A CLI failure is surfaced as its own message and suggestion instead of the raw JSON envelope.
- The upstream skill is bundled, so the documented CLI and the invoked one match.
