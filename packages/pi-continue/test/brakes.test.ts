import { describe, expect, it } from "vitest";
import type { BrakeState } from "#src/brakes";
import { evaluateBrakes, StreakLedger, sanitizeError } from "#src/brakes";

const clear: BrakeState = {
  enabled: true,
  gatedIn: true,
  aborted: false,
  operatorBusy: false,
  permissionPending: false,
  streak: 0,
  maxConsecutive: 3,
  msSinceLastRecovery: Number.POSITIVE_INFINITY,
  minIntervalMs: 2000,
  queueDirty: false,
  alreadyRecoveredForRun: false,
  forkCount: 0,
  maxForks: 3,
};

describe("evaluateBrakes", () => {
  it("allows a recovery when every brake is clear", () => {
    expect(evaluateBrakes(clear)).toBeUndefined();
  });

  it.each([
    ["enabled", { enabled: false }, "disabled"],
    ["gatedIn", { gatedIn: false }, "not-gated-in"],
    ["aborted", { aborted: true }, "after-abort"],
    ["operatorBusy", { operatorBusy: true }, "operator-busy"],
    ["permissionPending", { permissionPending: true }, "permission-pending"],
    ["streak", { streak: 3 }, "streak-exhausted"],
    ["interval", { msSinceLastRecovery: 10 }, "too-soon"],
    ["queueDirty", { queueDirty: true }, "queue-dirty"],
    ["alreadyRecovered", { alreadyRecoveredForRun: true }, "already-recovered"],
    ["forks", { forkCount: 3 }, "forks-exhausted"],
  ])("refuses on %s", (_name, over, refusal) => {
    expect(evaluateBrakes({ ...clear, ...over })).toBe(refusal);
  });

  it("reports the first refusal in precedence order", () => {
    expect(
      evaluateBrakes({
        ...clear,
        enabled: false,
        alreadyRecoveredForRun: true,
      }),
    ).toBe("disabled");
  });
});

describe("StreakLedger", () => {
  it("counts recoveries and their gap", () => {
    const ledger = new StreakLedger();
    ledger.record("run-a", {
      kind: "empty",
      reason: "",
      text: "",
      at: 1000,
      error: "",
    });
    expect(ledger.streak).toBe(1);
    expect(ledger.msSinceLast(1500)).toBe(500);
    expect(ledger.hasRecovered("run-a")).toBe(true);
    expect(ledger.forkCount("run-a")).toBe(1);
  });

  it("counts a second recovery of the same run as a fork", () => {
    const ledger = new StreakLedger();
    ledger.record("run-a", {
      kind: "",
      reason: "",
      text: "",
      at: 1,
      error: "",
    });
    ledger.record("run-a", {
      kind: "",
      reason: "",
      text: "",
      at: 2,
      error: "",
    });
    expect(ledger.forkCount("run-a")).toBe(2);
    expect(ledger.streak).toBe(2);
  });

  it("ends the streak on a healthy settle but keeps run identities", () => {
    const ledger = new StreakLedger();
    ledger.record("run-a", {
      kind: "",
      reason: "",
      text: "",
      at: 1,
      error: "",
    });
    ledger.resetStreak();
    expect(ledger.streak).toBe(0);
    expect(ledger.hasRecovered("run-a")).toBe(true);
  });

  it("forgets everything when the operator speaks", () => {
    const ledger = new StreakLedger();
    ledger.record("run-a", {
      kind: "",
      reason: "",
      text: "",
      at: 1,
      error: "",
    });
    ledger.reset();
    expect(ledger.streak).toBe(0);
    expect(ledger.lastAt).toBe(0);
    expect(ledger.hasRecovered("run-a")).toBe(false);
  });

  it("is unbounded-free: the gap is infinite before the first recovery", () => {
    expect(new StreakLedger().msSinceLast(5000)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("sanitizeError", () => {
  it("flattens whitespace and caps length", () => {
    expect(sanitizeError("a\n\n b  c")).toBe("a b c");
    expect(sanitizeError("x".repeat(500))).toHaveLength(201);
  });

  it("maps undefined to an empty string", () => {
    expect(sanitizeError(undefined)).toBe("");
  });
});
