import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";
import { expandHomePath } from "#src/path/expand-home";
import type { Ruleset } from "#src/policy/rule";
import { wildcardMatch } from "#src/policy/wildcard-matcher";
import { stripJsonComments, validateUnifiedConfig } from "./config-loader";

/**
 * `/permission-system allow-file | remove-file | list-files`.
 *
 * Saves an exact-path `allow` for one file in the global config, so the
 * operator can stop the prompts for a file that never holds secrets without
 * opening the config in an editor.
 *
 * Global only: the rule is an absolute path, so it means the same thing in
 * every project, and the shared project `config.json` (often tracked in git)
 * is never written.
 */

export type FileAccess = "read" | "edit" | "both";
type Direction = "read" | "edit";

export type FileApprovalCommand =
  | { kind: "allow"; path: string; access: FileAccess }
  | { kind: "remove"; path: string; access: FileAccess }
  | { kind: "list" }
  | { kind: "usage" };

export const FILE_APPROVAL_USAGE =
  "Usage: /permission-system allow-file <path> read|edit|both · remove-file <path> [read|edit|both] · list-files";

// Both families are written: `path_*` decides inside the working directory,
// `external_directory_*` outside it. A rule for an absolute path is inert on
// the family that does not apply, so writing both keeps it cwd-independent.
const SURFACES: Record<Direction, readonly string[]> = {
  read: ["path_read", "external_directory_read"],
  edit: ["path_write", "external_directory_write"],
};

// Bare keys are sugar for both directions (docs/configuration.md).
const BARE_SURFACES = ["path", "external_directory"];

const ACCESS_VALUES = new Set<string>(["read", "edit", "both"]);

const SECRET_NAMES = new Set([
  ".env",
  "auth.json",
  "credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
]);
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];
const SECRET_PREFIXES = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];
const ENV_TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist"];

function directionsOf(access: FileAccess): Direction[] {
  return access === "both" ? ["read", "edit"] : [access];
}

/** Split on whitespace, keeping `"quoted parts"` and `'quoted parts'` whole. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];

  for (const match of input.matchAll(/"[^"]*"|'[^']*'|\S+/g)) {
    const token = match[0];
    const quoted =
      token.length >= 2 && (token.startsWith('"') || token.startsWith("'"));

    tokens.push(quoted ? token.slice(1, -1) : token);
  }

  return tokens;
}

/**
 * Parse the file-approval subcommands.
 *
 * Returns `undefined` when `args` is not one of them, so the caller can fall
 * through to the other subcommands. Paths keep their case.
 */
export function parseFileApprovalArgs(
  args: string,
): FileApprovalCommand | undefined {
  const tokens = tokenize(args.trim());
  const subcommand = tokens[0]?.toLowerCase();

  if (subcommand === "list-files") {
    return tokens.length === 1 ? { kind: "list" } : { kind: "usage" };
  }

  if (subcommand !== "allow-file" && subcommand !== "remove-file") {
    return undefined;
  }

  const path = tokens.at(1);
  const defaultAccess = subcommand === "remove-file" ? "both" : "";
  const access = (tokens.at(2) ?? defaultAccess).toLowerCase();
  const rest = tokens.slice(3);

  if (!path || !ACCESS_VALUES.has(access) || rest.length > 0) {
    return { kind: "usage" };
  }

  return {
    kind: subcommand === "allow-file" ? "allow" : "remove",
    path,
    access: access as FileAccess,
  };
}

/** Resolve `~` and relative paths to one exact absolute file path. */
export function resolveFilePath(
  input: string,
  cwd: string,
): { path: string } | { error: string } {
  // The matcher reads `*` and `?` as wildcards and has no escape for them.
  if (/[*?]/.test(input)) {
    return {
      error:
        "the path contains * or ?, which the matcher reads as a wildcard. Give one exact file.",
    };
  }

  const expanded = expandHomePath(input);
  const path = normalize(
    isAbsolute(expanded) ? expanded : resolve(cwd, expanded),
  );

  if (existsSync(path) && statSync(path).isDirectory()) {
    return {
      error: "it is a folder. This command only saves rules for one file.",
    };
  }

  return { path };
}

/** Why a file name looks like a secret store, or `undefined` when it does not. */
export function secretFileReason(filePath: string): string | undefined {
  const name = basename(filePath).toLowerCase();
  const parts = normalize(filePath).split(/[\\/]/);

  if (parts.includes(".ssh")) {
    return "it is inside a .ssh folder.";
  }

  const isEnvTemplate = ENV_TEMPLATE_SUFFIXES.some((suffix) =>
    name.endsWith(suffix),
  );
  if (name.startsWith(".env.") && !isEnvTemplate) {
    return "it looks like an env file with secrets.";
  }

  const looksSecret =
    SECRET_NAMES.has(name) ||
    SECRET_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
    SECRET_PREFIXES.some((prefix) => name.startsWith(prefix));

  return looksSecret
    ? `'${basename(filePath)}' is a typical secret or key file.`
    : undefined;
}

/**
 * Why a saved allow would override a deny, or `undefined` when it would not.
 *
 * Rules are last-match-wins, so an allow appended to the global config could
 * open a file that an earlier deny (for example `*.env`) closes.
 */
export function denyRuleReason(
  filePath: string,
  access: FileAccess,
  rules: Ruleset,
): string | undefined {
  // Match the typed path and its symlink-resolved form, as the gate does.
  const values = [filePath];
  if (existsSync(filePath)) {
    values.push(realpathSync(filePath));
  }

  for (const direction of directionsOf(access)) {
    const surfaces = new Set([...SURFACES[direction], ...BARE_SURFACES]);
    const deny = rules.find(
      (rule) =>
        rule.action === "deny" &&
        surfaces.has(rule.surface) &&
        values.some((value) => wildcardMatch(rule.pattern, value)),
    );

    if (deny) {
      return `a deny rule matches it: ${deny.surface}["${deny.pattern}"].`;
    }
  }

  return undefined;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A copy of `map` without `key` (no dynamic `delete`). */
function omitKey(map: JsonObject, key: string): JsonObject {
  return Object.fromEntries(
    Object.entries(map).filter(([entryKey]) => entryKey !== key),
  );
}

/** A surface value as a pattern map. A bare state string means `{ "*": state }`. */
function surfaceMap(value: unknown): JsonObject {
  if (typeof value === "string") {
    return { "*": value };
  }

  return isObject(value) ? { ...value } : {};
}

/** Add `allow` rules for `filePath`, placed last so they have the final say. */
export function withFileApproval(
  config: JsonObject,
  filePath: string,
  access: FileAccess,
): JsonObject {
  const permission = isObject(config.permission)
    ? { ...config.permission }
    : {};

  for (const direction of directionsOf(access)) {
    for (const surface of SURFACES[direction]) {
      // Omit first: re-adding moves an existing key to the end.
      permission[surface] = {
        ...omitKey(surfaceMap(permission[surface]), filePath),
        [filePath]: "allow",
      };
    }
  }

  return { ...config, permission };
}

/** Remove the `allow` rules for `filePath`. Never removes an `ask` or `deny`. */
export function withoutFileApproval(
  config: JsonObject,
  filePath: string,
  access: FileAccess,
): { config: JsonObject; changed: boolean } {
  if (!isObject(config.permission)) {
    return { config, changed: false };
  }

  let permission: JsonObject = { ...config.permission };
  let changed = false;

  for (const direction of directionsOf(access)) {
    for (const surface of SURFACES[direction]) {
      const value = permission[surface];
      if (!isObject(value) || value[filePath] !== "allow") {
        continue;
      }

      const map = omitKey(value, filePath);
      changed = true;

      // Drop a surface that becomes empty, so no `{}` stays behind.
      permission =
        Object.keys(map).length === 0
          ? omitKey(permission, surface)
          : { ...permission, [surface]: map };
    }
  }

  return { config: changed ? { ...config, permission } : config, changed };
}

/** Exact-path (no wildcard) allow rules on the path surfaces, per file. */
export function listFileApprovals(config: JsonObject): Map<string, FileAccess> {
  const found = new Map<string, Set<Direction>>();
  const permission = isObject(config.permission) ? config.permission : {};

  for (const direction of ["read", "edit"] as const) {
    for (const surface of SURFACES[direction]) {
      const value = permission[surface];
      if (!isObject(value)) {
        continue;
      }

      for (const [pattern, state] of Object.entries(value)) {
        if (state !== "allow" || /[*?]/.test(pattern)) {
          continue;
        }

        const directions = found.get(pattern) ?? new Set<Direction>();
        directions.add(direction);
        found.set(pattern, directions);
      }
    }
  }

  const result = new Map<string, FileAccess>();
  for (const [pattern, directions] of found) {
    result.set(
      pattern,
      directions.size === 2 ? "both" : ([...directions][0] ?? "read"),
    );
  }

  return result;
}

/** Read the global config as plain JSON, or explain why it cannot be rewritten. */
export function readGlobalConfig(
  configPath: string,
): { config: JsonObject } | { error: string } {
  if (!existsSync(configPath)) {
    return { config: {} };
  }

  const raw = readFileSync(configPath, "utf-8");

  // The rewrite is plain JSON, so it would drop comments.
  if (stripJsonComments(raw) !== raw) {
    return {
      error: `${configPath} has comments, and this command would drop them. Add the rule by hand.`,
    };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    return isObject(parsed)
      ? { config: parsed }
      : { error: `${configPath} is not a JSON object.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return { error: `${configPath} is not valid JSON: ${message}` };
  }
}

/** Validate and write the global config atomically (temp file, then rename). */
export function writeGlobalConfig(
  configPath: string,
  config: JsonObject,
): { error?: string } {
  const validation = validateUnifiedConfig(config);
  if (validation.issues.length > 0) {
    return {
      error: `the result would not validate: ${validation.issues.join("; ")}`,
    };
  }

  const tmpPath = `${configPath}.tmp`;

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    renameSync(tmpPath, configPath);
  } catch (error) {
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath);
    }

    const message = error instanceof Error ? error.message : String(error);

    return { error: `could not write ${configPath}: ${message}` };
  }

  return {};
}

export interface FileApprovalDeps {
  cwd: string;
  configPath: string;
  /** The composed config rules, for the deny guard. */
  rules(): Ruleset;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

function describeSurfaces(access: FileAccess): string {
  return directionsOf(access)
    .flatMap((direction) => SURFACES[direction])
    .join(", ");
}

/** Run one parsed file-approval command and report the result in the TUI. */
export function runFileApprovalCommand(
  command: FileApprovalCommand,
  deps: FileApprovalDeps,
): void {
  if (command.kind === "usage") {
    deps.notify(FILE_APPROVAL_USAGE, "warning");
    return;
  }

  const loaded = readGlobalConfig(deps.configPath);
  if ("error" in loaded) {
    deps.notify(`Not changed: ${loaded.error}`, "warning");
    return;
  }

  if (command.kind === "list") {
    const approvals = listFileApprovals(loaded.config);
    const lines = [...approvals].map(
      ([path, access]) => `  ${access.padEnd(4)}  ${path}`,
    );

    deps.notify(
      lines.length > 0
        ? `Always-allowed files (${deps.configPath}):\n${lines.join("\n")}`
        : "No always-allowed files.",
      "info",
    );
    return;
  }

  const resolved = resolveFilePath(command.path, deps.cwd);
  if ("error" in resolved) {
    deps.notify(
      `Not saved: ${command.path}\nReason: ${resolved.error}`,
      "warning",
    );
    return;
  }

  const { path } = resolved;

  if (command.kind === "remove") {
    const result = withoutFileApproval(loaded.config, path, command.access);
    if (!result.changed) {
      deps.notify(
        `No always-allow rule for ${path} (${command.access}).`,
        "info",
      );
      return;
    }

    const written = writeGlobalConfig(deps.configPath, result.config);
    deps.notify(
      written.error
        ? `Not changed: ${written.error}`
        : `Removed the always-allow rule (${command.access}): ${path}`,
      written.error ? "error" : "info",
    );
    return;
  }

  const refusal =
    secretFileReason(path) ??
    denyRuleReason(path, command.access, deps.rules());
  if (refusal) {
    deps.notify(`Not saved: ${path}\nReason: ${refusal}`, "warning");
    return;
  }

  const written = writeGlobalConfig(
    deps.configPath,
    withFileApproval(loaded.config, path, command.access),
  );
  if (written.error) {
    deps.notify(`Not saved: ${written.error}`, "error");
    return;
  }

  // The edit tool reads the file as well, so `edit` alone still asks for the read.
  const editHint =
    command.access === "edit"
      ? "\nNote: the edit tool also reads the file. Use 'both' to stop every prompt for it."
      : "";

  deps.notify(
    `Always allowed (${command.access}): ${path}\nRules: ${describeSurfaces(command.access)} → allow\nFile: ${deps.configPath}${editHint}`,
    "info",
  );
}
