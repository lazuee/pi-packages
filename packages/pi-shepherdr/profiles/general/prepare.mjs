import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const GIT_TIMEOUT_MS = 10_000;

function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.error) return;
  return { code: result.status ?? 1, stdout: result.stdout.trim() };
}

function sh(cwd, ...args) {
  const result = run(cwd, "git", args);
  return result && result.code === 0 ? result.stdout : undefined;
}

/** Walk up for the widest gate. A package check only type-checks; the workspace
 * gate also runs the parity guard, so a private manifest wins over a nearer one. */
function workspaceRoot(cwd) {
  let nearest;
  let directory = cwd;
  for (let depth = 0; depth < 12; depth += 1) {
    const manifest = packageManifest(directory);
    if (manifest?.scripts?.check) {
      const isWorkspace =
        manifest.private === true || Array.isArray(manifest.workspaces);
      if (isWorkspace) return directory;
      nearest ??= directory;
    }
    const parent = directory.replace(/\/[^/]+$/, "");
    if (parent === directory || !parent) break;
    directory = parent;
  }
  return nearest;
}

function packageManifest(directory) {
  const path = join(directory, "package.json");
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return;
  }
}

function packageScripts(directory) {
  const scripts = packageManifest(directory)?.scripts;
  return scripts && typeof scripts === "object" ? scripts : undefined;
}

function safe(value) {
  return String(value).replaceAll("</", "&lt;/");
}

function bounded(value, limit) {
  const lines = value.split("\n").filter(Boolean);
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `… ${lines.length - limit} more`];
}

export function prepare(input) {
  const request = `Task:\n${input.message}`;
  const lines = ["Implementation context:", `Working directory: ${input.cwd}`];
  const root = workspaceRoot(input.cwd);
  const checks = root
    ? `Run \`bun run check\` in ${root} before reporting.`
    : undefined;

  if (input.local === false) {
    lines.push(
      "The tree is on another machine and was not inspected here. Read before editing, and run the project's own check command yourself.",
      ...(checks ? [checks] : []),
      "",
      "Instructions:",
      request
    );
    return lines.join("\n");
  }

  const status = sh(input.cwd, "status", "--porcelain=v1", "-uall");
  if (status === undefined)
    lines.push(
      "Not a Git repository; the working tree could not be inspected."
    );
  else
    lines.push(
      "",
      status
        ? `Already changed here, before you start. Do not revert these; build on them:\n${bounded(
            status,
            30
          )
            .map((line) => `  ${safe(line)}`)
            .join("\n")}`
        : "Working tree is clean."
    );

  const scripts = packageScripts(input.cwd);
  if (scripts)
    lines.push(
      "",
      `This directory's scripts: ${Object.keys(scripts).toSorted().join(", ") || "(none)"}.`
    );
  if (checks)
    lines.push(
      "",
      checks,
      "A failing check is yours to fix, not to report as done."
    );

  const conventions = [
    existsSync(join(input.cwd, "AGENTS.md")) ? "AGENTS.md" : undefined,
    existsSync(join(input.cwd, "README.md")) ? "README.md" : undefined,
  ].filter(Boolean);
  if (conventions.length)
    lines.push(
      `Read ${conventions.join(" and ")} first; they hold invariants the code will not show.`
    );

  lines.push("", "Instructions:", request);
  return lines.join("\n");
}
