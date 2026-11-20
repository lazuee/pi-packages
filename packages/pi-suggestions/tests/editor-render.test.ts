import { describe, expect, test } from "bun:test";

import type { EditorComponent } from "@earendil-works/pi-tui";
import {
  CURSOR_MARKER,
  renderFakeCursor,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { ghostOverRow, SuggestionEditor } from "../src/editor.ts";

const WIDTH = 20;

/**
 * Pi returns the same array from `render()` while nothing changed, so a wrapper
 * that writes into it corrupts every later frame. These tests hand the wrapper
 * exactly such a cached array and check the cache survives.
 */
function innerWithCachedLines(lines: string[]): EditorComponent {
  return {
    focused: true,
    getText: () => "",
    setText: () => {},
    handleInput: () => {},
    invalidate: () => {},
    isShowingAutocomplete: () => false,
    render: () => lines,
  } as unknown as EditorComponent;
}

function state(prediction: string | undefined) {
  return {
    active: true,
    prediction,
    onInput: () => {},
    requestRender: () => {},
  };
}

/** A three-row layout with the cursor and its fake-cursor cell in the content row. */
function emptyLayout(): string[] {
  const content = `${CURSOR_MARKER}${renderFakeCursor(" ")}`;
  return [
    "─".repeat(WIDTH),
    `${content}${" ".repeat(WIDTH - visibleWidth(content))}`,
    "─".repeat(WIDTH),
  ];
}

describe("ghost rendering over a cached inner array", () => {
  test("does not write the ghost line into the inner editor's cached array", () => {
    const cached = emptyLayout();
    const inner = innerWithCachedLines(cached);
    const editor = new SuggestionEditor(inner, state("hello"));

    const first = editor.render(WIDTH);

    expect(stripTerminalSequences(first[1])).toContain("hello");
    // The cache is a distinct array whose content row is untouched.
    expect(cached[1]).toBe(emptyLayout()[1]);
    // A second render of the same cached input still shows the ghost.
    expect(stripTerminalSequences(editor.render(WIDTH)[1])).toContain("hello");
  });

  test("returns the inner array untouched when there is nothing to add", () => {
    const cached = emptyLayout();
    const editor = new SuggestionEditor(
      innerWithCachedLines(cached),
      state(undefined)
    );

    expect(editor.render(WIDTH)).toBe(cached);
  });

  test("leaves a layout that is not the expected three rows alone", () => {
    const cached = ["just one line"];
    const editor = new SuggestionEditor(
      innerWithCachedLines(cached),
      state("hello")
    );

    expect(editor.render(WIDTH)).toBe(cached);
  });
});

/**
 * The synthetic layouts above pin the row logic; this one proves it against the
 * real editor, whose cursor lives below its top border rather than on it.
 */
describe("ghost rendering over pi's own editor", () => {
  const width = 30;
  const tui = {
    requestRender: () => {},
    terminal: { columns: width, rows: 24 },
  };
  const theme = new Proxy({}, { get: () => (text: string) => text });

  test("writes the ghost on the cursor row, not the top border", async () => {
    const { CustomEditor } = await import("@earendil-works/pi-coding-agent");
    const inner = new (CustomEditor as unknown as new (
      ...args: unknown[]
    ) => EditorComponent)(tui, theme, {});
    inner.focused = true;

    const editor = new SuggestionEditor(inner, state("predict-me"));
    const lines = editor.render(width);

    expect(lines.length).toBe(3);
    // Row 0 is the border and carries no cursor; the ghost must land below it.
    expect(lines[0]).not.toContain(CURSOR_MARKER);
    expect(stripTerminalSequences(lines[1] ?? "")).toContain("predict-me");
  });

  test("keeps every row at the requested width", async () => {
    const { CustomEditor } = await import("@earendil-works/pi-coding-agent");
    const inner = new (CustomEditor as unknown as new (
      ...args: unknown[]
    ) => EditorComponent)(tui, theme, {});
    inner.focused = true;

    const editor = new SuggestionEditor(inner, state("predict-me"));

    for (const line of editor.render(width)) {
      expect(visibleWidth(line)).toBe(width);
    }
  });
});

/**
 * The helper bails rather than guessing, so each guard gets its own case: a
 * wrong layout must come back as `undefined` and leave the caller's array alone.
 */
describe("ghostOverRow bail-outs", () => {
  const layout = () => emptyLayout();

  test("bails on a layout that is not three rows", () => {
    expect(ghostOverRow(["only one"], "hello", WIDTH)).toBeUndefined();
    expect(ghostOverRow([], "hello", WIDTH)).toBeUndefined();
  });

  test("bails when no row carries the cursor", () => {
    const lines = layout();
    lines[1] = " ".repeat(WIDTH);
    expect(ghostOverRow(lines, "hello", WIDTH)).toBeUndefined();
  });

  test("bails when more than one row carries the cursor", () => {
    const lines = layout();
    lines[0] = `${CURSOR_MARKER}${"─".repeat(WIDTH - visibleWidth(CURSOR_MARKER))}`;
    expect(ghostOverRow(lines, "hello", WIDTH)).toBeUndefined();
  });

  test("bails when the cursor row is not at the requested width", () => {
    const lines = layout();
    lines[1] = `${CURSOR_MARKER}${renderFakeCursor(" ")}`;
    expect(ghostOverRow(lines, "hello", WIDTH)).toBeUndefined();
  });

  test("bails when something already follows the cursor cell", () => {
    const content = `${CURSOR_MARKER}${renderFakeCursor(" ")}x`;
    const lines = [
      "─".repeat(WIDTH),
      `${content}${" ".repeat(WIDTH - visibleWidth(content))}`,
      "─".repeat(WIDTH),
    ];
    expect(ghostOverRow(lines, "hello", WIDTH)).toBeUndefined();
  });

  test("bails when the width leaves no room beside the cursor", () => {
    const lines = layout();
    // A cursor indented past the halfway mark leaves fewer than two columns.
    lines[1] = `${" ".repeat(10)}${CURSOR_MARKER}${renderFakeCursor(" ")}${" ".repeat(
      WIDTH - 10 - visibleWidth(CURSOR_MARKER) - 1
    )}`;
    expect(ghostOverRow(lines, "hello", WIDTH)).toBeUndefined();
  });

  test("leaves the caller's array untouched on every bail-out", () => {
    const lines = ["only one"];
    const before = [...lines];
    ghostOverRow(lines, "hello", WIDTH);
    expect(lines).toEqual(before);
  });
});

describe("ghostOverRow success path", () => {
  test("dims the ghost, keeps the cursor marker and lands on the cursor row", () => {
    const lines = emptyLayout();

    const ghosted = ghostOverRow(lines, "hello", WIDTH);

    expect(ghosted).toBeDefined();
    const row = ghosted?.[1] ?? "";
    // Dim on, dim off, around the ghost; the border rows are untouched.
    expect(row).toContain("\u001B[2m");
    expect(row).toContain("\u001B[22m");
    expect(row).toContain(CURSOR_MARKER);
    expect(stripTerminalSequences(row)).toContain("hello");
    expect(ghosted?.[0]).toBe(lines[0]);
    expect(ghosted?.[2]).toBe(lines[2]);
  });

  test("returns a copy, leaving the input array as it was", () => {
    const lines = emptyLayout();
    const before = [...lines];

    const ghosted = ghostOverRow(lines, "hello", WIDTH);

    expect(ghosted).not.toBe(lines);
    expect(lines).toEqual(before);
  });

  test("keeps every row at the requested width", () => {
    // Also the only guard on the assembled row: truncation keeps it in range, so
    // the final width check is a backstop that ordinary layouts rarely reach.
    const ghosted = ghostOverRow(emptyLayout(), "hello", WIDTH);

    for (const line of ghosted ?? []) expect(visibleWidth(line)).toBe(WIDTH);
  });

  test("shortens a prediction too long for the space", () => {
    const long = "a".repeat(200);

    const ghosted = ghostOverRow(emptyLayout(), long, WIDTH);

    expect(ghosted).toBeDefined();
    const row = stripTerminalSequences(ghosted?.[1] ?? "");
    expect(row).toContain("…");
    expect(row.length).toBe(WIDTH);
  });
});
