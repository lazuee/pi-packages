# Changelog

## Unreleased

- `timeout_ms` on a blocking `spawn`, `assign` or `reply` detaches after the budget; the work and its automatic report continue.
- A spawn records worker ownership before delivery, so a detached blocking spawn still keeps resume and close-idle.
- A wait detaches instead of hanging on an uncollectable result, a follow-up `assign` taking the work over, or a session whose monitoring ended; the cause is reported.
- Blocking results report `blocked_on` without an extra hop, and `blocking` states it.
- A wait whose work a follow-up `assign` took over is retired instead of hanging on the old attempt.
- Input baselines are read just before submitting, so a remote worker that persists the prompt first no longer fails the reply check.
