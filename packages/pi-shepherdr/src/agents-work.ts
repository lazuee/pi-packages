import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

import { activityTask } from "./activity.js";
import { getSnapshot } from "./core/agents.js";
import type { CoreConnection } from "./core/backend.js";
import type { ConnectedMachine } from "./fleet/index.js";
import { agentSource } from "./messages/attribution.js";
import type { WorkAttempt } from "./monitor-state.js";
import { isDispatchRejected } from "./remote/shepherdr-peer.mjs";
import { SettlementTimeoutError } from "./settlement/delivery.js";
import type { ClaimedSettlement } from "./settlement/index.js";
import type {
  ExtensionReply,
  MonitoredAgent,
  PaneInfo,
  PeerDelivery,
} from "./types.js";

export function toolResult(value: Record<string, unknown>, warning?: string) {
  if (warning) value = { ...value, next: warning };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  };
}

export function reportProgress(
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>>,
  message: string,
  details: Record<string, unknown>
): void {
  onUpdate({
    content: [{ type: "text", text: message }],
    details,
  });
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036F]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  const named = /^[a-z]/u.test(slug) ? slug : `agent-${slug}`;
  return named.slice(0, 32).replace(/-+$/u, "") || "agent";
}

const startingNames = new WeakMap<CoreConnection, Set<string>>();

/** Human reading of the settlement retry window. */
const SETTLEMENT_WINDOW = "7.75s";

export async function reserveAgentName(
  runtime: ConnectedMachine,
  label: string,
  requested?: string
): Promise<{ name: string; release(): void }> {
  const snapshot = await getSnapshot(runtime.client);
  let reserved = startingNames.get(runtime.client);
  if (!reserved) {
    reserved = new Set<string>();
    startingNames.set(runtime.client, reserved);
  }
  const names = new Set([
    ...snapshot.panes.flatMap((panel) => (panel.name ? [panel.name] : [])),
    ...reserved,
  ]);
  const name = requested?.trim() || availableAgentName(names, label);
  if (names.has(name))
    throw new Error(
      `Agent name ${JSON.stringify(name)} is already in use; omit name or choose another`
    );
  reserved.add(name);
  return {
    name,
    release: () => {
      reserved.delete(name);
    },
  };
}

function availableAgentName(names: ReadonlySet<string>, label: string): string {
  const base = slugify(label);
  if (!names.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, 32 - tail.length).replace(/-+$/u, "")}${tail}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new Error(
    `could not allocate an agent name for ${JSON.stringify(label)}`
  );
}

export function settlementResult(
  machine: string,
  settlement: ClaimedSettlement,
  options: { reportWorkerError?: boolean } = {}
): Record<string, unknown> {
  const workerError =
    settlement.reply?.stopReason === "error"
      ? settlement.reply.text ||
        `${settlement.agent.pane_id} assistant stopped with an error`
      : undefined;
  if (workerError && !options.reportWorkerError) throw new Error(workerError);
  const { pane, terminal, name, ...source } = agentSource(
    settlement.agent,
    settlement.labels
  );
  return {
    machine,
    target: pane ?? terminal,
    ...(name ? { name } : {}),
    source,
    status: settlement.status,
    ...(workerError ? { worker_error: workerError } : {}),
    ...(settlement.reply ? { reply: settlement.reply.text } : {}),
    ...(settlement.extensionMessages
      ? { extensionMessages: settlement.extensionMessages }
      : {}),
    ...(settlement.blockedMessage
      ? { blocked_on: settlement.blockedMessage }
      : {}),
    ...(settlement.status === "done" &&
    !settlement.reply &&
    !settlement.extensionMessages?.length
      ? { completed: true }
      : {}),
  };
}

export async function dispatchAgentWork(
  runtime: ConnectedMachine,
  panel: PaneInfo,
  task: string,
  blocking: boolean,
  signal: AbortSignal,
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>>,
  send: () => Promise<PeerDelivery | void>,
  options: {
    expectUserMessage?: boolean;
    onAccepted?: () => void;
    replyingTo?: ExtensionReply;
    timeoutMs?: number;
    /** Called once when a blocked result is still being collected. */
    onStall?: (window: string) => void;
  } = {}
): Promise<{
  /** Why the wait ended early; the work itself continues in every case. */
  detach?: "session" | "stall" | "timeout";
  detail?: string;
  settlement?: ClaimedSettlement;
  command?: true;
  warning?: string;
}> {
  signal.throwIfAborted();
  const addedWatch = !runtime.monitor
    .list()
    .some(
      (record) =>
        record.terminalId === panel.terminal_id ||
        record.paneId === panel.pane_id
    );
  let attempt: WorkAttempt | undefined;
  let settlement: Promise<ClaimedSettlement> | undefined;
  let receipt: PeerDelivery | undefined;
  let sendStarted = false;
  let track: MonitoredAgent | undefined;
  try {
    track = await runtime.monitor.track(panel);
    attempt = runtime.monitor.beginWork(track.paneId, task, null);
    if (!attempt) throw new Error(`${panel.pane_id} is not monitored`);
    settlement = blocking
      ? runtime.monitor.claimWork(
          attempt,
          signal,
          options.replyingTo,
          options.timeoutMs
        )
      : undefined;
    if (!blocking && options.replyingTo) {
      runtime.monitor.observeReply(attempt, options.replyingTo);
    }
    void settlement?.catch(() => undefined);
    signal.throwIfAborted();
    // A baseline taken before the send lets a slow worker persist the prompt
    // first, so read it immediately before submitting.
    if (options.expectUserMessage) {
      const baseline = await runtime.monitor.view(panel, signal);
      if (baseline.input?.id)
        runtime.monitor.expectUser(attempt, baseline.input.id);
    }
    sendStarted = true;
    receipt = (await send()) ?? undefined;
  } catch (error) {
    if (settlement || options.replyingTo)
      runtime.monitor.releaseWorkClaim(attempt, error);
    if (sendStarted) await runtime.monitor.handleWorkFailure(attempt, error);
    else runtime.monitor.rejectWork(attempt);
    if (addedWatch && (!sendStarted || isDispatchRejected(error))) {
      const record = runtime.monitor
        .list()
        .find((record) => record.terminalId === panel.terminal_id);
      try {
        if (record?.scope === "task" && !activityTask(record.activity)) {
          await runtime.monitor.unwatch(record.paneId);
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Delegation failed; temporary watch cleanup also failed",
          { cause: cleanupError }
        );
      }
    }
    throw error;
  }
  try {
    if (receipt?.command) {
      if (settlement || options.replyingTo)
        runtime.monitor.releaseWorkClaim(
          attempt,
          new Error("Command submitted without task waiting")
        );
      runtime.monitor.rejectWork(attempt);
      if (addedWatch) {
        const record = runtime.monitor
          .list()
          .find((record) => record.terminalId === panel.terminal_id);
        if (record?.scope === "task" && !activityTask(record.activity))
          await runtime.monitor.unwatch(record.paneId);
      }
    } else {
      runtime.monitor.acceptWork(attempt);
      runtime.monitor.noteMessage(panel.pane_id, task);
      options.onAccepted?.();
    }
    await runtime.monitor.reconcileNow();
  } catch (error) {
    if (settlement || options.replyingTo)
      runtime.monitor.releaseWorkClaim(attempt, error);
    return {
      ...(receipt?.command ? { command: true } : {}),
      warning: `Submitted, but monitoring refresh failed: ${error instanceof Error ? error.message : String(error)}. Inspect the target before resubmitting`,
    };
  }
  if (receipt?.command) return { command: true };
  if (!settlement) return {};
  const started = Date.now();
  const label = panel.name ?? panel.pane_id;
  // Visible so a long wait never looks like a stall, without repeating itself.
  let shown = "";
  const progress = (message: string) => {
    if (message === shown) return;
    shown = message;
    reportProgress(onUpdate, message, {
      machine: runtime.machine,
      target: panel.pane_id,
      status: "working",
      elapsedMs: Date.now() - started,
    });
  };
  progress(`Waiting for ${label}`);
  if (options.onStall) {
    const base = settlement;
    settlement = base.then(
      (value) => value,
      (error) => {
        if (error instanceof SettlementTimeoutError) throw error;
        options.onStall!(
          `${label} blocked without a result; still retrying for ${SETTLEMENT_WINDOW}`
        );
        return base;
      }
    );
  }
  try {
    return { settlement: await settlement };
  } catch (error) {
    // Only the waiter was dropped; the work and its later report continue.
    if (!(error instanceof SettlementTimeoutError)) throw error;
    const detached =
      error.source === "session"
        ? "session"
        : error.source === "stall"
          ? "stall"
          : "timeout";
    reportProgress(onUpdate, `Detached from ${label}`, {
      machine: runtime.machine,
      target: panel.pane_id,
      status: "working",
      detached,
      elapsedMs: Date.now() - started,
    });
    return { detach: detached, detail: error.detail };
  }
}
