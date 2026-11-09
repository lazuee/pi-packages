import { describe, expect, it } from "vitest";
import type { MessageLike } from "#src/evidence";
import {
  endsOnTerminal,
  endsPlainly,
  isClosedByTerminal,
  isSilent,
  readEvidence,
  trailsOff,
} from "#src/evidence";

const assistant = (content: MessageLike["content"], stopReason = "stop") => ({
  role: "assistant",
  stopReason,
  content,
});

describe("readEvidence", () => {
  it("reads the trailing assistant message, not an earlier one", () => {
    const evidence = readEvidence([
      assistant([{ type: "text", text: "first" }]),
      { role: "user", content: "next" },
      assistant([{ type: "text", text: "last" }]),
    ]);
    expect(evidence.text).toBe("last");
  });

  it("flattens a string content payload", () => {
    expect(readEvidence([assistant("  hi  ")]).text).toBe("hi");
  });

  it("reports tool calls and thinking blocks", () => {
    const evidence = readEvidence([
      assistant([{ type: "thinking" }, { type: "toolCall" }]),
    ]);
    expect(evidence.hasThinking).toBe(true);
    expect(evidence.hasToolCall).toBe(true);
  });

  it("falls back to unknown evidence when no assistant message exists", () => {
    expect(
      readEvidence([{ role: "user", content: "hi" }]).stopReason,
    ).toBeUndefined();
  });
});

describe("isSilent", () => {
  it("treats thinking-only as silent", () => {
    const evidence = readEvidence([assistant([{ type: "thinking" }])]);
    expect(isSilent(evidence)).toBe(true);
  });

  it("is not silent when a tool ran", () => {
    const evidence = readEvidence([assistant([{ type: "toolCall" }])]);
    expect(isSilent(evidence)).toBe(false);
  });

  it("is not silent when text exists", () => {
    const evidence = readEvidence([
      assistant([{ type: "text", text: "done" }]),
    ]);
    expect(isSilent(evidence)).toBe(false);
  });
});

describe("trailsOff", () => {
  it.each([
    "a comma,",
    "a colon:",
    "a semicolon;",
    "ends with and",
    "text ```",
    "Two paragraphs done.\n\nThen this one trails,",
    "```ts\nconst a = 1;",
    "```",
    "| a | b |\n| --- | --- |",
    "| a | b |\n| --- | --- |\n| 1 |",
    "notes\n\n| a | b |\n| --- | --- |\n| 1 | 2",
  ])("detects %j", (text) => {
    expect(trailsOff(text)).toBe(true);
  });

  it.each([
    "a complete sentence.",
    "Done.",
    "",
    "Done.\n\n- a list item\n",
    "```ts\nconst a = 1;\n```\n\nAll green.",
    "notes\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
  ])("passes %j", (text) => {
    expect(trailsOff(text)).toBe(false);
  });

  it("reads only the last paragraph", () => {
    expect(trailsOff("Section:\n\nAll green.")).toBe(false);
  });
});

describe("isClosedByTerminal", () => {
  it.each([
    "Whitespace-only. `@types/node`:\n\n",
    "This sentence closed. A bare colon:\n\n",
    "Done.\n\n",
    "Done!\n\n",
  ])("forgives the mark in %j", (text) => {
    expect(isClosedByTerminal(text)).toBe(true);
  });

  it.each(["a bare lead-in:", "See `x`:", "a bullet:\n\n- "])(
    "does not forgive %j",
    (text) => {
      expect(isClosedByTerminal(text)).toBe(false);
    },
  );
});

describe("endsOnTerminal", () => {
  it.each([
    "Done.",
    "Really?",
    "Watch out!",
    "Done.)",
    "Done.\n\n- item kept as is.",
  ])("accepts %j", (text) => {
    expect(endsOnTerminal(text)).toBe(true);
  });

  it.each(["the next version is", "3", "v1.2.0", "text ```", ""])(
    "rejects %j",
    (text) => {
      expect(endsOnTerminal(text)).toBe(false);
    },
  );
});

describe("endsPlainly", () => {
  it.each([
    "3",
    "v1.2.0",
    "`@types/node`",
    "see https://example.com",
    "(see above)",
  ])("accepts %j", (text) => {
    expect(endsPlainly(text)).toBe(true);
  });

  it.each(["a colon:", "a comma,", ""])("rejects %j", (text) => {
    expect(endsPlainly(text)).toBe(false);
  });
});
