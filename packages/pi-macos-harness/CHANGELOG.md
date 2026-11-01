# Changelog

## 0.1.0 (2026-11-01)

Initial release. The extension was developed in `~/.pi/agent/extensions` and is
packaged here with the runtime as a submodule.

### Features

- One `macos_harness` tool over eleven UI actions, with the element tree and a
  window screenshot on every read.
- A fresh read after every action, so element numbers are always valid.
- `point` clicks an element's centre with raw events for apps that ignore
  accessibility clicks.
- Turn bookkeeping on `agent_start`, `agent_settled` and `session_shutdown`, so
  apps are let go when the turn ends rather than when a retry or compaction
  passes.

### Bundled runtime fixes

- Screenshot pixels map through the window's current frame, so a moved window is
  still hit and a resized one asks for a new read.
- A pixel with nothing under it is refused instead of reporting success.
- A number superseded by a page redraw resolves instead of failing.
- A full tree is cut at 400 lines; a busy page measured 1250 and 102 KB.
- A bare number resolves as a pid; control characters are escaped in values;
  `type_text` takes a per-key delay.