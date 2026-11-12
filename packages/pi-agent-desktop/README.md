# @lazuee/pi-agent-desktop

Pi extension that lets the agent drive desktop apps on macOS, Windows and Linux through their native accessibility trees.

It wraps the [`agent-desktop`](https://github.com/vercel-labs/agent-desktop) CLI, so nothing about an app is app-specific: the accessibility tree works for any window that exposes one.

## Requirements

The extension is a wrapper: it ships no CLI of its own and needs `agent-desktop` installed once.
Without it the tool reports `agent-desktop is not on PATH` and every call fails.

## Install

```bash
npm install -g agent-desktop
```

Then install the package and pick the platform skill once:

```bash
agent-desktop status
agent-desktop skills get platform
```

`status` reports permissions. macOS needs Accessibility; the other platforms report what their backends need.

A source checkout under `upstream/` is a launcher, not a binary: it works only once npm's postinstall has put the native binary beside it.
The extension probes both, so it uses that checkout when it answers (a local patch is then live at once) and otherwise falls through to the `agent-desktop` on your `PATH`.
`open_system_surface` is not implemented on macOS (the trait method is a `not_supported` default no macOS adapter overrides), so it refuses as `PLATFORM_NOT_SUPPORTED` there whatever build answers.
The vendored 1.0.2 build also lacks the `dock` and `menu-bar-extras` snapshot surfaces it would cover, so on that build the Dock and the status items are not reachable by surface — `list-surfaces --app Dock` comes back empty even though the Dock runs.
An installed 2.6 CLI does support both `snapshot --surface dock` and `--surface menu-bar-extras`; the bundled checkout wins discovery, so update the submodule to get them.

## What it exposes

One tool, `agent_desktop`, with an action enum:

| Kind | Actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read | `snapshot`, `find`, `list_apps`, `list_windows`, `list_displays`, `list_surfaces`, `list_notifications`, `screenshot`, `get`, `is`, `wait`, `version`, `skills`, `session`, `trace`, `status`, `permissions`                                                                                                                                                                                                                                                                                                                                            |
| Act  | `click`, `type`, `press`, `set_value`, `select`, `scroll`, `hover`, `drag`, `mouse_click`, `mouse_wheel`, `right_click`, `double_click`, `toggle`, `check`, `uncheck`, `expand`, `collapse`, `clear`, `focus`, `scroll_to`, `triple_click`, `launch`, `close_app`, `focus_window`, `maximize`, `minimize`, `restore`, `move_window`, `resize_window`, `clipboard_get`, `clipboard_set`, `clipboard_clear`, `open_system_surface`, `dismiss_notification`, `dismiss_all_notifications`, `notification_action`, `cursor_overlay`, `trace_export`, `batch` |

Every result is plain text — the CLI's `data` envelope is unwrapped, never handed over as JSON, on an action's follow-up snapshot as much as on a read.
`get` reads one `property` of a ref (`text`, `value`, `title`, `bounds`, `role`, `states`) and `is` checks one `state`; both take a `ref`.
Both answer as `<property>: <value>`, and a `get` is never clamped — it is how you read whole what a snapshot line abbreviates.
`get bounds` returns exact points, so it is the precise way to locate an element — better than a pixel estimated from a screenshot.
`is` answering _not applicable_ means the element has no such state, which is not the same as false.

`snapshot` before acting, and map cheaply: `interactive_only` drops static text, `skeleton` and `compact` shrink the shape further, and `root` drills one region instead of re-reading the window.
`skeleton` only cuts a page deeper than the depth limit, so pair it with `interactive_only` rather than relying on it.
Every action answers with a fresh snapshot, so the refs it returns are the current ones — the CLI's refs are snapshot-scoped, and an old ref is stale by construction.

Prefer `ref` (`@e3`), and check `available_actions` first: click only what advertises `Click`, since a bare text field advertises `TypeText` and a click on it fails in either mode.
An app with several windows refuses as `AMBIGUOUS_TARGET`; pass `window_id` from `list_windows` to choose one.
`window_id` is accepted by `snapshot`, `screenshot` and `press` only — a ref already names its own window, and the other commands reject the flag.
Pin `window_id` also when an app may be running twice: a second instance leaves `list_windows` unambiguous while an app-only target flips between them.
The red traffic light only hides a window, so instances accumulate across runs; quit the app rather than closing its windows.
A node the platform gave no ref uses its `at` with `mouse_click`, the only click that takes coordinates; `x`/`y` are its arguments, and a negative one is sent in the `--xy=-100,50` form.
`drag` takes a `to_ref` for its destination.
`screenshot` returns the window as an image the model sees, with its pixel size in the text beside it.
The image is device pixels while the coordinates above are accessibility points, so the text names the ratio; divide a pixel by it before passing `x`/`y`.
The shot is also padded by the window shadow, which is why `x`/`y` is the fallback rather than the default — a ref needs no arithmetic.
`press` is the exception: its only positional is the combo, so it goes to the focused window unless an `app` names one.

## Background by default

The extension runs alongside your own work: it does not steal focus and does not move your cursor unless asked.

Every action goes through the accessibility tree.
Only `hover` and `drag` _are_ pointer movements in the CLI, and it refuses those headless with `POLICY_DENIED`.
Both are opt-in per call with `headed: true`.

```text
hover   { action: "hover", ref: "@e12", headed: true }
drag    { action: "drag", ref: "@e12", to_ref: "@e19", headed: true }
```

`click` also takes it, because the CLI declines rather than falls back physically for an element with no semantic delivery (a bare text field advertises `TypeText`, not `Click`).
Which elements those are is only visible in the error, so pass `headed` when a click is refused for `supported_action`.

When one does run, the session's cursor overlay draws where it lands, so the jump is followable.
The overlay is presentation only and never replaces the OS pointer; a platform without a renderer reports `rendered: false` rather than failing.

## Scope

This wraps the whole CLI command surface, and every action is contract-tested against the real binary.
The bundled `agent-desktop` skill is still the reference for what a command means and when to reach for it.
Run `agent-desktop <command> --help` for flags; the skill does not repeat them.

Six CLI commands have no action: `key-down`, `key-up`, `mouse-down`, `mouse-up`, `help` and `mcp`.
The first four fail with `ACTION_NOT_SUPPORTED: ... unavailable in stateless mode`, `--headed` included, because they exist for the stateful FFI API; `press`, `mouse_click` and `drag` are the composite forms that work, so nothing is lost by leaving them out.
`help` repeats what `skills` prints, and `mcp` serves the CLI over stdio rather than being one call.
What is left out of the `trace` and `cursor_overlay` flags is depth, not capability: `trace` exposes `show` and `export` with `--limit`/`--out`, and the overlay its `enable`/`disable`, so a style unchanged by the defaults needs the CLI directly.

Nested CLI groups are one action plus `sub`: `skills` (`list`, `get`, `path`), `session` (`start`, `end`, `list`, `gc`), `trace` (`show`, `export` via `trace_export`) and `cursor_overlay` (`enable`, `disable`).
`session start` mints a new session id and the extension adopts it, so the refs it seeds are the ones later calls use.
A session is started and ended around every run — one directory per turn — so `trace` reads one turn rather than the whole Pi session, and `session list` is that long.
That is the run's only session and it is ended exactly once: a `session start` or `session end` you call yourself as a tool takes over the run's session, so it replaces the hook's bookkeeping instead of sitting in a second, parallel one.
Shutdown prunes the ones older than a day, then, so the store does not grow without bound; run `session gc --older-than <s>` yourself to reach further back or clear now.
It also removes a record a killed run left open — a reload leaves one, and gc never reaches one from today — but only when that run's process is gone and its manifest shows no end, so another live Pi's session is left alone.

`batch` runs CLI commands back to back with no round trip.
Steps are `{ command, args }` with `args` keyed by the CLI's long option names (`{ ref: "@e3", headed: true }`).
There is no snapshot between steps, so a ref goes stale after the first act; end the batch with a `snapshot` step when you need to see the result.
A batch is not atomic and does not fail as a whole — each result carries its own verdict.
Reach for it when several acts belong together and you do not want the first one's result to renumber the refs before the next.

`version` answers the CLI's own version, OS and architecture — the first thing to check when a command behaves unlike its help.
`trace show` reads the run's recorded events (`--limit`ed, `--event`-filtered) to see what was actually attempted; `trace_export` writes the same timeline to a standalone HTML viewer for a person to open.
`cursor_overlay enable` draws the agent cursor so a human watching can follow where actions land; it is presentation only and never replaces the OS pointer.
`skills` fetches the compiled-in guides — `get desktop` before a long session, `get <platform>` for the OS's differences — so the reference cannot drift from the installed binary.

Notifications are an OS queue, not a window: the index is positional and guarded.
`dismiss_notification` and `notification_action` take an `index` from `list_notifications` plus `expected_title` (and `app` when known), because the queue shifts between listings.
Mutations are always ones that open and focus the notification surface, so they are always headed.
`dismiss_all_notifications` is the one mutation that needs no listing, so it still works when the queue cannot be read.

On macOS 26 the notification commands come back empty however the center is opened, and it is not a permissions or plumbing failure.
Reading the app element directly with `AXUIElementCopyAttributeValues("AXWindows")` — the call the adapter makes — succeeds with three windows, and every one of them reads role, title and children fine.
Those three are only widget windows (`Featured`, a weather widget, a calendar widget); the notification list is a fourth window macOS 26 does not create, and no notification row is ever among them while macOS holds records for the same period.
`AXStackingIdentifier`, which the adapter also probes, answers `kAXErrorAttributeUnsupported` (-25205) on all three.
It is not specific to this adapter: over the same window, with a banner just posted, System Events reports exactly those three names and nothing else, and `UserNotificationCenter` — the process that draws banners — exposes a menu bar but no windows at all.
Both the bundled 1.0.2 and an installed 2.6 CLI behave identically, headless and headed, so the wiring below is in place but unproven against a non-empty queue there.

Use [`@lazuee/pi-macos-harness`](../pi-macos-harness/) instead when the work is macOS-only and you want screenshots attached to every read.

## Layout

- `src/extension.ts` — the tool, the CLI invocation, and the session bookkeeping.
- `skills/agent-desktop/` — the upstream skill, copied from the checkout so it matches the CLI it documents, plus one local section on how the tool relates to it.
- `upstream/` — git submodule of `vercel-labs/agent-desktop`, Apache-2.0.
  Not published; see `LICENSE`.

## Development

```bash
pnpm --filter @lazuee/pi-agent-desktop run test
pnpm --filter @lazuee/pi-agent-desktop run check
pnpm --filter @lazuee/pi-agent-desktop run lint
```

The tests pin the argument contract against the CLI's real spellings — positional refs, `--from-xy x,y`, `--direction`/`--amount`.
`test/cli-contract.test.ts` goes further and parses every action through the built binary, which is what caught three shape defects the unit tests could not.
It skips unless `upstream/` is built.

`test/startup.test.ts` pins discovery in both directions: the checkout is used when it answers, and skipped when it cannot.
The checkout is a launcher that needs the native binary beside it, so a bare submodule clone is deliberately not enough.

Refresh the bundled skill after a submodule bump.
It is upstream's file plus a local "How this package relates to the CLI" section, so save that section and re-append it: a bare `cp -R` copies into the existing directory and loses it.

```bash
sed -n '/^## How this package relates to the CLI/,$p' \
  packages/pi-agent-desktop/skills/agent-desktop/SKILL.md > /tmp/local-section.md
git -C packages/pi-agent-desktop/upstream submodule update --init --recursive
rm -rf packages/pi-agent-desktop/skills/agent-desktop
cp -R packages/pi-agent-desktop/upstream/skills/agent-desktop packages/pi-agent-desktop/skills/
cat /tmp/local-section.md >> packages/pi-agent-desktop/skills/agent-desktop/SKILL.md
```
