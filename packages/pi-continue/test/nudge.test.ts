import { describe, expect, it } from "vitest";
import { composeNudge } from "#src/nudge";

describe("composeNudge", () => {
  it("sends a bare continue for an empty response", () => {
    expect(composeNudge({ kind: "empty", text: "" })).toBe("continue");
  });

  it("asks for shorter steps when truncated", () => {
    expect(composeNudge({ kind: "truncated", text: "" })).toContain(
      "output-token limit",
    );
  });

  it("quotes the tail back when the reply trailed off", () => {
    const nudge = composeNudge({ kind: "abandoned", text: "Now let me run" });
    expect(nudge).toContain('"Now let me run"');
  });

  it("caps a long tail quote", () => {
    const nudge = composeNudge({ kind: "abandoned", text: "y".repeat(1000) });
    expect(nudge).toContain("…");
    expect(nudge.length).toBeLessThan(700);
  });

  it("carries the operator's task", () => {
    const nudge = composeNudge({
      kind: "errored",
      text: "",
      operatorMessage: "fix the parser",
    });
    expect(nudge).toContain("The task is still: fix the parser");
  });

  it("caps a long operator quote", () => {
    const nudge = composeNudge({
      kind: "errored",
      text: "",
      operatorMessage: "z".repeat(1000),
    });
    expect(nudge).toContain("…");
  });

  it("omits the task block for a bare continue", () => {
    expect(
      composeNudge({ kind: "empty", text: "", operatorMessage: "do it" }),
    ).toBe("continue");
  });
});
