# Changelog

## 0.0.1

Initial release.

The extension wraps the `agent-desktop` CLI so the agent can read and act on any window that exposes an accessibility tree.

### Features

- One `agent_desktop` tool with an action enum: `snapshot`, `click`, `type`, `press`, `set_value`, `select`, `scroll`, `hover`, `drag`, `mouse_click`, `find`, `right_click`, `double_click`, `toggle`, `check`, `uncheck`, `expand`, `collapse`, `clear`, `focus`, `scroll_to`, `triple_click`, `launch`, `close_app`, `focus_window`, `maximize`, `minimize`, `restore`, `move_window`, `resize_window`, `wait`, `list_apps`, `list_displays`, `list_surfaces`, `clipboard_get`, `clipboard_set`, `clipboard_clear`, `status`, `permissions`, `list_windows`, `screenshot`, `get`, `is`.
- Every result is plain text: the CLI's `data` envelope is unwrapped and rendered, so no command answers with a JSON object — an acting action's follow-up snapshot included.
- `get` and `is` read one property or state of a ref, so `get bounds` gives exact points without estimating from a screenshot; `is` says _not applicable_ rather than a false `result`.
- Both answer as `<property>: <value>`, and a `get` is never clamped, so it really is the way to read whole what a snapshot line abbreviates.
- A ref-less node drops an `acts` line that only offers `RightClick`, `ScrollTo` and `SetFocus` — the actions that do not earn a ref — because no ref could address it.
- maximize, minimize and restore end in a verification read that times out while the window settles, so a failed verification is checked against the window itself before being reported as a failure.
- close_app no longer claims the follow-up snapshot failed; the app is gone.
- find searches by text or role without dumping a tree, and wait blocks on text instead of a fixed sleep.
- An ambiguous-target failure names the candidate window ids it already knows, rather than only telling the agent to go and list them.
- `window_id` is sent only to `snapshot`, `screenshot` and `press`, the three commands that take it; the ref commands reject it, so `click`/`type`/`get` alongside a `window_id` used to fail on the flag.
- `set_value` and `select` name the missing value themselves instead of bouncing off the CLI as `INVALID_ARGS`.
- The how-to-read legend prints only on a tree big enough to pay for it, so a small drilled region stays shorter than the JSON it came from.
- Every acting action answers with its own fresh snapshot, so refs from an older snapshot are never reused.
- Background by default: every action goes through the accessibility tree and leaves the cursor alone. `hover` and `drag` are the only pointer movements and are opt-in per call with `headed`.
- A cursor overlay marks where a pointer action lands, without replacing the OS pointer.
- Prefers a source checkout when it answers, and falls through to the `agent-desktop` on `PATH`; re-probes on a call if neither answered at session start.
- One session id per Pi session on `agent_start`, `agent_settled` and `session_shutdown`, so a subagent or a second window is a distinct session and does not release the apps another is driving.
- `screenshot` returns the pixels as an image, not base64 the model cannot see; the text names the pixel-to-point ratio, and an unreadable or unsupported shot stays text.
- `mouse_click` clicks at x/y, the only click that does: `click` is ref-only, so this is how a node the platform never qualified is reached from its `at`.
- `snapshot` takes `skeleton`, `compact`, `interactive_only` and `root`, the documented map-then-drill loop; and `interactive_only` is the lever that always shrinks a tree.
- `snapshot` takes `include_bounds` to report `at` for exactly those nodes, and the legend says `at` comes from it.
- A CLI failure is surfaced as its own message and suggestion instead of the raw JSON envelope.
- The upstream skill is bundled, so the documented CLI and the invoked one match.
- The remaining CLI commands are covered: `version`, `skills`, `session`, `trace`, `trace_export`, `cursor_overlay`, `list_notifications`, `dismiss_notification`, `dismiss_all_notifications`, `notification_action`, `open_system_surface`, `batch` and `mouse_wheel`. Every one is contract-tested against the real binary.
- Nested groups are one action plus `sub`; `session start` mints a new id and the extension adopts it, so the refs it seeds are the ones later calls use.
- `batch` takes `steps` of `{ command, args }`; results render one line each with their own verdict, since a batch is not atomic.
- Notification mutations always carry `--headed` (the OS surface is not accessibility-backed) and take `index` plus `expected_title`, because the queue shifts between listings.
- Notification mutations send flags before the `--` terminator: `--headed` after it was rejected as an unexpected argument.
- `mouse_wheel` takes `--x`/`--y` separately; the `--xy` spelling is unique to `hover` and `mouse_click`.

- Built against `agent-desktop` 1.3.1, and every new action below is contract-tested against that binary.
- `wait` gained its other forms: `wait_event` on a desktop signal, `wait_element` with `predicate`/`value`/`wait_action`, and the `menu`, `menu_closed` and `notification` modes.
- `launch` takes `launch_args`, `launch_env`, `cwd`, `no_attach` and `cdp`; `close_app` takes `force`.
- `drag` takes `drop_delay_ms`, `duration_ms`, `wait_for`, `wait_for_gone` and `wait_for_scope`.
- `permissions` takes `request` and `guide`, so a missing OS grant can be asked for and shown instead of only reported.
- `clipboard_get` takes `format` (and writes an image to a file); `clipboard_set` takes `stdin_text`, `image` or `file_url`, not only plain text.
- `screenshot` takes `screen` to capture a display, and `path` to write a file.
- `sandbox` is a new nested action over the CLI's whole sandbox group; `sandbox_exec` runs an agent-desktop argv inside one.
- `open_system_surface` works on macOS in this build instead of refusing as `PLATFORM_NOT_SUPPORTED`, so the Dock and the status items are reachable again.
- The CLI's state root is read from `HOME` per call rather than `os.homedir()`, which Bun caches at startup.
- The session store the CLI keeps is made by the CLI itself, which refuses a `.agent-desktop` other users can read; the test fixtures now match that.

### Fixed

- The CLI is now shipped prebuilt under `prebuilt/`, so the extension needs no global `agent-desktop` install and no Rust toolchain to work. The build is committed and synced by hand with `npm run link:cli:build` when the submodule moves.
- The snapshot taken after an action inherited the CLI's 3s observation deadline, which often expires mid-repaint, so a click that landed reported a failed follow-up. It now gets 10s.
- That failure also swallowed the CLI's own message; it is now reported, so a repeat failure is diagnosable rather than a sentence to retry blindly.
- The pid was read from the timestamp field of a `run-<µs>-<pid>-<n>` id, so no session ever looked alive and a live run's record was pruned out from under it — the "pruned N session record(s)" notice at the end of a turn. It reads the pid field now, and the 30s grace it relies on is documented as the real guard.
- The verification snapshot sent `--app undefined` for a ref-only call, which the CLI matched against an application literally named "undefined", so every click by ref reported a failed follow-up. `--app` is omitted when the call has no `app`.
- When the follow-up does read a different app than the action's (a ref-only call has no app to read back, so it gets the frontmost window), the result names the drift instead of presenting the wrong tree as the new state.
- The drift check only fired for a call that named an `app`, which is the case where it cannot drift. The app of the last snapshot is now remembered, so a ref-only call — the one that actually reads the frontmost window — gets the warning.
- The drift warning keyed off the newest snapshot, so a `launch` or `focus_window` in between rebound it and a ref from the older window got no warning again. Snapshot ids are now remembered per snapshot, and the ref's own id names the app it belongs to.

### Synced to upstream v1.3.1-7 (c7a1e64)

- The vendored launcher, `lib/` and `package.json` are regenerated from the new submodule, so `prebuilt/` and `upstream/` agree again.
- Binaries rebuilt from source; the vendored CLI still reports 1.3.1 — these are unpublishable commits on `lazuee/agent-desktop` `main`, not a release (AUTORELEASE puts a `chore: release` commit on `main` just before a release).
- Carried: macOS cursor overlay no longer hides itself on every headed command; `check`/`uncheck` press a tab button instead of writing `AXValue`, which crashed Chromium on web tabs; permission guide names the app that actually started the process tree under tmux; `sandbox start` can answer `needs_setup`.
