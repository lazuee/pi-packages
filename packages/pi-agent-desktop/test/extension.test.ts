import { describe, expect, it } from "vitest";
import { buildArgs } from "#src/extension";

// The CLI's own spellings are the contract here, and every case below was
// measured against the real binary plus `--help`, not inferred. Three defects
// shipped once because the tests and the builder shared an author: --app on the
// ref commands, a ref positional on press, and scroll sent to the wheel.
describe("buildArgs", () => {
  it("maps the tool's action names onto the CLI's dashed commands", () => {
    expect(buildArgs({ action: "set_value" })[0]).toBe("set-value");
    expect(buildArgs({ action: "list_apps" })[0]).toBe("list-apps");
    // scroll is a command of its own, not the wheel.
    expect(buildArgs({ action: "scroll" })[0]).toBe("scroll");
  });

  it("sends no --app to a ref command, which carries its window in the ref", () => {
    for (const action of ["click", "type", "set_value", "select"]) {
      expect(
        buildArgs({ action, app: "Notes", ref: "@s1:e3" }).some((a) =>
          a.startsWith("--app"),
        ),
      ).toBe(false);
    }
  });

  it("passes the ref positionally, before the text", () => {
    expect(
      buildArgs({ action: "type", app: "Notes", ref: "@s1:e3", text: "hi" }),
    ).toEqual(["type", "@s1:e3", "--", "hi"]);
  });

  it("keeps a multi-line text in one argument", () => {
    const args = buildArgs({
      action: "type",
      app: "Notes",
      ref: "@s1:e3",
      text: "a\nb",
    });
    expect(args.at(-1)).toBe("a\nb");
    expect(args.filter((a) => a === "a\nb")).toHaveLength(1);
  });

  it("passes set_value's value positionally, not as --value", () => {
    const args = buildArgs({
      action: "set_value",
      app: "Notes",
      ref: "@s1:e3",
      value: "v",
    });
    expect(args).toContain("v");
    expect(args).not.toContain("--value");
  });

  it("gives press the combo as its only positional, and scopes it by --app", () => {
    expect(buildArgs({ action: "press", app: "Notes", key: "cmd+s" })).toEqual([
      "press",
      "--app=Notes",
      "--",
      "cmd+s",
    ]);
  });

  it("drops the ref press cannot take", () => {
    expect(
      buildArgs({ action: "press", app: "Notes", ref: "@s1:e3", key: "cmd+s" }),
    ).toEqual(["press", "--app=Notes", "--", "cmd+s"]);
  });

  it("scrolls a ref by direction and amount, not by wheel coordinates", () => {
    expect(
      buildArgs({ action: "scroll", app: "Notes", ref: "@s1:e3", amount: 5 }),
    ).toEqual(["scroll", "@s1:e3", "--amount=5"]);

    const up = buildArgs({
      action: "scroll",
      app: "Notes",
      ref: "@s1:e3",
      direction: "up",
    });
    expect(up).toContain("--direction=up");
    expect(up).not.toContain("--dy");
  });

  it("joins coordinates and stays headless unless asked", () => {
    expect(
      buildArgs({ action: "hover", app: "Notes", x: 5, y: 9 }),
    ).not.toContain("--headed");
    expect(buildArgs({ action: "hover", app: "Notes", x: 5, y: 9 })).toContain(
      "--xy=5,9",
    );

    const drag = buildArgs({
      action: "drag",
      app: "Notes",
      from_x: 1,
      from_y: 2,
      to_x: 3,
      to_y: 4,
    });
    expect(drag).toEqual(
      expect.arrayContaining(["--from-xy=1,2", "--to-xy=3,4"]),
    );
  });

  it("opts the pointer in only when headed is set", () => {
    expect(
      buildArgs({ action: "hover", app: "Notes", x: 5, y: 9, headed: true }),
    ).toContain("--headed");
    expect(
      buildArgs({ action: "drag", app: "Notes", ref: "@s1:e3", headed: true }),
    ).toContain("--headed");
    // Also honoured on click: the CLI refuses instead of falling back
    // physically, and which elements lack semantic delivery cannot be known
    // before the call.
    expect(
      buildArgs({ action: "click", app: "Notes", ref: "@s1:e3", headed: true }),
    ).toEqual(["click", "--headed", "@s1:e3"]);
    expect(
      buildArgs({ action: "click", app: "Notes", ref: "@s1:e3" }),
    ).not.toContain("--headed");
  });

  it("hovers by ref as a positional, so the pointer travels less", () => {
    expect(buildArgs({ action: "hover", app: "Notes", ref: "@s1:e3" })).toEqual(
      ["hover", "@s1:e3"],
    );
  });

  it("drags between refs, falling back to coordinates per endpoint", () => {
    expect(
      buildArgs({
        action: "drag",
        app: "Notes",
        ref: "@s1:e3",
        to_ref: "@s1:e7",
      }),
    ).toEqual(["drag", "--from", "@s1:e3", "--to", "@s1:e7"]);

    // A ref start with a coordinate end still works, and sends no --from-xy.
    const mixed = buildArgs({
      action: "drag",
      app: "Notes",
      ref: "@s1:e3",
      to_x: 3,
      to_y: 4,
    });
    expect(mixed).toEqual(
      expect.arrayContaining(["--from", "@s1:e3", "--to-xy=3,4"]),
    );
    expect(mixed).not.toContain("--from-xy");
  });

  it("sends no --app to hover or drag, which are pointer-scoped", () => {
    expect(
      buildArgs({ action: "hover", app: "Notes", x: 1, y: 2 }),
    ).not.toContain("--app=Notes");
    expect(
      buildArgs({ action: "drag", app: "Notes", from_x: 1, from_y: 2 }),
    ).not.toContain("--app=Notes");
  });

  it("scopes the read commands by --app", () => {
    expect(buildArgs({ action: "snapshot", app: "Notes" })).toEqual([
      "snapshot",
      "--app=Notes",
    ]);
    expect(buildArgs({ action: "list_windows", app: "Notes" })).toEqual([
      "list-windows",
      "--app=Notes",
    ]);
  });

  it("stops after list_apps, which takes no other flags", () => {
    expect(buildArgs({ action: "list_apps", app: "Notes" })).toEqual([
      "list-apps",
    ]);
  });

  it("escapes a hyphen-leading value so clap does not read it as a flag", () => {
    expect(
      buildArgs({
        action: "type",
        app: "Notes",
        ref: "@s1:e3",
        text: "--headed",
      }),
    ).toEqual(["type", "@s1:e3", "--", "--headed"]);
    expect(
      buildArgs({
        action: "set_value",
        app: "Notes",
        ref: "@s1:e3",
        value: "--x",
      }),
    ).toContain("--x");
    // A flag stays ahead of the terminator, or `--` would swallow it.
    const scoped = buildArgs({ action: "press", app: "Notes", key: "--5" });
    expect(scoped).toEqual(["press", "--app=Notes", "--", "--5"]);
    expect(scoped.indexOf("--app=Notes")).toBeLessThan(scoped.indexOf("--"));
  });

  it("uses the equals form for a negative coordinate", () => {
    // A negative x is a left-hand display, where a bare `--xy -100,50` is read
    // as a flag and rejected.
    expect(
      buildArgs({ action: "hover", app: "Notes", x: -100, y: 50 }),
    ).toContain("--xy=-100,50");
    expect(
      buildArgs({
        action: "drag",
        app: "Notes",
        from_x: -100,
        from_y: 50,
        to_x: -5,
        to_y: 9,
      }),
    ).toEqual(expect.arrayContaining(["--from-xy=-100,50", "--to-xy=-5,9"]));
  });

  it("targets one window when an app name is ambiguous", () => {
    expect(
      buildArgs({ action: "snapshot", app: "Notes", window_id: "w-1" }),
    ).toEqual(["snapshot", "--window-id", "w-1", "--app=Notes"]);
  });

  it("omits empty strings so clap does not see a blank value", () => {
    const args = buildArgs({ action: "click", app: "Notes", ref: "" });
    expect(args).toEqual(["click"]);
  });
});
