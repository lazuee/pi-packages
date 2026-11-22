import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAgentsRequest } from "../src/agents-contract.js";
import { killedResult } from "../src/agents-tool.js";
import { dispatchAgentWork } from "../src/agents-work.js";
import { buildPanelItems } from "../src/control-panel/items.js";
import { resolvePiAgent } from "../src/core/agents.js";
import { CoreConnection } from "../src/core/backend.js";
import { RemoteCoreEndpoint } from "../src/core/remote-endpoint.js";
import { startCoreAgent } from "../src/core/spawn.js";
import { AgentFleet } from "../src/fleet/index.js";
import { notifyKilledParent } from "../src/kill-notice.js";
import { MonitorState } from "../src/monitor-state.js";
import { readSessionAncestry } from "../src/remote/shepherdr-session.mjs";
import { SettlementDelivery } from "../src/settlement/delivery.js";
import type { Waiter } from "../src/settlement/delivery.js";
import { setChildSupervision } from "../src/spawn-ownership.js";
import type { ExtensionReply, PaneInfo } from "../src/types.js";

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

describe("kill contract", () => {
  test("kill takes only a target", () => {
    expect(parseAgentsRequest({ action: "kill", target: "p" }).action).toBe(
      "kill"
    );
    for (const extra of [{ message: "m" }, { lines: 3 }] as const)
      expect(() =>
        parseAgentsRequest({ action: "kill", target: "p", ...extra })
      ).toThrow("kill");
  });
});

describe("kill guard", () => {
  /** Resolution refuses the session it was called from, before any close. */
  const client = (terminalId: string) =>
    ({
      core: {
        request: async () => ({
          address: terminalId,
          state: "live",
          status: { app: "pi" },
          labels: { "pi.session_file": "/tmp/s.jsonl" },
        }),
      },
    }) as never;

  test("the calling terminal is refused", async () => {
    await expect(resolvePiAgent(client("t1"), "t1", "t1")).rejects.toThrow(
      "controlling"
    );
  });

  test("another terminal resolves", async () => {
    await expect(
      resolvePiAgent(client("t2"), "t2", "t1")
    ).resolves.toMatchObject({ terminal_id: "t2" });
  });

  test("a remote caller without a local id is not refused", async () => {
    await expect(resolvePiAgent(client("t1"), "t1", "")).resolves.toMatchObject(
      { terminal_id: "t1" }
    );
  });

  test("a finished terminal resolves only for a kill", async () => {
    // A finished record keeps no session label, so it is not a Pi agent.
    const dead = {
      core: {
        request: async () => ({ address: "t1", state: "finished", labels: {} }),
      },
    } as never;
    await expect(resolvePiAgent(dead, "t1", "")).rejects.toThrow(
      "not a Pi agent"
    );
    await expect(resolvePiAgent(dead, "t1", "", false)).resolves.toMatchObject({
      terminal_id: "t1",
    });
  });

  test("a killed pane stops restoring supervision", () => {
    const appended: unknown[] = [];
    const branch = [
      {
        type: "custom",
        customType: "herdr-spawn-ownership-v1",
        data: {
          parent: "/tmp/self.jsonl",
          machine: "local",
          host: "h",
          session: "local",
          pane: "p",
          terminal: "t1",
          sessionFile: "/tmp/s.jsonl",
        },
      },
    ];
    const ctx = {
      sessionManager: {
        getSessionFile: () => "/tmp/self.jsonl",
        getBranch: () => branch,
      },
    } as never;
    setChildSupervision(
      {
        appendEntry: (_t: string, data: unknown) => appended.push(data),
      } as never,
      ctx,
      "local",
      { pane_id: "p" } as never,
      false
    );
    // A live child defaults to supervised, so killing it must record the change.
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ supervised: false });
  });
});

describe("session ancestry reader", () => {
  const write = (body: string) => {
    const path = join(tmpdir(), `anc-${randomUUID()}.jsonl`);
    writeFileSync(path, body);
    return path;
  };
  const entry = (parent: string) =>
    `${JSON.stringify({
      type: "custom",
      customType: "herdr-spawn-ancestry-v1",
      data: { parent: { sessionFile: parent } },
    })}\n`;

  test("reads the recorded parent past other entries", async () => {
    const path = write(
      `${JSON.stringify({ type: "session", id: "s" })}\n${JSON.stringify({ type: "message" })}\n${entry("/tmp/p")}`
    );
    expect(await readSessionAncestry(path)).toBe("/tmp/p");
  });

  test("a half-written last line does not hide the ancestry", async () => {
    const path = write(`${entry("/tmp/p")}{"type":"message","half":`);
    expect(await readSessionAncestry(path)).toBe("/tmp/p");
  });

  test("a session without ancestry returns undefined", async () => {
    expect(await readSessionAncestry(write('{"type":"session"}\n'))).toBe(
      undefined
    );
  });
});

describe("kill notice", () => {
  const fleet = (sent: unknown[], ancestry: string | undefined) =>
    ({
      connected: () => ({
        client: {
          sessionAncestry: async () => ancestry,
          sendMessage: async (panel: unknown, message: unknown) =>
            sent.push({ panel, message }),
        },
      }),
      snapshots: async () => [
        {
          id: "local",
          snapshot: {
            agents: [
              {
                pane_id: "tP",
                terminal_id: "tP",
                agent_session: { kind: "path", value: "/tmp/parent.jsonl" },
              },
            ],
          },
        },
      ],
    }) as never;

  const panel = {
    pane_id: "tK",
    terminal_id: "tK",
    name: "worker",
    agent_session: { kind: "path", value: "/tmp/child.jsonl" },
  } as never;
  const ctx = (self: string) =>
    ({ sessionManager: { getSessionFile: () => self } }) as never;

  test("a peer parent is told the worker is gone", async () => {
    const sent: unknown[] = [];
    expect(
      await notifyKilledParent(
        fleet(sent, "/tmp/parent.jsonl"),
        ctx("/tmp/killer.jsonl"),
        panel,
        { machine: "local", childName: "worker" }
      )
    ).toBe("sent");
    expect(sent).toHaveLength(1);
    expect((sent[0] as { message: { text: string } }).message.text).toContain(
      "was killed by another session"
    );
  });

  test("the parent killing its own child is not notified", async () => {
    const sent: unknown[] = [];
    expect(
      await notifyKilledParent(
        fleet(sent, "/tmp/parent.jsonl"),
        ctx("/tmp/parent.jsonl"),
        panel,
        { machine: "local" }
      )
    ).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  test("a worker with no recorded ancestry is skipped", async () => {
    const sent: unknown[] = [];
    expect(
      await notifyKilledParent(
        fleet(sent, undefined),
        ctx("/tmp/killer.jsonl"),
        panel,
        {
          machine: "local",
        }
      )
    ).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  test("a worker without a session file is skipped", async () => {
    const sent: unknown[] = [];
    expect(
      await notifyKilledParent(
        fleet(sent, "/tmp/parent.jsonl"),
        ctx("/tmp/killer.jsonl"),
        { pane_id: "tK", terminal_id: "tK" } as never,
        { machine: "local" }
      )
    ).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  test("a parent that cannot be reached is reported, not hidden", async () => {
    const unreachable = {
      ...(fleet([], "/tmp/parent.jsonl") as never as object),
      connected: () => ({
        client: {
          sessionAncestry: async () => "/tmp/parent.jsonl",
          sendMessage: async () => {
            throw new Error("receiver unavailable");
          },
        },
      }),
    } as never;
    expect(
      await notifyKilledParent(unreachable, ctx("/tmp/killer.jsonl"), panel, {
        machine: "local",
      })
    ).toBe("failed");
  });
});

describe("kill result", () => {
  const panel = { pane_id: "p" } as never;

  test("a live kill reports killed", () => {
    expect(killedResult("killed", "local", panel, "sent")).toEqual({
      killed: true,
      outcome: "killed",
      machine: "local",
      target: "p",
    });
  });

  test("a program that had already exited never claims a kill", () => {
    expect(killedResult("ended", "local", panel, "skipped")).toMatchObject({
      killed: false,
      outcome: "ended",
    });
  });

  test("an undelivered parent notice is named", () => {
    expect(killedResult("killed", "local", panel, "failed")).toMatchObject({
      notice: "failed",
      next: "Tell its parent the worker is gone",
    });
  });
});

describe("remote reply normalisation", () => {
  /** A mutating call may answer without a record; it must not throw. */
  const loose = (value: unknown) =>
    (
      Object.create(RemoteCoreEndpoint.prototype) as unknown as {
        localLoose: (value: unknown) => unknown;
      }
    ).localLoose(value);

  test("a prefixed address is stripped", () => {
    expect(loose({ address: "m1/t7" })).toMatchObject({ address: "t7" });
  });

  test("a bare confirmation is passed through", () => {
    expect(loose({ removed: "t7" })).toEqual({ removed: "t7" });
    expect(loose(null)).toBeNull();
    expect(loose("ok")).toBe("ok");
  });

  test("an unusable address is passed through instead of throwing", () => {
    expect(loose({ address: "nonsense" })).toEqual({ address: "nonsense" });
  });
});

describe("closeTerminal", () => {
  /** A Core that records calls; closeTerminal only touches request(). */
  /** `labels` is what the program leaves behind; a released pane has none. */
  const fakeCore = (state: string, address = "t1", labelled = false) => {
    const calls: string[] = [];
    const connection = Object.create(CoreConnection.prototype) as {
      core: { request: (method: string) => Promise<unknown> };
    };
    connection.core = {
      request: async (method: string) => {
        calls.push(method);
        return method === "terminal.get"
          ? {
              address,
              state,
              labels: labelled ? { "pi.session_file": "/tmp/s.jsonl" } : {},
              status: { app: "pi", state: "idle" },
            }
          : { address };
      },
    };
    return { calls, connection: connection as unknown as CoreConnection };
  };
  const panel = { pane_id: "p", terminal_id: "t1" } as never;
  /** What a live program's pane carries; `panel` is the bare exited shape. */
  const livePanel = {
    pane_id: "p",
    terminal_id: "t1",
    agent: "pi",
    agent_status: "idle",
    interactive_ready: true,
    launch_pending: false,
    name: "w",
  } as never;

  test("a live terminal is killed, then removed", async () => {
    const { calls, connection } = fakeCore("live");
    expect(await connection.closeTerminal(panel)).toBe("killed");
    expect(calls).toEqual(["terminal.get", "terminal.kill", "terminal.rm"]);
  });

  test("a finished terminal whose labels outlived it is not killed", async () => {
    const { calls, connection } = fakeCore("finished", "t1", true);
    expect(await connection.closeTerminal(livePanel)).toBe("ended");
    expect(calls).toEqual(["terminal.get", "terminal.rm"]);
  });

  test("a live terminal is killed whatever the caller's panel says", async () => {
    const { calls, connection } = fakeCore("live");
    // The state decides, not the caller's panel, which can be stale either way.
    expect(await connection.closeTerminal(panel)).toBe("killed");
    expect(await connection.closeTerminal(livePanel)).toBe("killed");
    expect(calls).toEqual([
      "terminal.get",
      "terminal.kill",
      "terminal.rm",
      "terminal.get",
      "terminal.kill",
      "terminal.rm",
    ]);
  });

  test("a program that already exited is only removed, never reported killed", async () => {
    const { calls, connection } = fakeCore("finished", "t1", true);
    // A finished program keeps its diff and even its labels; only `state` says
    // no kill happened.
    expect(await connection.closeTerminal(livePanel)).toBe("ended");
    expect(await connection.closeTerminal(panel)).toBe("ended");
    expect(calls).toEqual([
      "terminal.get",
      "terminal.rm",
      "terminal.get",
      "terminal.rm",
    ]);
  });

  test("a remapped address is read from the caller's terminal", async () => {
    const { calls, connection } = fakeCore("live", "t2");
    expect(await connection.closeTerminal(panel, "t2")).toBe("killed");
    expect(calls).toEqual(["terminal.get", "terminal.kill", "terminal.rm"]);
  });

  test("an unknown state is refused before anything is removed", async () => {
    const { calls, connection } = fakeCore("orphaned");
    await expect(connection.closeTerminal(panel)).rejects.toThrow("unknown");
    expect(calls).toEqual(["terminal.get"]);
  });

  test("a changed pane is refused", async () => {
    const { calls, connection } = fakeCore("live");
    await expect(
      connection.closeTerminal({ pane_id: "p", terminal_id: "t9" } as never)
    ).rejects.toThrow("changed");
    expect(calls).toEqual(["terminal.get"]);
  });
});

describe("spawn placement", () => {
  /** Records the labels sent to terminal.run, then fails the address check. */
  const run = async (placement = "new_workspace") => {
    const sent: Record<string, unknown>[] = [];
    const core = Object.create(RemoteCoreEndpoint.prototype) as never;
    Object.assign(core, {
      call: async (input: { op: string }) =>
        input.op === "pi-executable" ? "/usr/bin/pi" : undefined,
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "terminal.run") sent.push(params);
        return { address: "invalid" };
      },
    });
    const params = { name: "w", label: "l", placement } as never;
    await startCoreAgent(
      { core, remote: {} } as never,
      params,
      "/tmp",
      []
    ).catch(() => undefined);
    return (sent[0]?.labels ?? {}) as Record<string, string>;
  };

  test("a space is the default placement", async () => {
    expect((await run())["herdr.space"]).toBeString();
  });

  test("an explicit terminal placement stays bare", async () => {
    expect((await run("terminal"))["herdr.space"]).toBeUndefined();
  });
});

describe("inactive panel", () => {
  const items = (active: boolean, tab: "Settings" | "Status" | "Connections") =>
    buildPanelItems(
      {
        fleet: { isActive: () => active, statuses: () => [] },
        orchestration: () => false,
      } as never,
      tab,
      { target: "", name: "", session: "" } as never
    );

  test("connection tabs are empty without a fleet", () => {
    expect(items(false, "Status")).toEqual([]);
    expect(items(false, "Connections")).toEqual([]);
  });

  test("settings stay available without a fleet", () => {
    expect(items(false, "Settings").length).toBeGreaterThan(0);
  });
});

describe("inactive reason", () => {
  const fleet = () =>
    Object.create(AgentFleet.prototype) as { inactiveError(): Error };
  const bundle = process.env["__CFBundleIdentifier"];
  const id = process.env["HC_TERMINAL_ID"];
  afterEach(() => {
    for (const [key, value] of [
      ["__CFBundleIdentifier", bundle],
      ["HC_TERMINAL_ID", id],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("outside the app names the app, not Core", () => {
    delete process.env["__CFBundleIdentifier"];
    delete process.env["HC_TERMINAL_ID"];
    expect(fleet().inactiveError().message).toContain("inside the Herdr app");
  });

  test("inside the app without Core names Core", () => {
    process.env["__CFBundleIdentifier"] = "dev.herdr.app";
    delete process.env["HC_TERMINAL_ID"];
    expect(fleet().inactiveError().message).toContain("Herdr Core");
  });
});

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
    expect(
      parseAgentsRequest({
        action: "reply",
        target: "p",
        extension: "e",
        id: "1",
        message: "m",
      }).action
    ).toBe("reply");
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

describe("session ancestry depth", () => {
  const entry = `${JSON.stringify({
    type: "custom",
    customType: "herdr-spawn-ancestry-v1",
    data: { parent: { sessionFile: "/tmp/p" } },
  })}\n`;
  const filler = (count: number) =>
    Array.from(
      { length: count },
      (_, index) =>
        `${JSON.stringify({ type: "message", text: "x".repeat(1024), index })}\n`
    ).join("");

  const read = async (body: string) => {
    const path = join(tmpdir(), `anc-${randomUUID()}.jsonl`);
    writeFileSync(path, body);
    return readSessionAncestry(path);
  };

  test("a resumed session's ancestry past the old 64 KiB head is found", async () => {
    // A resume writes a compaction summary ahead of the ancestry entry.
    expect(await read(`${filler(70)}${entry}{"type":"message"}\n`)).toBe(
      "/tmp/p"
    );
  });

  test("the whole window answers, not just its first chunk", async () => {
    // 230 x ~1060 bytes sits inside the 256 KiB window, past every 64 KiB chunk.
    expect(await read(`${filler(230)}${entry}`)).toBe("/tmp/p");
    // 250 x ~1060 exceeds it; the boundary is honest rather than silent sooner.
    expect(await read(`${filler(250)}${entry}`)).toBeUndefined();
  });
});
