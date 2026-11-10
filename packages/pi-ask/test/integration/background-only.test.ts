import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  PiIntegrationTest,
  type PiRun,
  testArtifactsDir,
  text,
  toolCall,
} from "#test/fixtures/pi-coding-agent-test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const extensions = [
  fileURLToPath(
    new URL("../fixtures/background-only-driver.ts", import.meta.url),
  ),
  fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
];
const call = (id: string, name: string, args: Record<string, unknown>) =>
  assistantMessage([toolCall({ id, name, arguments: args })], {
    stopReason: "toolUse",
  });
const form = (id: string) => ({
  questions: [
    { id, prompt: `Choose ${id}?`, options: [{ value: "yes", label: "Yes" }] },
  ],
});

interface DeclaredTool {
  name: string;
  parameters: { properties?: Record<string, unknown> };
}

function declarations(
  request: PiRun["providerRequests"][number],
): Map<string, DeclaredTool> {
  assert(Array.isArray(request.messages));
  const tools = new Map<string, DeclaredTool>();
  for (const message of request.messages as Array<{
    role: string;
    toolsAdded?: DeclaredTool[];
    toolsRemoved?: Array<{ name: string }>;
  }>) {
    if (message.role !== "system") {
      continue;
    }
    for (const removed of message.toolsRemoved ?? []) {
      tools.delete(removed.name);
    }
    for (const added of message.toolsAdded ?? []) {
      tools.set(added.name, added);
    }
  }
  return tools;
}

interface Observation {
  activeForms: number;
  answerMessages: number;
  blocked: boolean[];
  completed: number;
  confirmations: boolean[];
  independentPackage?: string;
  savedMode: boolean;
  waitActive: boolean;
  waitCallable: boolean;
  waitExposure: string;
}

function observation(result: PiRun, id: string): Observation {
  const execution = getToolExecution(result, id);
  assert.equal(execution.isError, false, id);
  return getToolExecutionDetails(execution) as Observation;
}

function assertMode(
  request: PiRun["providerRequests"][number],
  backgroundOnly: boolean,
): void {
  const tools = declarations(request);
  const ask = tools.get("ask_user");
  assert(ask, `ask_user among ${[...tools.keys()].join(",")}`);
  assert.equal(
    Object.hasOwn(ask.parameters.properties ?? {}, "background"),
    !backgroundOnly,
    `${backgroundOnly} ${JSON.stringify(ask.parameters)}`.slice(0, 120),
  );
  assert.equal(tools.has("wait_for_answers"), !backgroundOnly);
}

test("real Pi queues background-only questions and delivers idle answers once without a wait tool", async () => {
  const result = await new PiIntegrationTest({
    testName: "background-only-queue-and-idle",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: root,
    isolateUserResources: true,
    extensions,
    // Exclude-only: ask_user registers on session_start, after the harness hook.
    tools: {
      exclude: [
        "read",
        "bash",
        "powershell",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        "ask_user",
        "wait_for_answers",
      ],
    },
    rawMode: false,
    conversation: [
      call("surface", "background_only_probe", { action: "reactivate_wait" }),
      call("stale-wait", "wait_for_answers", {}),
      call("invalid", "ask_user", {
        questions: [
          {
            id: "invalid",
            prompt: " ",
            options: [{ value: "yes", label: "Yes" }],
          },
        ],
      }),
      call("first-form", "ask_user", form("first")),
      call("second-form", "ask_user", { ...form("second"), background: false }),
      call("research", "background_only_probe", { action: "research" }),
      assistantMessage([text("Independent work finished; ending this turn.")]),
      call("after-wake", "background_only_probe", { action: "stats" }),
      call("after-boundary", "background_only_probe", { action: "stats" }),
      assistantMessage([text("Background-only verification complete.")]),
    ],
  }).run(
    "Queue decisions while completing independent work, and process the eventual answers.",
  );

  for (const request of result.providerRequests) {
    assertMode(request, true);
  }
  const surface = observation(result, "surface");
  assert.equal(surface.savedMode, true);
  assert.equal(surface.waitExposure, "hidden");
  assert.equal(surface.waitActive, false);
  assert.equal(surface.waitCallable, false);
  assert.equal(getToolExecution(result, "stale-wait").isError, true);
  const invalid = getToolExecutionDetails(
    getToolExecution(result, "invalid"),
  ) as {
    error: { kind: string };
  };
  assert.equal(invalid.error.kind, "invalid_input");

  const receipts = ["first-form", "second-form"].map((id) => {
    const execution = getToolExecution(result, id);
    assert.equal(execution.isError, false);
    const details = getToolExecutionDetails(execution) as {
      status: string;
      requestId: string;
    };
    assert.equal(details.status, "queued");
    return details.requestId;
  });
  assert.notEqual(receipts[0], receipts[1]);
  const research = observation(result, "research");
  assert.equal(research.independentPackage, "@lazuee/pi-ask");
  assert.equal(research.activeForms, 1);
  assert.equal(research.completed, 0);
  assert.equal(research.answerMessages, 0);
  assert.deepEqual(research.blocked, [true]);
  const complete = observation(result, "after-boundary");
  assert.equal(complete.answerMessages, 2);
  assert.equal(complete.completed, 2);
  assert.equal(complete.activeForms, 0);
  assert.deepEqual(complete.blocked, [true, false]);

  const snapshot = result.traceEvents
    .filter((event) => event.type === "session_snapshot")
    .at(-1);
  assert(Array.isArray(snapshot?.branch));
  const answers = snapshot.branch.filter(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "ask:background-answer",
  );
  assert.equal(answers.length, 2);
  assert.deepEqual(
    answers.map((entry) => entry.details.requestId).sort(),
    [...receipts].sort(),
  );
  const lastRequest = result.providerRequests.at(-1);
  assert(lastRequest && Array.isArray(lastRequest.messages));
  for (const requestId of receipts) {
    assert.equal(
      lastRequest.messages.filter(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes(requestId),
      ).length,
      1,
    );
  }
});

test("real Pi confirms mode changes after its first model request and preserves rejected changes", async () => {
  const result = await new PiIntegrationTest({
    testName: "background-only-runtime-confirmation",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: root,
    isolateUserResources: true,
    extensions,
    environment: Object.fromEntries([
      ["ASK_BACKGROUND_ONLY_START_NORMAL", "1"],
    ]),
    // Exclude-only: ask_user registers on session_start, after the harness hook.
    tools: {
      exclude: [
        "read",
        "bash",
        "powershell",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        "ask_user",
        "wait_for_answers",
      ],
    },
    conversation: [
      call("reject-enable", "background_only_probe", {
        action: "switch",
        backgroundOnly: true,
        confirm: false,
      }),
      call("enable", "background_only_probe", {
        action: "switch",
        backgroundOnly: true,
        confirm: true,
      }),
      call("reject-disable", "background_only_probe", {
        action: "switch",
        backgroundOnly: false,
        confirm: false,
      }),
      call("disable", "background_only_probe", {
        action: "switch",
        backgroundOnly: false,
        confirm: true,
      }),
      assistantMessage([text("Runtime mode changes checked.")]),
    ],
  }).run("Check mode switching through the registered command.");
  // ask_user registers once, with the session start policy (background-only here), so
  // its schema stays put; wait_for_answers is never hidden by later switches either
  // because its exposure is fixed at registration.

  // The startup switch to normal runs in before_agent_start, after the session start
  // registration, so the first request already carries the background-only schema.
  assertMode(result.providerRequests[0], true);
  const rejectedEnable = observation(result, "reject-enable");
  assert.deepEqual(rejectedEnable.confirmations, [false]);
  assert.equal(rejectedEnable.savedMode, false);
  assert.equal(rejectedEnable.waitExposure, "hidden");
  assertMode(result.providerRequests[1], true);
  const enabled = observation(result, "enable");
  assert.deepEqual(enabled.confirmations, [false, true]);
  assert.equal(enabled.savedMode, true);
  assert.equal(enabled.waitExposure, "hidden");
  assertMode(result.providerRequests[2], true);
  const rejectedDisable = observation(result, "reject-disable");
  assert.deepEqual(rejectedDisable.confirmations, [false, true, false]);
  assert.equal(rejectedDisable.savedMode, true);
  assertMode(result.providerRequests[3], true);
  const disabled = observation(result, "disable");
  assert.deepEqual(disabled.confirmations, [false, true, false, true]);
  assert.equal(disabled.savedMode, false);
  assert.equal(disabled.waitExposure, "hidden");
  assertMode(result.providerRequests[4], true);
}, 60_000);
