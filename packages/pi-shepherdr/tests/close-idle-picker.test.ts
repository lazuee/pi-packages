import { describe, expect, test } from "bun:test";

import { IdlePicker, machineLabel } from "../src/close-idle-picker.js";

const entries = [
  { label: "a", machine: "local", terminal: "t1" },
  { label: "b", machine: "remote", terminal: "t2" },
  { label: "c", machine: "local", terminal: "t3" },
];
// Pass the first string through so both style() and style(withArgs) render text.
const theme = new Proxy(
  {},
  { get: () => (first: string, second?: string) => second ?? first }
) as never;
const tui = { requestRender: () => undefined } as never;

function make() {
  let result: string[] | undefined | "unset" = "unset";
  const picker = new IdlePicker(
    entries,
    theme,
    tui,
    (value) => {
      result = value;
    },
    (m) => machineLabel([{ id: "local", local: true, status: "connected" }], m)
  );
  return { picker, get: () => result };
}

describe("idle picker", () => {
  test("checks everything by default", () => {
    const { picker } = make();
    expect(picker.render(60).join("\n")).toContain("3/3 selected");
  });

  test("space toggles one and enter submits it", () => {
    const { picker, get } = make();
    picker.handleInput(" ");
    expect(picker.render(60).join("\n")).toContain("2/3 selected");
    picker.handleInput("\r");
    expect(get()).toEqual(["t2", "t3"]);
    expect(picker.dialog).toBe("closing");
  });

  test("a clears then selects all", () => {
    const { picker, get } = make();
    picker.handleInput("a");
    expect(picker.render(60).join("\n")).toContain("0/3 selected");
    picker.handleInput("a");
    expect(picker.render(60).join("\n")).toContain("3/3 selected");
    picker.handleInput("\r");
    expect(get()).toEqual(["t1", "t2", "t3"]);
  });

  test("escape cancels", () => {
    const { picker, get } = make();
    picker.handleInput("\u001B");
    expect(get()).toBeUndefined();
  });

  test("an exited target is marked apart from one still running", () => {
    const picker = new IdlePicker(
      [
        { label: "a", machine: "local", terminal: "t1" },
        { label: "b", machine: "local", terminal: "t2", dead: true },
      ],
      theme,
      tui,
      () => undefined,
      (m) => machineLabel([{ id: "local", local: true, status: "connected" }], m)
    );
    const lines = picker.render(200);
    const a = lines.find((line) => line.includes(" a "))!;
    const b = lines.find((line) => line.includes(" b "))!;
    expect(a).not.toContain("exited");
    expect(b).toContain("exited");
  });

  test("input is ignored while closing", () => {
    const { picker } = make();
    picker.handleInput("\r");
    picker.handleInput(" ");
    expect(picker.render(60).join("\n")).toContain("3/3 selected");
  });
});
