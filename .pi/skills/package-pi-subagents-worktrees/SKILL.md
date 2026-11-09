---
name: package-pi-subagents-worktrees
description: |
  Package-specific context for @lazuee/pi-subagents-worktrees.
  Load when working on code, tests, or docs in packages/pi-subagents-worktrees/.
---

# pi-subagents-worktrees

Git worktree isolation for `@lazuee/pi-subagents`: a `WorkspaceProvider` that runs opted-in subagents in isolated worktrees.
It consumes `@lazuee/pi-subagents` from the npm registry, not the workspace (see `pnpm-workspace.yaml`).

## Upstream assumptions

The `/upstream-impact` watchlist for this package; the `upstream-watch` skill defines the impact classes.
Paths are relative to the Pi checkout.

| Our assumption                                                                                              | Upstream file                                                                                                                                                                                 | Breaks as                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `getAgentDir()` honors `PI_CODING_AGENT_DIR`                                                                | `packages/coding-agent/src/config.ts` (`getAgentDir`)                                                                                                                                         | Behavioral-silent: `worktreeAgents` silently falls back to empty                                                 |
| Subagent children see `ctx.hasUI === false` at `session_start`, the user session `true`                     | `packages/coding-agent/src/core/extensions/runner.ts` (`hasUI`)                                                                                                                               | Behavioral-silent: every child rescans worktrees and repeats the notice                                          |
| `session_start` fires on startup, reload, new, resume, and fork                                             | `packages/coding-agent/src/core/extensions/types.ts` (`SessionStartEvent.reason`); `packages/coding-agent/src/core/agent-session-runtime.ts`                                                  | Behavioral-silent: the notice frequency changes                                                                  |
| `session_shutdown` runs before every runtime replacement, so the provider is unregistered once per instance | `packages/coding-agent/src/core/agent-session-runtime.ts`; `packages/coding-agent/src/core/extensions/runner.ts`                                                                              | Coverage-gap: a replacement without it leaves two providers and two worktrees per child                          |
| `process.cwd()` at factory time is the session's repo root                                                  | `packages/coding-agent/src/core/extensions/types.ts` (`ExtensionContext.cwd`); `packages/coding-agent/src/core/agent-session-runtime.ts` (session switch takes the session's cwd, no `chdir`) | Coverage-gap, already live: resuming a session recorded in another directory leaves the captured `repoCwd` stale |
| `ctx.ui.select`/`confirm`/`notify` are usable in a command handler                                          | `packages/coding-agent/src/core/extensions/types.ts` (`registerCommand`, `ExtensionCommandContext`)                                                                                           | Behavioral-silent in RPC and print modes                                                                         |

The sibling `@lazuee/pi-subagents` contract (`getSubagentsService`, `registerWorkspaceProvider`, `dispose` on every outcome) is a first-party seam; `pi-subagents`' own tests own it.
`test/index.test.ts` mocks Pi down to `getAgentDir`, so no test is a canary for upstream drift.
