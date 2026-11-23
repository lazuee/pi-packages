# Changelog

## Unreleased

- A monitored program that exits is recognised from its pane, not only from the terminal losing the pane entirely. Core keeps a terminal's diff and status after the program ends, so a worker that stopped — or was killed — reconciled as settled forever, never showed its own removal and held a blocking wait no settlement could release. A pane without its session label, or one the terminal no longer considers interactive, now counts as gone.
- One record that cannot be resolved no longer skips the rest of a reconcile pass, which left every sibling's stored terminal address pinned to a dead one.
- A child whose program already exited is now offered by `/close-idle` rather than skipped. It has no receiver left to answer `/quit` and no monitor record, so it failed every guard and only its dead terminal lingered in the sidebar; its finished terminal is removed instead, and the row says `exited`. The terminal is read directly so an unreachable machine is not mistaken for a dead child.
- A removal settles the wait it was holding: the blocked call is released as closed before its work settled, a task the worker still owed is reported, and a worker that stopped mid-task reports `idle` rather than a finish that never happened.
- Read-only profiles pinned `PI_CODING_AGENT_DIR` when the module loaded, so anything that set the directory afterwards was ignored and the guard read an empty profile set — every declared writer ran unblocked. The directory and the paths built from it are resolved per call.
- A kill no longer reports success it did not have. A program that already exited is `outcome: "ended"` rather than a claimed kill, a remapped terminal address is read from the freshly loaded snapshot, and a peer parent that could not be reached is named in the result instead of looking told.
- The ancestry read covered 64 KiB, which a session resumed from a compaction outgrows, and the parent notice looked at a second snapshot taken after the worker's entry was gone. The window is 256 KiB and the notice uses the snapshot the kill already loaded.
- A controller that inherited its board from a parent no longer reads as boardless, so its spawns stop skipping a board the tree is on.
- Shepherdr requires running inside the Herdr app; outside it a session warns and stays inactive. The `herdr peers` footer widget is gone, leaving the sidebar as the only agent list.
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
