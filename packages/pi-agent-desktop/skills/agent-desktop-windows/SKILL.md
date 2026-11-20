---
name: agent-desktop-windows
tags: windows-automation, accessibility, uia, ai-agent, gui-automation, cli
requirements:
  - agent-desktop
description: >
  Windows setup and troubleshooting for agent-desktop: PowerShell refs, interactive sessions, UIPI, foreground-safe routes, and verification.
---

# agent-desktop on Windows

Use the core skill's headless observe, act, verify workflow. A platform capability never authorizes `--headed`; only the user's explicit request does.

## Setup and permissions

Run `agent-desktop status` in the signed-in user's interactive desktop session. `permissions.accessibility` reports whether UI Automation can be created: `granted`, `denied`, or `unknown`. `automation` is `not_required`; `screen_recording` is `not_required` when a capture backend is available, otherwise `unknown`. There is no permission dialog that bypasses a session or integrity boundary. Services, secure or locked desktops, and another user's session are not supported targets. Use `agent-desktop permissions` to recheck after the user fixes access.

Quote refs in PowerShell: `'@s8f3k2p9:e1'`. A bare `@token` invokes splatting. Use `$env:NAME = 'value'` for environment variables.

## Platform behavior

- A covered window can be driven headless; minimized controls report offscreen. Restore a minimized target and observe again rather than focusing it by reflex.
- UIPI (User Interface Privilege Isolation) blocks input into a higher-integrity process. Ask the user to run the CLI at the target's integrity level when needed; a working observation does not establish input permission.
- Headless routes use UIA patterns, legacy accessibility and native control messages; none takes the foreground. `agent-desktop type`, `agent-desktop right-click`, `agent-desktop focus`, an expand that opens a popup (combo box, menu), `agent-desktop scroll-to` on an item of a Win32 tree view and physical input need headed mode; a semantic value write may work instead when it matches the user's task. Never retry a refusal headed.
- A ref must be unique in its window, or inside its nearest unique ancestor (a cell inside its row), at capture and resolution. A root drill cannot make identical twins unique. Choose a distinct control.
- `press escape` with `--app` or `--window-id` on a window that is not in front is refused as before, unless that window shows an open menu, combo box or split button: then the innermost one is collapsed (`ExpandCollapsePattern.Collapse`), `delivered_verified` once read back closed. A tree item is never collapsed. `collapse` of an open combo box or menu item works headless, and reports `not_delivered` when it is already closed.
- A grid reports `row_count` and `column_count`. A row is a record: find it by its own name, and its cells through it. `agent-desktop click` on a grid cell that lists `Click` selects the row that holds it. A cell carries no grid position.
- `agent-desktop launch` takes an absolute executable path or a bare program name in the Windows or System32 directory, not an arbitrary display name or a PATH search. Without `--activate` the process starts with a show-window hint that asks for no activation. An application that activates itself anyway gets the foreground taken back for the window that had it, and the result reports `focus_returned: true`. A window you switched to is never touched.
- Chromium/Electron trees can be thin while accessibility settles. Finish a bounded observation before concluding that content is absent.
- An open application menu is the `menu` surface; there is no `menubar` surface. An owned popup window of the app (a ribbon drop-down) is a `popover`: `list-surfaces` lists it, `snapshot --surface popover` reads it. Shell surfaces are separate from ordinary window inventory. `quick-settings` refuses with `INVALID_ARGS` naming `action-center`.
- Notification reads adopt an already-open Action Center headless; opening it and notification mutations require headed permission. Indices can reorder: copy the expected app and title from a fresh listing before a single-item action.
- `agent-desktop wait --notification` opens and closes the center per poll when it was closed on entry, but leaves an already-open center open. Budget for the measured 1254.2 ms per poll median plus the polling interval; transient toasts can be missed.
- `agent-desktop cursor-overlay enable` reports `rendered: true` only after renderer acknowledgement. It does not move the physical pointer, and headed actions skip its travel animation.
- Sandboxes are not available on Windows yet. To run agent-desktop in a container you manage yourself, see `agent-browser.dev/desktop/guides/docker-container`.

Value verification is not application commit: `delivered_verified` with `element_value` confirms only the field. `unavailable` means readback evidence was missing, not that delivery failed. `post_action_verification` means the readback contradicted the request after delivery, so inspect `post_state` without retrying. Only `slider`, `incrementor`, `scrollbar`, and `handle` compare numeric values with tolerance; a `textfield` compares exactly, even if the app reformats it.

## Troubleshooting

Read the disposition before applying a fix. Match both the code and message.

| Code and message pattern | Cause and fix |
| --- | --- |
| `PERM_DENIED`: `UI Automation access is denied for this process` | A restricted token or noninteractive session cannot use UIA. Run in the user's interactive session with an allowed token. |
| `PERM_DENIED`: UIPI, integrity, or elevated target | The target has higher integrity. Ask the user to provide a matching-integrity caller; do not assume observation grants input access. |
| `POLICY_DENIED`: foreground, physical input, or closed Action Center | The route needs headed mode. Stop and tell the user which operation needs it; do not add `--headed`. |
| `STALE_REF`: `Stored ref does not match any live element` (`resolve_no_candidate`) | The adapter could not land the ref. Take a fresh snapshot in the same session; do not infer delivery from the missing target. |
| `ACTION_FAILED`: post-action verification or requested value mismatch | Delivery occurred but readback differs, possibly because the app reformatted the value. Inspect live state and `details.post_state`; do not repeat the write. |
| `PERM_DENIED`: `private file DACL grants an untrusted principal` | The state folder grants access beyond trusted principals. Keep only the user, SYSTEM, and Administrators on the folder, or point `AGENT_DESKTOP_HOME` at a new folder under the user profile and let the tool create it. |
| `PERM_DENIED`: `private file parent is owned by a foreign principal` | The state folder's owner is not eligible for this process. Point `AGENT_DESKTOP_HOME` at a new folder under the user profile and let the tool create it; do not take over another principal's folder. |
