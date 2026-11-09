/**
 * The engine: wire Pi's lifecycle to the brakes, the detectors and delivery.
 *
 * Everything host-specific is injected, so the whole pipeline runs in a test
 * with a stub host and no Pi process, no model call and no session file.
 *
 * `agent_settled` is the decision point, not `agent_end`. Pi fires `agent_end`
 * before its own retry, compaction and continuation handling, so a recovery
 * wired there burns the retry budget. `agent_end` only latches evidence and the
 * abort flag; `agent_settled` reads the latched value, by which point Pi has
 * confirmed nothing else will run.
 */

import type { BrakeState, RecoveryRecord } from "./brakes";
import { evaluateBrakes, StreakLedger, sanitizeError } from "./brakes";
import type { ContinueConfig } from "./config";
import type { Detector, FailureKind, Judge } from "./detectors";
import { defaultDetectors, runDetectors } from "./detectors";
import {
  type MessageLike,
  type RunEvidence,
  readEvidence,
  UNKNOWN_EVIDENCE,
} from "./evidence";
import type { SessionGateway } from "./gateway";
import { composeNudge } from "./nudge";

type NotifyLevel = "info" | "warning" | "error";

/** The host surface this engine uses. */
export interface EngineHost {
  on(event: string, handler: (payload: unknown) => void): void;
  sendUserMessage(
    text: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ): void | Promise<void>;
}

/** The slice of Pi's per-event context the engine reads. */
export interface EngineContext {
  hasUI: boolean;
  signal?: AbortSignal;
}

export interface EngineDeps {
  host: EngineHost;
  gateway: SessionGateway;
  config: () => ContinueConfig;
  permissionPending: () => boolean;
  /** Whether another agent waits behind this one and must not be talked over. */
  childPending: () => boolean;
  messages: () => readonly MessageLike[];
  operatorMessage: () => string | undefined;
  judge?: Judge;
  now?: () => number;
  log?: (message: string) => void;
  notify?: (text: string, level: NotifyLevel) => void;
  setStatus?: (text: string | undefined) => void;
}

/** What the last decision concluded, for `/continue status`. */
export interface LastDecision {
  at: number;
  verdict: string;
  reason: string;
}

const STATUS_KEY = "pi-continue";

export class ContinueEngine {
  readonly #ledger = new StreakLedger();
  #aborted = false;
  #operatorBusy = false;
  #evidence: RunEvidence = UNKNOWN_EVIDENCE;
  #firstMessageCount = 0;
  #lastDecision: LastDecision | undefined;
  #running = false;

  constructor(private readonly deps: EngineDeps) {}

  get lastDecision(): LastDecision | undefined {
    return this.#lastDecision;
  }

  get streak(): number {
    return this.#ledger.streak;
  }

  /** The operator spoke: clear every brake that is cleared by speaking. */
  noteOperatorSpoke(): void {
    this.#aborted = false;
    this.#operatorBusy = false;
    this.#ledger.reset();
    this.#renderStatus();
  }

  /** Esc: stand down until the operator speaks again. */
  noteAbort(): void {
    this.#aborted = true;
    this.#renderStatus();
  }

  /**
   * A session started or switched: run identities, the streak and the abort flag
   * all belong to the previous branch and must not leak into the new one.
   */
  noteSessionStart(): void {
    this.#ledger.reset();
    this.#operatorBusy = false;
    this.#aborted = false;
    this.#evidence = UNKNOWN_EVIDENCE;
    this.#firstMessageCount = this.deps.messages().length;
    this.#renderStatus();
  }

  /** A turn started: this run is no longer the previous one's. */
  noteRunStart(): void {
    this.#operatorBusy = false;
    this.#aborted = false;
    this.#firstMessageCount = this.deps.messages().length;
  }

  /** Read the settled run once and hold it for the decision. */
  captureRun(): void {
    this.#evidence = readEvidence(this.deps.messages());
  }

  /**
   * Decide, and recover when every brake is clear. Idempotent per run identity:
   * the same run cannot be recovered twice, so a re-entrant settle is harmless.
   */
  async onSettled(ctx: EngineContext): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.#decide(ctx);
    } finally {
      this.#running = false;
      this.#renderStatus();
    }
  }

  async #decide(ctx: EngineContext): Promise<void> {
    const config = this.deps.config();
    const evidence = this.#evidence;
    const identity = this.#identity();

    if (evidence === UNKNOWN_EVIDENCE || evidence.stopReason === undefined) {
      this.#settle("unknown", "no settled run");
      return;
    }

    const detection = await this.#detect(evidence, config);
    if (detection.verdict !== "stalled") {
      if (detection.verdict === "ok") this.#ledger.resetStreak();
      this.#settle(detection.verdict, detection.reason);
      return;
    }

    const refusal = evaluateBrakes(this.#brakeState(config, identity, ctx));
    if (refusal) {
      this.#settle(`refused:${refusal}`, detection.reason);
      if (refusal === "streak-exhausted" || refusal === "forks-exhausted") {
        this.#notify(
          `pi-continue gave up after ${refusal === "forks-exhausted" ? "repeated recoveries of this run" : `${config.maxConsecutive} recoveries`}`,
          "warning",
        );
      }
      return;
    }

    this.#recover(detection.kind ?? "empty", detection.reason);
  }

  async #detect(evidence: RunEvidence, config: ContinueConfig) {
    const detectors: Detector[] = defaultDetectors({
      enabled: ["empty", "truncated", "errored", "abandoned"],
      alreadyRetriedPatterns: config.alreadyRetriedPatterns,
      judgeMode: config.judgeMode,
      judge: this.deps.judge,
    });
    return runDetectors(evidence, detectors);
  }

  #brakeState(
    config: ContinueConfig,
    identity: string,
    _ctx: EngineContext,
  ): BrakeState {
    const now = this.#now();
    return {
      enabled: config.enabled,
      gatedIn: this.deps.gateway.isGatedIn(config),
      aborted: this.#aborted && config.suppressAfterAbort,
      operatorBusy: this.#operatorBusy,
      permissionPending: this.deps.permissionPending(),
      streak: this.#ledger.streak,
      maxConsecutive: config.maxConsecutive,
      msSinceLastRecovery: this.#ledger.msSinceLast(now),
      minIntervalMs: config.minIntervalMs,
      queueDirty: this.deps.childPending(),
      alreadyRecoveredForRun: this.#ledger.hasRecovered(identity),
      forkCount: this.#ledger.forkCount(identity),
      maxForks: config.maxForks,
    };
  }

  #recover(kind: FailureKind, reason: string): void {
    const text = composeNudge({
      kind,
      text: this.#evidence.text,
      operatorMessage: this.deps.operatorMessage(),
    });
    const now = this.#now();
    const record: RecoveryRecord = {
      kind,
      reason,
      text,
      at: now,
      error: sanitizeError(this.#evidence.errorMessage),
    };
    this.#ledger.record(this.#identity(), record);
    this.#lastDecision = { at: now, verdict: "recovered", reason };
    this.#log(`recover (${kind}): ${reason}`);
    this.#notify(`pi-continue recovering (${kind}): ${reason}`, "info");
    try {
      // Inside the settled emit Pi defers this into `_deferredSettledActions`,
      // so it cannot race a concurrent prompt; as a follow-up it cannot steer
      // the turn that just ended.
      void this.deps.host.sendUserMessage(text, { deliverAs: "followUp" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#notify(`pi-continue could not send: ${message}`, "error");
    }
  }

  /** Identity of the settled run: its start offset plus the settled call count. */
  #identity(): string {
    return `${this.#firstMessageCount}:${this.deps.messages().length}`;
  }

  #settle(verdict: string, reason: string): void {
    this.#lastDecision = { at: this.#now(), verdict, reason };
    this.#log(`settled -> ${verdict}: ${reason}`);
  }

  #renderStatus(): void {
    const setStatus = this.deps.setStatus;
    if (!setStatus) return;
    const streak = this.#ledger.streak;
    setStatus(streak > 0 ? `↻ ${streak}` : undefined);
  }

  #notify(text: string, level: NotifyLevel): void {
    if (!this.deps.config().notify) return;
    this.deps.notify?.(text, level);
  }

  #log(message: string): void {
    if (this.deps.config().debug) this.deps.log?.(message);
  }

  #now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}

export { STATUS_KEY };
