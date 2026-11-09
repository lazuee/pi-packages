/**
 * The optional model judge.
 *
 * Only the ambiguous `stop`-with-prose row reaches it, and only when
 * `judgeMode` asks for one. Its whole job is the one question a deterministic
 * rule cannot answer: did this run finish, or is it waiting for a human?
 *
 * A judge that fails must never turn every normal answer into a recovery, so
 * both a thrown call and an unparsable answer return `unavailable` and leave
 * the deterministic fallback to decide.
 */
import type { Judge, JudgeVerdict } from "./detectors";
import type { MessageLike, RunEvidence } from "./evidence";

/** What the host must provide to run a judge call. */
export interface JudgeCompleter {
  /** One attempt. The completer owns its own deadline. */
  complete: (prompt: string) => Promise<string>;
}

const SYSTEM_PROMPT = `You classify how an agent's coding turn ended.
Answer with exactly one word:
FINISHED — the agent completed what was asked, or is legitimately waiting for a human decision.
STALLED — the agent was mid-work and stopped without finishing: it announced a next step and never took it, trailed off, or left an obvious remainder.`;

/** Build the user prompt from the bounded tail. */
export function buildJudgePrompt(
  tail: readonly MessageLike[],
  evidence: RunEvidence,
): string {
  return [
    "Conversation tail:",
    flatten(tail),
    "",
    `The final assistant text: ${evidence.text || "(none)"}`,
    "",
    "One word:",
  ].join("\n");
}

function flatten(tail: readonly MessageLike[]): string {
  return tail
    .map((message) => `${message.role ?? "unknown"}: ${blockText(message)}`)
    .join("\n");
}

function blockText(message: MessageLike): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join(" ");
}

/** Keep the last `count` messages, capped in characters from the end. */
export function tailOf(
  messages: readonly MessageLike[],
  count: number,
  maxChars: number,
): MessageLike[] {
  const kept = messages.slice(-Math.max(1, count));
  let budget = maxChars;
  const out: MessageLike[] = [];
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const message = kept[index];
    const text = blockText(message);
    if (text.length > budget && out.length > 0) break;
    budget -= text.length;
    out.unshift(message);
  }
  return out;
}

/** Parse the judge's answer; anything unrecognized is `unavailable`. */
export function parseVerdict(raw: string): JudgeVerdict {
  const head = raw.trim().toUpperCase();
  if (head.startsWith("FINISHED")) return "finished";
  if (head.startsWith("STALLED")) return "stalled";
  return "unavailable";
}

/** Create a {@link Judge} over a host completer, a tail and a timeout. */
export function createJudge(options: {
  completer: JudgeCompleter | undefined;
  messages: () => readonly MessageLike[];
  tailMessages: number;
  timeoutMs: number;
  maxTailChars: number;
}): Judge | undefined {
  if (!options.completer) return undefined;
  const completer = options.completer;
  return async (evidence) => {
    const tail = tailOf(
      options.messages(),
      options.tailMessages,
      options.maxTailChars,
    );
    const prompt = `${SYSTEM_PROMPT}\n\n${buildJudgePrompt(tail, evidence)}`;
    try {
      return parseVerdict(await completer.complete(prompt));
    } catch {
      return "unavailable";
    }
  };
}

/** Character ceiling on the tail handed to the judge. */
export const JUDGE_MAX_TAIL_CHARS = 6000;
