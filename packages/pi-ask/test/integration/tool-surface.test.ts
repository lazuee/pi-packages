import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#test/fixtures/pi-coding-agent-test";

// Protects default tool exposure and prompt contributions through the real extension loader.
test("real Pi exposes question tools without default history tools or prompt rules", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ask-tool-surface-"));
  try {
    const result = await new PiIntegrationTest({
      testName: "agent-question-surface",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [
        fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
        fileURLToPath(
          new URL("../fixtures/tool-surface-driver.ts", import.meta.url),
        ),
      ],
      // ask_user is excluded so the nested call is rejected, then retried by the
      // extension once it registered on session_start.
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
        assistantMessage(
          [
            toolCall({
              id: "surface",
              name: "inspect_ask_surface",
              arguments: {},
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "ask", name: "ask_a_question", arguments: {} })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Question tool surface checked.")]),
      ],
    }).run("Read the registered ask surface.");
    const execution = getToolExecution(result, "surface");
    assert.equal(execution.isError, false);
    const details = getToolExecutionDetails(execution) as {
      commands: string[];
      toolGuidelines: Record<string, string[]>;
      tools: string[];
    };
    assert(
      details.commands.includes("ask-settings"),
      JSON.stringify(details.commands),
    );
    for (const removed of ["answer", "answer:again", "ask:replay"]) {
      assert(
        !details.commands.includes(removed),
        `${removed} must not be registered`,
      );
    }
    for (const tool of ["ask_user", "wait_for_answers"]) {
      assert(
        details.tools.includes(tool),
        `${tool} among ${details.tools.join(",")}`,
      );
    }
    // A rejected nested call is retried by the extension once the tool registered, so it
    // reaches the form instead of failing again.
    assert.match(
      getToolResultText(result, "ask"),
      /form still open|User cancelled/i,
    );
    for (const tool of [
      "list_ask_history",
      "read_ask_history",
      "export_ask_history",
    ]) {
      assert(!details.tools.includes(tool), `${tool} must be opt-in`);
    }
    for (const tool of ["ask_user", "wait_for_answers"]) {
      assert.deepEqual(details.toolGuidelines[tool] ?? [], [], tool);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);
