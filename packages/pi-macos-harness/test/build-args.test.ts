import { describe, expect, it } from "vitest";
import { buildArgs } from "#src/extension.js";

describe("buildArgs", () => {
  it("passes the app and the element it acts on", () => {
    expect(
      buildArgs({ action: "click", app: "Finder", element_index: 4 }),
    ).toEqual(["click", "--app", "Finder", "--element_index", "4"]);
  });

  it("drops --app for the one action that lists every app", () => {
    expect(buildArgs({ action: "list_apps", app: "Finder" })).toEqual([
      "list_apps",
    ]);
  });

  it("keeps a zero coordinate, which is falsy but real", () => {
    expect(buildArgs({ action: "click", app: "X", x: 0, y: 0 })).toEqual([
      "click",
      "--app",
      "X",
      "--x",
      "0",
      "--y",
      "0",
    ]);
  });

  it("carries a delay and a point click only when asked", () => {
    expect(
      buildArgs({ action: "type_text", app: "X", text: "a", delay: 0.03 }),
    ).toContain("--delay");
    expect(
      buildArgs({ action: "type_text", app: "X", text: "a" }),
    ).not.toContain("--delay");
    expect(
      buildArgs({ action: "click", app: "X", element_index: 1, point: true }),
    ).toContain("--point");
    expect(
      buildArgs({ action: "click", app: "X", element_index: 1 }),
    ).not.toContain("--point");
  });

  it("passes multi-line text whole, newlines included", () => {
    expect(buildArgs({ action: "paste", app: "X", text: "a\nb" })).toEqual([
      "paste",
      "--app",
      "X",
      "--text",
      "a\nb",
    ]);
  });

  it("puts the full tree only when asked for it", () => {
    expect(
      buildArgs({ action: "get_app_state", app: "X", disable_diff: true }),
    ).toContain("--disableDiff");
    expect(buildArgs({ action: "get_app_state", app: "X" })).not.toContain(
      "--disableDiff",
    );
  });
});
