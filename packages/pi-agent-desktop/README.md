# @gotgenes/pi-agent-desktop

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

## What it exposes

One tool, `agent_desktop`, with an action enum:

| Kind | Actions                                                                    |
| ---- | -------------------------------------------------------------------------- |
| Read | `snapshot`, `list_apps`, `list_windows`, `screenshot`                      |
| Act  | `click`, `type`, `press`, `set_value`, `select`, `scroll`, `hover`, `drag` |

`snapshot` before acting.
Every action answers with a fresh snapshot, so the refs it returns are the current ones — the CLI's refs are snapshot-scoped, and an old ref is stale by construction.

Prefer `ref` (`@e3`), and check `available_actions` first: click only what advertises `Click`, since a bare text field advertises `TypeText` and a click on it fails in either mode.
An app with several windows refuses as `AMBIGUOUS_TARGET`; pass `window_id` from `list_windows` to choose one.
Pin `window_id` also when an app may be running twice: a second instance leaves `list_windows` unambiguous while an app-only target flips between them.
The red traffic light only hides a window, so instances accumulate across runs; quit the app rather than closing its windows.
`x`/`y` are the fallback for elements the tree does not address, and a negative coordinate is sent in the `--xy=-100,50` form.
`drag` takes a `to_ref` for its destination.
`press` is the exception: its only positional is the combo, so it goes to the focused window unless an `app` names one.

## Background by default

The extension runs alongside your own work: it does not steal focus and does not move your cursor unless asked.

Every action goes through the accessibility tree.
Only `hover` and `drag` *are* pointer movements in the CLI, and it refuses those headless with `POLICY_DENIED`.
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

This wraps the common loop.
The CLI is wider — `find`, `wait`, `batch`, clipboard, window management, notifications, tracing — and the bundled `agent-desktop` skill documents it.
Run `agent-desktop <command> --help` for flags; the skill does not repeat them.

Use [`@gotgenes/pi-macos-harness`](../pi-macos-harness/) instead when the work is macOS-only and you want screenshots attached to every read.

## Layout

- `src/extension.ts` — the tool, the CLI invocation, and the session bookkeeping.
- `skills/agent-desktop/` — the upstream skill, copied from the checkout so it matches the CLI it documents, plus one local section on how the tool relates to it.
- `upstream/` — git submodule of `vercel-labs/agent-desktop`, Apache-2.0.
  Not published; see `LICENSE`.

## Development

```bash
pnpm --filter @gotgenes/pi-agent-desktop run test
pnpm --filter @gotgenes/pi-agent-desktop run check
pnpm --filter @gotgenes/pi-agent-desktop run lint
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
