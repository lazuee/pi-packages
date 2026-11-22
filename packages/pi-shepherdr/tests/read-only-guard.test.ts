import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as Guard from "../src/read-only-guard.js";

/**
 * The guard reads the live profile directory, which `profiles.ts` resolves per
 * call from `PI_CODING_AGENT_DIR`. The fixture directory must be set before the
 * first call, not before the import.
 */
const directory = mkdtempSync(join(tmpdir(), "guard-"));
const previous = process.env["PI_CODING_AGENT_DIR"];
let guard: typeof Guard;

function profile(name: string, writes: boolean, tools: string[] = []) {
  const path = join(directory, "shepherdr", "profiles", name);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "profile.json"),
    JSON.stringify({
      description: name,
      model: "m",
      thinking: "low",
      writes,
      ...(tools.length ? { write_tools: tools } : {}),
    })
  );
}

beforeAll(async () => {
  process.env["PI_CODING_AGENT_DIR"] = directory;
  profile("reviewer", false, ["mcp__x__write"]);
  profile("general", true);
  guard = await import("../src/read-only-guard.js");
});

afterAll(() => {
  if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = previous;
  rmSync(directory, { force: true, recursive: true });
});

type Blocked = { block?: boolean; reason?: string } | undefined;

type Handler = (event: object, ctx: unknown) => Promise<unknown>;

/** The guard reads its flags per call, so one registration serves every case. */
let handler: Handler | undefined;
let active = "reviewer";

function register() {
  // Registering twice would keep the second closure and drop the first.
  if (handler) return handler;
  guard.registerReadOnlyGuard({
    getFlag: (flag: string) =>
      flag === "shepherdr-profile" ? active : undefined,
    on: (_event: string, next: Handler) => {
      handler = next;
    },
  } as never);
  if (!handler) throw new Error("no tool_call handler registered");
  return handler;
}

async function guarded(
  command: string,
  name = "reviewer",
  tool = "bash"
): Promise<Blocked> {
  active = name;
  return (await register()(
    { toolName: tool, input: { command } },
    {}
  )) as Blocked;
}

describe("read-only shell classification", () => {
  test("inspecting commands run", async () => {
    for (const command of [
      "git status",
      "git log -5",
      "rg TODO src",
      "ls -la",
      "cat README.md",
    ])
      expect(await guarded(command)).toBeUndefined();
  });

  test("tree mutators are refused and named", async () => {
    const result = await guarded("cd x && rm -rf build");
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("rm");
  });

  test("writing git subcommands are refused", async () => {
    expect((await guarded("git commit -m x"))?.block).toBe(true);
    expect((await guarded("git add -A"))?.block).toBe(true);
  });

  test("a redirect or a sink writes whatever the verb", async () => {
    expect((await guarded("rg x > out.txt"))?.block).toBe(true);
    expect((await guarded("rg x >> out.txt"))?.block).toBe(true);
    expect((await guarded("rg x | tee out.txt"))?.block).toBe(true);
  });

  test("/dev/null is not a write", async () => {
    expect(await guarded("git status > /dev/null")).toBeUndefined();
  });

  test("a wrapped or xargs inner command is classified", async () => {
    expect((await guarded("sh -c 'rm x'"))?.reason).toContain("rm");
    expect(await guarded(`sh -c 'git status'`)).toBeUndefined();
    expect((await guarded("find . -name x | xargs rm"))?.reason).toContain(
      "rm"
    );
  });

  test("a runner writes unless its target reads as inspection", async () => {
    expect((await guarded("npm run build"))?.block).toBe(true);
    expect(await guarded("bun run check")).toBeUndefined();
    expect((await guarded("make"))?.block).toBe(true);
    // A write flag beats a reading name.
    expect((await guarded("bun test --update-snapshots"))?.block).toBe(true);
  });

  test("an opaque script writes unless its name reads as a check", async () => {
    expect((await guarded("./deploy.sh"))?.block).toBe(true);
    expect(await guarded("./check-deploy.sh")).toBeUndefined();
  });

  test("an interrupted parallel branch still counts", async () => {
    expect((await guarded("git status || rm -rf .cache"))?.block).toBe(true);
  });
});

describe("tool boundary", () => {
  test("edit and write are refused by name", async () => {
    expect((await guarded("", "reviewer", "edit"))?.reason).toContain("`edit`");
    expect((await guarded("", "reviewer", "write"))?.reason).toContain(
      "`write`"
    );
  });

  test("a declared writer is refused, compared folded", async () => {
    const result = await guarded("", "reviewer", "MCP__X__WRITE");
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("declared as writing");
  });

  test("an undeclared tool runs, bash included", async () => {
    for (const tool of ["read", "grep", "mcp__other__read"])
      expect(await guarded("", "reviewer", tool)).toBeUndefined();
  });

  test("a writing profile is never blocked", async () => {
    expect(await guarded("rm -rf x", "general")).toBeUndefined();
    expect(await guarded("", "general", "write")).toBeUndefined();
  });

  test("the writes flag opts a single spawn out", async () => {
    let handler: Handler | undefined;
    guard.registerReadOnlyGuard({
      getFlag: (flag: string) =>
        flag === "shepherdr-profile"
          ? "reviewer"
          : flag === "shepherdr-writes"
            ? "0"
            : undefined,
      on: (_event: string, next: Handler) => {
        handler = next;
      },
    } as never);
    expect(
      await handler!({ toolName: "bash", input: { command: "rm x" } }, {})
    ).toBeUndefined();
  });
});
