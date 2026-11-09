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

/** Whether an unclosed code fence is the most recent code structure. */
export function inOpenFence(text: string): boolean {
  return (text.match(/```/g)?.length ?? 0) % 2 === 1;
}

/**
 * Whether the reply ends on a bare mark that only means "more follows": a
 * trailing comma, colon, semicolon, or an item marker with nothing after it.
 *
 * Distinct from {@link trailsOff} because a sentence may hold a trailing colon
 * *and* a full stop — `"… done. `@types/node`:

"` ends on a colon but says
 * `done` first, so the terminal behind it decides.
 */
export function endsOnLeadIn(text: string): boolean {
  const trimmed = lastParagraph(text);
  if (/[,;:]$/.test(trimmed)) return true;
  return /(^|\n)\s*[-*+]\s*$/.test(trimmed);
}

/**
 * Whether the text stops mid-sentence, the *proof* that a reply was cut off: an
 * open fence, a half-written table, a lead-in mark, or a dangling connector.
 *
 * The last paragraph decides, because the earlier paragraphs of a composite
 * reply are finished by definition.
 */
export function trailsOff(text: string): boolean {
  const trimmed = lastParagraph(text);
  if (trimmed.length === 0) return false;
  if (inOpenFence(trimmed)) return true;
  if (tableIsCut(trimmed)) return true;
  if (endsOnLeadIn(trimmed)) return true;
  return /\b(and|or|then|with|the|a|to|of|in|for|but|so|next|following)$/i.test(
    trimmed,
  );
}

/**
 * Whether an unfinished-looking reply was nonetheless closed off: the last
 * paragraph is only partly finished and an earlier sentence already closed it.
 *
 * This is the case a mark-based rule alone gets wrong. `"… done.
 * `@types/node`:\n\n"` ends on a colon, but `done.` is a whole sentence behind
 * it, so the colon is layout rather than a promise. A paragraph that is nothing
 * but a lead-in — `"a bare lead-in:"`, `"See `x`:"` — has no such sentence.
 */
export function isClosedByTerminal(text: string): boolean {
  const trimmed = lastParagraph(text);
  const selfClosed = trimmed.replace(/[,;:\s]+$/, "");
  // A terminal anywhere in the paragraph, behind any trailing mark.
  return selfClosed !== "" && /[.!?]/.test(selfClosed);
}

/**
 * Whether the reply ends on a sentence terminator — `.`, `!` or `?`, optionally
 * behind a closing pair — outside an open fence.
 *
 * The *default* verdict: prose that does not end on one may have been cut off.
 * It is not proof, because a reply can legitimately end on a bare table row, a
 * list item without punctuation, or a trailing blank line.
 */
export function endsOnTerminal(text: string): boolean {
  const trimmed = lastParagraph(text);
  if (trimmed.length === 0) return false;
  if ((trimmed.match(/```/g)?.length ?? 0) % 2 === 1) return false;
  return /[.!?][)`'"\]]?$/.test(trimmed);
}

/**
 * Whether the reply stops dead — no trailing punctuation at all, just the last
 * character of the sentence, or a closing pair behind it.
 *
 * This is the one shape where a missing full stop means nothing: `3`, `v1.2.0`,
 * `` `@types/node` ``, a URL and a line of prose under house style all end this
 * way when they are complete. A reply ending on `.`, `:` or `,` is not `dead`.
 */
export function endsPlainly(text: string): boolean {
  const trimmed = lastParagraph(text);
  return trimmed.length > 0 && !/[.!?:;,]$/.test(trimmed);
}

const TABLE_DELIMITER = /^\s*\|?\s*:?-{2,}/;

/**
 * Whether a table was left half-written. Complete is not the same as whole: a
 * table that finished in the middle — one body row, no blank line after it — was
 * still cut off, so the test is structural rather than a trailing-character one.
 * A delimiter row with no body row, a ragged row, or a row that stops before its
 * closing pipe all say the same thing.
 */
function tableIsCut(text: string): boolean {
  const all = text.split("\n");
  const lines: string[] = [];
  for (let i = all.length - 1; i >= 0 && all[i].trim().startsWith("|"); i--) {
    lines.unshift(all[i]);
  }
  const divider = lines.findIndex((line) => TABLE_DELIMITER.test(line.trim()));
  // No table, or a table that ended a paragraph ago: not this rule's business.
  if (divider === -1) return false;
  const rows = lines.length - divider - 1;
  if (rows === 0) return true;
  const width = cells(lines[divider]);
  for (const row of lines.slice(divider + 1)) {
    if (!row.trim().endsWith("|")) return true;
    if (cells(row) !== width) return true;
  }
  return !lines[lines.length - 1].trim().endsWith("|");
}

/** How many cells a table row declares. */
function cells(row: string): number {
  return row.trim().split("|").length - 2;
}

/** The last paragraph, trimmed: everything before the final blank line dropped. */
function lastParagraph(text: string): string {
  const trimmed = text.trimEnd();
  // `lastIndexOf` is -1 with no blank line, so `-1 + 2` would eat the first
  // character of a single-paragraph reply.
  const split = trimmed.lastIndexOf("\n\n");
  const tail = split === -1 ? trimmed : trimmed.slice(split + 2);
  return tail.trimEnd();
}
