import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadAgentProfiles } from "./profiles.js";
import { PROFILE_FLAG } from "./worker-role.js";

/** Tools that only ever write. A read-only worker never needs them. */
const WRITES = new Set(["edit", "write", "multi_edit", "apply_patch", "patch"]);

/** Shell verbs that change the tree. Matched against command segments. */
const MUTATORS =
	/(^|[\s;&|(])(rm|mv|cp|mkdir|rmdir|touch|ln|tee|sed\s+-i|perl\s+-i|patch|truncate|chmod|chown|install)\b/;

/** `git` subcommands that write. Anything else under git is a read. */
const GIT_WRITES =
	/^git\s+(commit|add|checkout|switch|reset|restore|revert|merge|rebase|cherry-pick|stash|tag|clone|init|apply|clean|mv|rm|pull|push)\b/;

/** Package managers and build tools write into the tree or the lockfile. */
const INSTALLERS =
	/^(npm|pnpm|yarn|bun)\s+(install|add|remove|update|ci|link)\b|^(npx|bunx|tsc|prettier)\b.*\s--write\b/;

/** Split on shell separators, keeping quoted strings intact enough to classify. */
function segments(command: string): string[] {
	return command
		.split(/&&|\|\||;|\n|\|/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function mutatingSegment(command: string): string | undefined {
	return segments(command).find(
		(segment) =>
			GIT_WRITES.test(segment) ||
			INSTALLERS.test(segment) ||
			MUTATORS.test(segment.replace(/^["']|["']$/g, "")),
	);
}

function reasonForName(name: string): string | undefined {
	if (WRITES.has(name)) return `\`${name}\` writes files`;
	return undefined;
}

/** Advisory profiles can be ignored; this stops the wrong one shipping. */
export function registerReadOnlyGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		const name = pi.getFlag(PROFILE_FLAG);
		if (typeof name !== "string" || !name.trim()) return;
		// Re-read each call, so a profile edited mid-run takes effect immediately.
		const profile = (await loadAgentProfiles()).get(name.trim());
		if (profile?.writes !== false) return;

		const byName = reasonForName(event.toolName);
		if (byName) return blocked(byName);
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;
		const command = typeof event.input["command"] === "string" ? event.input["command"] : "";
		const mutator = mutatingSegment(command);
		if (mutator) return blocked(`\`${mutator.trim()}\` changes the tree`);
		void ctx;
	});
}

function blocked(reason: string) {
	return {
		block: true,
		reason: `Read-only profile: ${reason}. Report it instead of changing it.`,
	};
}
