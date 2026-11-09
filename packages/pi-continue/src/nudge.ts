/**
 * Compose the message a recovery sends.
 *
 * Four shapes, one per failure class. Each names what the operator was doing so
 * the model resumes the same task instead of restating it, and each ends with
 * the handback rule that keeps the railway running unattended.
 */
import type { FailureKind } from "./detectors";

/** What the recovery can say about the run it is resuming. */
export interface NudgeBasis {
  kind: FailureKind;
  text: string;
  operatorMessage?: string;
}

/** How much of the operator's last message is quoted back. */
const OPERATOR_QUOTE_LIMIT = 400;
/** How much of a trailing-off reply is quoted back. */
const TAIL_QUOTE_LIMIT = 300;

export function composeNudge(basis: NudgeBasis): string {
  switch (basis.kind) {
    case "empty":
      return "continue";
    case "truncated":
      return withOperator(
        "Your last response was cut off at the output-token limit. Continue from exactly where it stopped, in smaller steps so it fits the budget.",
        basis,
      );
    case "errored":
      return withOperator(
        "continue from where the last run failed. If the same failure repeats, report it and stop instead of retrying blindly.",
        basis,
      );
    case "abandoned":
      return withOperator(
        `Your last response stopped mid-sentence${tailQuote(basis.text)}. Continue from that point, and carry on with the remaining work until the task is finished rather than summarising.`,
        basis,
      );
  }
}

function tailQuote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  const tail =
    flat.length > TAIL_QUOTE_LIMIT
      ? `…${flat.slice(-TAIL_QUOTE_LIMIT)}`
      : flat.slice(0, TAIL_QUOTE_LIMIT);
  return ` ("${tail}")`;
}

function withOperator(base: string, basis: NudgeBasis): string {
  const operator = basis.operatorMessage?.replace(/\s+/g, " ").trim();
  if (!operator) return base;
  const quote =
    operator.length > OPERATOR_QUOTE_LIMIT
      ? `${operator.slice(0, OPERATOR_QUOTE_LIMIT)}…`
      : operator;
  return `${base}\n\nThe task is still: ${quote}`;
}
