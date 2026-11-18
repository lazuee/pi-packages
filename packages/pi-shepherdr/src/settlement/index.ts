import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  activityAttemptId,
  activityExpectedUser,
  activityTask,
} from "../activity.js";
import type { CoreConnection } from "../core/backend.js";
import type { MonitorState, WorkAttempt } from "../monitor-state.js";
import type { AssistantReader } from "../session-reader.js";
import type {
  ExtensionReply,
  LatestAssistant,
  MonitoredAgent,
  PaneInfo,
  SessionView,
  SettledAgentStatus,
} from "../types.js";
import { blockedSettlement, SettlementCollector } from "./collector.js";
import type { CollectedSettlementWithSession } from "./collector.js";
import { SettlementDelivery, SettlementTimeoutError } from "./delivery.js";

export { SettlementCollector } from "./collector.js";

export { SettlementTimeoutError } from "./delivery.js";
export type { ClaimedSettlement } from "./delivery.js";

interface SettlementRetry {
  attemptId: string | undefined;
  count: number;
  reason?: string;
  /** Built from live state on every pass, never replayed stale. */
  request: () => SettlementRequest;
}

const SETTLEMENT_RETRY_DELAYS_MS = [
  500, 1000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000,
  2000, 2000,
] as const;
const SETTLEMENT_RETRY_WINDOW_SECONDS = Math.ceil(
  SETTLEMENT_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0) / 1000
);

const FINAL_REPLY = "the final assistant reply was not persisted";
const EXTENSION_REPLY = "the worker remained blocked after its extension reply";
const INPUT_PERSISTED = "the submitted input and reply were not persisted";
const NEW_REPLY = "the new assistant reply was not persisted";
// A missing turn is either a slow write or a worker still running its tool.
const TURN_PERSISTED = "the worker's own turn was not persisted";
const TURN_RUNNING = "the worker was still running the submitted turn";
const SNAPSHOT = "the settlement snapshot remained unavailable";

/** A turn is either still running its tool or never landed on disk. */
export function turnReason(view: { toolHead?: boolean }): string {
  return view.toolHead ? TURN_RUNNING : TURN_PERSISTED;
}

function attemptKey(terminalId: string, attemptId: string | undefined): string {
  return JSON.stringify([terminalId, attemptId ?? null]);
}

export interface SettlementRequest {
  blockedMessage?: string;
  /**
   * A tool may only complete once its own input head has persisted. A working
   * worker can still hold the previous turn's reply, and herdr's done arrives a
   * status tick ahead of the write.
   */
  requireTurn?: boolean;
  /** Reports that the blocked result is still being collected. */
  onStall?: (window: string) => void;
  record: MonitoredAgent;
  requireNewReply?: boolean;
  status: SettledAgentStatus;
  task?: string;
}

export interface SettlementLifecycle {
  context: ExtensionContext;
  generation: number;
  isCurrent: () => boolean;
}

interface PendingBlockedSettlement {
  lifecycle: SettlementLifecycle;
  request: SettlementRequest;
  retry?: SettlementRetry;
}

export class SettlementReporter {
  private readonly collector: SettlementCollector;
  private readonly persist: () => void;
  private readonly reporting = new Map<string, SettledAgentStatus>();
  private readonly failedAttempts = new Map<string, string | undefined>();
  private readonly pendingBlocked = new Map<string, PendingBlockedSettlement>();
  private readonly delivery: SettlementDelivery;
  private readonly retries = new Map<
    string,
    { terminalId: string; timer: NodeJS.Timeout }
  >();
  private readonly state: MonitorState;
  private readonly onClosed: (record: MonitoredAgent) => Promise<void>;

  constructor(
    pi: ExtensionAPI,
    client: CoreConnection,
    state: MonitorState,
    persist: () => void,
    reader: AssistantReader | undefined,
    origin: { machine: string; label: () => string; operatorPrefix: string },
    onClosed: (record: MonitoredAgent) => Promise<void>
  ) {
    this.delivery = new SettlementDelivery(pi, origin);
    this.collector = new SettlementCollector(client, reader);
    this.state = state;
    this.persist = persist;
    this.onClosed = onClosed;
  }

  latest(panel: PaneInfo): Promise<LatestAssistant | undefined> {
    return this.collector.latest(panel);
  }

  view(panel: PaneInfo, signal?: AbortSignal): Promise<SessionView> {
    return this.collector.view(panel, signal);
  }

  stop(): void {
    this.reporting.clear();
    this.failedAttempts.clear();
    this.pendingBlocked.clear();
    this.delivery.stop();
    for (const { timer } of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
  }

  claim(
    attempt: WorkAttempt,
    signal: AbortSignal,
    replyingTo?: ExtensionReply,
    timeoutMs?: number,
    onStall?: (window: string) => void
  ) {
    const pending = this.delivery.claim(attempt, signal, replyingTo, timeoutMs);
    if (pending && onStall) this.stalls.set(attempt.attemptId, onStall);
    return pending;
  }
  /** Registered at claim time so a stalled first pass can be reported. */
  private readonly stalls = new Map<string, (window: string) => void>();
  /** Marks a live claim as a tool wait, which must see its own turn. */
  requireTurn(attemptId: string | undefined): void {
    if (attemptId) this.turns.add(attemptId);
  }
  private readonly turns = new Set<string>();
  retireAttempt(attemptId: string | undefined): void {
    this.turns.delete(attemptId ?? "");
    this.stalls.delete(attemptId ?? "");
    this.delivery.retireAttempt(attemptId);
  }
  observeReply(attempt: WorkAttempt, reply: ExtensionReply): void {
    this.delivery.observeReply(attempt, reply);
  }
  releaseClaim(attempt: WorkAttempt | undefined, error: unknown) {
    this.stalls.delete(attempt?.attemptId ?? "");
    this.turns.delete(attempt?.attemptId ?? "");
    this.delivery.releaseClaim(attempt, error);
  }
  releaseAgentClaim(record: MonitoredAgent, error: unknown) {
    this.failedAttempts.delete(record.terminalId);
    for (const [key, retry] of this.retries) {
      if (retry.terminalId !== record.terminalId) continue;
      clearTimeout(retry.timer);
      this.retries.delete(key);
    }
    for (const [key, pending] of this.pendingBlocked) {
      if (pending.request.record.terminalId === record.terminalId)
        this.pendingBlocked.delete(key);
    }
    this.delivery.releaseAgentClaim(record, error);
  }
  async report(
    lifecycle: SettlementLifecycle,
    initial: SettlementRequest,
    retry?: SettlementRetry
  ): Promise<void> {
    let request = initial;
    const task = request.task ?? activityTask(request.record.activity);
    const retryState: SettlementRetry = retry ?? {
      attemptId: activityAttemptId(request.record.activity),
      count: 0,
      request: () => request,
    };
    const key = `${lifecycle.generation}:${attemptKey(
      request.record.terminalId,
      retryState.attemptId
    )}`;
    const activeStatus = this.reporting.get(key);
    if (activeStatus) {
      if (request.status === "blocked" && activeStatus !== "blocked") {
        this.pendingBlocked.set(key, {
          lifecycle,
          request,
          ...(retry ? { retry } : {}),
        });
      } else if (
        this.pendingBlocked.has(key) &&
        this.pendingBlocked.get(key)!.request.status === "blocked"
      ) {
        // A blocked pass is already queued and replays after this one.
      } else {
        // Another pass owns the key. Queue instead of dropping: the in-flight
        // pass may be a stale idle report that will retire this waiter.
        this.pendingBlocked.set(key, {
          lifecycle,
          request,
          ...(retry ? { retry } : {}),
        });
      }
      return;
    }
    this.reporting.set(key, request.status);
    if (retryState.attemptId && this.turns.has(retryState.attemptId))
      request = { ...request, requireTurn: true };
    const onStall =
      request.onStall ?? this.stalls.get(retryState.attemptId ?? "");
    const retryRequest = task ? { ...request, task } : request;
    // A pending blocked report supersedes the visible attempt; a stall in the
    // first pass would otherwise leave the caller silent until the window ends.
    if (retryState.count === 0 && request.status === "blocked" && onStall)
      onStall(`${SETTLEMENT_RETRY_WINDOW_SECONDS}s`);
    // Later passes carry the live record: its settled activity no longer holds
    // the attempt id, so a retry must not be re-stamped with a stale task.
    const retryLive = (reason: string, record: MonitoredAgent) => ({
      ...retryState,
      reason,
      request: () => ({ ...retryRequest, record }),
    });
    try {
      const replyingTo = retryState.attemptId
        ? this.delivery.replyingTo(retryState.attemptId)
        : undefined;
      const settlement = await this.collector.collect(
        request.record,
        request.status === "blocked" && !replyingTo ? "blocked" : undefined
      );
      if (!settlement || !lifecycle.isCurrent()) return;
      if (settlement === "closed") {
        await this.onClosed(request.record);
        return;
      }
      if (this.pendingBlocked.has(key)) return;
      const current = this.state.byPane(settlement.agent.pane_id);
      if (!current || current.terminalId !== request.record.terminalId) return;
      if (
        activityTask(current.activity) !== task ||
        activityAttemptId(current.activity) !== retryState.attemptId
      ) {
        if (request.status !== "blocked") {
          // A follow-up assignment owns the live work. A first pass only just
          // recorded it, so give a waiter one more chance before retiring it.
          if (retryState.count === 0 && this.retry(lifecycle, retryState))
            return;
          this.delivery.retireAttempt(retryState.attemptId);
          return;
        }
        this.clearRetry(request.record.terminalId, retryState.attemptId);
        this.stalls.delete(retryState.attemptId ?? "");
        this.delivery.deliverSettlement(
          lifecycle,
          request.record,
          settlement,
          retryState.attemptId,
          request.blockedMessage,
          undefined
        );
        return;
      }
      const expectedUser = activityExpectedUser(current.activity);
      const blocked = settlement.status === "blocked";
      if (
        !blocked &&
        !this.turnOwned(settlement.session, expectedUser, request)
      ) {
        const reason = settlement.session.toolHead
          ? TURN_RUNNING
          : TURN_PERSISTED;
        if (!this.retry(lifecycle, retryLive(reason, current))) {
          this.failReconciliation(lifecycle, current, reason);
        }
        return;
      }
      // Status and session writes arrive separately. A tool call is not a reply,
      // even if done arrives before the final message is visible on disk.
      if (!blocked && settlement.session.assistantPending) {
        if (!this.retry(lifecycle, retryLive(FINAL_REPLY, current))) {
          this.failReconciliation(
            lifecycle,
            current,
            "the final assistant reply was not persisted"
          );
        }
        return;
      }
      // Closing a message and publishing resumed status use separate transports.
      if (blocked && replyingTo) {
        if (
          settlement.extensionMessages?.some(
            (message) =>
              message.extension === replyingTo.extension &&
              message.id === replyingTo.id
          )
        )
          return;
        if (
          !settlement.extensionMessages?.some((message) => message.blocking)
        ) {
          if (!this.retry(lifecycle, retryLive(EXTENSION_REPLY, current))) {
            this.failReconciliation(
              lifecycle,
              current,
              "the worker remained blocked after its extension reply"
            );
          }
          return;
        }
      }
      // A blocked status is authoritative even when Pi has not persisted the turn.
      // Pi persists expanded skills/templates, not the submitted command text.
      if (
        !blocked &&
        expectedUser &&
        (settlement.session.assistantAfterInput !== true ||
          !settlement.session.input ||
          settlement.session.input.id === expectedUser.after)
      ) {
        if (!this.retry(lifecycle, retryLive(INPUT_PERSISTED, current))) {
          this.failReconciliation(
            lifecycle,
            current,
            "the submitted input and reply were not persisted"
          );
        }
        return;
      }
      const newReply =
        !blocked && settlement.reply?.id !== current.lastAssistantId
          ? settlement.reply
          : undefined;
      // A tool call is not a reply, but it also means another turn is coming.
      if (
        !blocked &&
        request.requireNewReply &&
        !newReply &&
        !settlement.session.assistantToolUse
      ) {
        if (!this.retry(lifecycle, retryLive(NEW_REPLY, current))) {
          this.failReconciliation(
            lifecycle,
            current,
            settlement.session.assistantPending
              ? "the new assistant reply was still being written"
              : "the new assistant reply was not persisted"
          );
        }
        return;
      }
      const blockedMessage =
        settlement.status === request.status
          ? request.blockedMessage
          : undefined;
      const attemptId = activityAttemptId(current.activity);
      if (
        this.state.complete(
          current.terminalId,
          settlement.status,
          task,
          newReply?.id
        )
      ) {
        this.clearRetry(current.terminalId, retryState.attemptId);
        this.failedAttempts.delete(current.terminalId);
        this.persist();
        this.stalls.delete(retryState.attemptId ?? "");
        this.delivery.deliverSettlement(
          lifecycle,
          current,
          settlement,
          attemptId,
          blockedMessage,
          newReply
        );
      }
    } catch (error) {
      if (!lifecycle.isCurrent()) return;
      if (!this.state.byTerminal(request.record.terminalId)) return;
      if (request.status === "blocked") {
        const current = this.state.byTerminal(request.record.terminalId);
        if (current) {
          const currentOwnsAttempt =
            activityTask(current.activity) === task &&
            activityAttemptId(current.activity) === retryState.attemptId;
          this.clearRetry(request.record.terminalId, retryState.attemptId);
          if (
            currentOwnsAttempt &&
            this.state.complete(current.terminalId, "blocked", task)
          ) {
            this.persist();
          }
          this.stalls.delete(retryState.attemptId ?? "");
          this.delivery.deliverSettlement(
            lifecycle,
            currentOwnsAttempt ? current : request.record,
            blockedSettlement(current),
            retryState.attemptId,
            request.blockedMessage,
            undefined
          );
        }
        return;
      }
      if (this.pendingBlocked.has(key)) return;
      if (retryState.count === 0) {
        lifecycle.context.ui.notify(
          `Could not collect ${request.record.name ?? request.record.paneId}: ${error instanceof Error ? error.message : String(error)}`,
          "warning"
        );
      }
      const retryRequest = task ? { ...request, task } : request;
      const current = this.state.byTerminal(request.record.terminalId);
      if (
        !this.retry(lifecycle, {
          ...retryState,
          reason: SNAPSHOT,
          request: () => ({
            ...retryRequest,
            record: current ?? request.record,
          }),
        }) &&
        current &&
        activityTask(current.activity) === task &&
        activityAttemptId(current.activity) === retryState.attemptId
      )
        this.failReconciliation(
          lifecycle,
          current,
          "the settlement snapshot remained unavailable"
        );
    } finally {
      this.reporting.delete(key);
      const pending = this.pendingBlocked.get(key);
      if (pending) {
        this.pendingBlocked.delete(key);
        void this.report(pending.lifecycle, pending.request, pending.retry);
      }
    }
  }

  private turnOwned(
    view: CollectedSettlementWithSession["session"],
    expected: ReturnType<typeof activityExpectedUser>,
    request: SettlementRequest
  ): boolean {
    // No recorded watermark means nothing to match; known readers bound it.
    if (
      !expected ||
      (expected.after === null && view.replyAfterInput !== undefined)
    )
      return true;
    const id = view.input?.id;
    if (!id || id === expected.after) return false;
    // herdr settles a tool-calling turn before the follow-up request runs. Such
    // a turn has no assistant reply yet, only the call, and will get one.
    if (view.toolHead) return false;
    if (view.assistantAfterInput !== true) return false;
    // Only a bounded view proves where the reply sits. Otherwise answering
    // depends on the session cache first noticing the new head, and an echo of
    // the previous reply is expected: fine for a release, not for a tool wait.
    // Unbounded readers cannot place the reply; a tool wait then keeps retrying
    // instead of trusting an echo it cannot rule out.
    return view.replyAfterInput === undefined
      ? request.requireTurn !== true
      : view.replyAfterInput;
  }

  private clearRetry(terminalId: string, attemptId: string | undefined): void {
    const key = attemptKey(terminalId, attemptId);
    const retry = this.retries.get(key);
    if (retry) clearTimeout(retry.timer);
    this.retries.delete(key);
  }

  private retry(
    lifecycle: SettlementLifecycle,
    retry: SettlementRetry
  ): boolean {
    const delay = SETTLEMENT_RETRY_DELAYS_MS[retry.count];
    if (delay === undefined) return false;
    const request = retry.request();
    const current = this.state.byTerminal(request.record.terminalId);
    if (
      !lifecycle.isCurrent() ||
      !current ||
      activityTask(current.activity) !==
        (request.task ?? activityTask(request.record.activity)) ||
      activityAttemptId(current.activity) !== retry.attemptId
    ) {
      return false;
    }
    const key = attemptKey(request.record.terminalId, retry.attemptId);
    if (this.retries.has(key)) return true;
    const timer = setTimeout(() => {
      this.retries.delete(key);
      if (!lifecycle.isCurrent()) return;
      void this.report(lifecycle, retry.request(), {
        ...retry,
        count: retry.count + 1,
      });
    }, delay);
    this.retries.set(key, { terminalId: request.record.terminalId, timer });
    timer.unref();
    return true;
  }

  private failReconciliation(
    lifecycle: SettlementLifecycle,
    record: MonitoredAgent,
    reason: string
  ): void {
    const attemptId = activityAttemptId(record.activity);
    this.clearRetry(record.terminalId, attemptId);
    const message = `${record.name ?? record.paneId} settled, but ${
      reason
    } after ${SETTLEMENT_RETRY_WINDOW_SECONDS} seconds`;
    if (attemptId)
      this.delivery.releaseAttempt(
        attemptId,
        new SettlementTimeoutError(0, "stall", message)
      );
    if (
      this.failedAttempts.has(record.terminalId) &&
      this.failedAttempts.get(record.terminalId) === attemptId
    )
      return;
    this.failedAttempts.set(record.terminalId, attemptId);
    lifecycle.context.ui.notify(message, "warning");
  }
}
