/**
 * The two states that keep pi-continue from fighting the operator or spinning.
 *
 * {@link Brakes} answers "may a recovery run right now?" and nothing else, so a
 * new reason to hesitate is one more field rather than one more branch threaded
 * through the engine.
 */

/** Why a recovery was refused. */
export type Refusal =
  | "disabled"
  | "not-gated-in"
  | "after-abort"
  | "operator-busy"
  | "permission-pending"
  | "streak-exhausted"
  | "too-soon"
  | "queue-dirty"
  | "already-recovered"
  | "forks-exhausted";

/** The input a {@link Brakes} answer is computed from. */
export interface BrakeState {
  enabled: boolean;
  gatedIn: boolean;
  aborted: boolean;
  operatorBusy: boolean;
  permissionPending: boolean;
  streak: number;
  maxConsecutive: number;
  msSinceLastRecovery: number;
  minIntervalMs: number;
  queueDirty: boolean;
  alreadyRecoveredForRun: boolean;
  forkCount: number;
  maxForks: number;
}

/** The first credential that refuses a recovery, or `undefined`. */
export function evaluateBrakes(state: BrakeState): Refusal | undefined {
  if (!state.enabled) return "disabled";
  if (!state.gatedIn) return "not-gated-in";
  if (state.aborted) return "after-abort";
  if (state.operatorBusy) return "operator-busy";
  if (state.permissionPending) return "permission-pending";
  // The fork budget precedes the per-run dedupe: a run that stalls again at an
  // unchanged message count is refused as "already recovered" only while it
  // still has budget, so the ceiling is reachable for a real crash loop.
  if (state.forkCount >= state.maxForks) return "forks-exhausted";
  if (state.alreadyRecoveredForRun) return "already-recovered";
  if (state.streak >= state.maxConsecutive) return "streak-exhausted";
  if (state.msSinceLastRecovery < state.minIntervalMs) return "too-soon";
  if (state.queueDirty) return "queue-dirty";
  return undefined;
}

/** One recorded recovery, for the operator-visible ledger. */
export interface RecoveryRecord {
  kind: string;
  reason: string;
  text: string;
  at: number;
  /** Sanitized: the record lives in the session file. */
  error: string;
}

const LEDGER_LIMIT = 25;
const ERROR_LIMIT = 200;

/** Sanitize a provider error for persistence. */
export function sanitizeError(error: string | undefined): string {
  if (!error) return "";
  const flat = error.replace(/\s+/g, " ").trim();
  return flat.length > ERROR_LIMIT ? `${flat.slice(0, ERROR_LIMIT)}…` : flat;
}

/**
 * Rolling session state: the consecutive-recovery streak, the dedupe of runs
 * already recovered, and a bounded human-readable ledger.
 */
export class StreakLedger {
  #streak = 0;
  #lastAt = 0;
  #recovered = new Map<string, number>();
  #records: RecoveryRecord[] = [];

  get streak(): number {
    return this.#streak;
  }

  get lastAt(): number {
    return this.#lastAt;
  }

  get records(): readonly RecoveryRecord[] {
    return this.#records;
  }

  msSinceLast(now: number): number {
    return this.#lastAt === 0 ? Number.POSITIVE_INFINITY : now - this.#lastAt;
  }

  /** Whether this run identity was already nudged. */
  hasRecovered(identity: string): boolean {
    return this.#recovered.has(identity);
  }

  /** How many recoveries this run identity has spent. */
  forkCount(identity: string): number {
    return this.#recovered.get(identity) ?? 0;
  }

  /** Record one recovery against a run identity. */
  record(identity: string, record: RecoveryRecord): void {
    this.#streak += 1;
    this.#lastAt = record.at;
    this.#recovered.set(identity, this.forkCount(identity) + 1);
    this.#records = [...this.#records, record].slice(-LEDGER_LIMIT);
  }

  /**
   * A healthy settle ends the streak. The per-run counts stay, because a run
   * that keeps stalling across several settles must not reset its own ceiling.
   */
  resetStreak(): void {
    this.#streak = 0;
  }

  /** The operator spoke: forget the streak, the timer and every run identity. */
  reset(): void {
    this.#streak = 0;
    this.#lastAt = 0;
    this.#recovered.clear();
  }
}
