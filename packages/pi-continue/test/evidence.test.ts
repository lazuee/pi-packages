import { describe, expect, it } from "vitest";
import type { MessageLike } from "#src/evidence";
import { isSilent, readEvidence, trailsOff } from "#src/evidence";

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
  ])("detects %j", (text) => {
    expect(trailsOff(text)).toBe(true);
  });

  it.each(["a complete sentence.", "Done.", ""])("passes %j", (text) => {
    expect(trailsOff(text)).toBe(false);
  });
});
