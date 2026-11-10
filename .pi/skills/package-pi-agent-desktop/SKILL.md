---
name: package-pi-agent-desktop
description: |
  Package-specific context for @lazuee/pi-agent-desktop.
  Load when working on code, tests, or docs in packages/pi-agent-desktop/.
---

# pi-agent-desktop

Pi extension that drives desktop apps on macOS, Windows and Linux by their native accessibility trees, on top of the [`agent-desktop`](https://github.com/vercel-labs/agent-desktop) CLI.
It mirrors `pi-macos-harness`: one tool, one action enum, and a fresh read after every action.

## Architecture

- `src/extension.ts` — the whole extension.
  `buildArgs` turns tool parameters into the CLI's argv; the tool calls it, and the tests call it directly.
  `ACTIONS` is the enum, `READ_ACTIONS` names the ones that are their own answer (the reads; `get`/`is` are ref-scoped and the rest are `--app`-scoped), and `COMMANDS` holds the one rename, `list_apps` to `list-apps`.
  Responses go through `render`, `shotContent` or `cliError` so no call answers with a JSON envelope.
- `skills/agent-desktop/` — the upstream skill, copied from the checkout so it documents the CLI actually invoked, plus one local section at the end.
  It is both the agent's long-form manual and the upgrade surface: refresh it whenever `upstream/` moves.
- `upstream/` — git submodule of `vercel-labs/agent-desktop`.
  Apache-2.0, not published; `LICENSE` covers it.

## The CLI is found, never installed

`agent-desktop` is never a workspace dependency, so pnpm's `allowBuilds` has no entry for it and npm's postinstall (which downloads the native binary) never runs in this repo.
That is why discovery is two-layered: the checkout's `upstream/npm/bin/agent-desktop` is a **Node launcher**, not a binary.
It is always executable and fatal without the native binary beside it.

So a candidate is accepted only when it **answers** `list-apps`, never on file mode.
A bare submodule clone fails that probe; that is the point, and it falls through to the `agent-desktop` on `PATH`.
Never re-introduce a `test -x` precondition, which accepts the launcher unconditionally so every later call dies with `Native binary not found`.
`test/startup.test.ts` pins both directions, and it fakes `pi.exec` keyed on the `$0` payload of the `sh` wrapper, not on the shell path.

On a machine with no `PATH` install, tell the operator to run `npm install -g agent-desktop`; the tool's own error says so.
Discovery also re-runs on a call when session start found nothing, so a CLI installed or built mid-session is picked up without a Pi restart.

## Session bookkeeping

The CLI keeps a session directory and manifest, opened by `session start` and sealed by `session end`.
The id reaches the CLI through `AGENT_DESKTOP_SESSION`, prefixed by a `sh -c` wrapper because `pi.exec` carries no environment.
Each Pi session derives its own id from pid and clock, so a subagent or a second window is a distinct session and one session's end does not release the apps another is still driving.

Three events carry it: `agent_start` starts, `agent_settled` ends, and `session_shutdown` ends and clears the id.
It is `agent_settled`, not `agent_end`, because `agent_end` also fires before a retry, compaction or queued work starts another run.

## Pointer policy

Every action is semantic and leaves the operator's cursor alone; only `hover` and `drag` are pointer movements, and headless delivery refuses both.
They are therefore **opt-in per call** with `headed: true`, and it is off by default.

`--headed` is also honoured on the other actions: the CLI refuses a `click` on an element with no semantic delivery instead of falling back physically, and that is not knowable before the call.
Keep it that way: a stray unconditional `--headed` yanks the cursor of someone typing in another window.

When one runs, the session's `--cursor` overlay draws where it lands.
The overlay is presentation only (`CONCEPTS.md`: it never moves or replaces the OS pointer), so it cannot substitute for `--headed` -- it only makes the movement followable.

## Priorities

1. A stale ref never survives into the next call.
   Every acting action answers with its own fresh snapshot, and a failed re-read is reported rather than swallowed.
2. The argv contract is the CLI's, not ours.
   Verify every spelling against `upstream/src/cli_args/` before changing `buildArgs`, then pin it in a test.
3. A probe failure is a fallthrough, never a hard stop.

## Upstream assumptions

The `/upstream-impact` watchlist for this package; the `upstream-watch` skill defines the impact classes.
Paths are relative to `packages/pi-agent-desktop/upstream/`.

| Our assumption                                                                                                                     | Upstream file                                                                        | Breaks as                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `click`/`type`/`set_value`/`select`/`scroll` take the ref **positionally**, before TEXT/VALUE, and take **no** `--app`             | `src/cli_args/actions.rs`, `src/cli_args/mod.rs` (`RefArgs`; the `WindowScope` note) | Loud on `--app`; **silent** if a value begins with `-` and `--` is dropped                                          |
| `press` takes COMBO as its **only** positional (no ref), scopes by `--app`, and has no `--timeout-ms`                              | `src/cli_args/actions.rs` (`PressArgs`)                                              | Loud: the combo is read as a second positional and rejected; **silent** if a stray `--timeout-ms` is added          |
| `scroll` is its own ref command taking `--direction` and `--amount`; it is **not** `mouse-wheel`, and **needs a ref**              | `src/cli_args/actions.rs` (`ScrollArgs`)                                             | Loud: a ref-less scroll is `INVALID_ARGS` (guarded in `execute`); the wheel turns where a semantic scroll was meant |
| A value or combo starting with `-` needs the `--` terminator before it, with the flags ahead of it                                 | `src/cli_args/actions.rs` (`allow_hyphen_values`)                                    | **Silent**: clap eats the value as a flag, so it parses and the text is lost                                        |
| `click` and the other ref commands accept `--timeout-ms`                                                                           | `src/cli_args/mod.rs` (`RefArgs`)                                                    | **Silent**: the flag is optional, so dropping it parses and the budget silently reverts to 5000                     |
| `hover` and `drag` are pointer-only, take no `--app`, and every one of their inputs declares `requires --headed`                   | `src/cli_args/actions.rs` (`HoverArgs`), `src/cli_args/drag_target.rs`               | Loud: headless refusal (`POLICY_DENIED`), or an `--app` rejection; see the pointer note below                       |
| `--headed` is a **global** flag on the interaction args, not a per-command one                                                     | `src/cli_args/interaction.rs`                                                        | Loud: the flag is rejected as unknown                                                                               |
| Drag targets are `--from`/`--to` refs or `--from-xy`/`--to-xy` points, each an `x,y` string                                        | `src/cli_args/drag_target.rs`                                                        | Loud: drag moves nothing or is rejected                                                                             |
| Hover coordinates are the `--xy` flag, also an `x,y` string                                                                        | `src/cli_args/actions.rs` (`HoverArgs`)                                              | Loud: hover misses                                                                                                  |
| Only `snapshot`/`screenshot`/`list-windows`/`list-apps` are `--app`-scoped, and they are the reads                                 | `src/cli_args/mod.rs` (`WindowScope`), `src/cli_args/snapshot.rs`                    | Loud: the CLI rejects a read with no scope, or an action is sent one                                                |
| The red traffic light closes a window, not the app, so instances accumulate and a later app-only target can resolve to a stale one | macOS TextEdit and similar; pin `--window-id`, and `kill` the leftover pid           | Behavioral-silent: the call appears to act on a different window than the one read                                  |
| `list-apps` is a top-level command taking no other flags                                                                           | `src/cli_args/mod.rs`                                                                | Loud: the startup probe inverts and every session looks broken                                                      |
| `session start`/`session end` open and seal a run, and `AGENT_DESKTOP_SESSION` supplies the id                                     | `src/cli_args/session.rs`, `src/command_host/command_host_client.rs`                 | Behavioral-silent: apps leak until `session gc`, or two sessions collide on one id                                  |
| `skills get <name>` prints a compiled-in skill                                                                                     | `src/cli_args/skills.rs`                                                             | Behavioral-silent: the documented `skills get desktop` guidance names nothing                                       |
| `npm/bin/agent-desktop` is a launcher that execs a sibling native binary, so executable-but-inert is a real state                  | `npm/bin/agent-desktop`, `npm/scripts/postinstall.js`                                | Loud: discovery settles on a broken checkout and never falls back                                                   |
| Refs are snapshot-scoped and renumber on any repaint or menu                                                                       | `src/cli_args/snapshot.rs`, `src/cli_args/snapshot_tree.rs`                          | Behavioral-silent: an action lands on the wrong element                                                             |

`test/extension.test.ts` pins the argv shapes above, and `test/cli-contract.test.ts` runs every action through the real binary and fails on a clap parse error (exit 2).
That contract test needs a built checkout and skips without one, so it does not run in CI -- a shape change made blind still needs the `--help` check below.
It is not a substitute for one: a changed **meaning** at an unchanged spelling (a swapped flag, an inverted default) parses fine and only `--help` shows it.

## Verify before changing the surface

```bash
packages/pi-agent-desktop/upstream/npm/bin/agent-desktop <command> --help   # needs the native binary
```

Then `pnpm --filter @lazuee/pi-agent-desktop run test` covers the argv (including the real-binary contract, when built) and `run check` the types.
The checkout answers only once the native binary exists beside it; until then run the installed CLI and diff the two.

## Refreshing the vendored skill

The copy is upstream's plus a local "How this package relates to the CLI" section at the end.
Save that section, replace the directory wholesale, and append it again; it is cut from its heading rather than by a line count, which drifts as it grows.
A bare `cp -R` into the existing directory copies _into_ it and leaves a renamed file behind:

```bash
sed -n '/^## How this package relates to the CLI/,$p' \
  packages/pi-agent-desktop/skills/agent-desktop/SKILL.md > /tmp/local-section.md
git -C packages/pi-agent-desktop/upstream submodule update --init --recursive
rm -rf packages/pi-agent-desktop/skills/agent-desktop
cp -R packages/pi-agent-desktop/upstream/skills/agent-desktop packages/pi-agent-desktop/skills/
cat /tmp/local-section.md >> packages/pi-agent-desktop/skills/agent-desktop/SKILL.md
```

Do not edit the rest of `skills/agent-desktop/` by hand; put other local guidance here instead.
