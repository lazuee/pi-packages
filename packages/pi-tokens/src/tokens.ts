// Session token accounting. Context usage is the live prompt size; billed totals
// aggregate usage captured on assistant messages across the whole session branch.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface SessionTokens {
	context: number | null;
	contextWindow: number | null;
	percent: number | null;
	billed: number;
	assistantMessages: number;
}

export function emptyTokens(): SessionTokens {
	return {
		context: null,
		contextWindow: null,
		percent: null,
		billed: 0,
		assistantMessages: 0,
	};
}

/** Sum billed prompt/completion tokens for every billed assistant message on the branch. */
export function billedTokens(entries: readonly SessionEntry[]): {
	billed: number;
	assistantMessages: number;
} {
	let billed = 0;
	let assistantMessages = 0;

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		if (!usage) continue;
		const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		if (total <= 0) continue;
		assistantMessages += 1;
		billed += total;
	}

	return { billed, assistantMessages };
}

export function formatTokens(tokens: number | null): string {
	if (tokens === null) return "unknown";
	if (tokens < 1_000) return Math.round(tokens).toString();
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}m`;
}

export function describeTokens(tokens: SessionTokens): string {
	const context =
		tokens.context === null
			? "unknown"
			: `${formatTokens(tokens.context)} of ${formatTokens(tokens.contextWindow)} (${Math.round(tokens.percent ?? 0)}%)`;
	const lines = [
		`Context: ${context}`,
		`Billed this session: ${formatTokens(tokens.billed)} tokens across ${tokens.assistantMessages} assistant message(s)`,
	];
	if (tokens.context === null)
		lines.push("Context size is unknown until the next assistant response.");
	return lines.join("\n");
}
