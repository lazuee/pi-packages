# Changelog

## Unreleased

- `timeout_ms` on a blocking `spawn`, `assign` or `reply` detaches after the budget; the work and its automatic report continue.
- A spawn records worker ownership before delivery, so a detached blocking spawn still keeps resume and close-idle.
- A wait detaches instead of hanging on an uncollectable result, a follow-up `assign` taking the work over, or a session whose monitoring ended; the cause is reported.
- A blocking call waits for the worker's own turn, not whatever reply the pane happened to hold. A tool-calling turn, which has no reply until the tool returns, no longer ends the wait early or stalls it.
- A wait that gives up says whether the worker was still running its tool or the turn never reached disk.
- Blocking results report `blocked_on` without an extra hop, and `blocking` states it.
- A wait whose work a follow-up `assign` took over is retired instead of hanging on the old attempt.
- Input baselines are read just before submitting, so a remote worker that persists the prompt first no longer fails the reply check.
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
