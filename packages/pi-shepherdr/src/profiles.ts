import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PROFILE_FLAG, WRITES_FLAG } from "./worker-role.js";

const PROFILE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const AGENT_DIRECTORY =
  process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
const PROFILES_ROOT = join(AGENT_DIRECTORY, "shepherdr");
const PROFILES_DIRECTORY = join(PROFILES_ROOT, "profiles");
const PROFILE_INSTALL_MARKER = join(PROFILES_ROOT, ".profiles-initialized");
const BUNDLED_PROFILES_DIRECTORY =
  process.env["PI_SHEPHERDR_PROFILES"] ??
  fileURLToPath(new URL("../profiles", import.meta.url));
/** Bundled digests from the last install, so shipped profile edits can be rolled forward. */
const PROFILE_MANIFEST = join(PROFILES_ROOT, "profiles-installed.json");

export interface AgentProfile {
  accepts: string[];
  blocking?: boolean;
  description: string;
  model: string;
  name: string;
  piArgs: string[];
  prepare?: string;
  prompt?: string;
  shareContext?: boolean;
  /** `false` makes the profile read-only; the tool guard enforces it. */
  writes?: boolean;
  /** Extra tool names that write, for MCP tools the guard cannot know. */
  writeTools: string[];
  thinking: string;
}

interface ProfilePreparationInput {
  base?: string;
  cwd: string;
  message: string;
}

type ProfilePreparationContext = ProfilePreparationInput & { local: boolean };

interface ProfileFile {
  accepts?: unknown;
  blocking?: unknown;
  description?: unknown;
  model?: unknown;
  pi_args?: unknown;
  prepare?: unknown;
  prompt?: unknown;
  share_context?: unknown;
  thinking?: unknown;
  writes?: unknown;
  write_tools?: unknown;
}

function stringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw new TypeError(`${field} must be a boolean`);
  return value;
}

function readProfileFile(name: string, directory: string): ProfileFile {
  const path = join(directory, "profile.json");
  let parsed: ProfileFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as ProfileFile;
  } catch (error) {
    throw new Error(
      `invalid ${name} profile: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} profile must be an object`);
  }
  const allowed = new Set([
    "accepts",
    "blocking",
    "description",
    "model",
    "pi_args",
    "prepare",
    "prompt",
    "share_context",
    "writes",
    "write_tools",
    "thinking",
  ]);
  if (parsed.write_tools !== undefined && parsed.writes !== false) {
    throw new Error(
      `${name}.write_tools has no effect without ${name}.writes: false`
    );
  }
  const unknown = Object.keys(parsed).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`unknown ${name} profile field(s): ${unknown.join(", ")}`);
  }
  return parsed;
}

// Code/Notebook wait classification is synchronous; read live policy, not a cache.
export function loadAgentProfileBlocking(name: string): boolean | undefined {
  if (!PROFILE_NAME.test(name))
    throw new Error(`invalid agent profile: ${name}`);
  const parsed = readProfileFile(name, join(PROFILES_DIRECTORY, name));
  return optionalBoolean(parsed.blocking, `${name}.blocking`);
}

async function readProfile(
  name: string,
  directory: string
): Promise<AgentProfile> {
  const parsed = readProfileFile(name, directory);
  const blocking = optionalBoolean(parsed.blocking, `${name}.blocking`);
  const shareContext = optionalBoolean(
    parsed.share_context,
    `${name}.share_context`
  );
  const writes = optionalBoolean(parsed.writes, `${name}.writes`);
  const description = optionalString(parsed.description, `${name}.description`);
  if (!description) throw new Error(`${name}.description is required`);
  const model = optionalString(parsed.model, `${name}.model`);
  if (!model) throw new Error(`${name}.model is required`);
  const thinking = optionalString(parsed.thinking, `${name}.thinking`);
  if (!thinking) throw new Error(`${name}.thinking is required`);
  const promptPath = optionalString(parsed.prompt, `${name}.prompt`);
  const preparePath = optionalString(parsed.prepare, `${name}.prepare`);
  const resolvedPromptPath = promptPath
    ? resolve(directory, promptPath)
    : undefined;
  const prepare = preparePath ? resolve(directory, preparePath) : undefined;
  if (resolvedPromptPath && !(await stat(resolvedPromptPath)).isFile()) {
    throw new Error(`${name}.prompt is not a file`);
  }
  if (prepare && !(await stat(prepare)).isFile()) {
    throw new Error(`${name}.prepare is not a file`);
  }
  return {
    name,
    description,
    model,
    thinking,
    ...(blocking === undefined ? {} : { blocking }),
    ...(shareContext === undefined ? {} : { shareContext }),
    ...(writes === undefined ? {} : { writes }),
    writeTools: parsed.write_tools
      ? stringArray(parsed.write_tools, `${name}.write_tools`).map((tool) =>
          tool.trim()
        )
      : [],
    accepts: parsed.accepts
      ? stringArray(parsed.accepts, `${name}.accepts`)
      : [],
    piArgs: parsed.pi_args
      ? stringArray(parsed.pi_args, `${name}.pi_args`)
      : [],
    ...(resolvedPromptPath
      ? {
          prompt: await readFile(resolvedPromptPath, "utf-8"),
        }
      : {}),
    ...(prepare ? { prepare } : {}),
  };
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function installProfile(name: string): Promise<void> {
  const target = join(PROFILES_DIRECTORY, name);
  if (await exists(target)) return;
  await copyProfile(join(BUNDLED_PROFILES_DIRECTORY, name), target, name);
}

async function copyProfile(
  bundled: string,
  target: string,
  name: string
): Promise<void> {
  const stagingRoot = await mkdtemp(join(PROFILES_ROOT, `.${name}-`));
  const staging = join(stagingRoot, name);
  try {
    await cp(bundled, staging, {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
    try {
      await rename(staging, target);
    } catch (error) {
      if (hasCode(error, "EXDEV")) {
        // The staging root sits inside the agent directory, so this only
        // happens when a bind mount splits it. Copy straight to the target.
        try {
          await cp(staging, target, {
            errorOnExist: true,
            force: false,
            recursive: true,
          });
        } catch (copyError) {
          if (!hasCode(copyError, "EEXIST", "ENOTEMPTY")) throw copyError;
        }
      } else if (!hasCode(error, "EEXIST", "ENOTEMPTY")) throw error;
    }
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
  }
}

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function profileFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .toSorted();
}

/** Bundled digests per profile file, keyed `profile/file`. */
async function bundledDigests(): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  for (const name of (await readdir(BUNDLED_PROFILES_DIRECTORY)).toSorted()) {
    if (!PROFILE_NAME.test(name)) continue;
    for (const file of await profileFiles(
      join(BUNDLED_PROFILES_DIRECTORY, name)
    )) {
      digests.set(
        `${name}/${file}`,
        digest(await readFile(join(BUNDLED_PROFILES_DIRECTORY, name, file)))
      );
    }
  }
  return digests;
}

async function readManifest(): Promise<Map<string, string>> {
  try {
    const parsed = JSON.parse(
      await readFile(PROFILE_MANIFEST, "utf-8")
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return new Map();
    return new Map(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
  } catch {
    return new Map();
  }
}

async function writeManifest(digests: Map<string, string>): Promise<void> {
  const ordered = Object.fromEntries(
    [...digests].toSorted(([left], [right]) => left.localeCompare(right))
  );
  await writeFile(
    PROFILE_MANIFEST,
    `${JSON.stringify(ordered, null, "\t")}\n`,
    {
      mode: 0o600,
    }
  );
}

/**
 * Copy a shipped profile file over the installed one, but only when the installed
 * copy still matches the bundled version it replaced. A locally edited file wins.
 */
async function upgradeProfileFile(
  key: string,
  previous: string
): Promise<boolean> {
  const target = join(PROFILES_DIRECTORY, key);
  let installed: Buffer;
  try {
    installed = await readFile(target);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    // A file added by a newer bundle arrives as long as its profile directory exists.
    if (!(await exists(join(PROFILES_DIRECTORY, key.split("/")[0]!))))
      return false;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      await readFile(join(BUNDLED_PROFILES_DIRECTORY, key))
    );
    return true;
  }
  if (digest(installed) === previous) {
    await writeFile(
      target,
      await readFile(join(BUNDLED_PROFILES_DIRECTORY, key))
    );
    return true;
  }
  return false;
}

export async function installAgentProfiles(): Promise<void> {
  await mkdir(PROFILES_DIRECTORY, { mode: 0o700, recursive: true });
  const bundled = await bundledDigests();
  if (await exists(PROFILE_INSTALL_MARKER)) {
    const previous = await readManifest();
    for (const [key, hash] of bundled) {
      const wasShipped = previous.get(key);
      if (wasShipped === undefined || wasShipped === hash) continue;
      await upgradeProfileFile(key, wasShipped);
    }
  } else {
    for (const name of (await readdir(BUNDLED_PROFILES_DIRECTORY)).toSorted()) {
      if (!(await stat(join(BUNDLED_PROFILES_DIRECTORY, name))).isDirectory())
        continue;
      if (!PROFILE_NAME.test(name)) {
        throw new Error(`invalid bundled agent profile: ${name}`);
      }
      await installProfile(name);
    }
    try {
      await writeFile(PROFILE_INSTALL_MARKER, "1\n", {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
  await writeManifest(bundled);
}

export async function loadAgentProfiles(): Promise<Map<string, AgentProfile>> {
  const profiles = new Map<string, AgentProfile>();
  let entries;
  try {
    entries = await readdir(PROFILES_DIRECTORY, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return profiles;
    throw error;
  }
  for (const entry of entries.toSorted((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    if (!entry.isDirectory()) continue;
    if (!PROFILE_NAME.test(entry.name)) {
      throw new Error(`invalid agent profile directory: ${entry.name}`);
    }
    profiles.set(
      entry.name,
      await readProfile(entry.name, join(PROFILES_DIRECTORY, entry.name))
    );
  }
  return profiles;
}

export function profileAgentArgs(
  profile: AgentProfile,
  allowWrites = false
): string[] {
  return [
    "--model",
    profile.model,
    "--thinking",
    profile.thinking,
    `--${PROFILE_FLAG}`,
    profile.name,
    // Only a read-only profile needs the opt-out recorded.
    ...(allowWrites && profile.writes === false
      ? [`--${WRITES_FLAG}`, "0"]
      : []),
    ...profile.piArgs,
  ];
}

export async function prepareProfileMessage(
  profile: AgentProfile,
  input: ProfilePreparationInput,
  options: { targetLocal?: boolean } = {}
): Promise<string> {
  if (input.base && !profile.accepts.includes("base")) {
    throw new Error(`base is not supported by ${profile.name}`);
  }
  if (profile.prepare) {
    const metadata = await stat(profile.prepare);
    const module = (await import(
      `${pathToFileURL(profile.prepare).href}?mtime=${metadata.mtimeMs}`
    )) as { prepare?: (value: ProfilePreparationContext) => unknown };
    if (typeof module.prepare !== "function") {
      throw new TypeError(`${profile.name}.prepare must export prepare()`);
    }
    const prepared = await module.prepare({
      ...input,
      local: options.targetLocal !== false,
    });
    if (typeof prepared !== "string" || prepared.trim().length === 0) {
      throw new Error(`${profile.name}.prepare must return a non-empty string`);
    }
    return prepared;
  }
  return input.base
    ? `Review base: ${input.base}\n\n${input.message}`
    : input.message;
}
