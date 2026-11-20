---
name: agent-desktop-macos
tags: macos-automation, accessibility, ax, tcc, ai-agent, gui-automation, cli
requirements:
  - agent-desktop
description: >
  macOS setup and troubleshooting for agent-desktop: accessibility permissions, native element identity, application-owned surfaces, and headless refusals.
---

# agent-desktop on macOS

Use the core skill's headless observe, act, verify workflow. A platform capability never authorizes `--headed`; only the user's explicit request does.

## Setup and permissions

The sandbox provider on macOS is `macos`: a macOS VM needing an Apple Silicon Mac, macOS 13 or later on the host and guest, and Xcode Command Line Tools. The first setup needs a person in the guest window; clones need none. See `agent-browser.dev/desktop/sandboxes/macos`.

`agent-desktop status` reports `permissions` and `supported_surfaces`. Accessibility must be `granted` for observation and actions, Screen Recording for screenshots including session artifacts. Grant the launching app, and the binary if listed separately. Ask the user, then confirm with `agent-desktop permissions`. A new CLI call sees a new grant; a batch keeps its cached report.

`permissions` does not prompt. The guide opens a visible settings page, so ask the user first; it offers the app that started the process tree (under tmux, the app that started the tmux server, which can differ from your terminal; under SSH, the binary). Automation may report `unknown` when consent would require a prompt.

## Platform behavior

- Native AX element tokens identify individual controls, including twins. A stale token never falls back to a look-alike search; elements without one follow the core rule.
- `list-windows` also lists a floating or panel window an app raises above the normal level, as accessory apps do with settings and panels, while it is on screen.
- `menu` and `menubar` observations are application-owned and can omit `data.window`. An app without an ordinary window may still expose process-owned surfaces. Inspect `supported_surfaces` rather than assuming every surface exists.
- `agent-desktop press escape --app <app>` closes an open menu or popover with its cancel action when no focused element takes Escape, and reads that it closed. A popover can appear a moment after the click that opens it: read it with `snapshot --app <app> --surface popover`.
- `list-surfaces` lists the sheets, dialogs and popovers of every window, not only the focused one. A system service panel, such as AirDrop from a share, is a dialog.
- A control with no ref takes a headless window-relative click: capture with `screenshot --window-id w-4521 --window-frame f.png`, divide image coordinates by `scale_factor`, then `mouse-click --window-id w-4521 --window-xy 120,95` in points from the frame's top-left. Target the frontmost on-screen window; a window behind a sibling of the same app is refused because macOS reorders it on click. The post is `delivered_unverified`.
- Headless menu-opening and dialog-opening actions can refuse before delivery. A label ending in an ellipsis predicts a dialog; it does not prove one exists. A click on a button inside a popover refuses with `kind: popover_command`: a share item starts a service whose window takes the front. Stop on a headed-only refusal rather than changing mode.
- A file-name text field is not a file-system rename interface. Value-write actions refuse it because a changed field could falsely imply a renamed file.
- Chromium accessibility is enabled by the adapter when needed. A sparse or incomplete read still needs another observation, not an assumption of absence.
- A table cell carries its grid address in `native_id` (kind `grid_cell`, for example `B7`), or its own identifier when it has one; the address finds it either way. Get one cell with `find --role cell --native-id B7 --root '<table ref>'`. A cell that spans several rows or columns has no address.
- `set-value` and `clear` on a table cell that lists `SetValue` write its value directly when the cell takes one. Any other cell is written through its own editor and committed with Return, without activating the app. Text and Return go only to that editor. An application that moves a value into an editor of its own, as a spreadsheet does with a formula that starts with `=`, leaves it typed and open, and the write fails as `delivered_unverified`: commit it with `press return --app <app>`. The cell is read after the commit: a cell that still shows nothing fails as `ACTION_FAILED` with `delivered_unverified`, and one that shows another value stays `delivered_unverified`. An application that gives its cell editor no keyboard input from a press always takes that failure; type there with `--headed` only if the user explicitly asked for that. The write also commits an edit that is open in another cell.
- A tab (`AXRadioButton` with subrole `AXTabButton`) is said to be selected, not checked. `check` on one presses it rather than writing `AXValue`, because writing `AXValue` on a web `role="tab"` crashes Chromium-based browsers. Some web tab widgets ignore that press, so `check` reports that the state was not reached; select those with `click --headed`.
- AX success alone does not prove an application effect. Verify the task's result independently, especially after a menu action or a value write.

## Troubleshooting

Read the disposition before applying a fix. Match both the code and message.

| Code and message pattern | Cause and fix |
| --- | --- |
| `PERM_DENIED`: Accessibility or Screen Recording permission | The launching app lacks the relevant grant. Ask the user to grant it, then check `permissions` in a new CLI call. |
| `POLICY_DENIED`: interaction policy, menu, dialog, or physical route | The operation cannot run headless. Stop and tell the user which operation needs headed mode; do not add `--headed`. |
| `ACTION_NOT_SUPPORTED`: `The field shows a file's name` | A value write cannot prove a rename. Use the app's exposed rename operation or an authorized file-system operation, then verify the file itself. |
| `STALE_REF`: `Element not found` (`resolution_complete_absence`) | The adapter could not land the ref. Take a fresh snapshot in the same session; do not infer delivery from the missing target. |
| `APP_UNRESPONSIVE`: accessibility action did not complete | A modal action may already have landed. If retry is unsafe, inspect the relevant surface and live state without repeating it. |
| `WINDOW_NOT_FOUND`: no window or requested surface | A running process need not own a window. Read `list-windows` and `list-surfaces`; wait for the needed surface instead of activating the app. |
| `PERM_DENIED`: `private file parent is accessible by group or other users` | The state root is not private. Run `chmod 700 "${AGENT_DESKTOP_HOME:-$HOME/.agent-desktop}"`, or use a new state root and let the tool create it. |
| `PERM_DENIED`: `private file parent is not owned by the effective user` | The directory belongs to another user. Point `AGENT_DESKTOP_HOME` at a new directory under your home and let the tool create it; do not take over someone else's state. |
| `needs_setup` from `sandbox status` for a sandbox that worked before | The guest agent, `agent-desktop-guest`, is not running in the guest, or Accessibility is off for it. Run `sandbox stop <name>`, then `sandbox start <name> --window`. In the guest, turn on automatic login, run `sh "/Volumes/My Shared Files/guest-setup.sh"` in Terminal, and switch on **agent-desktop-guest** in System Settings > Privacy & Security > Accessibility. Then check `status` on the host. A sandbox set up by agent-desktop 1.3.0 needs this once. |
| `ACTION_NOT_SUPPORTED`: `The packaged macOS clipboard helper is missing or invalid` | Every clipboard command runs the packaged `agent-desktop-macos-helper` beside the binary, and it is checked before launch: a regular file (not a symlink) owned by you, executable, one link, no group or world write, no ACL that lets someone else change it, under directories owned by you or root that are not group or world writable unless sticky. `details.kind` is `clipboard_helper_invalid` or `clipboard_helper_not_found`, and `platform_detail` names the failed rule. Repair the install; the clipboard is not empty. |
