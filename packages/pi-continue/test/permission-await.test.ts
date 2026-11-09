import { describe, expect, it, vi } from "vitest";
import { PermissionAwait } from "#src/permission-await";

function harness() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const events = {
    on: (channel: string, handler: (payload: unknown) => void) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
  };
  const awaitState = new PermissionAwait(events);
  const emit = (channel: string, payload: unknown) =>
    handlers.get(channel)?.(payload);
  return { awaitState, emit };
}

describe("PermissionAwait", () => {
  it("is not pending with no prompts", () => {
    expect(harness().awaitState.pending).toBe(false);
  });

  it("holds while a prompt is open", () => {
    const { awaitState, emit } = harness();
    emit("permissions:ui_prompt", { requestId: "r1" });
    expect(awaitState.pending).toBe(true);
    expect(awaitState.pendingCount).toBe(1);
  });

  it("clears on that prompt's decision", () => {
    const { awaitState, emit } = harness();
    emit("permissions:ui_prompt", { requestId: "r1" });
    emit("permissions:decision", { requestId: "r1" });
    expect(awaitState.pending).toBe(false);
  });

  it("ignores a decision for a request that never prompted", () => {
    const { awaitState, emit } = harness();
    emit("permissions:ui_prompt", { requestId: "r1" });
    emit("permissions:decision", { requestId: "other" });
    expect(awaitState.pending).toBe(true);
  });

  it("tracks several prompts independently", () => {
    const { awaitState, emit } = harness();
    emit("permissions:ui_prompt", { requestId: "r1" });
    emit("permissions:ui_prompt", { requestId: "r2" });
    emit("permissions:decision", { requestId: "r1" });
    expect(awaitState.pendingCount).toBe(1);
  });

  it("reads a payload defensively", () => {
    const { awaitState, emit } = harness();
    emit("permissions:ui_prompt", { requestId: 42 });
    emit("permissions:ui_prompt", null);
    expect(awaitState.pending).toBe(false);
  });

  it("unsubscribes on dispose", () => {
    const { awaitState, emit } = harness();
    awaitState.dispose();
    emit("permissions:ui_prompt", { requestId: "r1" });
    expect(awaitState.pending).toBe(false);
  });

  it("does not throw when dispose runs twice", () => {
    const { awaitState } = harness();
    const off = vi.fn();
    expect(() => {
      awaitState.dispose();
      off();
      awaitState.dispose();
    }).not.toThrow();
  });
});
