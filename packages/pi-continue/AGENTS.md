# pi-continue — agent notes

Load this before touching `packages/pi-continue/`, and load `pi-extension-lifecycle` first: the lifecycle rules below are its payload, applied.

## Shape

The package is split so nearly everything runs without Pi:

- `src/evidence.ts` — pure read of a settled run.
  No host types.
- `src/detectors.ts` — the decision chain plus its injected `Judge` type.
- `src/brakes.ts` — the refusal predicate and the streak/ledger.
- `src/nudge.ts`, `src/config.ts` — pure text and config.
- `src/gateway.ts`, `src/permission-await.ts`, `src/judge.ts` — state and host seams.
- `src/engine.ts` — wires the above; takes a stub host in tests.
- `src/extension.ts` — Pi imports live here and nowhere else except `arm-tool.ts`.

A new stall shape is one more detector; a new reason to hesitate is one more field on `BrakeState`.
Neither should touch the engine.

## The two rules that are easy to break

1. **Decide on `agent_settled`, never `agent_end`.**
   `agent_end` fires before Pi's own retry, compaction recovery and continuation handling.
   Latch on `agent_end`, decide on settle.
2. **Never loop on "is it idle yet".**
   Pi clears its run-active flag _before_ emitting `agent_settled`, so a polling loop that waits for `isIdle()` hides inside a `while` that never exits.

Delivery is `sendUserMessage(text, { deliverAs: "followUp" })`.
Inside the settle emit that lands in Pi's deferred-settled queue; as a follow-up it cannot steer the turn that just ended.

## Faults this package has already hit

- Pi 1.0 exports no `typebox`; the schema helper is `@earendil-works/pi-ai`'s re-exported `Type`.
- The judge runs through `ctx.modelRegistry.complete(model, …)`, not a `pi.complete`.
  A probe `Context` message needs a `timestamp`.
- `ctx.ui.notify` takes `info | warning | error` — there is no `success`.
- `defineTool`'s `execute` must return a promise, so it is `async` with no `await`; `extension.ts` and `arm-tool.ts` carry a file-level `require-await` disable for that.

## Upstream assumptions

The `/upstream-impact` watchlist for this package; `upstream-watch` defines the impact classes.
Paths are relative to the Pi checkout and were confirmed in the packaged `dist/` of the pinned 1.0.0.

| Our assumption                                                                                                                             | Upstream file                                                                              | Breaks as                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| The run-active flag is cleared before `agent_settled` emits, so settle is the idle boundary                                                | `packages/coding-agent/src/core/agent-session.ts` (`_emitAgentSettled`)                    | Behavioral-silent: a settle-side idle wait spins forever                           |
| A `sendUserMessage` with `deliverAs: "followUp"` inside the settle emit is deferred into `_deferredSettledActions`                         | `packages/coding-agent/src/core/agent-session.ts` (`sendMessage`, `_emitAgentSettled`)     | Loud or behavioral-silent: delivery races a concurrent prompt, or lands as a steer |
| `agent_end` fires before retry and compaction; `agent_settled` after both                                                                  | `packages/coding-agent/src/core/agent-session.ts` (`_runAgentPrompt`, `_emitAgentSettled`) | Behavioral-silent: recoveries spend the retry budget                               |
| `stopReason` is one of `pending \| stop \| length \| toolUse \| error \| aborted \| deferred` and `errorMessage` carries the provider text | `@earendil-works/pi-ai` `dist/types.d.ts` (`StopReason`, `AssistantMessage`)               | Loud: the error row stops matching and silently never fires                        |
| Subagents broadcast `subagents:started` / `:completed` / `:failed` with an `agentId`                                                       | `packages/pi-subagents/src/service/service.ts` (`SUBAGENT_EVENTS`)                         | Behavioral-silent: the gateway stops seeing children and talks over them           |
| A prompt is open between `permissions:ui_prompt` and the matching `permissions:decision`, paired by `requestId`                            | `packages/pi-permission-system` `docs/cross-extension-api.md`                              | Behavioral-silent: recoveries push work past an unanswered ask                     |
| `input` carries `source: "interactive" \| "rpc" \| "extension"`                                                                            | `packages/coding-agent/src/core/extensions/types.ts` (`InputEvent`)                        | Behavioral-silent: a recovery counts as the operator and resets its own streak     |

`test/engine.test.ts` drives the engine with a hand-built host, so it pins this package's logic, not Pi's event order.
The end-to-end check is a real `pi` run with a stubbed provider that answers empty once.

## Testing

`pnpm --filter @gotgenes/pi-continue run test` — inject `now` through the engine rather than sleeping; the interval brake reads it.
