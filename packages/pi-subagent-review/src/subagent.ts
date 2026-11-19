import { join } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getPackageDir, RpcClient } from "@earendil-works/pi-coding-agent";

import { CHILD_ENV, REVIEW_LABEL, REVIEW_PROMPT_PATH } from "./constants.js";
import { createChildRunDetails } from "./run-details.js";
import type { ChildRunDetails, ResolvedReviewConfig } from "./types.js";

const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

function recordAssistantMessage(
  details: ChildRunDetails,
  message: AssistantMessage
): void {
  details.messages.push(message);
  details.usage.turns++;
  details.usage.input += message.usage.input || 0;
  details.usage.output += message.usage.output || 0;
  details.usage.cacheRead += message.usage.cacheRead || 0;
  details.usage.cacheWrite += message.usage.cacheWrite || 0;
  details.usage.cost += message.usage.cost.total || 0;
  details.usage.contextTokens = message.usage.totalTokens || 0;
  details.stopReason = message.stopReason;
  if (message.errorMessage) details.errorMessage = message.errorMessage;
}

export async function runReviewSubagent(
  task: string,
  cwd: string,
  config: ResolvedReviewConfig,
  signal?: AbortSignal
) {
  const details = createChildRunDetails(task, cwd, config);
  const client = new RpcClient({
    cliPath: join(getPackageDir(), "dist", "cli.js"),
    cwd,
    env: { [CHILD_ENV]: "1" },
    model: config.model,
    args: [
      // A review is read-only and must not write into the user's session store.
      "--no-session",
      "--no-skills",
      "--thinking",
      config.thinking,
      // RPC children do not inherit the parent's edits; without these the
      // reviewer carried the parent's own /review registration and spun up a
      // nested review.
      "--append-system-prompt",
      REVIEW_PROMPT_PATH,
    ],
  });
  const abort = () => {
    void client.abort().catch(() => {
      /* empty */
    });
  };

  try {
    if (signal?.aborted) throw new Error(`${REVIEW_LABEL} aborted.`);
    await client.start();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) throw new Error(`${REVIEW_LABEL} aborted.`);
    await client.setAutoCompaction(true);
    await client.setAutoRetry(true);
    if (signal?.aborted) throw new Error(`${REVIEW_LABEL} aborted.`);
    const events = await client.promptAndWait(
      `Task: ${task}`,
      undefined,
      REVIEW_TIMEOUT_MS
    );
    for (const event of events) {
      if (event.type === "message_end" && event.message.role === "assistant") {
        recordAssistantMessage(details, event.message);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = client.getStderr().trim();
    if (!stderr || message.includes(stderr)) throw error;
    throw new Error(`${message}\nStderr: ${stderr}`, { cause: error });
  } finally {
    signal?.removeEventListener("abort", abort);
    await client.stop();
  }

  details.stderr = client.getStderr();
  // Only requestAssistantMessage records a non-zero exit; reaching here means
  // the child ran to completion. Its failures travel in stopReason instead.
  return details;
}

const FENCE = "````";

// The reviewer prompt asks for an inline `path:start-end` tag, which Pi's
// renderer parses as the start of a code span inside a list item and swallows
// to the end of the report. Fence it so the line survives rendering.
export function normalizeReviewMarkup(findings: string): string {
  return findings
    .split("\n")
    .map((line) => {
      const match = /^(\s*[-*] )`(\[(?:high|medium|low)\][^`]*)`/.exec(line);
      return match ? `${match[1]}${match[2]} ${FENCE}` : line;
    })
    .join("\n");
}
