---
name: package-pi-ask
description: |
  Package-specific context for @lazuee/pi-ask.
  Load when working on code, tests, or docs in packages/pi-ask/.
---

# pi-ask

Pi extension giving the agent an `ask_user` clarification tool: a terminal form with single-select, multi-select, notes, free-form answers, and clipboard images, plus a background question queue and an opt-in answer journal.

This package is a full port of [`alexshpunt/pi-agent-ask`](https://github.com/alexshpunt/pi-agent-ask) (itself a fork of [`eko24ive/pi-ask`](https://github.com/eko24ive/pi-ask)), re-homed onto this monorepo's conventions.
The sources are the upstream sources: a diff that removes something upstream does is a decision to state, not a cleanup.

## What the port changed

Only these, each because the repo requires it:

- `.ts` import extensions dropped; tests moved from `node:test` + `node --test` to Vitest (`after` → `onTestFinished`,
  `timeout` option → third argument).
- `#src/*` / `#test/*` aliases replace parent-relative imports. `#src/*` is also declared in `package.json` `imports`:
  a real Pi process loads `src/index.ts` directly and does not read the tsconfig or the Vitest alias.
- Product identity is `@lazuee/pi-ask` (settings screens, notification title, the README the driver reads).
  The `pi-agent-ask:*` event channel names and the `pi-agent-ask.json` config filename are kept, so an existing bridge or config file keeps working.
- The integration harness is not a root dependency, so `test/fixtures/pi-coding-agent-test.ts` re-exports it and the
  ported imports point at that.
- `<h3>Behaviour fixes found by the port</h3>` — see below.

## Behaviour the port fixed

- `ui/render-frame.ts` `getVisibleTabRange` walked past the end of the tab array forever at narrow widths, because TypeScript types an out-of-range index as present with `noUncheckedIndexedAccess` off.
  Three tabs on the Review tab at width 24 hung the render.
  Fixed with an explicit bounds check.
- `clipboard-image.ts` gated the `wl-paste`/`xclip` path on `process.platform === "linux"`, so on macOS the path never ran and a `wl-paste` on `PATH` (which is how the integration test drives images) was ignored.
  A host that can run `wl-paste` is described by `WAYLAND_DISPLAY`/`DISPLAY`, not by the kernel, so the session decides now.

## Config identity

Settings live at `<agentDir>/extensions/pi-agent-ask.json`, not `@lazuee/pi-ask.json`, so a file written before the fork keeps applying.
If you rename it, migrate rather than add a second path.

## Docs

`docs/contract.md` is the behaviour contract and the first thing to read before changing a tool payload or the form UX.
`docs/architecture.md` is the module map.
`docs/configuration.md` and `docs/remote-events.md` cover settings and the inter-extension events.

## Upstream assumptions

The `/upstream-impact` watchlist for this package; the `upstream-watch` skill defines the impact classes.
Paths are relative to the Pi checkout.

| Our assumption                                                                                                                   | Upstream file                                                                         | Breaks as                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ctx.ui.custom()` accepts a component factory whose callbacks may run before/after mount                                         | `packages/coding-agent/src/core/extensions/types.ts` (`ExtensionUIContext.custom`)    | Loud: the form never opens, or the queue panel renders nothing                                     |
| `pi.appendEntry` accepts arbitrary `customType` + `data`, and entries replay from `getBranch()`                                  | `packages/coding-agent/src/core/extensions/types.ts` (`appendEntry`), session manager | Behavioral-silent: queue and draft recovery stop rebuilding after reload                           |
| `pi.registerTool` honours `exposure: "hidden"` / `"model-only"` and `outputSchema`                                               | `packages/coding-agent/src/core/extensions/types.ts` (`registerTool`)                 | Loud or behavioral-silent: the wait tool leaks into the schema, or output validation drops answers |
| `session_start` reason, `resources_discover`, `agent_settled`, `turn_start`/`turn_end`, `agent_before_settle` fire in this order | `packages/coding-agent/src/core/extensions/runner.ts`                                 | Behavioral-silent: recovery and delivery boundaries land in the wrong phase                        |
| `ctx.isIdle()`/`ctx.signal` distinguish a settled agent from an active turn                                                      | `packages/coding-agent/src/core/extensions/types.ts` (`ExtensionContext`)             | Behavioral-silent: an idle wake interrupts a running turn                                          |
| A stale `ctx` after `newSession()`/`fork()` throws a readable error                                                              | `packages/coding-agent/src/core/extensions/runner.ts`                                 | Behavioral-silent: a disposed surface writes into the wrong session                                |
| `terminal.setProgramStatus` (OSC 7501) exists only when negotiated                                                               | `packages/coding-agent/src/core/extensions/types.ts`                                  | Silent: Herdr status is skipped, never wrong                                                       |

`test/integration/` is the canary for all of these: it drives real Pi through a PTY, so a green run there means the assumptions still hold.
