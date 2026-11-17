import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";

import { createSkillsTool, prepareSkillsCodeModeInput } from "./src/tool.js";

export { createSkillsTool, prepareSkillsCodeModeInput } from "./src/tool.js";

const REGISTRATION_KEY = Symbol.for(
  "@howaboua/pi-better-skills-tool.registered"
);
const CODE_MODE_PACKAGE = "@howaboua/pi-codex-conversion";
const CODE_MODE_MODULE = `${CODE_MODE_PACKAGE}/code-mode`;

/**
 * Names plus trigger lines, no locations: enough to match a task without the full catalog.
 * Fenced so it stays adjacent to the other prompt sections instead of reading as user text.
 */
function skillIndex(skills: readonly Skill[]): string | undefined {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return undefined;
  const lines = visible.map((skill) => `- ${skill.name}: ${skill.description}`);
  return [
    "<skill_index>",
    "Read a matching skill with the `skills` tool before starting that work.",
    ...lines,
    "</skill_index>",
  ].join("\n");
}

export default async function skillsExtension(pi: ExtensionAPI): Promise<void> {
  const sharedState = pi.events as typeof pi.events & {
    [REGISTRATION_KEY]?: object;
  };
  if (sharedState[REGISTRATION_KEY]) return;
  const owner = {};
  sharedState[REGISTRATION_KEY] = owner;

  let loadedSkills: readonly Skill[] = [];
  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    loadedSkills = [...options.skills];
    // Native /skill: expansion uses Pi's loader, not these prompt fields.
    // Names alone keep the catalog compact while still giving the model a trigger to match.
    const index = skillIndex(loadedSkills);
    options.skills = [];
    delete options.sections["skills"];
    delete options.sections["skill_catalog"];
    if (index) options.sections["skills"] = index;
    if (options.forceSystemPrompt !== undefined) {
      // Full-prompt overrides bypass sections. Preserve text outside catalog containers,
      // and drop any index a chained handler already injected so it is not duplicated.
      options.forceSystemPrompt = options.forceSystemPrompt
        .replaceAll(/<(skills|skill_catalog)>[\s\S]*?<\/\1>/g, "")
        .replaceAll(/\n*<skill_index>[\s\S]*?<\/skill_index>/g, "");
      if (index) options.forceSystemPrompt += `\n\n${index}`;
    }
  });
  let gpt = false;
  const tool = createSkillsTool({
    getLoadedSkills: () => loadedSkills,
    isGpt: () => gpt,
  });
  const ordinaryGuidelines = tool.promptGuidelines;
  pi.registerTool(tool);
  try {
    const { registerGptPromptMode } =
      await import("@howaboua/pi-codex-conversion/prompt-mode");
    registerGptPromptMode(pi, (active) => {
      gpt = active;
      if (active)
        tool.promptGuidelines = [
          'skills: read matching skill before work (tools.skills("list") to discover)',
        ];
      else if (ordinaryGuidelines) tool.promptGuidelines = ordinaryGuidelines;
      else delete tool.promptGuidelines;
      return [tool];
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      ![
        "ERR_MODULE_NOT_FOUND",
        "MODULE_NOT_FOUND",
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
      ].includes(String(error.code)) ||
      !error.message.includes(CODE_MODE_PACKAGE)
    )
      throw error;
  }

  const registration = await registerSkillsInCodeMode(pi, tool);
  pi.on("session_shutdown", () => {
    registration?.unregister();
    if (sharedState[REGISTRATION_KEY] === owner)
      delete sharedState[REGISTRATION_KEY];
  });
}

async function registerSkillsInCodeMode(
  pi: ExtensionAPI,
  tool: ReturnType<typeof createSkillsTool>
) {
  try {
    const { adaptToolForCodeMode, registerCodeModeExtensionTools } =
      await import("@howaboua/pi-codex-conversion/code-mode");
    return registerCodeModeExtensionTools(pi, () => [
      adaptToolForCodeMode(tool, {
        kind: "freeform",
        inputOptional: true,
        prepareInput: prepareSkillsCodeModeInput,
        usage: "await tools.skills() // discover skills and calling syntax",
      }),
    ]);
  } catch (error) {
    if (isMissingCodeModeExtension(error)) return;
    if (isOutdatedCodeModeExtension(error)) {
      throw new Error(
        `Update ${CODE_MODE_PACKAGE} to 3.0.24 or newer to use Better Skills with it`,
        { cause: error }
      );
    }
    throw error;
  }
}

function isMissingCodeModeExtension(error: unknown): boolean {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    !("message" in error) ||
    typeof error.message !== "string"
  )
    return false;
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" &&
    error.code !== "MODULE_NOT_FOUND"
  )
    return false;
  const missing = error.message.match(
    /Cannot find (?:package|module) ['"]([^'"]+)['"]/
  )?.[1];
  return missing === CODE_MODE_PACKAGE || missing === CODE_MODE_MODULE;
}

function isOutdatedCodeModeExtension(error: unknown): boolean {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    !("message" in error) ||
    typeof error.message !== "string"
  )
    return false;
  return (
    (error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
      error.code === "ERR_UNSUPPORTED_DIR_IMPORT") &&
    (error.message.includes(CODE_MODE_MODULE) ||
      (error.message.includes("Package subpath './code-mode'") &&
        error.message.includes(CODE_MODE_PACKAGE)))
  );
}
