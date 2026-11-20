import { describe, expect, test } from "bun:test";

import type { EditorComponent } from "@earendil-works/pi-tui";
import {
  CURSOR_MARKER,
  renderFakeCursor,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { SuggestionEditor } from "../src/editor.ts";

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
