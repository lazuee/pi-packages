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
	await PiUnicodeCharts(pi);
}
