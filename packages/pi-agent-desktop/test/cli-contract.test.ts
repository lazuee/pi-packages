import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildArgs, startArgs } from "#src/extension";

// The unit tests assert buildArgs against itself, so they cannot catch a shape
// change -- three defects shipped that way. This runs the real binary over every
// action instead. It needs a checkout built (cargo build in upstream/) and is
// skipped without one; CI has no submodule, so CI never runs it.
//
// A parse is the whole assertion, and clap separates the two outcomes for us: a
// rejected argument exits 2, while a runtime refusal (a stale ref, a missing
// window) exits 1. So a non-2 exit means the argv was well formed, and the test
// needs no window, permission or snapshot.
const PARSE_FAILURE = 2;

const BIN = fileURLToPath(
  new URL("../upstream/target/debug/agent-desktop", import.meta.url),
);

/** Everything a well-formed call of each action needs to be parseable. */
const CALLS: Record<string, Record<string, unknown>> = {
  snapshot: { app: "Finder" },
  screenshot: { app: "Finder" },
  list_windows: { app: "Finder" },
  list_apps: {},
  click: { ref: "@1:e1" },
  type: { ref: "@1:e1", text: "hi" },
  set_value: { ref: "@1:e1", value: "v" },
  select: { ref: "@1:e1", value: "v" },
  press: { key: "cmd+s" },
  scroll: { ref: "@1:e1", direction: "down", amount: 3 },
  hover: { x: 5, y: 9 },
  drag: { from_x: 1, from_y: 2, to_x: 3, to_y: 4 },
  get: { ref: "@1:e1", property: "bounds" },
  is: { ref: "@1:e1", property: "visible" },
};

// Extra cases: the ref forms the builder prefers, an explicit timeout, and
// hyphen-leading values that need the escape. Keyed apart so merging keeps both.
const EXTRA_CALLS: Record<string, Record<string, unknown>> = {
  "hover by ref": { action: "hover", ref: "@1:e1" },
  "drag by ref": { action: "drag", ref: "@1:e1", to_ref: "@1:e2" },
  "click with a timeout": { action: "click", ref: "@1:e1", timeout_ms: 100 },
  // Values and combos that begin with a hyphen; each needs the `--` escape.
  "type a hyphen value": { action: "type", ref: "@1:e1", text: "--headed" },
  "set_value a hyphen value": {
    action: "set_value",
    ref: "@1:e1",
    value: "--x",
  },
  "press a hyphen combo": { action: "press", key: "--5" },
  "press a hyphen combo scoped": {
    action: "press",
    app: "Finder",
    key: "--5",
  },
  // A negative coordinate is a left-hand display, and needs the `=` form.
  "hover on negative coordinates": { action: "hover", x: -100, y: 50 },
  "mouse_click a coordinate": { action: "mouse_click", x: 171, y: 50 },
  "mouse_click a negative coordinate": {
    action: "mouse_click",
    x: -100,
    y: 50,
  },
  "drag to negative coordinates": {
    action: "drag",
    from_x: -100,
    from_y: 50,
    to_x: -5,
    to_y: 9,
  },
  "hover headed": { action: "hover", ref: "@1:e1", headed: true },
  "snapshot a named window": { action: "snapshot", window_id: "w-1" },
  "snapshot shaped for a map": {
    action: "snapshot",
    app: "Finder",
    skeleton: true,
    compact: true,
    interactive_only: true,
  },
  "snapshot drilled into a region": { action: "snapshot", root: "@1:e1" },
  find: { action: "find", app: "Finder", query: "OK" },
  find_by_role: { action: "find", app: "Finder", role: "button" },
  wait_text: {
    action: "wait",
    app: "Finder",
    wait_text: "OK",
    timeout_ms: 300,
  },
  wait_ms: { action: "wait", wait_ms: 50 },
  right_click: { action: "right_click", ref: "@1:e1" },
  double_click: { action: "double_click", ref: "@1:e1" },
  toggle: { action: "toggle", ref: "@1:e1" },
  check: { action: "check", ref: "@1:e1" },
  uncheck: { action: "uncheck", ref: "@1:e1" },
  expand: { action: "expand", ref: "@1:e1" },
  collapse: { action: "collapse", ref: "@1:e1" },
  clear: { action: "clear", ref: "@1:e1" },
  focus: { action: "focus", ref: "@1:e1" },
  triple_click: { action: "triple_click", ref: "@1:e1" },
  launch: { action: "launch", app: "Finder" },
  close_app: { action: "close_app", app: "Finder" },
  focus_window: { action: "focus_window", app: "Finder" },
  maximize: { action: "maximize", app: "Finder" },
  minimize: { action: "minimize", app: "Finder" },
  restore: { action: "restore", app: "Finder" },
  move_window: { action: "move_window", window_id: "w-1", x: 10, y: 10 },
  resize_window: {
    action: "resize_window",
    window_id: "w-1",
    width: 400,
    height: 300,
  },
  list_displays: { action: "list_displays" },
  list_surfaces: { action: "list_surfaces", app: "Finder" },
  status: { action: "status" },
  permissions: { action: "permissions" },
  clipboard_get: { action: "clipboard_get" },
  clipboard_clear: { action: "clipboard_clear" },
  clipboard_set: { action: "clipboard_set", text: "hello" },
  clipboard_set_hyphen: { action: "clipboard_set", text: "--5" },
  focus_window_by_id: { action: "focus_window", window_id: "w-1" },
  scroll_to: { action: "scroll_to", ref: "@1:e1" },
  "snapshot with bounds": {
    action: "snapshot",
    app: "Finder",
    include_bounds: true,
  },
  // Only snapshot/screenshot/press take --window-id; a ref command rejects it.
  "press in a named window": {
    action: "press",
    app: "Finder",
    key: "Return",
    window_id: "w-1",
  },
  "screenshot a named window": {
    action: "screenshot",
    app: "Finder",
    window_id: "w-1",
  },
  "get with a ref and no window": {
    action: "get",
    ref: "@1:e1",
    property: "text",
  },
  "drag headed": {
    action: "drag",
    ref: "@1:e1",
    to_ref: "@1:e2",
    headed: true,
  },
  "drag a mixed start-ref end-coordinate": {
    action: "drag",
    ref: "@1:e1",
    to_x: 3,
    to_y: 4,
  },
  version: { action: "version" },
  skills_list: { action: "skills", sub: "list" },
  skills_get: { action: "skills", sub: "get", name: "desktop" },
  session_list: { action: "session", sub: "list" },
  session_start: { action: "session", sub: "start", name: "probe" },
  trace_show: { action: "trace", sub: "show", limit: 5 },
  // trace reads need a live session; the runner makes one for the whole suite.
  trace_export: {
    action: "trace_export",
    sub: "export",
    path: "/tmp/t.html",
  },
  cursor_overlay_enable: { action: "cursor_overlay", sub: "enable" },
  list_notifications: { action: "list_notifications", limit: 3 },
  dismiss_notification: {
    action: "dismiss_notification",
    index: 1,
    app: "Finder",
    expected_title: "hi",
  },
  dismiss_all_notifications: { action: "dismiss_all_notifications" },
  notification_action: {
    action: "notification_action",
    index: 2,
    app: "Mail",
    option: "Reply",
  },
  open_system_surface: { action: "open_system_surface", surface: "dock" },
  // The batch payload is a JSON positional behind `--`.
  batch: {
    action: "batch",
    steps: [{ command: "version" }, { command: "list-apps" }],
  },
  mouse_wheel: { action: "mouse_wheel", x: 400, y: 300, dy: -2 },
  mouse_move: { action: "mouse_move", x: 400, y: 300 },
};

const built = existsSync(BIN);

// Window geometry animates, so those cases outrun the default per-test budget.
describe.skipIf(!built)(
  "buildArgs against the real CLI",
  { timeout: 15_000 },
  () => {
    // The trace cases resolve a session themselves, so one is started for the
    // suite rather than each case inventing an id.
    const started = spawnSync(BIN, ["session", "start"], {
      encoding: "utf8",
    });
    const sessionId: string = JSON.parse(started.stdout).data.session_id;
    afterAll(() => {
      spawnSync(BIN, ["session", "end", `--session=${sessionId}`]);
    });

    const cases = {
      ...Object.fromEntries(
        Object.entries(CALLS).map(([action, params]) => [
          action,
          { action, ...params },
        ]),
      ),
      ...EXTRA_CALLS,
    };

    for (const [label, params] of Object.entries(cases)) {
      it(`${label} parses`, () => {
        const args = buildArgs(params);
        // The extension prefixes this itself; only the trace cases need it here.
        if (label.startsWith("trace")) args.push(`--session=${sessionId}`);
        const { status, stderr } = spawnSync(BIN, args, {
          encoding: "utf8",
          // A screenshot answers a megabyte of base64; the 1MB default buffer would
          // kill the child (null status) instead of testing it.
          maxBuffer: 8 * 1024 * 1024,
        });
        // Assert a real outcome, not just "not 2": a null status (a failed spawn)
        // also satisfies `not.toBe(2)`, so the test would pass vacuously through
        // ENOENT.
        expect(typeof status).toBe("number");
        expect(stderr).not.toContain("unexpected argument");
        expect(status).not.toBe(PARSE_FAILURE);
      });
    }
  },
);

// `session start` mints its own id and ignores --session, so the extension runs
// it unprefixed and adopts the id it answers with. That id has to be the
// namespace the next call lands in, or the refs a start seeds are unreachable.
describe.skipIf(!built)("a nested session start", { timeout: 15_000 }, () => {
  it("hands back an id the next call really runs in", () => {
    const started = spawnSync(BIN, startArgs({ sub: "start", name: "adopt" }), {
      encoding: "utf8",
    });
    expect(started.status).toBe(0);
    const id: string = JSON.parse(started.stdout).data.session_id;
    expect(id).toMatch(/^run-/);
    const snap = spawnSync(BIN, ["snapshot", "--app", "Finder"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_DESKTOP_SESSION: id },
    });
    expect(JSON.parse(snap.stdout).data.snapshot_id).toBeTruthy();
    spawnSync(BIN, ["session", "end", `--session=${id}`]);
  });
});
