# Changelog

## 0.1.0

### Features

- Recover a stalled run at the `agent_settled` boundary with a per-class nudge: empty or thinking-only reply, response cut off at the output-token limit, unretried provider error, prose that trails off mid-sentence.
- Deterministic detector chain that needs no model call, plus an optional `judgeMode` for the ambiguous rows with a fail-safe fallback.
- Brakes: Esc stands the extension down until the operator types, streak ceiling, minimum interval, one recovery per settled run, and refusal while a permission prompt is open or a subagent is still running.
- Session gateway that follows the subagent lifecycle, including the `PI_CONTINUE_FOR_CHILD` stamp for out-of-process children.
- `continue_arm` tool and `/continue arm|disarm|status` so a run arms its own recovery instead of the operator remembering beforehand.