import { describe, expect, it } from "vitest";
import { buildArgs, cliError, render, shotContent } from "#src/extension";

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

  // Only three commands take the flag; a ref command rejects it, so passing
  // window_id alongside a ref must not reach argv.
  it("drops window_id for the commands that reject it", () => {
    const args = buildArgs({
      action: "click",
      ref: "@1:e1",
      window_id: "w-1",
    });
    expect(args).not.toContain("--window-id");
    expect(args).toContain("@1:e1");
    expect(
      buildArgs({
        action: "press",
        app: "Notes",
        key: "Return",
        window_id: "w-1",
      }),
    ).toContain("--window-id");
  });

  it("omits empty strings so clap does not see a blank value", () => {
    const args = buildArgs({ action: "click", app: "Notes", ref: "" });
    expect(args).toEqual(["click"]);
  });
});

// The CLI answers a pathless screenshot with base64 JSON. Left as text the model
// gets bytes it cannot see, so it becomes ImageContent; the size stays in text
// because a pixel click needs it and the image does not carry it.
describe("shotContent", () => {
  // The CLI wraps every result as { command, data, ok, version }: the payload is
  // one level down, and reading the top level is what silently found nothing.
  const shot = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      command: "screenshot",
      data: {
        data: "iVBORw0KGgo=",
        format: "png",
        width: 2496,
        height: 1064,
        scale_factor: 2,
        ...over,
      },
      ok: true,
      version: "2.5",
    });

  it("returns the pixels as an image beside their size at the real scale", () => {
    expect(shotContent(shot())).toEqual([
      {
        type: "text",
        text: "Screenshot 2496x1064 px at 2x: divide a pixel by 2 for a point.",
      },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
    ]);
  });

  // The image is device pixels; click/hover x/y are accessibility points.
  it("names no ratio at 1x, where the pixels are already points", () => {
    const text = shotContent(shot({ scale_factor: 1 }))[0] as { text: string };
    expect(text.text).toBe("Screenshot 2496x1064 px.");
  });

  it("falls back to the raw text when the payload or format is unknown", () => {
    const raw = "Not JSON";
    expect(shotContent(raw)).toEqual([{ type: "text", text: raw }]);
    const tiff = shot({ format: "tiff" });
    expect(shotContent(tiff)).toEqual([{ type: "text", text: tiff }]);
    const empty = JSON.stringify({ command: "screenshot", data: {}, ok: true });
    expect(shotContent(empty)).toEqual([{ type: "text", text: empty }]);
  });

  it("keeps the text when the CLI reports a saved path instead of data", () => {
    const saved = shot({ data: undefined, path: "/tmp/a.png" });
    expect(shotContent(saved)).toEqual([{ type: "text", text: saved }]);
  });
});

// A failure arrives as the CLI's own JSON envelope. Thrown whole it is a wall of
// braces; the message and the suggestion are the two parts worth keeping.
describe("cliError", () => {
  const fail = (error: unknown) =>
    JSON.stringify({ command: "screenshot", error, ok: false, version: "2.5" });

  it("keeps the message and the suggestion, without the envelope", () => {
    const out = fail({
      code: "AMBIGUOUS_TARGET",
      message: "Multiple windows matched the selected process instance",
      suggestion: "Run 'list-windows' and retry with --window-id <id>.",
    });
    expect(cliError(out, "screenshot", 1)).toBe(
      "Multiple windows matched the selected process instance\nRun 'list-windows' and retry with --window-id <id>.",
    );
  });

  it("passes through what it cannot read, and a bare message", () => {
    expect(cliError("boom", "click", 3)).toBe("boom");
    expect(cliError("", "click", 3)).toBe(
      "agent-desktop click failed with exit 3",
    );
    const bare = fail({ code: "TIMEOUT", message: "No answer" });
    expect(cliError(bare, "click", 1)).toBe("No answer");
  });

  // The ids that would disambiguate the target are in `details`, so the agent
  // does not have to go looking for what the error already knew.
  it("names the candidates an ambiguous target offers", () => {
    const out = fail({
      code: "AMBIGUOUS_TARGET",
      details: { candidate_pids: [611], candidates: [{ id: "w-1" }] },
      message: "2 windows matched",
      suggestion: "Pass --window-id",
    });
    expect(cliError(out, "snapshot", 1)).toBe(
      "2 windows matched\nPass --window-id\nCandidates: w-1",
    );
  });
});

// Every command answers `{ command, ok, data }`. Handing that to the agent as
// JSON costs it a parse, so `data` is written as text instead. The payloads below
// are what the real binary returns, sampled with --property, list-displays and
// find --count.
describe("render", () => {
  const ok = (data: unknown) =>
    JSON.stringify({ command: "get", data, ok: true, version: "2.6" });

  // The legend is printed only on a big tree, so tests that count lines drop it
  // rather than assume an offset.
  const below = (text: string) =>
    text.split("\n").filter((l) => !l.startsWith("Elements read"));

  it("writes bounds as a rectangle, and flags a stale one", () => {
    const at = { height: 1027, width: 656, x: 152, y: -537 };
    expect(render(ok({ live: true, property: "bounds", value: at }))).toBe(
      "bounds: 152,-537 656x1027",
    );
    // Docs: when live is false the rectangle came from the snapshot.
    expect(render(ok({ live: false, property: "bounds", value: at }))).toBe(
      "bounds: 152,-537 656x1027\n(from the snapshot, not live — re-read before a click)",
    );
  });

  it("writes a list one entry per line", () => {
    const displays = JSON.stringify({
      command: "list-displays",
      data: [{ bounds: { height: 982, width: 1512, x: 0, y: 0 }, id: "1" }],
      ok: true,
    });
    expect(render(displays)).toBe(
      [
        "#1 bounds:",
        "  height: 982",
        "  width: 1512",
        "  x: 0",
        "  y: 0",
        " id: 1",
      ].join("\n"),
    );
  });

  // A node leads with the ref, because the ref is what gets acted on. An unnamed
  // node carries its content in `value`, so that stays the identity.
  it("writes a node as ref, role, name and value, with state and actions", () => {
    const tree = JSON.stringify({
      command: "snapshot",
      data: {
        tree: {
          children: [
            {
              available_actions: ["Click"],
              name: "Close",
              ref_id: "@s1:e10",
              role: "button",
              states: ["disabled"],
            },
          ],
        },
      },
      ok: true,
    });
    expect(below(render(tree))).toEqual([
      "tree:",
      " children:",
      "  #1 @s1:e10 button Close",
      "    states: disabled",
      "    acts: Click",
    ]);
  });

  it("keeps a clamped long value and marks the cut", () => {
    const long = "x".repeat(400);
    const tree = JSON.stringify({
      command: "snapshot",
      data: { tree: { ref_id: "@s1:e1", role: "textfield", value: long } },
      ok: true,
    });
    const line = below(render(tree))[1];
    expect(line).toContain("@s1:e1 textfield xxxx");
    expect(line.endsWith("…")).toBe(true);
  });

  // A skeleton marks what depth cut, so the ref appears with its count.
  it("shows a drill marker on a cut container", () => {
    const tree = JSON.stringify({
      command: "snapshot",
      data: { tree: { children_count: 2, ref_id: "@s1:e1", role: "group" } },
      ok: true,
    });
    expect(below(render(tree))).toEqual(["tree:", " @s1:e1 group", "  +2"]);
  });

  // RightClick/ScrollTo/SetFocus do not earn a ref on their own, so on a ref-less
  // node they advertised an action no ref could address. A primary action still
  // prints, because it is what makes the node worth looking at.
  it("drops only situational actions on a ref-less node", () => {
    const bare = JSON.stringify({
      command: "snapshot",
      data: {
        tree: {
          available_actions: ["RightClick", "ScrollTo", "SetFocus"],
          children: [],
          role: "group",
        },
      },
      ok: true,
    });
    expect(below(render(bare))).toEqual(["tree:", " group"]);

    const kept = JSON.stringify({
      command: "snapshot",
      data: {
        tree: {
          available_actions: ["Expand", "ScrollTo", "SetFocus"],
          children: [],
          role: "disclosure",
        },
      },
      ok: true,
    });
    expect(render(kept)).toContain("acts: Expand, ScrollTo, SetFocus");
  });

  // The live CLI omits `children` on a leaf, so a leaf has to be recognised by
  // the fields it does carry, or its actions print as a numbered list.
  // The legend is a fixed ~360 chars, so it is only worth printing on a tree big
  // enough to pay for it; a drilled region of one or two nodes reads shorter
  // without, and that is the common follow-up to a skeleton.
  it("prints the legend only on a tree big enough to pay for it", () => {
    const leaf = (i: number) => ({ ref_id: `@s1:e${i}`, role: "button" });
    const tree = (n: number) =>
      JSON.stringify({
        command: "snapshot",
        data: {
          tree: {
            children: Array.from({ length: n }, (_, i) => leaf(i)),
            role: "window",
          },
        },
        ok: true,
      });
    expect(render(tree(1))).not.toContain("Elements read");
    expect(render(tree(30))).toContain("Elements read");
    // The gate flips exactly here (17 children is 19 lines, 18 is 21), so a
    // loosened or removed constant shows up as one of these two failing.
    expect(render(tree(17))).not.toContain("Elements read");
    expect(render(tree(18))).toContain("Elements read");
    // Both sides stay shorter than the JSON they came from.
    expect(render(tree(1)).length).toBeLessThan(tree(1).length);
    expect(render(tree(30)).length).toBeLessThan(tree(30).length);
  });

  it("reads a leaf with no children array as a node", () => {
    const leaf = JSON.stringify({
      command: "snapshot",
      data: {
        tree: {
          available_actions: ["Click", "RightClick"],
          role: "button",
        },
      },
      ok: true,
    });
    const lines = render(leaf).split("\n");
    expect(lines).toContain("  acts: Click, RightClick");
    expect(lines.join("\n")).not.toContain("available_actions");
  });

  // A bare `{ role }` is the least a leaf can be: no ref, no children, no
  // actions. It still has to read as a node line, not as `role: group`.
  it("reads a bare role object as a node", () => {
    const tree = JSON.stringify({
      command: "snapshot",
      data: { tree: { children: [{ role: "group" }], role: "window" } },
      ok: true,
    });
    expect(below(render(tree))).toContain("  #1 group");
  });

  // A scrollbar's name is a float position; the tail is noise on every call.
  it("rounds a float name", () => {
    const tree = JSON.stringify({
      command: "snapshot",
      data: {
        tree: {
          ref_id: "@s1:e1",
          role: "scrollbar",
          value: "0.18518517911434174",
        },
      },
      ok: true,
    });
    expect(below(render(tree))).toContain(" @s1:e1 scrollbar 0.1852");
    expect(below(render(tree)).join(" ")).not.toContain("0.18518");
  });

  it("writes a count and a bare scalar as themselves", () => {
    expect(render(ok({ count: 7 }))).toBe("count: 7");
    expect(render(ok("textfield"))).toBe("textfield");
  });

  // A false result on a text field is not "unchecked", it is not checkable; the
  // plain unwrap guessed and said `false`.
  it("says an inapplicable state instead of a false result", () => {
    const na = ok({ applicable: false, property: "checked", result: false });
    expect(render(na)).toBe("checked: not applicable to this element");
    const yes = ok({ applicable: true, property: "visible", result: true });
    expect(render(yes)).toBe("visible: true");
  });

  // `get` is the way to read whole what a snapshot line clamps, so it must not
  // clamp too; the property name stays on the line so a one-word answer says
  // which question it answers.
  it("writes a get whole, under its property name", () => {
    const long = "y".repeat(300);
    expect(render(ok({ property: "text", value: long }))).toBe(`text: ${long}`);
    expect(render(ok({ property: "states", value: ["expanded"] }))).toBe(
      "states: expanded",
    );
    // An empty list is a real answer and would otherwise print a bare label.
    expect(render(ok({ property: "states", value: [] }))).toBe(
      "states: (none)",
    );
    // A null value is the answer here, not an absent key, so it is not dropped.
    expect(render(ok({ property: "text", value: null }))).toBe("text: (none)");
  });

  it("passes through what it cannot unwrap, and never returns empty", () => {
    expect(render("plain words")).toBe("plain words");
    expect(render("")).toBe("Nothing on screen.");
    expect(render(JSON.stringify({ data: null }))).toBe("Nothing on screen.");
  });
});
