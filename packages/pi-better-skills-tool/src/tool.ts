import { defineTool } from "@earendil-works/pi-coding-agent";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import {
  defaultSessionSkillsDir,
  defaultSkillsDir,
  runSkills,
} from "./catalog.js";
import type { LoadedSkill } from "./catalog.js";

const SkillsParameters = obj({
  command: opt(str({ description: "help, list or read" })),
});
const checkParameters = compile(SkillsParameters).check;
type SkillsParameters = Static<typeof SkillsParameters>;

export interface SkillsToolOptions {
  isGpt?(): boolean;
  globalRoot?: string;
  getLoadedSkills?(): readonly LoadedSkill[];
}

export function prepareSkillsCodeModeInput(input: unknown): SkillsParameters {
  if (
    input === undefined ||
    (input !== null &&
      typeof input === "object" &&
      Object.getPrototypeOf(input) === Object.prototype &&
      Reflect.ownKeys(input).length === 0)
  )
    return {};
  if (typeof input !== "string")
    throw new TypeError(
      'Expected a string command or no arguments: tools.skills() for discovery, tools.skills("read <skill>") to read'
    );
  return { command: input };
}

/** The prompt only carries a names index, so the guideline states the trigger rather than a cron-style reminder. */
function guideline() {
  return "skills: Before work, run `skills` and read any skill matching the task; re-check before changing direction";
}

export function createSkillsTool(options: SkillsToolOptions = {}) {
  return defineTool({
    name: "skills",
    label: "Skills",
    description: "Load skill instructions and references",
    promptGuidelines: [guideline()],
    parameters: SkillsParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!checkParameters(params))
        throw new Error(
          "Invalid arguments; call skills with no arguments for help"
        );
      const { output, skillReads } = runSkills(
        params.command ?? "",
        options.globalRoot ?? defaultSkillsDir(),
        defaultSessionSkillsDir(ctx.cwd),
        options.getLoadedSkills?.() ?? [],
        options.isGpt?.() ?? false
      );
      return {
        content: [{ type: "text", text: output }],
        details: { skillReads },
      };
    },
  });
}
