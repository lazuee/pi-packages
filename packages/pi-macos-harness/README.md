# @gotgenes/pi-macos-harness

Pi extension that lets the agent drive this Mac's real UI.
It ships the [`macos-harness`](https://github.com/browser-use/macos-harness) runtime as a git submodule and exposes one tool over it.

Nothing comes to the front and the pointer does not move.

## Install

```bash
pi install git:github.com/lazuee/pi-packages
```

Then grant Accessibility and Screen Recording to the app that starts Pi (your terminal).
`macos-harness doctor` reports what is missing and names that app.

## What the tool does

One `macos_harness` tool with an `action` covering the eleven commands: `get_app_state`, `click`, `type_text`, `press_key`, `set_value`, `paste`, `scroll`, `drag`, `select_text`, `perform_secondary_action`, `list_apps`.

- `get_app_state` returns the element tree **and** the window screenshot, so you
  aim at what you can see.
- Every action is followed by a fresh read on its own, so the numbers you get
  back are already valid.
- `point` clicks an element's own centre with raw events, for apps that ignore
  accessibility clicks.
- A pixel with nothing under it is refused rather than silently doing nothing.

Read, act, read again.
Prefer `element_index`; use `x`/`y` from the screenshot that arrived with the read, and never for a menu bar (it is outside the image).

## The bundled runtime

`upstream/` is a submodule of this fork, not the published wheel, so a patch is live without reinstalling.
The extension drives that checkout first and falls back to an installed `macos-harness` only if it is missing.

```bash
cd packages/pi-macos-harness/upstream
uv sync                 # once
pkill -f macos_harness.helper   # the helper holds the old code; needed after a patch
```

To move it forward: commit in `upstream/`, then commit the new submodule pointer here.

## Notes

- The helper is a long-lived process.
  A runtime change needs the `pkill` above; nothing does it for you.
- `pi` reads the skill in `skills/` for the full command and error guide.

## License

MIT.
The bundled runtime is MIT and carries its own license.
