---
name: agent-desktop
tags: computer-use, desktop-automation, accessibility, ai-agent, gui-automation, cli
requirements:
  - agent-desktop
description: >
  Operate desktop apps on macOS, Windows, and Linux through native accessibility trees with agent-desktop. Use for desktop GUI tasks: observe controls, click, edit fields, navigate menus, manage windows, launch apps, or read notifications.
---

# agent-desktop

## Critical: headless only by default

Every operation runs headless, which is the default. Add `--headed` only when the user explicitly asked for a visible, foreground, or physical operation. Some operations exist only in headed mode and return `POLICY_DENIED` headless. Then stop and tell the user which operation needs headed mode. Never add `--headed` on your own; never switch to headed mode to recover from a headless failure, even if an error suggestion proposes it.

`close-app --force` discards unsaved work. Use it only when the user accepts losing unsaved work. A recovery suggestion or a fresh-launch requirement does not supply that consent.

## First run

Run `agent-desktop status` to check permissions and `supported_surfaces`. If `state_root_privacy.ok` is false, tell the user the path and the fix that `status` reports; do not change permissions or delete saved state on your own. If setup blocks the task, read `agent-desktop skills get platform`:

- macOS needs Accessibility permission for the launching app, plus Screen Recording for capture.
- Windows needs an interactive desktop session and sufficient integrity for the target.
- Linux needs the target's desktop session and a reachable AT-SPI accessibility bus.

Use `agent-desktop <command> --help` for syntax when you need it. Permission requests run in a bounded isolated helper. Ask the user before opening permission prompts or a visible setup guide.

## Observe, act, verify

1. Observe with `agent-desktop snapshot -i --app "<app>"`. In a large window, take a skeleton and drill the relevant container with `--root`. Omit `-i` when you need static labels to distinguish rows.
2. Act on a qualified ref from that observation. Prefer a semantic ref action over coordinates, and `check` or `uncheck` over a state-reversing `toggle`.
3. Verify the requested outcome with an independent read: a fresh snapshot or a condition-based `wait`. Wait with `wait`, never a fixed sleep or a duration-only wait. A field value alone does not prove an application committed a change or saved a file.
4. On an error, branch on `error.code` and `error.disposition`, retry only when `disposition.retry` is `safe`, and follow `recovery.strategy`. Recovery guidance never overrides the headless rule.

`get` can fall back to saved values, names, bounds, or states, and `is` can use saved states. Only `get` bounds report `live`; use a fresh snapshot for post-action proof.

Fast path: one observation, then one call per step. These forms cover most tasks; replace `<...>` with values from real output and use `--help` only for anything else.

```bash
agent-desktop launch <program>                 # data.window means a window is ready; without it, wait --window
agent-desktop snapshot -i --app "<app>"        # interactive elements with refs
agent-desktop find --app "<app>" --role button --name "<label>"   # matching elements with refs, no full tree
agent-desktop click '@s8f3k2p9:e12' --wait-for "<role>:<text>"   # act, then return the snapshot showing the result
agent-desktop set-value '@s8f3k2p9:e4' "<text>"  # replaces the whole value; the headless route
agent-desktop type '@s8f3k2p9:e4' "<text>"       # inserts text at the caret and keeps the rest
agent-desktop get '@s8f3k2p9:e4' --property value
agent-desktop close-app "<app>"                # a save prompt keeps the app open; see --force below
```

If an action reports `data.surfaces`, inspect the overlay before acting on the window behind it. A menu, sheet, or alert needs its own surface observation. `data.details.surfaces: "not_read"` means that read failed, so run `list-surfaces` before assuming no overlay opened. Attached selector waits usually observe the parent window, not a separate popup. A gone match cannot prove that popup closed, and matching text elsewhere can satisfy an appearance wait. Use `launch` with a program name or path accepted by the platform. A running process or a launch result without `window` does not prove a window is ready. `launch --cdp [<port>]` opens a loopback DevTools port on a fresh Chromium-based process and returns `data.cdp`; a running app returns `ACTION_FAILED`, so `close-app` first. agent-desktop never talks to the port: hand it to a CDP client. While the port is open, any local process can control the app's web contents, including processes of other accounts on the same machine, because the DevTools port has no authentication. Request `--cdp` only for the step that needs it. `close-app` ends the exposure.

## Workflows

- Fewer round trips: when you already know the next steps, send them in one `batch`, for example `agent-desktop batch '[{"command":"click","args":{"ref_id":"@s8f3k2p9:e5"}},{"command":"wait","args":{"text":"<text>","app":"<app>","timeout":3000}}]'`. Entry args mirror the CLI arguments, with `ref_id` for the ref; an unknown field fails with `INVALID_ARGS` naming the accepted ones. `batch` runs sequential steps in one process, but outer `ok: true` and exit 0 can include failures. Read each entry's `ok`, even with `--stop-on-error`, which stops later steps after a failure.
- Lifecycle verification: put an action immediately before its event `wait` in the same batch so the baseline is captured before the action; a later event wait can miss an already-completed transition. A surface a click opens late is a state: `wait --surface <kind> --app <app>`.
- Targeting: use `find` when the role or name is known; explore a large window with a skeleton snapshot and a `--root` drill.
- Tables: a table node reports `row_count` and `column_count`; a skeleton keeps it as one node, so drill it with `--root`. `set-value` on a cell that lists `SetValue` writes the cell; read it again to verify. The platform skill says how cells are addressed.
- Parallel tasks: create a session per task with `session start` and pass `--session` or `AGENT_DESKTOP_SESSION` to every command. Each agent uses refs from its own snapshots.
- Concurrency: read-only observations of independent targets can run in parallel; actions take turns under the interaction lease. The caller must serialize multi-step edits to the same window because the lease does not make a workflow atomic.
- Visible cursors: `session start --cursor` enables the overlay on macOS, Windows, and Linux X11, not Wayland. It is presentation only, sends no input, and needs no `--headed`.
- Several cursors: add `--multi-agent` when starting a cursor session and pass a distinct `--agent-id` per agent on its commands; this does not change session or ref ownership.
- Review afterwards: sessions trace by default; inspect the session with `trace show` or make a self-contained viewer with `trace export`.
- Secrets: run secret steps as separate `--stdin` commands, not batch JSON `text` or `value` fields, which expose secrets in process arguments. `--stdin` omits observed `value` fields from results; it does not redact later observations or screenshots.

## Refs and incomplete observations

Pass refs unchanged as `@<snapshot_id>:e<N>`, for example `@s8f3k2p9:e1`. Quote them in PowerShell, where a bare `@token` invokes splatting. Refs belong to their snapshot and session. `session start` does not activate later processes: a session-owned ref still requires the same `--session` or `AGENT_DESKTOP_SESSION`. Keep that scope from observation through verification.

After a UI change, re-observe the affected region. A root drill keeps its snapshot id and refs outside that subtree, including the root, but replaces descendant refs. Refs re-identify live elements; they are not coordinates or a promise that a widget instance survives. Without a native element token, identity must be unique in the whole window, or inside the nearest ancestor that is unique (a cell inside its row), at capture and resolution. Values and bounds are not identity.

- `STALE_REF` means no matching live element or a stale native token. Observe again.
- `AMBIGUOUS_TARGET` means multiple matches or unproven capture identity. Identical twins that no unique ancestor separates stay ambiguous after another snapshot or a narrower drill; choose a unique control. If capture identity was unproven because the read was incomplete, finish the observation before acting.
- `SNAPSHOT_NOT_FOUND` means the snapshot is absent in the current scope. Check the session before taking a replacement snapshot.

Read `data.complete` even on success: `complete: false` or `truncated` means missing evidence, not absence; use a larger budget or drill a proven root. For `identity_unproven` on a tokenless ref, take a new whole-window snapshot with enough budget; drilling that unproven ref cannot repair it. A timed-out root drill returns no partial replacement. A thin accessibility tree does not prove an empty window or folder.

## Sandboxes

A sandbox is a desktop a provider manages on your machine. The provider is `macos`: a macOS VM on an Apple Silicon Mac running macOS 13 or later. Linux and Windows have no provider; to run agent-desktop in a container you manage yourself there, follow `agent-browser.dev/desktop/guides/docker-container`.

```sh
agent-desktop sandbox install                          # report the provider's state
agent-desktop sandbox install macos                    # compile and sign the VM host and guest agent, then report ready
```

```sh
agent-desktop sandbox create demo --provider macos --set from=base   # clone a set-up sandbox; or --set ipsw=latest to install
agent-desktop sandbox start demo                       # start it headless; add --window to show its desktop
agent-desktop sandbox status demo                      # state, message and next command
agent-desktop sandbox list                             # every sandbox and its state
agent-desktop sandbox exec demo -- status              # run a command in the guest
agent-desktop sandbox stop demo                        # stop the sandbox
agent-desktop sandbox rm demo                          # remove it
```

Names are 1–32 lowercase letters, digits or hyphens, starting with a letter or digit. `exec` runs the guest's `~/.local/bin/agent-desktop` through `agent-desktop-guest` with the arguments after `--`; the agent does not run a shell. It returns the guest's envelope and exit status; a provider failure returns a host error. `rm` refuses a sandbox reported as `running`; stop it first. `create` needs exactly one source: `--set from=<sandbox>`, `--set ipsw=latest` or `--set ipsw=<path>`. `start` answers `working`, or `needs_setup` when the guest agent is not answering; wait for `status` to report `running` before `exec`.

Read `state`, `message` and optional `next`; `ok: true` alone does not mean the sandbox is ready.

- `unavailable`: satisfy the host requirements in `message` and `next`.
- `missing`: install the provider.
- `ready`: create a sandbox.
- `working`: repeat the command in `next` until the work finishes.
- `needs_setup`: have a person complete guest setup, then check status.
- `running`: run guest commands, or stop before removal.
- `stopped`: start the sandbox to use it, or remove it.
- `broken`: follow `next`; a broken sandbox may need removal.

A sandbox separates the desktop, not the network or the host. Sandboxes on one host share a virtual network, and a guest can reach the host's network services; keep one trust level per host. The host reaches the guest over the virtual machine's own socket device: only the process that runs the VM can open that connection, and `agent-desktop-guest` refuses any caller that is not the host. The host sends commands only to the agent whose key it recorded at setup, so another guest account cannot answer in its place. The agent runs the guest's `agent-desktop` with the arguments after `--` and never a shell. In the guest, Accessibility belongs to `agent-desktop-guest`.

Cloning a configured macOS VM has been tested end to end. Installing the first VM from a macOS image is experimental and has not been verified end to end. Provider setup steps and limits are in the docs: `agent-browser.dev/desktop/sandboxes/macos`.

## Delivery and damage prevention

Action results carry `data.disposition`; errors carry `error.disposition`. Only `not_delivered` permits a safe retry. `delivered_verified` confirms the reported readback, not the whole task. `delivered_unverified`, `delivery_uncertain`, and `unknown` do not prove that nothing happened. A click or select carries `effect`: `observed` verifies it; `indeterminate` (a change the app can make by itself, see `details.witness_diff`) and `not_observed` do not prove that nothing happened. If retry is unsafe or missing, read live state first and never repeat an action blindly; use `details.post_state` when present. An action can land even when `ok` is false.

Held input fails closed: `key-down`, `key-up`, `mouse-down`, and `mouse-up` cannot hold input across CLI calls until daemon-owned release exists. They return `ACTION_NOT_SUPPORTED`; headless mouse holds return `POLICY_DENIED` first. Use atomic input commands instead. `hover`, `drag`, `mouse-move`, `mouse-click --xy` and `mouse-wheel` need `--headed`; a macOS `--window-xy` click does not.

Do not bypass a blocked shortcut with `--force` unless the user authorized its effect. Notification indices are positions, not identities: list again and copy the expected app and title before a mutation.

Batch is not a transaction and does not roll back earlier entries. Never read a value through an app's own Copy command: it replaces the user's clipboard. Treat snapshots, screenshots, notification bodies, clipboard reads, and session artifacts as sensitive data.
