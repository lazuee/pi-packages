/**
 * The deterministic half of the decision.
 *
 * Each rule inspects the settled run and answers `stalled` (with the failure
 * class and the nudge to send), `ok` (a healthy stop, stop looking), or
 * `unknown` (this rule cannot tell; pass to the next one).
 *
 * In `judgeMode: "model"` a rule may ask the {@link Judge} before stalling, so
 * the ambiguous shapes are still decided here and the judge stays an injected
 * collaborator rather than a second decision tree.
 */
import { isSilent, type RunEvidence, trailsOff } from "./evidence";

/** Why a run was judged stalled. Drives which message is sent. */
export type FailureKind = "empty" | "truncated" | "errored" | "abandoned";

export interface Detection {
  verdict: "stalled" | "ok" | "unknown";
  kind?: FailureKind;
  reason: string;
}

const STALLED = (kind: FailureKind, reason: string): Detection => ({
  verdict: "stalled",
  kind,
  reason,
});
const OK = (reason: string): Detection => ({ verdict: "ok", reason });
const UNKNOWN = (reason: string): Detection => ({ verdict: "unknown", reason });

/** One deterministic rule. */
export interface Detector {
  name: string;
  detect(evidence: RunEvidence): Promise<Detection> | Detection;
}

/** Ask a model whether the run finished, or is waiting for a human. */
export type Judge = (evidence: RunEvidence) => Promise<JudgeVerdict>;

export type JudgeVerdict = "stalled" | "finished" | "unavailable";

/** The parts of the message rows a detector needs. */
export interface DetectorContext {
  enabled: FailureKind[];
  alreadyRetriedPatterns: string[];
  judgeMode: "off" | "model" | "always";
  judge?: Judge;
}

const ERROR = "error";
const LENGTH = "length";
const STOP = "stop";
const TOOL_USE = "toolUse";
const PENDING = "pending";
const ABORTED = "aborted";

/**
 * A `toolUse` (or `pending`) stop means Pi ran a tool and the loop already
 * continued. `aborted` is the operator pressing Esc, which has its own brake.
 * Neither is worth a nudge or a judge call.
 */
export function terminalGuard(evidence: RunEvidence): Detection {
  const stopReason = evidence.stopReason ?? "";
  if (
    stopReason === TOOL_USE ||
    stopReason === PENDING ||
    stopReason === ABORTED
  ) {
    return OK(`stopReason=${stopReason}`);
  }
  return UNKNOWN(`stopReason=${stopReason || "unset"}`);
}

/**
 * A run cut off at the output-token limit. Pi does not continue these, so the
 * only way out is a nudge; the nudge asks for shorter steps.
 */
export function truncatedDetector(evidence: RunEvidence): Detection {
  if (evidence.stopReason !== LENGTH) return UNKNOWN("not truncated");
  return STALLED("truncated", "stopReason=length");
}

/**
 * A run that ended without a word and without a tool call. There is nothing for
 * a human to read, so no judge is spent — the ambiguity does not exist.
 */
export function silentDetector(evidence: RunEvidence): Detection {
  if (!isSilent(evidence)) return UNKNOWN("produced output");
  return STALLED(
    "empty",
    evidence.hasThinking ? "thinking-only response" : "empty response",
  );
}

/**
 * A provider error. The interesting split is whether Pi already retried it:
 * a transient status arrives here only once Pi's own retry budget is spent, so
 * recovering again just burns tokens on the same failure. A quota, billing or
 * unmatched 4xx error fails fast on purpose and is worth one more attempt.
 */
export function errorDetector(
  error: string | undefined,
  alreadyRetriedPatterns: string[],
): Detection {
  if (!error) return UNKNOWN("no error message");
  const matched = alreadyRetriedPatterns.find((pattern) =>
    error.toLowerCase().includes(pattern.toLowerCase()),
  );
  if (matched) return UNKNOWN(`already retried by pi (${matched})`);
  return STALLED("errored", `unretried error: ${error}`);
}

/**
 * A `stop` carrying prose. This is the genuinely ambiguous row and the only one
 * the judge is spent on. Without a judge, only text that visibly stops
 * mid-sentence clears the bar.
 */
export async function abandonedDetector(
  evidence: RunEvidence,
  context: DetectorContext,
): Promise<Detection> {
  if (evidence.stopReason !== STOP) {
    return UNKNOWN(`stopReason=${evidence.stopReason ?? "unset"}`);
  }
  if (evidence.text.length === 0) return UNKNOWN("no prose");
  if (context.judgeMode === "model" && context.judge) {
    const verdict = await context.judge(evidence);
    if (verdict === "stalled") return STALLED("abandoned", "judge: unfinished");
    if (verdict === "finished") return OK("judge: finished");
    // Unavailable: fall through to the deterministic read below.
  }
  // With a judge in play an ambiguous end is still worth one nudge; without
  // one, a nudge on every clean sentence would be pure noise.
  const judged = context.judgeMode === "model" && context.judge;
  if (trailsOff(evidence.text)) {
    return STALLED("abandoned", "text trails off mid-sentence");
  }
  if (judged) return STALLED("abandoned", "judge unavailable, prose ambiguous");
  return OK("prose ends cleanly");
}

/**
 * The built-in chain, in order. `judgeMode: "always"` prepends an
 * {@link alwaysJudgeDetector} so the model sees every non-tool row first; the
 * rows below still act as the fallback when the judge is unavailable.
 */
export function defaultDetectors(context: DetectorContext): Detector[] {
  const chain: Detector[] = [
    { name: "terminal-guard", detect: terminalGuard },
    {
      name: "truncated",
      detect: (evidence) =>
        context.enabled.includes("truncated")
          ? truncatedDetector(evidence)
          : UNKNOWN("truncated disabled"),
    },
    { name: "silent", detect: (evidence) => silentDetector(evidence) },
    {
      name: "errored",
      detect: (evidence) =>
        context.enabled.includes("errored")
          ? errorDetector(evidence.errorMessage, context.alreadyRetriedPatterns)
          : UNKNOWN("errored disabled"),
    },
    {
      name: "abandoned",
      detect: (evidence) =>
        context.enabled.includes("abandoned")
          ? abandonedDetector(evidence, context)
          : UNKNOWN("abandoned disabled"),
    },
  ];
  if (context.judgeMode !== "always" || !context.judge) return chain;
  return [
    { name: "judge-first", detect: (e) => judgeFirst(e, context) },
    ...chain,
  ];
}

async function judgeFirst(
  evidence: RunEvidence,
  context: DetectorContext,
): Promise<Detection> {
  const stopReason = evidence.stopReason ?? "";
  if (stopReason === TOOL_USE || stopReason === PENDING) {
    return UNKNOWN("toolUse");
  }
  if (!context.judge) return UNKNOWN("no judge");
  const verdict = await context.judge(evidence);
  if (verdict === "stalled") {
    return STALLED(kindFor(evidence), "judge: unfinished");
  }
  if (verdict === "finished") return OK("judge: finished");
  return UNKNOWN("judge unavailable");
}

/** Which nudge fits a judged-stalled run, without re-asking the model. */
function kindFor(evidence: RunEvidence): FailureKind {
  if (evidence.stopReason === LENGTH) return "truncated";
  if (evidence.stopReason === ERROR) return "errored";
  if (isSilent(evidence)) return "empty";
  return "abandoned";
}

/** Run the chain and return the first verdict that is not `unknown`. */
export async function runDetectors(
  evidence: RunEvidence,
  detectors: Detector[],
): Promise<Detection> {
  for (const detector of detectors) {
    const detection = await detector.detect(evidence);
    if (detection.verdict !== "unknown") return detection;
  }
  return UNKNOWN("no rule matched");
}
