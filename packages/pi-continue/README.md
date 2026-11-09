# @gotgenes/pi-continue

Keeps an unattended pi run moving.

When a run **stops without finishing** — an empty reply, a response cut off at the output-token limit, a provider error pi could not retry, or prose that trails off mid-sentence — pi-continue nudges the agent back into motion at the settle boundary, exactly as if you had typed `continue`.

It is bounded, and it gets out of the way.

> **Scope.**
> This is a recovery layer, not a scheduler.
> It resumes the work already in front of the agent; it does not invent the next task.

## Why the settle boundary

pi fires `agent_end` **before** its own retry, compaction and continuation handling.
An extension that recovers on `agent_end` competes with pi's retry budget.

pi-continue latches the run at `agent_end` and decides at `agent_settled`, the point where pi has confirmed that no retry, compaction recovery or queued continuation is left.
Verified against `agent-session.js` in the pinned host: the run flag is already cleared when `agent_settled` emits, so a "wait until idle" loop would never terminate — settlement *is* the idle boundary.

The nudge is delivered as a `followUp`, which inside the settle window lands in pi's deferred-settled queue, so it cannot race a concurrent prompt.

## What it counts as a stall

| Row                                 | Decided by        | Without a judge                       | With a judge        |
| ----------------------------------- | ----------------- | ------------------------------------- | ------------------- |
| `toolUse` / `pending` stop          | deterministic     | not a stall                           | not a stall         |
| Response cut off at the token limit | deterministic     | **recover**, asking for shorter steps | same                |
| Empty or thinking-only reply        | deterministic     | **recover**                           | same, no judge call |
| Provider error pi already retried   | deterministic     | not a stall                           | not a stall         |
| Provider error pi did **not** retry | deterministic     | **recover**                           | same                |
| `stop` with prose that trails off   | deterministic     | **recover**                           | judge decides       |
| `stop` with clean prose             | heuristic / judge | not a stall                           | judge decides       |

`429`, `5xx`, `overloaded`, `rate limit`, timeouts, connection resets and WebSocket failures are in the already-retried list — pi has spent its retry budget on them, so recovering again only burns tokens on the same failure.
A quota, billing or unmatched `4xx` error fails fast on purpose and is worth one attempt.

## The brakes

A recovery is refused when any of these is true, checked before it fires:

| Brake                                       | Why                                                           |
| ------------------------------------------- | ------------------------------------------------------------- |
| Disabled, or gated out of this session      | see [Sessions](#sessions)                                     |
| The operator pressed Esc                    | they want out, not one more iteration; cleared when they type |
| The operator is mid-typing                  | do not talk over a half-written prompt                        |
| A permission prompt is still open           | continuing past an `ask` lands work nobody can approve        |
| The streak ceiling is reached               | default 3 back-to-back recoveries, then a warning             |
| Minimum interval not elapsed                | default 2 s, so a fast crash loop cannot spin                 |
| A subagent of this session is still running | do not bury a child's result                                  |
| This exact run was already recovered        | one recovery per settled run                                  |

A healthy settle ends the streak.
Typing anything resets it, along with everything else.

## Sessions

Modules never travel between sessions, so the gateway is local knowledge:

- an in-process subagent child marks **itself** on load;
- an out-of-process child is stamped by its spawner with `PI_CONTINUE_FOR_CHILD=1`;
- a session with live children will not talk over them.

A child's asks travel to the parent per the permission system's forwarding contract, so `continueChildren` is only safe while that contract holds.

Calling pi-continue on its own with no subagent present works in both directions: it continues the session it is loaded into.

## Arming

Recovery is on by default but a run usually wants to *choose* when it is unattended.
The agent can arm itself:

```text
continue_arm { "action": "arm", "goal": "get the suite green" }
continue_arm { "action": "disarm" }
```

Arming overrides the master switch and survives `/reload` and a resume.
The goal is quoted back into the nudge so a recovery resumes the right task.

Or by hand:

```text
/continue arm
/continue disarm
/continue off        # mute for this session, without touching the config
/continue on         # unmute
/continue            # status: gating, streak, open prompts, last decision
```

`/continue off` outranks `arm` and the config.
It clears on a session switch, so a mute never silently follows you into a new session.

## Install

```bash
pi install npm:@gotgenes/pi-continue
```

Then `/reload` if pi is already running.
The footer shows `↻ armed` or `↻ <streak>` while a recovery counts.

## Configuration

`<agent dir>/extensions/pi-continue/config.json` (global) or `.pi/extensions/pi-continue/config.json` (project).
Either file may be absent; the config is re-read each turn, so an edit applies without a reload.

```json
{
  "enabled": true,
  "continueSelf": true,
  "continueChildren": true,
  "maxConsecutive": 3,
  "minIntervalMs": 2000,
  "emptyText": "continue",
  "truncatedText": "Continue from where you stopped, in smaller steps.",
  "errorText": "continue",
  "alreadyRetriedPatterns": ["429", "500", "503", "overloaded", "WebSocket"],
  "judgeMode": "off",
  "judgeModel": { "provider": "some-provider", "model": "a-cheap-model" },
  "judgeTailMessages": 12,
  "judgeTimeoutMs": 8000,
  "suppressAfterAbort": true,
  "notify": true,
  "debug": false
}
```

| Field                                       | Default       | Meaning                                                                                   |
| ------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| `enabled`                                   | `true`        | Master switch; `/continue` and arming still work.                                         |
| `continueSelf`                              | `true`        | Recover in this session.                                                                  |
| `continueChildren`                          | `true`        | Recover in subagent child sessions.                                                       |
| `maxConsecutive`                            | `3`           | Back-to-back recoveries before giving up.                                                 |
| `minIntervalMs`                             | `2000`        | Minimum gap between two recoveries.                                                       |
| `emptyText` / `truncatedText` / `errorText` | see above     | The nudge per failure class.                                                              |
| `alreadyRetriedPatterns`                    | retry list    | Case-insensitive error substrings pi already retried.                                     |
| `judgeMode`                                 | `"off"`       | `off`, `model` (ambiguous row only) or `always`.                                          |
| `judgeModel`                                | unset         | Unset uses the session model, then any model with working credentials. Set it to pin one. |
| `judgeTailMessages` / `judgeTimeoutMs`      | `12` / `8000` | The judge's context and per-model deadline.                                               |
| `suppressAfterAbort`                        | `true`        | Stay quiet after Esc until the operator types.                                            |
| `notify`                                    | `true`        | Notify on each recovery and each give-up.                                                 |
| `debug`                                     | `false`       | Log every decision to stderr.                                                             |

### The judge

The judge is one small model call that answers `FINISHED` or `STALLED` for the ambiguous rows.
It fails safe: a failed or unparsable call leaves the deterministic read in charge, so a broken judge cannot turn every normal answer into a loop.

Every deterministic row still works with no judge, which matters because the thing that broke may be the model itself.
With no `judgeModel` the judge tries the session model first and then each credentialed chat model in turn, stopping at the first that answers, so it keeps working when the configured provider dies — but the session model is the one most likely to be down at the same time, so pinning `judgeModel` to a second provider is worth it for long unattended runs.

## An idea it borrowed

Six extensions do a version of this and each shaped one row or brake here:

- [`pi-invisible-continue`](https://github.com/monotykamary/pi-invisible-continue) — a recovery that hides its own marker from the model.
- [`pi-auto-continue`](https://github.com/latent-variable/pi-auto-continue) — the streak ceiling and the "Esc means out" rule.
- [`avtc-pi-unstuck`](https://github.com/avtc/avtc-pi-unstuck) — empty-response detection with escalating nudges.
- [`pi-unstall`](https://github.com/zeroicey/pi-unstall) — deciding at `agent_settled`, a detector chain before any model call.
- [`pi-websocket-auto-continue`](https://github.com/xRyul/pi-websocket-auto-continue) — latching on `agent_end`, acting on settled.
- [`pi-agent-foreman`](https://github.com/alexshpunt/pi-agent-foreman) — a classifier for "announced but not done".

## Limitations

- The heuristic rows are heuristics.
  A genuinely finished reply may be nudged once; the brakes bound it.
- A `toolUse` stop is always treated as healthy.
  A tool that silently returns nothing to do is not caught.
- Streak and arm state live in the process; `/continue` and `continue_arm` re-arm after a restart, but a resume of a run that was never persisted starts disarmed.
