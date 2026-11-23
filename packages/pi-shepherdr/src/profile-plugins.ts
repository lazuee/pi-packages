import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadAgentProfiles } from "./profiles.js";
import { PROFILE_FLAG } from "./worker-role.js";

/** The one hook a profile plugin answers, the only event it gets. */
const HOOK = "tool_call";

export interface PluginToolCall {
  input: Record<string, unknown>;
  toolName: string;
}

export interface PluginVerdict {
  /** Optional state the next call receives back as `memory`. */
  memory?: unknown;
  block?: boolean;
  /** Shown as a UI warning: the plugin's own stderr is invisible in Pi. */
  notice?: string;
  reason?: string;
}

export interface ProfilePluginContext {
  /** What this same plugin returned as `memory` on its previous call. */
  memory?: unknown;
  /** `provider/model` of the session's current model, for messages and verdicts.
   * Read from the context, not the environment: `PI_MODEL` is a bash-tool
   * variable and is deleted from the extension's own `process.env`. */
  model?: string;
}

/** Everything a profile plugin answers, the mirror of `prepare()`'s contract. */
export interface ProfilePlugin {
  hook?: typeof HOOK;
  /** @returns a verdict, or nothing to let the call run. */
  tool_call?: (
    event: PluginToolCall,
    context: ProfilePluginContext
  ) => PluginVerdict | undefined | Promise<PluginVerdict | undefined>;
}

/** Profiles are read, and so listed, from one directory. Plugin entries are
 * relative to their own `profile.json`; resolve them here, not in the profile. */
function profilesDirectory() {
  return join(
    process.env["PI_CODING_AGENT_DIR"] || join(homedir(), ".pi", "agent"),
    "shepherdr",
    "profiles"
  );
}

/** Loaded plugins, keyed by path and stamp. Failures are cached the same way, so
 * a broken plugin is tried once and retried only after the file really changes. */
const cache = new Map<string, Promise<ProfilePlugin>>();

function load(path: string, stamp: string): Promise<ProfilePlugin> {
  const key = `${path}:${stamp}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = importPlugin(path, stamp);
    cache.set(key, pending);
  }
  return pending;
}

/** Bun resolves an import by file path and ignores the query, so a changed
 * `?v=` alone still returns the first evaluation. A copy under a unique name is
 * what actually re-reads the file there, and it costs nothing on Node. */
async function importPlugin(path: string, stamp: string) {
  const directory = await mkdtemp(join(tmpdir(), "shepherdr-plugin-"));
  const copy = join(directory, `${path.split("/").at(-1)}.${stamp}.mjs`);
  try {
    await copyFile(path, copy);
    const plugin = (await import(pathToFileURL(copy).href)) as ProfilePlugin;
    validate(plugin);
    return plugin;
  } finally {
    // The module is evaluated already; only a lazy sibling import would miss it.
    // A cleanup that fails is not the call's finding.
    await rm(directory, { force: true, recursive: true }).catch(
      () => undefined
    );
  }
}

/** mtime alone repeats within one millisecond, which a quick fix would miss, so
 * the size rides along: any edit changes the length or moves the clock. */
async function stampOf(path: string): Promise<string> {
  const { mtimeMs, size } = await stat(path);
  return `${mtimeMs}-${size}`;
}

/** A plugin that cannot load used to only warn, which made a guard doing nothing
 * look identical to a clean run. It fails the tool call instead: a guard is only
 * worth having when its absence is visible. */
function validate(plugin: ProfilePlugin) {
  if (!plugin || typeof plugin !== "object")
    throw new TypeError("must export an object");
  if (typeof plugin.tool_call !== "function")
    throw new TypeError("must export tool_call()");
  if (plugin.hook !== undefined && plugin.hook !== HOOK)
    throw new TypeError(`hook must be "${HOOK}", not "${String(plugin.hook)}"`);
}

export function registerProfilePlugins(pi: ExtensionAPI): void {
  /** Per plugin path, whatever it returned as `memory` last. */
  const memory = new Map<string, unknown>();

  // The profile name is read from the flag, never the worker marker: the marker
  // is only written at the first turn, after any restored tool call.
  const live = async () => {
    const name = pi.getFlag(PROFILE_FLAG);
    if (typeof name !== "string" || !name.trim()) return;
    const profile = (await loadAgentProfiles()).get(name.trim());
    if (!profile?.plugins.length) return;
    const loaded = [];
    for (const entry of profile.plugins) {
      const path = join(profilesDirectory(), profile.name, entry);
      try {
        loaded.push({
          path,
          plugin: await load(path, await stampOf(path)),
        });
      } catch (error) {
        // Name the profile and the entry: the bare error would read as ours.
        throw new Error(
          `${profile.name} profile plugin ${entry}: ${say(error)}`,
          {
            cause: error,
          }
        );
      }
    }
    return { name: profile.name, loaded };
  };

  pi.on(HOOK, async (event, ctx) => {
    if (!isToolCall(event)) return;
    let found;
    try {
      found = await live();
    } catch (error) {
      // Outside the session, `abort()` can itself fail; the hook's error is the
      // one worth keeping.
      await abortQuietly(ctx);
      throw error;
    }
    if (!found) return;
    for (const { path, plugin } of found.loaded) {
      let verdict: PluginVerdict | undefined;
      try {
        verdict = await plugin.tool_call!(event, {
          ...(memory.has(path) ? { memory: memory.get(path) } : {}),
          ...(currentModel(ctx) ? { model: currentModel(ctx) } : {}),
        });
      } catch (error) {
        await abortQuietly(ctx);
        throw new Error(
          `${found.name} profile plugin ${path.split("/").at(-1)} failed: ${say(error)}`,
          { cause: error }
        );
      }
      if (verdict?.memory !== undefined) memory.set(path, verdict.memory);
      if (verdict?.notice) ctx.ui.notify(verdict.notice, "warning");
      if (!verdict?.block) continue;
      return {
        block: true,
        reason: verdict.reason ?? `${found.name} profile plugin refused it.`,
      };
    }
  });
}

/** The model the session is on, if the context still has one. */
function currentModel(ctx: unknown): string | undefined {
  const { model } = ctx as { model?: { id?: unknown; provider?: unknown } };
  if (typeof model?.id !== "string" || !model.id) return;
  return typeof model.provider === "string" && model.provider
    ? `${model.provider}/${model.id}`
    : model.id;
}

function say(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).trim();
}

/** Stopping the turn on a plugin fault is the safe read, but never let the abort
 * replace the fault that caused it. */
async function abortQuietly(ctx: { abort: () => unknown }) {
  try {
    await ctx.abort();
  } catch {
    // The thrown error carries the detail.
  }
}

/** The public `tool_call` event carries `toolName` and the mutable `input`. */
function isToolCall(event: unknown): event is PluginToolCall {
  return (
    !!event &&
    typeof event === "object" &&
    "toolName" in event &&
    typeof event.toolName === "string" &&
    "input" in event &&
    !!event.input &&
    typeof event.input === "object"
  );
}
