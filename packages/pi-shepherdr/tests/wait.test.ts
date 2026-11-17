import { describe, expect, test } from "bun:test";

import { parseAgentsRequest, requestedWaitMs } from "../src/agents-contract.js";
import { dispatchAgentWork } from "../src/agents-work.js";
import { MonitorState } from "../src/monitor-state.js";
import {
  SettlementDelivery,
  SettlementTimeoutError,
} from "../src/settlement/delivery.js";

const attempt = { attemptId: "a1", terminalId: "t1" };
const signal = () => new AbortController().signal;

const lifecycle = {
  context: {},
  generation: 1,
  isCurrent: () => true,
} as never;

async function loadDelivery(): Promise<{
  counter: { value: number };
  delivery: SettlementDelivery;
}> {
  const counter = { value: 0 };
  const delivery = new SettlementDelivery(
    {
      getActiveTools: () => [],
      sendMessage: () => counter.value++,
      events: { emit: () => undefined, on: () => undefined },
    } as never,
    { machine: "local", label: () => "local", operatorPrefix: "hc" }
  );
  return { counter, delivery };
}

const record = (attemptId?: string) =>
  ({
    activity: attemptId
      ? { attemptId, phase: "working", task: "t" }
      : { phase: "settled", status: "done" },
    paneId: "p",
    scope: "task",
    terminalId: "t1",
  }) as never;

const settlement = {
  agent: { pane_id: "p", terminal_id: "t1" },
  labels: {},
  session: {},
  status: "done",
} as never;

describe("wait contract", () => {
  test("timeout_ms is accepted only with a blocking call", () => {
    expect(
      parseAgentsRequest({
        action: "assign",
        target: "p",
        message: "m",
        blocking: true,
        timeout_ms: 5,
      }).timeout_ms
    ).toBe(5);
    expect(
      parseAgentsRequest({
        action: "spawn",
        agent_type: "general",
        label: "l",
        message: "m",
        timeout_ms: 5,
      }).timeout_ms
    ).toBe(5);
    expect(
      parseAgentsRequest({
        action: "reply",
        target: "p",
        extension: "e",
        id: "1",
        message: "m",
        timeout_ms: 5,
      }).timeout_ms
    ).toBe(5);
    expect(() =>
      parseAgentsRequest({
        action: "send",
        target: "p",
        message: "m",
        timeout_ms: 5,
      })
    ).toThrow("timeout_ms");
    expect(() =>
      parseAgentsRequest({ action: "read", target: "p", timeout_ms: 5 })
    ).toThrow("timeout_ms");
    expect(() =>
      parseAgentsRequest({
        action: "assign",
        target: "p",
        message: "m",
        timeout_ms: 0,
      })
    ).toThrow("timeout_ms");
    expect(() =>
      parseAgentsRequest({
        action: "assign",
        target: "p",
        message: "m",
        timeout_ms: 1.5,
      })
    ).toThrow("timeout_ms");
    expect(requestedWaitMs({ action: "assign", timeout_ms: 250 })).toBe(250);
    expect(requestedWaitMs({ action: "assign" })).toBeUndefined();
  });
});

describe("deadline", () => {
  test("rejects with a timeout and leaves later results to the controller", async () => {
    const { counter, delivery } = await loadDelivery();
    const pending = delivery.claim(attempt, signal(), undefined, 5)!;
    const outcome = await pending.catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).name).toBe("SettlementTimeoutError");
    // No waiter left: the result now goes to the controller instead.
    delivery.deliverSettlement(
      lifecycle,
      record("a1"),
      settlement,
      "a1",
      undefined,
      { id: "m1", stopReason: "stop", text: "done" } as never
    );
    expect(counter.value).toBe(1);
  });

  test("a delivered result wins over its deadline", async () => {
    const { delivery } = await loadDelivery();
    const pending = delivery.claim(attempt, signal(), undefined, 1000)!;
    delivery.deliverSettlement(
      null as never,
      record("a1"),
      settlement,
      "a1",
      undefined,
      undefined
    );
    expect((await pending).status).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  test("a stopped monitor detaches as a session detach, not a warning", async () => {
    const { delivery } = await loadDelivery();
    const pending = delivery.claim(attempt, signal(), undefined, 1000)!;
    delivery.stop();
    const outcome = (await pending.catch((error: unknown) => error)) as Error;
    expect(outcome.name).toBe("SettlementTimeoutError");
    expect((outcome as SettlementTimeoutError).source).toBe("session");
  });

  test("retiring an attempt drops its waiter", async () => {
    const { delivery } = await loadDelivery();
    const pending = delivery.claim(attempt, signal(), undefined, 1000)!;
    delivery.retireAttempt("a1");
    expect(
      ((await pending.catch((error: unknown) => error)) as Error).message
    ).toBe("Settlement was reported separately");
    // A stale retry can claim again once its attempt was retired.
    expect(delivery.claim(attempt, signal())).toBeDefined();
  });
});

describe("baseline", () => {
  test("an input id can be recorded after submission started", async () => {
    const state = new MonitorState();
    state.watch({
      agent: "pi",
      agent_status: "idle",
      pane_id: "p",
      terminal_id: "t1",
    });
    const begun = state.beginWork("p", "task", null)!;
    expect(state.byTerminal("t1")!.activity.phase).toBe("submitting");
    state.expectUser(begun, "input-1");
    expect(state.byTerminal("t1")!.activity).toMatchObject({
      expectedUserAfter: "input-1",
      phase: "submitting",
    });
    // Accepting keeps the watermark recorded after the begin call.
    state.acceptWork(begun);
    expect(state.byTerminal("t1")!.activity).toMatchObject({
      expectedUserAfter: "input-1",
      phase: "working",
    });
  });
});

/** Minimal monitor/doc surface for dispatch; the real one needs a Core session. */
function fakeMonitor(state: MonitorState) {
  const claims: { attemptId: string; timeoutMs?: number }[] = [];
  const monitor = {
    claims,
    list: () => state.list(),
    // state.watch keeps the caller's panel id, so hand back the record itself.
    track: async (panel: never) => state.watch(panel).record,
    beginWork: (paneId: string, task: string, expected?: string | null) =>
      state.beginWork(paneId, task, expected),
    expectUser: (work: never, after: string | null) =>
      state.expectUser(work, after),
    claimWork: (
      work: { attemptId: string; terminalId: string },
      _signal: AbortSignal,
      _reply: string | undefined,
      timeoutMs?: number
    ) => {
      claims.push({ attemptId: work.attemptId, timeoutMs });
      // The fake monitor has no reporter behind it, so honour the deadline here.
      return new Promise((_, reject) =>
        setTimeout(
          () => reject(new SettlementTimeoutError(timeoutMs ?? 1, "result")),
          timeoutMs
        )
      );
    },
    observeReply: () => undefined,
    acceptWork: (work: never) => state.acceptWork(work),
    noteMessage: () => undefined,
    reconcileNow: async () => undefined,
    view: async () => ({}),
    releaseWorkClaim: () => undefined,
    handleWorkFailure: async () => undefined,
    rejectWork: (work: never) => state.rejectWork(work),
    unwatch: async () => undefined,
  };
  return monitor;
}

describe("dispatch", () => {
  test("carries the deadline to the claim and returns a detach result", async () => {
    const state = new MonitorState();
    const monitor = fakeMonitor(state);
    const runtime = { machine: "local", monitor } as never;
    const panel = { pane_id: "p", terminal_id: "t1" } as never;

    const dispatch = await dispatchAgentWork(
      runtime,
      panel,
      "task",
      true,
      signal(),
      () => undefined,
      async () => undefined,
      { expectUserMessage: true, timeoutMs: 5 }
    );

    expect(monitor.claims).toHaveLength(1);
    expect(monitor.claims[0]!.timeoutMs).toBe(5);
    expect(dispatch.detach).toBe("timeout");
    expect(dispatch.settlement).toBeUndefined();
    // The work itself is untouched: still working, not settled.
    expect(state.byTerminal("t1")!.activity.phase).toBe("working");
  });
});
