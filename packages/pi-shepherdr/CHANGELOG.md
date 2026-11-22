# Changelog

## Unreleased

- A blocking wait is unbounded: it holds until the settlement arrives instead of detaching on a budget, a stall or an ended session. It still gives up rather than hangs when its result cannot be collected, when a follow-up `assign` takes the work over, or when that session's monitoring ends. `blocking` is the only wait control; `timeout_ms` and the `detached`/`detail` result fields are gone.
- A held wait reports through one `Waiter` handed to the settlement layer, so the caller keeps the wording. A collectable blocked result says it is being collected instead of the call sitting silent.
- A blocking call waits for the worker's own turn, not whatever reply the pane happened to hold. A tool-calling turn, which has no reply until the tool returns, no longer ends the wait early or stalls it.
- A wait that gives up says whether the worker was still running its tool or the turn never reached disk.
- Blocking results report `blocked_on` without an extra hop, and `blocking` states it.
- A wait whose work a follow-up `assign` took over is retired instead of hanging on the old attempt.
- `SettlementTimeoutError` is renamed `SettlementLostError`; no timeout is involved now that waits are unbounded.
- Input baselines are read once before submitting, so a remote worker that persists the prompt first no longer fails the reply check.
- New `kill` action ends a worker's terminal and removes its record: it kills a live pane, only removes a finished one, and refuses an unknown state, a changed pane or its own calling session. A killed pane also stops restoring supervision when it is resumed, and its owning parent is told it is gone so it stops waiting.
- Remote focus frames carry their payload escaped instead of base64, and the stream's parser tolerates either encoding so a mixed pair of builds still connects.
- Remote frames pack the messages already queued, so a burst of small repaints costs one write and one acknowledgement instead of one each.
- Fixed remote focus dropping a frame when its kind byte was misread, when a write raced the attach handshake, and when an acknowledgement frame arrived.
- Fixed a literal `%` corrupting a remote frame, and a send-offset that received bytes could shift while two replies were in flight.
- Helper diagnostics reach the host as frames instead of landing in the PTY stream mid-frame, and a helper `error` frame reaches the code that reports it instead of being skipped as a diagnostic.
- Fixed a helper request carrying no chunk number failing the stream as out of order, and a closing frame being dropped by the queue instead of sent.
- A request arriving before a helper finished starting is queued instead of failing the connection, and a frame kind the owner does not know is passed on rather than rejected.
- The wire enforces its queued-output limit, which was accepted but never read.
- The remote launcher guard measures each argument, which is what Core's ~130KiB limit applies to, instead of a doubled total.
- A shared-context relay that fails after `start` reports it instead of leaving the machine advertising a route that answers nothing.
- Closing a route drops its published listener, so a reconnect does not find a stale relay; a failure recorded for an older connection is cleared when a tool retries sharing.
