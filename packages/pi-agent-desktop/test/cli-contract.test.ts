import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildArgs } from "#src/extension";

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
  "drag to negative coordinates": {
    action: "drag",
    from_x: -100,
    from_y: 50,
    to_x: -5,
    to_y: 9,
  },
  "hover headed": { action: "hover", ref: "@1:e1", headed: true },
  "snapshot a named window": { action: "snapshot", window_id: "w-1" },
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
};

const built = existsSync(BIN);

describe.skipIf(!built)("buildArgs against the real CLI", () => {
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
      const { status, stderr } = spawnSync(BIN, buildArgs(params), {
        encoding: "utf8",
      });
      // Assert a real outcome, not just "not 2": a null status (a failed spawn)
      // also satisfies `not.toBe(2)`, so the test would pass vacuously through
      // ENOENT.
      expect(typeof status).toBe("number");
      expect(stderr).not.toContain("unexpected argument");
      expect(status).not.toBe(PARSE_FAILURE);
    });
  }
});
