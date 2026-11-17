import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { billedTokens, describeTokens, emptyTokens } from "./src/tokens.js";

const tool = defineTool({
	name: "tokens",
	label: "Tokens",
	description:
		"Report the token count of the current session: live context usage (with the context window and percentage) and total billed tokens so far. Takes no parameters.",
	promptSnippet: "Report the current session's token count",
	parameters: Type.Object({}),
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		const usage = ctx.getContextUsage();
		const { billed, assistantMessages } = billedTokens(ctx.sessionManager.getBranch());
		const tokens = {
			...emptyTokens(),
			context: usage?.tokens ?? null,
			contextWindow: usage?.contextWindow ?? null,
			percent: usage?.percent ?? null,
			billed,
			assistantMessages,
		};
		const text = describeTokens(tokens);
		return {
			content: [{ type: "text" as const, text }],
			details: tokens,
			structuredContent: tokens,
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(tool);
}
