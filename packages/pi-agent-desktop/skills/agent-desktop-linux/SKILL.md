---
name: agent-desktop-linux
tags: linux-automation, accessibility, at-spi, ai-agent, gui-automation, cli
requirements:
  - agent-desktop
description: >
  Linux setup and troubleshooting for agent-desktop: the AT-SPI bus, toolkit identity, X11 versus Wayland, capture consent, and headless refusals.
---

# agent-desktop on Linux

Use the core skill's headless observe, act, verify workflow. A platform capability never authorizes `--headed`; only the user's explicit request does.

## Setup and permissions

Use an `at-spi2-core` bridge with fix `dc0dc33` before observing applications. Ubuntu 22.04's older bridge can abort the target on `Action.GetActions`; a reachable bus does not prove it is safe.

Run `agent-desktop status` as the target's user in the same desktop session. It probes the AT-SPI registry through the session's accessibility bus: `permissions.accessibility` is `granted` when the registry answers, even if `list-apps` is empty. `denied` with no `supported_surfaces` means the bus is unavailable, not an empty desktop. Follow the reported setup suggestion. `automation` is `not_required`. `screen_recording` is `not_required` when the X11 capture probe answers and `unknown` on Wayland or an unproven display.

There is no accessibility permission dialog. The target must share the bus, including through a sandbox. Restart an app that predates the bus only after preserving its work. Never restart another user's or a shared host's live bus; use a private session and runtime directory for isolated work.

## Platform behavior

- Semantic AT-SPI observation and actions work on X11 and Wayland. A reachable accessibility bus does not establish pointer, window-control, capture, shell, notification, or tray capability.
- GTK refs can retain native element addresses and ancestry. Chromium, Qt, and unknown-toolkit refs must be unique in the window or inside their nearest unique ancestor. Take fresh refs after list changes; a narrower drill does not disambiguate identical twins.
- A table reports `row_count` and `column_count`, and a large sheet is read by its cells in view. While a window shows a sheet read this way, a ref that carries no native element address is refused: a twin could sit among the cells that were not read. A cell's text is its `value`. Where a spreadsheet names a cell by its address, get it with `find --role cell --name B7 --root '<table ref>'`. `set-value` on an editable cell takes a number; text has no background route and is refused. `click` and `select` on a table cell select it where the table supports that; a GTK3 tree view does not.
- GTK4 list-backed dropdowns stay in the window tree. Use `wait --text` and `snapshot --root` to read their contents, not a menu-surface wait. Menu-role popups use the menu surface instead.
- Popup and dialog openers can take the foreground and refuse headless. Qt combo selection may need pointer input to commit rather than highlight a row. Stop on a headed-only refusal instead of changing mode.
- A headless graceful `close-app` reads which window has the focus first. When it cannot (a Wayland session, or an owner it cannot identify), it fails with `POLICY_DENIED` (`details.kind: focus_unreadable`) before any close request is sent. Report it to the user, or use `--force`, which discards unsaved work.
- A window can precede its content. Wait for the application's observable result; an accepted AT-SPI call or a changed selected value is not proof that dependent handlers ran. Wait for each effect before another click.
- Wayland refuses headed pointer input; window operations can use a mapped Xwayland client, but native Wayland windows lack that route.
- Authorized physical `type` sends a newline as `Return` on X11 too. It refuses a tab and other control characters.
- Authorized physical `type` on Wayland sends a newline as `Return` and a tab as `Tab`, which can submit a form or move focus instead of inserting literal text.
- Wayland per-window screenshots are unsupported; display capture uses a portal that can ask for consent. Ask the user before initiating a visible consent flow, and do not retry a pending portal request in a loop.
- X11 capture depends on compositing: a covered noncomposited window may have no readable pixels, and a composited desktop may not support whole-screen capture. Neither failure authorizes focusing the target.
- Shell notifications require the supported GNOME service; tray reads require a StatusNotifierWatcher. A missing service is an error, not an empty list.
- Password-role values are withheld, but a field that merely masks its text can still be readable. Treat observation output as sensitive.
- `launch` accepts a program on PATH, an absolute path, an installed desktop id, or an unambiguous desktop entry name. Use process and window identity from observations rather than guessing from a window title. Without `--activate`, a launch on X11 gives the focus back to the window that had it when the new window took it, and reports `focus_returned: true`.
- `press escape --app <app> --window-id <id>` on a background window that shows an open combo box or popup button popup closes it through the owner's own action and reports `delivered_verified` once a read shows it gone, or the owner's own failure. With no open popup the focus refusal stands. It never collapses a tree row.
- Sandboxes are not available on Linux yet. To run agent-desktop in a container you manage yourself, see `agent-browser.dev/desktop/guides/docker-container`.

## Troubleshooting

Read the disposition before applying a fix. Match both the code and message.

| Code and message pattern | Cause and fix |
| --- | --- |
| `PLATFORM_NOT_SUPPORTED`: session bus or accessibility bus unavailable | Run in the target's desktop session. Install `at-spi2-core` if missing and share the accessibility bus with sandboxed targets; do not restart a shared live bus. |
| `APP_NOT_FOUND`: running but not on the accessibility bus | The process has not registered or its toolkit is inaccessible. Preserve work before restarting; Chromium may need `--force-renderer-accessibility`, and Qt needs `QT_ACCESSIBILITY=1` at launch. |
| `STALE_REF`: `Stored ref does not match any live element` (`resolve_no_candidate`) | The adapter could not land the ref. Take a fresh snapshot in the same session; do not infer delivery from the missing target. |
| `POLICY_DENIED`: foreground, popup, dialog, or pointer required | The operation cannot run headless. Stop and tell the user which operation needs headed mode; do not add `--headed`. |
| `ACTION_NOT_SUPPORTED`: Wayland pointer input, window operation, or native popup requires input | The display server or toolkit cannot provide the route. Use an exposed semantic operation when available, or report the capability limit. |
| `PERM_DENIED` or `TIMEOUT`: screenshot portal consent | The portal denied capture or is waiting for the user. Ask the user to handle consent; do not loop or attempt to automate the inaccessible prompt. |
| `PLATFORM_NOT_SUPPORTED`: missing clipboard owner helper or `wl-clipboard` | X11 needs the shipped owner helper beside the binary; Wayland needs `wl-copy` and `wl-paste`. Repair the installation instead of treating the clipboard as empty. |
| `PERM_DENIED`: `private file parent is accessible by group or other users` | The state root is not private. Run `chmod 700 "${AGENT_DESKTOP_HOME:-$HOME/.agent-desktop}"`, or use a new state root and let the tool create it. |
| `PERM_DENIED`: `private file parent is not owned by the effective user` | The directory belongs to another user. Point `AGENT_DESKTOP_HOME` at a new directory under your home and let the tool create it; do not take over someone else's state. |
