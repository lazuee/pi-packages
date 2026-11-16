import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	contextBriefingWindow,
	recordContextBriefing,
	registerContextBriefing,
} from "./context-briefing.js";
import { loadAgentProfiles } from "./profiles.js";
import { PROFILE_FLAG } from "./worker-role.js";

const OWNER = "shepherdr-worker-profile";

/** The profile prompt rides in the first task message. Compaction can drop it, and
 * the worker then loses the role with no way back, so re-record it per window. */
export function registerWorkerBriefing(pi: ExtensionAPI): void {
	// Projects the recorded role without Pi Codex, as for any other briefing.
	registerContextBriefing(pi, async (ctx) => {
		const name = pi.getFlag(PROFILE_FLAG);
		if (typeof name !== "string" || !name.trim()) return;
		const profile = (await loadAgentProfiles()).get(name.trim());
		// A profile can be deleted after it launched; the saved role still stands.
		if (!profile?.prompt) return;
		await recordContextBriefing(
			pi,
			ctx,
			OWNER,
			briefingKey(ctx),
			async () => `Your role for this session:\n\n${profile.prompt}`,
		);
	});
}

/** Key on the window so each new window gets exactly one copy, and a reused
 * window keeps its original bytes. */
function briefingKey(ctx: ExtensionContext): string {
	return JSON.stringify([ctx.sessionManager.getSessionId(), contextBriefingWindow(ctx)]);
}
