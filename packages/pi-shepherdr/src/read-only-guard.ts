import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadAgentProfiles } from "./profiles.js";
import { PROFILE_FLAG, WRITES_FLAG } from "./worker-role.js";

/** The two built-in tools that write. Everything else Pi ships (read, grep, find,
 * ls) only reads; unknown tools, including MCP ones, are allowed and their effect
 * is left to the prompt. */
const WRITES = new Set(["edit", "write"]);

/** Shell verbs that change the tree. Matched against command segments. */
const MUTATORS =
  /(^|[\s;&|(])(rm|mv|cp|mkdir|rmdir|touch|ln|tee|sed\s+-i|perl\s+-i|patch|truncate|chmod|chown|install)\b/;

/** `git` subcommands that write. Anything else under git is a read. */
const GIT_WRITES =
  /^git\s+(commit|add|checkout|switch|reset|restore|revert|merge|rebase|cherry-pick|stash|tag|clone|init|apply|clean|mv|rm|pull|push)\b/;

/** Package managers and build tools write into the tree or the lockfile. */
const INSTALLERS =
  /^(npm|pnpm|yarn|bun)\s+(install|add|remove|update|ci|link)\b|^(npx|bunx|tsc|oxfmt|oxlint)\b.*\s--write\b/;

/** A task runner is a write unless its target reads as inspection. `make` with no
 * target runs the default goal, which builds more often than it checks. */
const RUNNER =
  /^(?:make|npm|pnpm|yarn|bun|npx|bunx|cargo|just|task)(?:\s+(.*))?$/;
const RUNNER_READS =
  /\b(check|lint|typecheck|test|status|parity|pack:dry|fmt:check|format:check)\b/i;
/** Flags that make an otherwise-reading command write: snapshot updates, incremental builds. */
const RUNNER_WRITES = /(?:[:\s-])update\b|\s-b\b|\s--write\b/;

/** Split on shell separators, keeping quoted strings intact enough to classify. */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n|\|/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** A script path is opaque, so assume it writes unless the name reads as inspection. */
const INSPECTING_NAME =
  /(^|[/_-])(check|lint|test|status|list|ls|log|audit|inspect)([_.-]|$)/i;
const SCRIPT = /^(?:\.{1,2}\/|\/|~\/)\S+$/;

/** `> f`, `>> f`, `tee f`, `sponge f` all write whatever the verb before them was. */
const REDIRECT = /(^|[^<>])>{1,2}(?![>&])\s*(?!\/dev\/null)\S/;
const SINK = /(^|[\s|])tee\b|(^|[\s|])sponge\b/;

/** `xargs [flags] cmd`: the useful part is the command it runs. */
const XARGS = /(^|[\s|])xargs\b\s*((?:-\S+\s+)*)(.*)$/;

/** `sh -c '…'`, `bash -c "…"`: classify the inner command, not the wrapper. */
const WRAPPER = /^(?:ba|z|da)?sh\s+-c\s+(.+)$/;

function writes(segment: string): boolean {
  const bare = segment.replaceAll(/^["']|["']$/g, "").trim();
  const wrapped = WRAPPER.exec(bare);
  if (wrapped?.[1]) return writes(wrapped[1].replaceAll(/^["']|["']$/g, ""));
  const xargs = XARGS.exec(bare);
  if (xargs) {
    const inner = (xargs[3] ?? "").trim();
    return inner ? writes(inner) : false;
  }
  if (REDIRECT.test(bare) || SINK.test(bare)) return true;
  const runner = RUNNER.exec(bare);
  // `bun run check` reads; `npm run build` may not. A bare runner hits the default
  // goal, so only `make`'s is predictable enough to allow.
  if (runner) {
    const tail = (runner[1] ?? "").trim();
    // A write flag beats a reading name: `bun test --update-snapshots` rewrites files.
    if (tail && RUNNER_WRITES.test(tail)) return true;
    if (tail && RUNNER_READS.test(tail)) return false;
    if (tail || /^make\b/.test(bare)) return true;
  }
  if (GIT_WRITES.test(bare) || INSTALLERS.test(bare) || MUTATORS.test(bare))
    return true;
  const first = bare.split(/\s+/)[0] ?? "";
  return SCRIPT.test(first) && !INSPECTING_NAME.test(first);
}

function mutatingSegment(command: string): string | undefined {
  const found = segments(command).find(writes);
  if (!found) return undefined;
  // Name what actually writes, so a wrapper does not get reported as itself.
  const bare = found.replaceAll(/^["']|["']$/g, "").trim();
  const inner = WRAPPER.exec(bare)?.[1] ?? XARGS.exec(bare)?.[3];
  return inner?.trim() ? inner.trim() : found;
}

function reasonForName(name: string): string | undefined {
  if (WRITES.has(name)) return `\`${name}\` writes files`;
  return undefined;
}

/** Advisory profiles can be ignored; this stops the wrong one shipping. */
export function registerReadOnlyGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (pi.getFlag(WRITES_FLAG) === "0") return;
    const name = pi.getFlag(PROFILE_FLAG);
    if (typeof name !== "string" || !name.trim()) return;
    // Re-read each call, so a profile edited mid-run takes effect immediately.
    const profile = (await loadAgentProfiles()).get(name.trim());
    if (profile?.writes !== false) return;

    const byName =
      reasonForName(event.toolName) ??
      // Tool-name case is not promised by anyone; compare folded.
      (profile.writeTools.some(
        (tool) => tool.toLowerCase() === event.toolName.toLowerCase()
      )
        ? `\`${event.toolName}\` is declared as writing`
        : undefined);
    if (byName) return blocked(byName);
    if (event.toolName !== "bash" && event.toolName !== "powershell") return;
    const command =
      typeof event.input["command"] === "string" ? event.input["command"] : "";
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
