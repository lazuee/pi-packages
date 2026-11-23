import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as Plugins from "../src/profile-plugins.ts";

const pluginModule = join(import.meta.dir, "..", "src", "profile-plugins.ts");

/** A throwaway agent directory with one profiled, reported `tool_call` events. */
async function fixture(plugins: string[], files: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "plugins-"));
  const previous = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = directory;
  const profiles = join(directory, "shepherdr", "profiles");
  const own = join(profiles, "committer");
  mkdirSync(own, { recursive: true });
  writeFileSync(
    join(own, "profile.json"),
    JSON.stringify({
      description: "d",
      model: "m",
      thinking: "low",
      plugins,
    })
  );
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(own, name), body);

  let handler: Handler | undefined;
  const module = (await import(
    `${pluginModule}?case=${crypto.randomUUID()}`
  )) as typeof Plugins;
  module.registerProfilePlugins({
    getFlag: (flag: string) =>
      flag === "shepherdr-profile" ? "committer" : undefined,
    on: (_event: string, next: Handler) => {
      handler = next;
    },
  } as never);
  let model: unknown;
  const notices: [string, string?][] = [];
  const call = (event: object) =>
    handler!(event, {
      abort: async () => {},
      get model() {
        return model;
      },
      ui: {
        notify: (message: string, type?: string) =>
          notices.push(type ? [message, type] : [message]),
      },
    });
  return {
    directory,
    call,
    setModel(next: unknown) {
      model = next;
    },
    notices,
    async dispose() {
      if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = previous;
      rmSync(directory, { force: true, recursive: true });
    },
  };
}

type Handler = (event: object, ctx: object) => Promise<unknown>;

/** A plugin written to a file the profile names, so the loader imports it. */
const DENY = `
export const hook = "tool_call";
export function tool_call(event) {
  return event.input.command === "blocked" ? { block: true, reason: "no" } : undefined;
}
`;

describe("profile plugins", () => {
  let dispose = () => {};
  afterEach(() => dispose());

  test("a plugin resolves relative to its own profile directory", async () => {
    const setup = await fixture(["guard.mjs"], { "guard.mjs": DENY });
    const { call, dispose: stop } = setup;
    dispose = stop;

    const result = (await call({
      toolName: "bash",
      input: { command: "blocked" },
    })) as { block?: boolean; reason?: string };
    expect(result?.block).toBe(true);
    expect(result?.reason).toBe("no");
  });

  test("a passing call is let through unnamed", async () => {
    const setup = await fixture(["guard.mjs"], { "guard.mjs": DENY });
    const { call, dispose: stop } = setup;
    dispose = stop;

    expect(
      await call({ toolName: "bash", input: { command: "ok" } })
    ).toBeUndefined();
  });

  test("memory comes back to the same plugin on its next call", async () => {
    const setup = await fixture(["count.mjs"], {
      "count.mjs": `
export function tool_call(_event, context) {
  const next = (context.memory ?? 0) + 1;
  return { block: true, reason: String(next), memory: next };
}`,
    });
    const { call, dispose: stop } = setup;
    dispose = stop;
    // The loader owns memory; the plugin only reads it back and counts.
    const at = (command: string) =>
      call({ toolName: "bash", input: { command } });

    expect(await at("a")).toMatchObject({ block: true, reason: "1" });
    expect(await at("b")).toMatchObject({ block: true, reason: "2" });
  });

  test("the context carries the session's model", async () => {
    // PI_MODEL is deleted from the extension process, so the model must ride
    // on the context the loader passes in.
    const setup = await fixture(["model.mjs"], {
      "model.mjs": `export function tool_call(_event, context) {
        return { block: true, reason: String(context.model) };
      }`,
    });
    const { call, dispose: stop } = setup;
    dispose = stop;
    setup.setModel({ id: "auto", provider: "pandesal-1" });

    expect(
      await call({ toolName: "bash", input: { command: "x" } })
    ).toMatchObject({ block: true, reason: "pandesal-1/auto" });
  });

  test("a verdict notice becomes a UI warning", async () => {
    // A plugin's stderr is invisible in Pi, so a notice must ride the verdict.
    const setup = await fixture(["notice.mjs"], {
      "notice.mjs": `export function tool_call() {
        return { block: true, reason: "r", notice: "heads up" };
      }`,
    });
    const { call, dispose: stop, notices } = setup;
    dispose = stop;

    expect(
      await call({ toolName: "bash", input: { command: "x" } })
    ).toMatchObject({ block: true, reason: "r" });
    expect(notices).toEqual([["heads up", "warning"]]);
  });

  test("a profile with no plugins costs nothing", async () => {
    const setup = await fixture([]);
    const { call, dispose: stop } = setup;
    dispose = stop;

    expect(
      await call({ toolName: "bash", input: { command: "x" } })
    ).toBeUndefined();
  });

  test("a broken plugin fails the call instead of warning", async () => {
    const setup = await fixture(["bad.mjs"], {
      "bad.mjs": `export const hook = "prepare"; export function tool_call() {}`,
    });
    const { call, dispose: stop } = setup;
    dispose = stop;

    // A guard that loaded to nothing must not pass silently.
    await expect(
      call({ toolName: "bash", input: { command: "x" } })
    ).rejects.toThrow(/committer profile plugin bad\.mjs: hook must be/);
  });

  test("a plugin without tool_call fails the call", async () => {
    const setup = await fixture(["empty.mjs"], {
      "empty.mjs": `export const hook = "tool_call";`,
    });
    const { call, dispose: stop } = setup;
    dispose = stop;

    await expect(
      call({ toolName: "bash", input: { command: "x" } })
    ).rejects.toThrow(/must export tool_call/);
  });

  test("a failed load is retried once the file changes", async () => {
    const setup = await fixture(["guard.mjs"], {
      "guard.mjs": `export const hook = "prepare"; export function tool_call() {}`,
    });
    const { call, dispose: stop } = setup;
    dispose = stop;
    const at = () => call({ toolName: "bash", input: { command: "x" } });

    await expect(at()).rejects.toThrow();
    await expect(at()).rejects.toThrow();
    // Repair the file in place: no restart, only a new mtime.
    const file = join(
      setup.directory,
      "shepherdr",
      "profiles",
      "committer",
      "guard.mjs"
    );
    writeFileSync(file, DENY);
    expect(await at()).toBeUndefined();
  });

  test("an edit reaches the next call, not just the next process", async () => {
    // Bun caches by path and ignores the import query, so a copy is what reloads.
    const setup = await fixture(["live.mjs"], {
      "live.mjs": `export function tool_call() { return { block: true, reason: "first", memory: "first" }; }`,
    });
    const { call, dispose: stop } = setup;
    dispose = stop;
    const at = (command: string) =>
      call({ toolName: "bash", input: { command } });
    expect(await at("a")).toMatchObject({ block: true, reason: "first" });

    writeFileSync(
      join(setup.directory, "shepherdr", "profiles", "committer", "live.mjs"),
      `export function tool_call() { return { block: true, reason: "second" }; }`
    );
    expect(await at("b")).toMatchObject({ block: true, reason: "second" });
  });

  test("a plugin that throws aborts the turn and keeps its message", async () => {
    const setup = await fixture(["boom.mjs"], {
      "boom.mjs": `export function tool_call() { throw new Error("boom"); }`,
    });
    const { call, dispose: stop } = setup;
    dispose = stop;

    await expect(
      call({ toolName: "bash", input: { command: "x" } })
    ).rejects.toThrow(/boom\.mjs failed: boom/);
  });

  test("a missing plugin file names the entry", async () => {
    const setup = await fixture(["gone.mjs"]);
    const { call, dispose: stop } = setup;
    dispose = stop;

    await expect(
      call({ toolName: "bash", input: { command: "x" } })
    ).rejects.toThrow(/gone\.mjs/);
  });
});
