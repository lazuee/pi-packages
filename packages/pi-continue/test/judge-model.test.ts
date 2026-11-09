import { describe, expect, it } from "vitest";
import { resolveJudgeModel } from "#src/judge-model";

const a = { provider: "p", id: "a" };
const b = { provider: "p", id: "b" };

describe("resolveJudgeModel", () => {
  it("orders the configured model first", () => {
    expect(
      resolveJudgeModel({ configured: b, session: a, available: [a] }),
    ).toEqual([b, a]);
  });

  it("keeps a configured model that is not in the available list", () => {
    const gone = { provider: "other", id: "gone" };
    expect(
      resolveJudgeModel({ configured: gone, session: a, available: [a] }),
    ).toEqual([gone, a]);
  });

  it("falls back through the session model then every available model", () => {
    expect(
      resolveJudgeModel({ configured: undefined, session: a, available: [b] }),
    ).toEqual([a, b]);
  });

  it("offers availability alone when nothing else is set", () => {
    expect(
      resolveJudgeModel({ configured: undefined, session: undefined, available: [b] }),
    ).toEqual([b]);
  });

  it("collapses a configured model that equals the session model", () => {
    expect(resolveJudgeModel({ configured: a, session: a, available: [] })).toEqual([a]);
  });

  it("is empty when nothing is reachable", () => {
    expect(
      resolveJudgeModel({ configured: undefined, session: undefined, available: [] }),
    ).toEqual([]);
  });
});
