/**
 * Structural reading of a settled run.
 *
 * Everything here is a pure function over the messages Pi handed to `agent_end`.
 * No host types are imported: the shapes are declared narrowly so a test can
 * build one inline, and so a Pi field rename shows up as one compile error here
 * instead of a silent behavior change at a call site.
 */

/** An assistant content block, as far as this package reads one. */
export interface MessageBlock {
  type: string;
  text?: string;
}

/** The structural subset of an agent message this package inspects. */
export interface MessageLike {
  role?: string;
  content?: string | MessageBlock[];
  stopReason?: string;
  errorMessage?: string;
}

/** What the last assistant message of a settled run says about how it ended. */
export interface RunEvidence {
  stopReason: string | undefined;
  errorMessage: string | undefined;
  /** Concatenated visible text, trimmed. */
  text: string;
  hasToolCall: boolean;
  hasThinking: boolean;
}

export const UNKNOWN_EVIDENCE: RunEvidence = {
  stopReason: undefined,
  errorMessage: undefined,
  text: "",
  hasToolCall: false,
  hasThinking: false,
};

const TOOL_CALL_BLOCK = "toolCall";
const THINKING_BLOCK = "thinking";
const TEXT_BLOCK = "text";

/** Read the trailing assistant message, or {@link UNKNOWN_EVIDENCE} if absent. */
export function readEvidence(messages: readonly MessageLike[]): RunEvidence {
  const last = findLastAssistant(messages);
  if (!last) return UNKNOWN_EVIDENCE;
  const blocks = normalizeBlocks(last.content);
  return {
    stopReason: last.stopReason,
    errorMessage: last.errorMessage,
    text: blocks
      .filter((block) => block.type === TEXT_BLOCK)
      .map((block) => block.text ?? "")
      .join("\n")
      .trim(),
    hasToolCall: blocks.some((block) => block.type === TOOL_CALL_BLOCK),
    hasThinking: blocks.some((block) => block.type === THINKING_BLOCK),
  };
}

function findLastAssistant(
  messages: readonly MessageLike[],
): MessageLike | undefined {
  return messages.findLast((message) => message.role === "assistant");
}

function normalizeBlocks(
  content: string | MessageBlock[] | undefined,
): MessageBlock[] {
  if (typeof content === "string") return [{ type: TEXT_BLOCK, text: content }];
  return content ?? [];
}

/**
 * Whether a run left nothing a human could read or answer: no visible text and
 * no tool call. Thinking alone counts as nothing, because it never reaches the
 * transcript the operator sees.
 */
export function isSilent(evidence: RunEvidence): boolean {
  return evidence.text.length === 0 && !evidence.hasToolCall;
}

/**
 * Whether the text stops mid-sentence — a trailing comma, an open fence, or a
 * dangling connector — which is the one shape of prose that reliably means the
 * model was cut off rather than finished.
 */
export function trailsOff(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return false;
  if ((trimmed.match(/```/g)?.length ?? 0) % 2 === 1) return true;
  if (/[,;:]$/.test(trimmed)) return true;
  if (/(^|\n)\s*[-*+]\s*$/.test(trimmed)) return true;
  return /\b(and|or|then|with|the|a|to|of|in|for|but|so|next|following)$/i.test(
    trimmed,
  );
}
