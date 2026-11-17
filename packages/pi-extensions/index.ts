// Aggregate bundle: every sibling package is imported here and awaited below.
// Keep imports ≡ root `dependencies`/`devDependencies` keys and `pi-agent-comms`
// strictly before `pi-shepherdr`; `bun run parity` (scripts/check-packages-parity.mjs)
// enforces it. Skills-only `pi-skill-agent-harness` is wired via root `pi.skills`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import PiAgentComms from "@lazuee/pi-agent-comms";
import PiAsk from "@lazuee/pi-ask";
import PiAutoTrees from "@lazuee/pi-auto-trees";
import PiBetterSkillsTool from "@lazuee/pi-better-skills-tool";
import PiCacheHitPredictor from "@lazuee/pi-cache-hit-predictor";
import PiGithubWatch from "@lazuee/pi-github-watch";
import PiShepherdr from "@lazuee/pi-shepherdr";
import PiSmartBtw from "@lazuee/pi-smart-btw";
import PiSubagentReview from "@lazuee/pi-subagent-review";
import PiSuggestions from "@lazuee/pi-suggestions";
import PiTokens from "@lazuee/pi-tokens";
import PiUnicodeCharts from "@lazuee/pi-unicode-charts";

export default async function (pi: ExtensionAPI) {
	await PiAgentComms(pi);
	await PiAsk(pi);
	await PiAutoTrees(pi);
	await PiBetterSkillsTool(pi);
	await PiCacheHitPredictor(pi);
	await PiGithubWatch(pi);
	await PiShepherdr(pi);
	await PiSmartBtw(pi);
	await PiSubagentReview(pi);
	await PiSuggestions(pi);
	await PiTokens(pi);
	await PiUnicodeCharts(pi);
}
