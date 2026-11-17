import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const ENTRY_LIMIT = 40;
const MANIFEST = "AGENTS.md";

/** Pointers only. Anything read here would be stale by the time the task starts. */
async function entries(directory) {
  try {
    const values = await readdir(directory, { withFileTypes: true });
    return values
      .filter(
        (entry) => !entry.name.startsWith(".") && entry.name !== "node_modules"
      )
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .toSorted();
  } catch {
    return [];
  }
}

/** Invariants live beside the code, not only at the root; name them so they get read. */
async function manifests(root, depth) {
  const found = [];
  const walk = async (directory, level) => {
    if (level > depth) return;
    for (const entry of await entries(directory)) {
      if (!entry.endsWith("/")) continue;
      const path = join(directory, entry.slice(0, -1));
      if (await exists(join(path, MANIFEST)))
        found.push(join("/", path.slice(root.length + 1), MANIFEST));
      await walk(path, level + 1);
    }
  };
  if (await exists(join(root, MANIFEST))) found.push(join("/", MANIFEST));
  await walk(root, 1);
  return found;
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function bounded(values, limit) {
  if (values.length <= limit) return values;
  return [...values.slice(0, limit), `… ${values.length - limit} more`];
}

function safe(value) {
  return String(value).replaceAll("</", "&lt;/");
}

export async function prepare(input) {
  const request = `Exploration request:\n${input.message}`;
  if (input.local === false) {
    return [
      "Exploration context:",
      `Working directory: ${input.cwd}`,
      "The tree is on another machine and was not inspected here. Look around before reading much, and confirm the directory matches the request.",
      ...((input.cwd ?? "").includes("node_modules")
        ? [
            "You appear to be inside node_modules; the package source is usually above it.",
          ]
        : []),
      "",
      "Instructions:",
      request,
    ].join("\n");
  }
  const top = await entries(input.cwd);
  if (top.length === 0) {
    return [
      "Exploration context:",
      `Working directory: ${input.cwd}`,
      "Empty or unreadable. Confirm the directory before exploring.",
      "",
      "Instructions:",
      request,
    ].join("\n");
  }
  const root = (await manifests(input.cwd, 3)).map(safe);
  return [
    "Exploration context:",
    `Working directory: ${input.cwd}`,
    "Contents, names only. Explore these rather than guessing paths:",
    ...bounded(top, ENTRY_LIMIT).map((entry) => `- ${safe(entry)}`),
    ...(root.length
      ? [
          "",
          `Local invariants (${MANIFEST}). Read the relevant one before claiming how a part works:`,
          ...root.map((entry) => `- ${entry}`),
        ]
      : [`No ${MANIFEST} here; the README or types are the closest guide.`]),
    "",
    "Instructions:",
    request,
  ].join("\n");
}
