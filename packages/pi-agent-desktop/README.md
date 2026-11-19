# @lazuee/pi-agent-desktop

Pi extension that lets the agent drive desktop apps on macOS, Windows and Linux through their native accessibility trees.

Computer use without screenshots or pixel matching: the agent reads a window's accessibility tree as text, every addressable element carries a `ref`, it clicks or types that ref, and the tool answers with the tree again to check the result. No model runs inside the extension — the read/act/read loop is the agent's.

It wraps the [`agent-desktop`](https://github.com/vercel-labs/agent-desktop) CLI, so nothing about an app is app-specific: the accessibility tree works for any window that exposes one.

## Privacy

A snapshot, a clipboard read, a screenshot, command output and the trace artifacts are all real desktop content, not sanitized summaries. They go to the model with the turn, so keep them out of anything you log, publish or upload — a snapshot of a mail client is that mailbox's subjects, and `clipboard_get` can return a password.

## Requirements

The package ships its own `agent-desktop` build under `prebuilt/`, so nothing has to be installed first. `prebuilt/` is a self-contained copy of the upstream npm package — its launcher, the lib it loads, and the release binaries — so it resolves with no submodule present, and it is the only local bin calls use.

The pair is a release build of [`upstream/`](upstream), committed rather than compiled on install, so the package stays installable with no Rust toolchain. It is synced by hand with `npm run link:cli:build` when the submodule moves. A global `agent-desktop` install is still the fallback for a machine without the checkout: discovery probes the shipped launcher first and falls through to whatever a global npm, bun, pnpm or yarn install put on `PATH`. Windows has no `sh` to carry the session id, so calls there run bare with `AGENT_DESKTOP_SESSION` in their environment and the lookup is `where.exe`.

On macOS the first real call needs Accessibility for whichever app pi runs in; `agent-desktop status` reports the grant.

## Install

```bash
pi install ./packages/pi-agent-desktop    # local, hot-reloadable via /reload
pi install git:github.com/lazuee/pi-packages
```

## What it exposes

One tool, `agent_desktop`, with an action enum:

| Kind | Actions |
| --- | --- |
| Read | `snapshot`, `find`, `list_apps`, `list_windows`, `list_displays`, `list_surfaces`, `list_notifications`, `screenshot`, `get`, `is`, `wait`, `version`, `skills`, `session`, `trace`, `status`, `permissions` |
| Act | `click`, `type`, `press`, `set_value`, `select`, `scroll`, `hover`, `drag`, `mouse_click`, `mouse_wheel`, `right_click`, `double_click`, `toggle`, `check`, `uncheck`, `expand`, `collapse`, `clear`, `focus`, `scroll_to`, `triple_click`, `launch`, `close_app`, `focus_window`, `maximize`, `minimize`, `restore`, `move_window`, `resize_window`, `clipboard_get`, `clipboard_set`, `clipboard_clear`, `open_system_surface`, `dismiss_notification`, `dismiss_all_notifications`, `notification_action`, `cursor_overlay`, `trace_export`, `batch`, `sandbox` |

Every result is plain text — the CLI's `data` envelope is unwrapped, never handed over as JSON, on an action's follow-up snapshot as much as on a read. `get` reads one `property` of a ref (`text`, `value`, `title`, `bounds`, `role`, `states`) and `is` checks one `state`; both take a `ref`. Both answer as `<property>: <value>`, and a `get` is never clamped — it is how you read whole what a snapshot line abbreviates. `get bounds` returns exact points, so it is the precise way to locate an element — better than a pixel estimated from a screenshot. `is` answering _not applicable_ means the element has no such state, which is not the same as false.

`snapshot` before acting, and map cheaply: `interactive_only` drops static text, `skeleton` and `compact` shrink the shape further, and `root` drills one region instead of re-reading the window. `skeleton` only cuts a page deeper than the depth limit, so pair it with `interactive_only` rather than relying on it. Every action answers with a fresh snapshot, so the refs it returns are the current ones — the CLI's refs are snapshot-scoped, and an old ref is stale by construction.

Prefer `ref` (`@e3`), and check `available_actions` first: click only what advertises `Click`, since a bare text field advertises `TypeText` and a click on it fails in either mode. An app with several windows refuses as `AMBIGUOUS_TARGET`; pass `window_id` from `list_windows` to choose one. `window_id` is accepted by `snapshot`, `screenshot` and `press` only — a ref already names its own window, and the other commands reject the flag. Pin `window_id` also when an app may be running twice: a second instance leaves `list_windows` unambiguous while an app-only target flips between them. The red traffic light only hides a window, so instances accumulate across runs; quit the app rather than closing its windows. A node the platform gave no ref uses its `at` with `mouse_click`, the only click that takes coordinates; `x`/`y` are its arguments, and a negative one is sent in the `--xy=-100,50` form. `drag` takes a `to_ref` for its destination. `screenshot` returns the window as an image the model sees, with its pixel size in the text beside it. The image is device pixels while the coordinates above are accessibility points, so the text names the ratio; divide a pixel by it before passing `x`/`y`. The shot is also padded by the window shadow, which is why `x`/`y` is the fallback rather than the default — a ref needs no arithmetic. `press` is the exception: its only positional is the combo, so it goes to the focused window unless an `app` names one.

`wait` is how an async step is waited for, and text is only one form: `wait_text` returns as soon as the words appear, `wait_event` blocks on a desktop signal (`window-opened`, `window-closed`, `app-launched`, `app-terminated`, `focus-changed`, `surface-appeared`, `surface-dismissed`) that a baseline diff detects without an id up front, and `menu`, `menu_closed` and `notification` are the surface and queue forms. `wait_element` with `predicate` (`exists`, `enabled`, `visible`, `actionable`, `value`) is the element form; a raw `wait_ms` is the race the others avoid.

`launch` waits for a window, so a cold session can start. It takes `launch_args` and `launch_env` for the app, `cwd`, `no_attach` for a fresh instance rather than attaching to a running one, and `cdp` to expose a DevTools endpoint. `close_app` takes `force` for an app that will not quit. `drag` takes `drop_delay_ms` when the drop target needs a hover first, and `wait_for`/`wait_for_gone` with `wait_for_scope` when the gesture changes the screen.

`clipboard_get` reads the clipboard and `format: "image"` writes it to a file; `clipboard_set` takes `text`, `stdin_text` for text that is long or starts with a hyphen, `image` for a PNG path, or `file_url` for paths as file references — which is what a Finder paste takes. On a Homebrew install the clipboard commands can refuse with `ACTION_NOT_SUPPORTED` because the helper sits under `/opt/homebrew/lib`, which Homebrew makes group-writable; `chmod g-w /opt/homebrew/lib` once fixes it.

## Background by default

The extension runs alongside your own work: it does not steal focus and does not move your cursor unless asked.

Every action goes through the accessibility tree. Only `hover` and `drag` _are_ pointer movements in the CLI, and it refuses those headless with `POLICY_DENIED`. Both are opt-in per call with `headed: true`.

```text
hover   { action: "hover", ref: "@e12", headed: true }
drag    { action: "drag", ref: "@e12", to_ref: "@e19", headed: true }
```

`click` also takes it, because the CLI declines rather than falls back physically for an element with no semantic delivery (a bare text field advertises `TypeText`, not `Click`). Which elements those are is only visible in the error, so pass `headed` when a click is refused for `supported_action`.

When one does run, the session's cursor overlay draws where it lands, so the jump is followable. The overlay is presentation only and never replaces the OS pointer; a platform without a renderer reports `rendered: false` rather than failing.

## Scope

This wraps the whole CLI command surface, and every action is contract-tested against the real binary. The bundled `agent-desktop` skill is still the reference for what a command means and when to reach for it. Run `agent-desktop <command> --help` for flags; the skill does not repeat them.

Six CLI commands have no action: `key-down`, `key-up`, `mouse-down`, `mouse-up`, `help` and `mcp`. The first four fail with `ACTION_NOT_SUPPORTED: ... unavailable in stateless mode`, `--headed` included, because they exist for the stateful FFI API; `press`, `mouse_click` and `drag` are the composite forms that work, so nothing is lost by leaving them out. `help` repeats what `skills` prints, and `mcp` serves the CLI over stdio rather than being one call. What is left out of the `trace` and `cursor_overlay` flags is depth, not capability: `trace` exposes `show` and `export` with `--limit`/`--out`, and the overlay its `enable`/`disable`, so a style unchanged by the defaults needs the CLI directly.

Nested CLI groups are one action plus `sub`: `skills` (`list`, `get`, `path`), `session` (`start`, `end`, `list`, `gc`), `trace` (`show`, `export` via `trace_export`), `cursor_overlay` (`enable`, `disable`) and `sandbox` (`install`, `create`, `start`, `stop`, `status`, `list`, `rm`, `exec`). A sandbox is a whole desktop on another host, so nothing it does shows in a local snapshot; `sandbox_exec` runs an agent-desktop argv inside it (`exec_args`). `session start` mints a new session id and the extension adopts it, so the refs it seeds are the ones later calls use. A session is started and ended around every run — one directory per turn — so `trace` reads one turn rather than the whole Pi session, and `session list` is that long. That is the run's only session and it is ended exactly once: a `session start` or `session end` you call yourself as a tool takes over the run's session, so it replaces the hook's bookkeeping instead of sitting in a second, parallel one. Shutdown runs `session gc --ended`, so ended sessions do not grow without bound; reach further back with `session gc --older-than <s>`. On settle and shutdown it also removes a record a killed run left open — a reload leaves one, and gc reaches neither that nor a directory with no manifest. A record is spared for its first 30 seconds, so a session still settling — and another live Pi's, which is young when it starts — is left alone; past that it is collected even when its manifest never recorded an end, since a reload is the usual reason one never did. The 30 seconds is what protects it: `session start` names the id after its own short-lived child, which has already exited when the start returns, so a live run's session never looks alive by its pid.

`batch` runs CLI commands back to back with no round trip. Steps are `{ command, args }` with `args` keyed by the CLI's long option names (`{ ref: "@e3", headed: true }`). There is no snapshot between steps, so a ref goes stale after the first act; end the batch with a `snapshot` step when you need to see the result. A batch is not atomic and does not fail as a whole — each result carries its own verdict. Reach for it when several acts belong together and you do not want the first one's result to renumber the refs before the next.

`version` answers the CLI's own version, OS and architecture — the first thing to check when a command behaves unlike its help. `trace show` reads the run's recorded events (`--limit`ed, `--event`-filtered) to see what was actually attempted; `trace_export` writes the same timeline to a standalone HTML viewer for a person to open — and that viewer is a full copy of the desktop content just described, so treat the file like the session itself. `cursor_overlay enable` draws the agent cursor so a human watching can follow where actions land; it is presentation only and never replaces the OS pointer. `skills` fetches the compiled-in guides — `get desktop` before a long session, `get <platform>` for the OS's differences — so the reference cannot drift from the installed binary.

`open_system_surface` opens a shell panel — the Dock, the status items, the Start menu — and is implemented by every adapter in the vendored build, macOS included. `supported_surfaces` from `status` is the authoritative list for the running one.

Notifications are an OS queue, not a window: the index is positional and guarded. `dismiss_notification` and `notification_action` take an `index` from `list_notifications` plus `expected_title` (and `app` when known), because the queue shifts between listings. Mutations are always ones that open and focus the notification surface, so they are always headed. `dismiss_all_notifications` is the one mutation that needs no listing, so it still works when the queue cannot be read.

On macOS 26 the notification commands come back empty however the center is opened, and it is not a permissions or plumbing failure. Reading the app element directly with `AXUIElementCopyAttributeValues("AXWindows")` — the call the adapter makes — succeeds with three windows, and every one of them reads role, title and children fine. Those three are only widget windows (`Featured`, a weather widget, a calendar widget); the notification list is a fourth window macOS 26 does not create, and no notification row is ever among them while macOS holds records for the same period. `AXStackingIdentifier`, which the adapter also probes, answers `kAXErrorAttributeUnsupported` (-25205) on all three. It is not specific to this adapter: over the same window, with a banner just posted, System Events reports exactly those three names and nothing else, and `UserNotificationCenter` — the process that draws banners — exposes a menu bar but no windows at all. The vendored build behaves the same headless and headed, so the wiring below is in place but unproven against a non-empty queue there.

Use [`@lazuee/pi-macos-harness`](../pi-macos-harness/) instead when the work is macOS-only and you want screenshots attached to every read.

## Layout

- `src/extension.ts` — the tool, the CLI invocation, and the session bookkeeping. A start and a `session gc` run unprefixed; everywhere else the session id rides in `AGENT_DESKTOP_SESSION`.
- `skills/agent-desktop/` — the upstream skill, copied from the checkout so it matches the CLI it documents, plus one local section on how the tool relates to it.
- `prebuilt/` — a self-contained copy of the upstream npm package: `bin/agent-desktop`, its `lib/`, its `package.json`, and the committed release binaries in `bin/`. This is what runs.
- `upstream/` — git submodule of `vercel-labs/agent-desktop`, Apache-2.0. Not published.

## License

MIT.

The `agent-desktop` binaries in `prebuilt/`, and the `upstream/` submodule they are built from, are [Apache-2.0](https://github.com/vercel-labs/agent-desktop/blob/main/LICENSE): the CLI and its helper stay under that licence. They are shipped compiled rather than as source, so `prebuilt/` is in the published `files` and carries that build with it.

## Development

```bash
mise run check                                   # parity + type-check
mise run fmt                                     # oxfmt + oxlint --fix
bun test packages/pi-agent-desktop               # behavioural tests
```

The tests pin the argument contract against the CLI's real spellings — positional refs, `--from-xy x,y`, `--direction`/`--amount`. `tests/cli-contract.test.ts` goes further and parses every action through the built binary, which is what caught three shape defects the unit tests could not. It skips unless `upstream/` is built.

`tests/startup.test.ts` pins discovery in both directions: the shipped copy is used when it answers, and skipped when it cannot. It is a launcher that needs the native binary beside it, so a half-copied one is deliberately not enough.

Refresh the bundled skill after a submodule bump. It is upstream's file plus a local "How this package relates to the CLI" section, so save that section and re-append it: a bare `cp -R` copies into the existing directory and loses it.

```bash
sed -n '/^## How this package relates to the CLI/,$p' \
  packages/pi-agent-desktop/skills/agent-desktop/SKILL.md > /tmp/local-section.md
git -C packages/pi-agent-desktop/upstream submodule update --init --recursive
rm -rf packages/pi-agent-desktop/skills/agent-desktop
cp -R packages/pi-agent-desktop/upstream/skills/agent-desktop packages/pi-agent-desktop/skills/
cat /tmp/local-section.md >> packages/pi-agent-desktop/skills/agent-desktop/SKILL.md
```
