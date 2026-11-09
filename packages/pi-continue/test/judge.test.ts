import { describe, expect, it } from "vitest";
import type { MessageLike } from "#src/evidence";
import { buildJudgePrompt, parseVerdict, tailOf } from "#src/judge";

describe("parseVerdict", () => {
  it.each([
    ["FINISHED", "finished"],
    ["finished.", "finished"],
    ["STALLED", "stalled"],
    ["  stalled because x", "stalled"],
    ["maybe", "unavailable"],
    ["", "unavailable"],
  ])("parses %j", (raw, verdict) => {
    expect(parseVerdict(raw)).toBe(verdict);
  });
});

describe("tailOf", () => {
  const messages: MessageLike[] = Array.from({ length: 5 }, (_, i) => ({
    role: "assistant",
    content: `m${i}`,
  }));

  it("keeps the last n messages", () => {
    expect(tailOf(messages, 2, 1000).map((m) => m.content)).toEqual([
      "m3",
      "m4",
    ]);
  });

  it("stops at the character budget", () => {
    expect(tailOf(messages, 5, 4).map((m) => m.content)).toEqual(["m3", "m4"]);
  });

  it("keeps one message even when it exceeds the budget", () => {
    expect(tailOf(messages, 5, 1).map((m) => m.content)).toEqual(["m4"]);
  });
});

describe("buildJudgePrompt", () => {
  it("carries the tail and the final text", () => {
    const prompt = buildJudgePrompt(
      [{ role: "assistant", content: "earlier" }],
      {
        stopReason: "stop",
        errorMessage: undefined,
        text: "final words",
        hasToolCall: false,
        hasThinking: false,
      },
    );
    expect(prompt).toContain("assistant: earlier");
    expect(prompt).toContain("final words");
  });
});
