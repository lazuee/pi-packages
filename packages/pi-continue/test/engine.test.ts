import { describe, expect, it, vi } from "vitest";
import type { ContinueConfig } from "#src/config";
import { DEFAULT_CONFIG } from "#src/config";
import type { EngineDeps } from "#src/engine";
import { ContinueEngine } from "#src/engine";
import type { MessageLike } from "#src/evidence";
import { SessionGateway } from "#src/gateway";

interface Harness {
  engine: ContinueEngine;
  sent: Array<{ text: string; deliverAs?: string }>;
  notify: ReturnType<typeof vi.fn>;
  config: ContinueConfig;
  gateway: SessionGateway;
  setMessages: (messages: MessageLike[]) => void;
}

function harness({
  config: overrides,
  ...over
}: Omit<Partial<EngineDeps>, "config"> & {
  config?: Partial<ContinueConfig>;
} = {}): Harness {
  const sent: Array<{ text: string; deliverAs?: string }> = [];
  const notify = vi.fn();
  const config: ContinueConfig = { ...DEFAULT_CONFIG, ...overrides };
  const gateway = new SessionGateway();
  let messages: MessageLike[] = [];
  let clock = 1000;

  const engine = new ContinueEngine({
    host: {
      on: () => {},
      sendUserMessage: (text, options) => {
        sent.push({ text, deliverAs: options?.deliverAs });
      },
    },
    gateway,
    config: () => config,
    permissionPending: () => false,
    childPending: () => false,
    messages: () => messages,
    operatorMessage: () => undefined,
    notify,
    now: () => clock,
    ...over,
  });
  return {
    engine,
    sent,
    notify,
    config,
    gateway,
    setMessages: (next) => {
      messages = next;
      clock += 10_000;
    },
  };
}

const assistant = (over: Partial<MessageLike> = {}): MessageLike => ({
  role: "assistant",
  stopReason: "stop",
  content: [{ type: "text", text: "All done." }],
  ...over,
});

const ctx = { hasUI: true };
const settle = (h: Harness) => h.engine.onSettled(ctx);

async function settled(over: Partial<MessageLike> = {}) {
  const h = harness();
  h.engine.noteRunStart();
  h.setMessages([{ role: "user", content: "go" }, assistant(over)]);
  h.engine.captureRun();
  await settle(h);
  return h;
}

describe("ContinueEngine", () => {
  it("recovers an empty response as a follow-up", async () => {
    const h = await settled({
      content: [{ type: "thinking" }],
      stopReason: "pending",
    });
    h.setMessages([{ role: "assistant", stopReason: "stop", content: [] }]);
    h.engine.captureRun();
    await settle(h);
    expect(h.sent).toEqual([{ text: "continue", deliverAs: "followUp" }]);
  });

  it("recovers a lead-in left hanging before a blank line", async () => {
    const h = await settled({
      content: [{ type: "text", text: "Next up is `@types/node`:\n\n" }],
    });
    expect(h.engine.lastDecision?.verdict).toBe("recovered");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toContain("@types/node");
  });

  it("does nothing on a healthy stop", async () => {
    const h = await settled();
    expect(h.sent).toHaveLength(0);
    expect(h.engine.lastDecision?.verdict).toBe("ok");
  });

  it("recovers only once per settled run", async () => {
    const h = harness();
    h.engine.noteRunStart();
    h.setMessages([
      { role: "assistant", stopReason: "error", errorMessage: "boom" },
    ]);
    h.engine.captureRun();
    await settle(h);
    await settle(h);
    expect(h.sent).toHaveLength(1);
    expect(h.engine.lastDecision?.verdict).toBe("refused:already-recovered");
  });

  it("stands down after an abort until the operator speaks", async () => {
    const h = harness();
    h.engine.noteRunStart();
    h.engine.noteAbort();
    h.setMessages([{ role: "assistant", stopReason: "length" }]);
    h.engine.captureRun();
    await settle(h);
    expect(h.engine.lastDecision?.verdict).toBe("refused:after-abort");

    h.engine.noteOperatorSpoke();
    await settle(h);
    expect(h.sent).toHaveLength(1);
  });

  it("recovers after an abort when suppression is off", async () => {
    const h = harness({ config: { suppressAfterAbort: false } });
    h.engine.noteRunStart();
    h.engine.noteAbort();
    h.setMessages([{ role: "assistant", stopReason: "length" }]);
    h.engine.captureRun();
    await settle(h);
    expect(h.engine.lastDecision?.verdict).toBe("recovered");
    expect(h.sent).toHaveLength(1);
  });

  it("spends the fork budget on a run that keeps stalling at one message count", async () => {
    const h = harness({ config: { maxForks: 1, maxConsecutive: 99 } });
    h.engine.noteRunStart();
    h.setMessages([{ role: "assistant", stopReason: "length" }]);
    h.engine.captureRun();
    await settle(h);
    await settle(h);
    expect(h.engine.lastDecision?.verdict).toBe("refused:forks-exhausted");
  });

  it("gives up after the streak ceiling and says so", async () => {
    const h = harness({ config: { maxConsecutive: 1 } });
    h.engine.noteRunStart();
    h.setMessages([{ role: "assistant", stopReason: "length" }]);
    h.engine.captureRun();
    await settle(h);
    h.setMessages([
      { role: "assistant", stopReason: "length" },
      assistant({ stopReason: "length" }),
    ]);
    h.engine.captureRun();
    await settle(h);
    expect(h.engine.lastDecision?.verdict).toBe("refused:streak-exhausted");
    expect(h.notify).toHaveBeenCalledWith(
      expect.stringContaining("gave up"),
      "warning",
    );
  });

  it("refuses while a child is running", async () => {
    const h = harness({ childPending: () => true });
    h.engine.noteRunStart();
    h.setMessages([{ role: "assistant", stopReason: "length" }]);
    h.engine.captureRun();
    await settle(h);
    expect(h.engine.lastDecision?.verdict).toBe("refused:queue-dirty");
  });

  it("refuses while a permission prompt is open", async () => {
    const h = harness({ permissionPending: () => true });
    h.engine.noteRunStart();
    h.setMessages([{ role: "assistant", stopReason: "length" }]);
    h.engine.captureRun();
    await settle(h);
    expect(h.engine.lastDecision?.verdict).toBe("refused:permission-pending");
  });

  it("refuses in a session the gateway excluded", async () => {
    const h = harness({ config: { continueSelf: false } });
    h.engine.noteRunStart();
    h.setMessages([{ role: "assistant", stopReason: "length" }]);
    h.engine.captureRun();
    await settle(h);
    expect(h.engine.lastDecision?.verdict).toBe("refused:not-gated-in");
  });

  it("forgets the previous branch's streak and identities on a session start", async () => {
    const h = harness();
    h.engine.noteRunStart();
    h.setMessages([{ role: "assistant", stopReason: "length" }]);
    h.engine.captureRun();
    await settle(h);
    expect(h.engine.streak).toBe(1);

    // /new: the same message count must not look like the same run.
    h.engine.noteSessionStart();
    h.engine.noteRunStart();
    h.engine.captureRun();
    await settle(h);
    expect(h.engine.streak).toBe(1);
    expect(h.sent).toHaveLength(2);
  });

  it("ignores a settle with no recorded run", async () => {
    const h = harness();
    await settle(h);
    expect(h.engine.lastDecision?.verdict).toBe("unknown");
  });

  it("ends the streak on a healthy settle", async () => {
    const h = await settled({ stopReason: "length" });
    expect(h.engine.streak).toBe(1);
    h.setMessages([assistant(), assistant()]);
    h.engine.captureRun();
    await settle(h);
    expect(h.engine.streak).toBe(0);
  });

  it("notes a send failure instead of throwing", async () => {
    const h = harness({
      host: {
        on: () => {},
        sendUserMessage: () => {
          throw new Error("nope");
        },
      },
    });
    h.engine.noteRunStart();
    h.setMessages([{ role: "assistant", stopReason: "length" }]);
    h.engine.captureRun();
    await settle(h);
    expect(h.notify).toHaveBeenCalledWith(
      expect.stringContaining("nope"),
      "error",
    );
  });

  it("stays silent when notifications are off", async () => {
    const h = await settled();
    expect(h.notify).not.toHaveBeenCalled();
    h.config.notify = false;
    h.setMessages([
      assistant({ stopReason: "length" }),
      assistant({ stopReason: "length" }),
    ]);
    h.engine.captureRun();
    await settle(h);
    expect(h.notify).not.toHaveBeenCalled();
  });
});
