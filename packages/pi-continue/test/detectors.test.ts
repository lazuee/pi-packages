import { describe, expect, it, vi } from "vitest";
import type { DetectorContext, Judge } from "#src/detectors";
import { defaultDetectors, errorDetector, runDetectors } from "#src/detectors";
import type { RunEvidence } from "#src/evidence";

const evidence = (over: Partial<RunEvidence> = {}): RunEvidence => ({
  stopReason: "stop",
  errorMessage: undefined,
  text: "all done.",
  hasToolCall: false,
  hasThinking: false,
  ...over,
});

const context = (over: Partial<DetectorContext> = {}): DetectorContext => ({
  enabled: ["empty", "truncated", "errored", "abandoned"],
  alreadyRetriedPatterns: ["429", "overloaded", "WebSocket"],
  judgeMode: "off",
  ...over,
});

const detect = (e: RunEvidence, c: DetectorContext = context()) =>
  runDetectors(e, defaultDetectors(c));

describe("default detection chain", () => {
  it("passes a toolUse stop straight through", async () => {
    const result = await detect(evidence({ stopReason: "toolUse" }));
    expect(result.verdict).toBe("ok");
  });

  it("passes an aborted stop through", async () => {
    expect((await detect(evidence({ stopReason: "aborted" }))).verdict).toBe(
      "ok",
    );
  });

  it("stalls an empty response and nags about it", async () => {
    const result = await detect(evidence({ text: "", hasThinking: true }));
    expect(result).toMatchObject({ verdict: "stalled", kind: "empty" });
  });

  it("stalls a truncated response", async () => {
    const result = await detect(evidence({ stopReason: "length" }));
    expect(result).toMatchObject({ verdict: "stalled", kind: "truncated" });
  });

  it("stalls an error pi never retried", async () => {
    const result = await detect(
      evidence({ stopReason: "error", errorMessage: "insufficient_quota" }),
    );
    expect(result).toMatchObject({ verdict: "stalled", kind: "errored" });
  });

  it("skips an error pi already retried", async () => {
    const result = await detect(
      evidence({
        stopReason: "error",
        errorMessage: "WebSocket idle timeout after 60000ms",
      }),
    );
    expect(result.verdict).toBe("unknown");
  });

  it("leaves a retryable 500 unknown even with an empty pattern list", async () => {
    const result = await detect(
      evidence({ stopReason: "error", errorMessage: "Error: 500: boom" }),
      context({ alreadyRetriedPatterns: [] }),
    );
    expect(result.verdict).toBe("unknown");
  });

  it("stalls prose that stops mid-sentence", async () => {
    const result = await detect(
      evidence({ text: "Now let me run the tests and" }),
    );
    expect(result).toMatchObject({ verdict: "stalled", kind: "abandoned" });
  });

  it("stalls a lead-in whose body never arrived", async () => {
    const result = await detect(
      evidence({ text: "The types are listed:\n\n" }),
    );
    expect(result).toMatchObject({ verdict: "stalled", kind: "abandoned" });
  });

  it("passes prose that ends cleanly", async () => {
    expect((await detect(evidence({ text: "All tests pass." }))).verdict).toBe(
      "ok",
    );
  });

  it("passes a colon with a closed sentence behind it", async () => {
    const result = await detect(
      evidence({ text: "Whitespace-only. `@types/node`:\n\n" }),
    );
    expect(result.verdict).toBe("ok");
  });

  it("stalls a reply that ends on a bare lead-in", async () => {
    const result = await detect(evidence({ text: "Next, the config:" }));
    expect(result).toMatchObject({ verdict: "stalled", kind: "abandoned" });
  });

  it("stalls a reply that ends without any terminator", async () => {
    const result = await detect(evidence({ text: "Change is now in place," }));
    expect(result).toMatchObject({ verdict: "stalled", kind: "abandoned" });
  });

  it("stalls an unclosed code fence", async () => {
    const result = await detect(evidence({ text: "```ts\nconst a = 1.\n" }));
    expect(result).toMatchObject({ verdict: "stalled", kind: "abandoned" });
  });

  it("stalls a half-written table", async () => {
    const result = await detect(
      evidence({ text: "| a | b |\n| --- | --- |\n| 1 |" }),
    );
    expect(result).toMatchObject({ verdict: "stalled", kind: "abandoned" });
  });

  it("passes a bare word, which is how plenty of replies finish", async () => {
    expect((await detect(evidence({ text: "3" }))).verdict).toBe("ok");
    expect((await detect(evidence({ text: "v1.2.0" }))).verdict).toBe("ok");
  });

  it("leaves a row unknown when its rule is disabled", async () => {
    const result = await detect(
      evidence({ stopReason: "length" }),
      context({ enabled: ["abandoned"] }),
    );
    expect(result.verdict).toBe("unknown");
  });
});

describe("judge integration", () => {
  it("asks the judge on the ambiguous row in model mode", async () => {
    const judge = vi.fn<Judge>(async () => "stalled");
    const result = await detect(
      evidence({ text: "All tests pass." }),
      context({ judgeMode: "model", judge }),
    );
    expect(result).toMatchObject({ verdict: "stalled", kind: "abandoned" });
    expect(judge).toHaveBeenCalledOnce();
  });

  it("trusts a finished verdict", async () => {
    const judge = vi.fn<Judge>(async () => "finished");
    const result = await detect(
      evidence({ text: "the work continues here" }),
      context({ judgeMode: "model", judge }),
    );
    expect(result.verdict).toBe("ok");
  });

  it("falls back to the heuristic when the judge is unavailable", async () => {
    const judge = vi.fn<Judge>(async () => "unavailable");
    const result = await detect(
      evidence({ text: "Ran the suite, and then" }),
      context({ judgeMode: "model", judge }),
    );
    expect(result).toMatchObject({ verdict: "stalled", kind: "abandoned" });
  });

  it("never spends a judge call on an empty response", async () => {
    const judge = vi.fn<Judge>(async () => "finished");
    await detect(
      evidence({ text: "" }),
      context({ judgeMode: "model", judge }),
    );
    expect(judge).not.toHaveBeenCalled();
  });

  it("asks first in always mode", async () => {
    const judge = vi.fn<Judge>(async () => "stalled");
    const result = await detect(
      evidence({ text: "All tests pass." }),
      context({ judgeMode: "always", judge }),
    );
    expect(result.verdict).toBe("stalled");
    expect(judge).toHaveBeenCalledOnce();
  });
});

describe("errorDetector", () => {
  it("matches patterns case-insensitively", () => {
    expect(errorDetector("Rate Limit exceeded", ["rate limit"]).verdict).toBe(
      "unknown",
    );
  });

  it("skips a retryable transport error Pi already retired", () => {
    const error = `Error: 500: {"message":"litellm.InternalServerError: InternalServerError: OpenAIException - Connection error.. Received Model
 Group=auto\\nAvailable Model Group Fallbacks=None","type":null,"param":null,"code":"500"}`;
    expect(errorDetector(error, []).verdict).toBe("unknown");
  });

  it("is unknown without an error message", () => {
    expect(errorDetector(undefined, ["429"]).verdict).toBe("unknown");
  });
});
