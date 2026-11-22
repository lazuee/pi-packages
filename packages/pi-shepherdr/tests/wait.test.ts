import { describe, expect, test } from "bun:test";
import { parseAgentsRequest } from "../src/agents-contract.js";
import { dispatchAgentWork } from "../src/agents-work.js";
import { MonitorState } from "../src/monitor-state.js";
import { SettlementDelivery } from "../src/settlement/delivery.js";
import type { Waiter } from "../src/settlement/delivery.js";
import type { ExtensionReply } from "../src/types.js";

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
  test("blocking is the only wait control", () => {
    expect(
      parseAgentsRequest({
        action: "assign",
        target: "p",
        message: "m",
        blocking: true,
      }).blocking
    ).toBe(true);
    // The wait is unbounded, so the field is gone from every action.
    for (const action of ["assign", "spawn", "reply"] as const)
      expect(() =>
        parseAgentsRequest({
          action,
          target: "p",
          message: "m",
          ...(action === "spawn" ? { agent_type: "general", label: "l" } : {}),
          ...(action === "reply" ? { extension: "e", id: "1" } : {}),
          timeout_ms: 5,
        })
      ).toThrow("timeout_ms");
    expect(() =>
      parseAgentsRequest({ action: "send", target: "p", message: "m" })
    ).not.toThrow();
  });
});

describe("claim", () => {
  test("a delivered result resolves its waiter, never the controller", async () => {
    const { counter, delivery } = await loadDelivery();
    const pending = delivery.claim(attempt, signal())!;
    delivery.deliverSettlement(
      lifecycle,
      record("a1"),
      settlement,
      "a1",
      undefined,
      { id: "m1", stopReason: "stop", text: "done" } as never
    );
    expect((await pending).status).toBe("done");
    // The waiter consumed the result, so the controller was never asked.
    expect(counter.value).toBe(0);
  });

  test("a dropped waiter leaves the result to the controller", async () => {
    const { counter, delivery } = await loadDelivery();
    const pending = delivery.claim(attempt, signal())!;
    delivery.releaseClaim(attempt, new Error("dropped"));
    expect(
      ((await pending.catch((error: unknown) => error)) as Error).message
    ).toBe("dropped");
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

  test("an abort rejects its waiter with the abort reason", async () => {
    const { delivery } = await loadDelivery();
    const controller = new AbortController();
    const pending = delivery.claim(attempt, controller.signal)!;
    const reason = new Error("caller gave up");
    controller.abort(reason);
    expect(await pending.catch((error: unknown) => error)).toBe(reason);
  });

  test("a stopped monitor rejects its waiters", async () => {
    const { delivery } = await loadDelivery();
    const pending = delivery.claim(attempt, signal())!;
    delivery.stop();
    const outcome = (await pending.catch((error: unknown) => error)) as Error;
    expect(outcome.message).toBe("Shepherdr monitor stopped");
  });

  test("an observed claim still resolves through its waiter", async () => {
    const { delivery } = await loadDelivery();
    const pending = delivery.claim(attempt, signal())!;
    delivery.observeReply(attempt, { id: "e1", extension: "ask" } as never);
    delivery.deliverSettlement(
      null as never,
      record("a1"),
      settlement,
      "a1",
      undefined,
      undefined
    );
    expect((await pending).status).toBe("done");
  });

  test("a note survives observeReply", async () => {
    const { delivery } = await loadDelivery();
    const notes: string[] = [];
    const pending = delivery.claim(attempt, signal(), undefined, {
      note: (message) => notes.push(message),
    })!;
    delivery.observeReply(attempt, { id: "e1", extension: "ask" } as never);
    delivery.note("a1", "still collecting");
    expect(notes).toEqual(["still collecting"]);
    delivery.deliverSettlement(
      null as never,
      record("a1"),
      settlement,
      "a1",
      undefined,
      undefined
    );
    expect((await pending).status).toBe("done");
  });

  test("a note without a waiter is silent", async () => {
    const { delivery } = await loadDelivery();
    delivery.claim(attempt, signal());
    expect(() => delivery.note("a1", "nobody listens")).not.toThrow();
    expect(() => delivery.note("missing", "no claim")).not.toThrow();
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
  const claims: { attemptId: string; waiter?: Waiter }[] = [];
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
      _reply?: ExtensionReply,
      waiter?: Waiter
    ) => {
      claims.push({ attemptId: work.attemptId, ...(waiter ? { waiter } : {}) });
      // The fake monitor has no reporter behind it, so this never resolves.
      return new Promise<never>(() => undefined);
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
  test("claims the work, then waits on its settlement", async () => {
    const state = new MonitorState();
    const monitor = fakeMonitor(state);
    const runtime = { machine: "local", monitor } as never;
    const panel = { pane_id: "p", terminal_id: "t1" } as never;

    const dispatch = dispatchAgentWork(
      runtime,
      panel,
      "task",
      true,
      signal(),
      () => undefined,
      async () => undefined,
      { expectUserMessage: true }
    );
    // Let the submit path run up to the unresolved claim.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(monitor.claims).toHaveLength(1);
    // The wait is still open, so the work itself stays accepted, not settled.
    expect(state.byTerminal("t1")!.activity.phase).toBe("working");
    expect(dispatch).toBeInstanceOf(Promise);
  });

  test("a note reaches the caller's own wording", async () => {
    const state = new MonitorState();
    const monitor = fakeMonitor(state);
    const runtime = { machine: "local", monitor } as never;
    const panel = { pane_id: "p", terminal_id: "t1" } as never;
    const shown: string[] = [];

    void dispatchAgentWork(
      runtime,
      panel,
      "task",
      true,
      signal(),
      (update) =>
        shown.push(
          (update.content?.[0] as { text?: string } | undefined)?.text ?? ""
        ),
      async () => undefined,
      { expectUserMessage: true, describeWait: (note) => `p ${note}` }
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    monitor.claims[0]!.waiter!.note("is collecting");
    expect(shown.at(-1)).toBe("p is collecting");
  });

  test("without describeWait the claim carries no waiter", async () => {
    const state = new MonitorState();
    const monitor = fakeMonitor(state);
    const runtime = { machine: "local", monitor } as never;
    const panel = { pane_id: "p", terminal_id: "t1" } as never;

    void dispatchAgentWork(
      runtime,
      panel,
      "task",
      true,
      signal(),
      () => undefined,
      async () => undefined
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(monitor.claims[0]!.waiter).toBeUndefined();
  });
});

describe("turn ownership", () => {
  const reporter = async () => {
    const { SettlementReporter } = await import("../src/settlement/index.js");
    const state = new MonitorState();
    return {
      reporter: new SettlementReporter(
        {} as never,
        {} as never,
        state,
        () => undefined,
        {} as never,
        { machine: "local", label: () => "local", operatorPrefix: "hc" },
        async () => undefined
      ),
      state,
    };
  };

  /** Previous turn's reply is still what the bounded reader sees. */
  const stale = {
    session: {
      assistant: { id: "m-old", stopReason: "stop", text: "s300" } as never,
      assistantAfterInput: true,
      input: { id: "in-new", text: "new task" },
      replyAfterInput: false,
    },
  };

  test("a tool wait retries an echoed previous reply", async () => {
    const { reporter: instance } = await reporter();
    const own = instance as unknown as {
      turnOwned: (
        settlement: unknown,
        expected: unknown,
        request: unknown
      ) => boolean;
    };
    const expected = { after: "in-old" };
    const unbounded = {
      session: { ...stale.session, replyAfterInput: undefined },
    };
    // A release may complete on the echo; a tool wait may not.
    expect(own.turnOwned(unbounded.session, expected, {})).toBe(true);
    expect(
      own.turnOwned(unbounded.session, expected, { requireTurn: true })
    ).toBe(false);
    // A bounded view does not need the fallback at all.
    expect(own.turnOwned(stale.session, expected, { requireTurn: true })).toBe(
      false
    );
  });

  test("the head itself is never owned", async () => {
    const { reporter: instance } = await reporter();
    const own = instance as unknown as {
      turnOwned: (
        settlement: unknown,
        expected: unknown,
        request: unknown
      ) => boolean;
    };
    const head = { session: { ...stale.session, input: { id: "in-old" } } };
    expect(
      own.turnOwned(head.session, { after: "in-old" }, { requireTurn: true })
    ).toBe(false);
  });

  test("a newer reply than the input is owned", async () => {
    const { reporter: instance } = await reporter();
    const own = instance as unknown as {
      turnOwned: (
        settlement: unknown,
        expected: unknown,
        request: unknown
      ) => boolean;
    };
    const fresh = { session: { ...stale.session, replyAfterInput: true } };
    expect(
      own.turnOwned(fresh.session, { after: "in-old" }, { requireTurn: true })
    ).toBe(true);
  });
});

describe("tool turns", () => {
  const owned = async () => {
    const { SettlementReporter } = await import("../src/settlement/index.js");
    const instance = new SettlementReporter(
      {} as never,
      {} as never,
      new MonitorState(),
      () => undefined,
      {} as never,
      { machine: "local", label: () => "local", operatorPrefix: "hc" },
      async () => undefined
    ) as unknown as {
      turnOwned: (v: unknown, e: unknown, r: unknown) => boolean;
    };
    return instance.turnOwned.bind(instance);
  };
  const view = {
    assistant: { id: "x", stopReason: "toolUse", text: "" },
    assistantAfterInput: true,
    input: { id: "in-new" },
    replyAfterInput: true,
  };

  test("a trailing tool call is not an answer", async () => {
    const turnOwned = await owned();
    expect(
      turnOwned(
        { ...view, toolHead: true },
        { after: "in-old" },
        { requireTurn: true }
      )
    ).toBe(false);
  });

  test("an earlier tool call with a later reply is an answer", async () => {
    const turnOwned = await owned();
    expect(
      turnOwned(
        {
          ...view,
          assistantToolUse: true,
          assistant: { id: "y", stopReason: "stop", text: "ok" },
        },
        { after: "in-old" },
        { requireTurn: true }
      )
    ).toBe(true);
  });
});

describe("no baseline visible", () => {
  const owned = async () => {
    const { SettlementReporter } = await import("../src/settlement/index.js");
    const i = new SettlementReporter(
      {} as never,
      {} as never,
      new MonitorState(),
      () => undefined,
      {} as never,
      { machine: "local", label: () => "local", operatorPrefix: "hc" },
      async () => undefined
    ) as unknown as {
      turnOwned: (v: unknown, e: unknown, r: unknown) => boolean;
    };
    return i.turnOwned.bind(i);
  };
  const view = {
    assistant: { id: "x", stopReason: "stop", text: "old" },
    assistantAfterInput: true,
    replyAfterInput: false,
  };

  test("a null watermark defers to a bounded reader", async () => {
    const turnOwned = await owned();
    expect(
      turnOwned(
        { ...view, replyAfterInput: true },
        { after: null },
        { requireTurn: true }
      )
    ).toBe(true);
  });

  test("a null watermark never trusts an unbounded echo", async () => {
    const turnOwned = await owned();
    expect(
      turnOwned(
        { ...view, replyAfterInput: undefined },
        { after: null },
        { requireTurn: true }
      )
    ).toBe(false);
  });
});

describe("own input", () => {
  const owned = async () => {
    const { SettlementReporter } = await import("../src/settlement/index.js");
    const i = new SettlementReporter(
      {} as never,
      {} as never,
      new MonitorState(),
      () => undefined,
      {} as never,
      { machine: "local", label: () => "local", operatorPrefix: "hc" },
      async () => undefined
    ) as unknown as {
      turnOwned: (v: unknown, e: unknown, r: unknown) => boolean;
    };
    return i.turnOwned.bind(i);
  };
  const view = {
    assistant: { id: "y", stopReason: "stop", text: "new" },
    assistantAfterInput: true,
    input: { id: "in-new" },
    replyAfterInput: true,
  };

  test("the task text primed as watermark still owns a newer head", async () => {
    const turnOwned = await owned();
    expect(
      turnOwned(
        { ...view, inputAtHead: true },
        { after: "the task text" },
        { requireTurn: true }
      )
    ).toBe(true);
  });

  test("a newer head alone already owns the turn", async () => {
    const turnOwned = await owned();
    expect(
      turnOwned(view, { after: "the task text" }, { requireTurn: true })
    ).toBe(true);
  });

  test("the alias is only trusted by position, never as the head", async () => {
    const turnOwned = await owned();
    // The index still says the reply precedes the input and the head is unknown.
    expect(
      turnOwned(
        { ...view, input: { id: "the task text" }, replyAfterInput: false },
        { after: "the task text" },
        { requireTurn: true }
      )
    ).toBe(false);
  });
});

describe("stall reason", () => {
  test("names the tool still running, not a lost write", async () => {
    const { turnReason } = await import("../src/settlement/index.js");
    expect(turnReason({ toolHead: true })).toContain("still running");
    expect(turnReason({})).toContain("not persisted");
  });
});

describe("blocked note", () => {
  const reporter = async () => {
    const { SettlementReporter } = await import("../src/settlement/index.js");
    return new SettlementReporter(
      {} as never,
      {} as never,
      new MonitorState(),
      () => undefined,
      {} as never,
      { machine: "local", label: () => "local", operatorPrefix: "hc" },
      async () => undefined
    );
  };

  test("a claimed wait is the one a note reaches", async () => {
    const instance = await reporter();
    const notes: string[] = [];
    instance.claim(attempt, signal(), undefined, {
      note: (message) => notes.push(message),
    });
    const { delivery } = instance as unknown as {
      delivery: { note: (id: string, message: string) => void };
    };
    delivery.note("a1", "stopped on a question; collecting it for up to 30s");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("stopped on a question");
  });

  test("the wording names collection, not a timeout", async () => {
    const { delivery } = await loadDelivery();
    const notes: string[] = [];
    delivery.claim(attempt, signal(), undefined, {
      note: (message) => notes.push(message),
    });
    delivery.note("a1", "stopped on a question; collecting it for up to 30s");
    expect(notes[0]).toContain("collecting");
    expect(notes[0]).not.toContain("timeout");
  });
});
