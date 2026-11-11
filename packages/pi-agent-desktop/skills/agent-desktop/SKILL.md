---

name: agent-desktop
tags: computer-use, desktop-automation, accessibility, ai-agent, gui-automation, cli
description: "Operate desktop applications on macOS, Windows and Linux through native accessibility trees, using the agent-desktop CLI. Use when an AI agent must see or act on a desktop GUI: click buttons, fill forms, read UI state, navigate menus, toggle checkboxes, scroll, drag, type text, press shortcuts, take screenshots, manage windows, use the clipboard, launch or close apps, read notifications, batch several steps, follow a session trace, or move and wheel the pointer. Triggers on: \"click button\", \"fill form\", \"open app\", \"read UI\", \"computer use\", \"operate desktop\", \"accessibility tree\", \"snapshot app\", \"type into field\", \"navigate menu\", \"toggle checkbox\", \"take screenshot\", \"desktop automation\", \"agent-desktop\", \"batch clicks\", \"read notifications\", \"session trace\", \"move the mouse\", \"scroll at a point\", or any desktop GUI task on macOS, Windows or Linux."
---

# agent-desktop

agent-desktop is a CLI that lets an AI agent observe and operate desktop apps through the OS accessibility tree.
It is a tool, not an agent.
Every command prints one JSON envelope (`ok`, `data` or `error`), which the `agent_desktop` tool renders as text before you see it.
The JSON shapes below are what that text is built from.
The observe, act and verify loop runs in you.

## Shell syntax

Examples use a POSIX shell.
In PowerShell, quote every ref (`'@s8f3k2p9:e1'`), because a bare `@token` is the splatting operator.
Use `$env:NAME = 'value'` instead of `export`, and `| ConvertFrom-Json` instead of `$(...)` and `jq`.
The Windows skill has the PowerShell forms.

## First run

1. Run `agent-desktop status`.
   It reports the platform, permissions and `supported_surfaces`.
2. Run `agent-desktop skills get platform`.
   It loads the skill for the OS the binary runs on (macOS, Windows or Linux).
3. For flags and syntax, run `agent-desktop <command> --help`.
   This skill does not repeat flag lists.

## The loop

Use `find` when you know the role or exact name.
Otherwise map the app first and drill into one region.

```text
agent-desktop snapshot --skeleton --app "Notes" -i --compact   # shallow map, children_count on cut branches
agent-desktop snapshot --root @s8f3k2p9:e3 -i --compact        # drill into one region
agent-desktop click @s8f3k2p9:e12                              # act on a qualified ref
agent-desktop snapshot --root @s8f3k2p9:e3 -i --compact        # verify: re-read the same region
```

- A small app needs no skeleton.
  Take a full `snapshot -i`.
- Never skeleton a surface (`--surface menu`, `sheet`, `alert`).
  A surface is already focused.
- An action that opens a menu, sheet or alert lists it in `data.surfaces`.
  Target that overlay next.
- After an async step, use `wait` (see `commands-system.md`).
  A fixed sleep is a race.

## Refs

- Output refs are qualified: `@<snapshot_id>:e<N>`, for example `@s8f3k2p9:e1`.
  Pass them to later commands as they are.
- Refs are valid for one snapshot.
  After any UI change, re-drill the affected region or take a new snapshot.
- Only addressable elements get refs.
  Static text and inert containers do not.
- `STALE_REF`: the ref no longer matches the live UI.
  Take a fresh snapshot and use the new ref.
- `AMBIGUOUS_TARGET`: more than one live element matches.
  Narrow the target with `find --role --name --exact` or `--root`, then use the new ref.
- `SNAPSHOT_NOT_FOUND`: the snapshot id expired.
  Snapshot again.

## Delivery and retry

Action results carry `data.disposition` and errors carry `error.disposition`, each with `delivery` and `retry`.
Observation commands such as `snapshot` have none on success; their errors, and every `INVALID_ARGS` refusal, carry `not_delivered` and `retry: safe`.

- Retry or substitute an action only when `disposition.retry` is `safe`.
  Only `not_delivered` is safe.
- Any other delivery value means the action may have landed.
  A repeat can click, type or submit twice, and `toggle` can undo itself.
- On a result that is not safe, read the live state (`get`, `is`, or a fresh snapshot) and decide from that. `details.post_state` helps when present.
- Branch on `error.code` and `error.disposition`.
  Message and suggestion text can change.
- `details.retryable: false` means waiting cannot change the outcome.
  Try a different approach.

## Beyond one action

The tool covers the CLI's whole command surface, including the run bookkeeping around it.
These are grouped rather than one action each, so name the child in `sub`:

- `skills list|get|path` — the compiled-in guides. `get desktop` before a long session; `get <platform>` for what differs on this OS.
- `session start|end|list|gc` — the run's session.
  A start mints its own id; pass its `name` to label it.
- `trace show|export` via `trace` and `trace_export` — what the run actually attempted. `show` answers a timeline, `export` writes an HTML viewer for a person.
- `cursor_overlay enable|disable` — draw the agent cursor so a human can follow along.
  Presentation only; it never replaces the OS pointer.

`batch` takes `steps` of `{ command, args }` and runs them without a round trip.
A ref goes stale after the first act because nothing re-snapshots between steps, so finish the batch with a `snapshot` step when you need to see the result.
It is not atomic: each result carries its own `ok`, and `stop_on_error` halts at the first failure.

`mouse_move` parks the pointer at a point, and `mouse_wheel` scrolls at one; both take `x`/`y` and are always headed.
`mouse_click` is the only coordinate click, and `hover` the element-shaped move.

`open_system_surface --surface <name>` opens a shell panel such as the Dock or the status items.
It is not implemented on macOS, so reach those panels with `snapshot --surface dock` / `--surface menu-bar-extras` there, and expect the vendored checkout to lack both until its submodule is updated.

Notifications are an OS queue, not a window: `list_notifications` numbers them, and a single `dismiss_notification` or `notification_action` takes that `index` plus `expected_title` (and `app` when known) because the queue shifts between listings.
Mutations are always headed.
`dismiss_all_notifications` needs no listing, so it still works where the queue cannot be read — as on macOS 26, whose center exposes no notification rows to the accessibility tree.

`key_down`, `key_up`, `mouse_down` and `mouse_up` fail in stateless mode; use `press`, `mouse_click` and `drag` instead.

## Headless and headed

Ref actions are headless by default.
They use semantic accessibility calls and do not take focus, move the cursor, synthesize keys or use the clipboard.
If no semantic path exists, the action fails closed.
Use the global `--headed` flag only when the user explicitly permits physical input, such as double-click, hover, drag, or focus.
Never switch to headed mode to recover from a headless failure.
Raw coordinates (`--xy`) never imply focus.
Which actions need `--headed` differs by OS: read the platform skill.

## References

Load one only when you need it: `agent-desktop skills get desktop <reference>`.

| Reference              | Open it when                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `commands-observation` | You need `snapshot`, `find`, `get`, `is`, `screenshot`, `list-surfaces` semantics, partial trees, or the `--root` rules              |
| `commands-interaction` | You choose between click, type, set-value, select, toggle, scroll, press and mouse commands, or you debug an action error            |
| `commands-system`      | You launch or close apps, manage windows, use the clipboard, `wait`, `batch`, sessions, multi-agent cursors, tracing, or load skills |
| `workflows`            | You want worked patterns (forms, menus, dialogs, waiting for a new window, scroll-find, drag) and the anti-patterns list             |

## How this package relates to the CLI

This skill documents the `agent-desktop` CLI from [`vercel-labs/agent-desktop`](https://github.com/vercel-labs/agent-desktop) (Apache-2.0), copied here from `upstream/`.
The `agent_desktop` tool covers the whole CLI command surface with an action enum; anything not in it is reached by running `agent-desktop` directly in a shell.
When the two disagree, the CLI is authoritative — run `<command> --help`.

Writing an argument and it is rejected as an `unexpected argument`?
Check these first:

- A value beginning with `-` (`--headed` as text, a `--5` combo) needs the `--` terminator before it, with any flags ahead of that terminator.
- Negative coordinates need the `=` form: `--xy=-100,50`, `--from-xy=-100,50`.
  A negative `--amount` also needs it and is still invalid on its own.
- `scroll` needs a `ref`; it has no ref-less form.
- `click` only what advertises `Click` in `available_actions`.
  A bare text field advertises `TypeText`, not `Click`, and clicking it fails in both modes.
- An app with several windows refuses as `AMBIGUOUS_TARGET`; pass `--window-id` from `list-windows`.
  A second _instance_ of an app is worse than a second window: `list-windows` shows no ambiguity, yet an app-only target can resolve to the other one, so pin `--window-id` whenever an app may be running twice.
- Flags differ per command: only the reads (`snapshot`, `screenshot`, `list-windows`, `list-apps`) and `press` take `--app`, and `hover`/`drag` need `--headed` (this tool makes it opt-in per call with `headed: true`, which also rescues a `click` the CLI refuses for `supported_action`).
