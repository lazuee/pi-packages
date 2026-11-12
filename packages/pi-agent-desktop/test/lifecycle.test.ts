import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import start from "#src/extension";

const exec = promisify(execFile);
const HOME = process.env.HOME!;

it("adopts the id the hook's own start mints", async () => {
  const h: Record<string, ((e: unknown, c: unknown) => Promise<void>)[]> = {};
  let seen: string | undefined;
  const pi: any = {
    registerTool: () => {},
    on: (n: string, f: never) => {
      h[n] ??= [];
      h[n].push(f);
    },
    exec: async (bin: string, args: string[]) => {
      // Record the namespace every call runs under.
      seen = args.join(" ");
      return exec(bin, args).then(
        (v) => ({ code: 0, stdout: v.stdout, stderr: v.stderr }),
        (e: unknown) => {
          const { code, stdout, stderr } = e as {
            code?: number;
            stdout?: string;
            stderr?: string;
          };
          return {
            code: code ?? 1,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          };
        },
      );
    },
  };
  start(pi);
  const ctx: any = {
    hasUI: false,
    mode: "tui",
    ui: { setStatus: () => {}, notify: () => {} },
  };
  await h.session_start[0]({ reason: "startup" }, ctx);
  await h.agent_start[0]({}, ctx);
  const sh = (c: string) => exec("/bin/sh", ["-c", c]);
  // The newest session dir must have a manifest: that is the minted id.
  const { stdout: dirs } = await sh(
    `ls -t "$HOME/.agent-desktop/sessions" | head -1`,
  );
  const newest = dirs.trim();
  const files = await readdir(`${HOME}/.agent-desktop/sessions/${newest}`);
  expect(files).toContain("session.json");
  // And the next call must run in that namespace.
  await h.agent_settled[0]({}, ctx);
  expect(seen).toContain("session end");
  await sh(`rm -rf "$HOME/.agent-desktop/sessions/${newest}"`);
});

// A sealed session refuses to start under itself, and the id the next turn's
// start would inherit belongs to the run that just settled. Without running a
// start unprefixed, the first settle pins the whole process to a dead id.
it("starts a second run after the first one settled", async () => {
  const h: Record<string, ((e: unknown, c: unknown) => Promise<void>)[]> = {};
  const starts: string[] = [];
  const pi: any = {
    registerTool: () => {},
    on: (n: string, f: never) => {
      h[n] ??= [];
      h[n].push(f);
    },
    exec: async (bin: string, args: string[]) => {
      // A prefixed call goes through sh -c; a bare start keeps the binary as
      // the command. That is the only difference that matters here.
      if (args[0] === "session" && args[1] === "start") starts.push(bin);
      return { code: 0, stdout: '{"data":{}}', stderr: "" };
    },
  };
  start(pi);
  const ctx: any = {
    hasUI: false,
    mode: "tui",
    ui: { setStatus: () => {}, notify: () => {} },
  };
  await h.session_start[0]({ reason: "startup" }, ctx);
  await h.agent_start[0]({}, ctx);
  await h.agent_settled[0]({}, ctx);
  await h.agent_start[0]({}, ctx);
  expect(starts).toHaveLength(2);
  for (const bin of starts) expect(bin).not.toBe("/bin/sh");
});

// One session is started and ended per run, so a Pi session leaves a directory
// per turn and nothing collects them. Shutdown prunes the ones old enough that
// their trace is unlikely to be wanted.
it("prunes old sessions on shutdown", async () => {
  const h: Record<string, ((e: unknown, c: unknown) => Promise<void>)[]> = {};
  const calls: string[][] = [];
  const pi: any = {
    registerTool: () => {},
    on: (n: string, f: never) => {
      h[n] ??= [];
      h[n].push(f);
    },
    exec: async (_bin: string, args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: '{"data":{}}', stderr: "" };
    },
  };
  start(pi);
  const ctx: any = {
    hasUI: false,
    mode: "tui",
    ui: { setStatus: () => {}, notify: () => {} },
  };
  await h.session_start[0]({ reason: "startup" }, ctx);
  await h.agent_start[0]({}, ctx);
  await h.session_shutdown[0]({}, ctx);
  // A prefixed call carries its argv after the sh wrapper, so search the args.
  const gc = calls.find((c) => c.includes("gc"));
  expect(gc?.slice(-4)).toEqual(["session", "gc", "--older-than", "86400"]);
});

// A reload tears the process tree down mid-run, so no settle ends the run's
// session and shutdown has no manifest to end; the placeholder id it would end
// is not a session, and the CLI answers "has no manifest". Only an open run is
// worth an end, and gc still runs.
it("does not end a session that no start opened", async () => {
  const h: Record<string, ((e: unknown, c: unknown) => Promise<void>)[]> = {};
  const calls: string[][] = [];
  const pi: any = {
    registerTool: () => {},
    on: (n: string, f: never) => {
      h[n] ??= [];
      h[n].push(f);
    },
    exec: async (_bin: string, args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: '{"data":{}}', stderr: "" };
    },
  };
  start(pi);
  const ctx: any = {
    hasUI: false,
    mode: "tui",
    ui: { setStatus: () => {}, notify: () => {} },
  };
  await h.session_start[0]({ reason: "startup" }, ctx);
  // An idle reload: a start never ran, so there is nothing to end.
  await h.session_shutdown[0]({}, ctx);
  expect(calls.some((c) => c.includes("end"))).toBe(false);
  expect(calls.some((c) => c.includes("gc"))).toBe(true);
});

// A missing CLI was invisible until the first call failed, while the pill said
// ready regardless.
it("says so in the status line when no CLI answers", async () => {
  const h: Record<string, ((e: unknown, c: unknown) => Promise<void>)[]> = {};
  const status: (string | undefined)[] = [];
  const pi: any = {
    registerTool: () => {},
    on: (n: string, f: never) => {
      h[n] ??= [];
      h[n].push(f);
    },
    exec: async () => {
      throw new Error("ENOENT");
    },
  };
  start(pi);
  const ctx: any = {
    hasUI: true,
    mode: "tui",
    ui: {
      setStatus: (_k: string, v?: string) => status.push(v),
      notify: () => {},
    },
  };
  await h.session_start[0]({ reason: "startup" }, ctx);
  expect(status.at(-1)).toBe("🖥 no agent-desktop on PATH");
});

// The agent may run `session start`/`end` itself as a tool. A tool end closes
// the run's session, so the settle hook must not end it a second time — the CLI
// answers "has no manifest" for the already-closed id and the operator sees a
// warning on every turn that ended its own session.
it("does not end a session a tool already ended", async () => {
  const h: Record<string, ((e: unknown, c: unknown) => Promise<void>)[]> = {};
  let tool: { execute: (...a: unknown[]) => Promise<unknown> } | undefined;
  const calls: string[][] = [];
  const pi: any = {
    registerTool: (t: typeof tool) => {
      tool = t;
    },
    on: (n: string, f: never) => {
      h[n] ??= [];
      h[n].push(f);
    },
    exec: async (_bin: string, args: string[]) => {
      calls.push(args);
      return {
        code: 0,
        stdout: '{"data":{"session_id":"run-a-0"}}',
        stderr: "",
      };
    },
  };
  start(pi);
  const ctx: any = {
    hasUI: false,
    mode: "tui",
    ui: { setStatus: () => {}, notify: () => {} },
  };
  await h.session_start[0]({ reason: "startup" }, ctx);
  await h.agent_start[0]({}, ctx);
  await tool!.execute(
    "1",
    { action: "session", sub: "end" },
    undefined,
    () => {},
    {},
  );
  calls.length = 0;
  await h.agent_settled[0]({}, ctx);
  expect(calls.some((c) => c.includes("end"))).toBe(false);
});

// A tool start re-points the run at a new session, so shutdown still has a
// manifest to release even when the hooks only know the placeholder.
it("ends the session a tool start opened on shutdown", async () => {
  const h: Record<string, ((e: unknown, c: unknown) => Promise<void>)[]> = {};
  let tool: { execute: (...a: unknown[]) => Promise<unknown> } | undefined;
  const calls: string[][] = [];
  const pi: any = {
    registerTool: (t: typeof tool) => {
      tool = t;
    },
    on: (n: string, f: never) => {
      h[n] ??= [];
      h[n].push(f);
    },
    exec: async (_bin: string, args: string[]) => {
      calls.push(args);
      return {
        code: 0,
        stdout: '{"data":{"session_id":"run-a-0"}}',
        stderr: "",
      };
    },
  };
  start(pi);
  const ctx: any = {
    hasUI: false,
    mode: "tui",
    ui: { setStatus: () => {}, notify: () => {} },
  };
  await h.session_start[0]({ reason: "startup" }, ctx);
  await tool!.execute(
    "1",
    { action: "session", sub: "start" },
    undefined,
    () => {},
    {},
  );
  calls.length = 0;
  await h.session_shutdown[0]({}, ctx);
  expect(calls.some((c) => c.includes("end"))).toBe(true);
});

// The agent may run `session start`/`end` as a tool. A tool end closes the run's
// session, so the settle hook must not end it again — the CLI answers "has no
// manifest" for the closed id and the operator sees a warning on every turn.
it("does not end a session a tool already ended", async () => {
  const h: Record<string, ((e: unknown, c: unknown) => Promise<void>)[]> = {};
  let tool: { execute: (...a: unknown[]) => Promise<unknown> } | undefined;
  const calls: string[][] = [];
  const pi: any = {
    registerTool: (t: typeof tool) => {
      tool = t;
    },
    on: (n: string, f: never) => {
      h[n] ??= [];
      h[n].push(f);
    },
    exec: async (_bin: string, args: string[]) => {
      calls.push(args);
      return {
        code: 0,
        stdout: '{"data":{"session_id":"run-a-0"}}',
        stderr: "",
      };
    },
  };
  start(pi);
  const ctx: any = {
    hasUI: false,
    mode: "tui",
    ui: { setStatus: () => {}, notify: () => {} },
  };
  await h.session_start[0]({ reason: "startup" }, ctx);
  await h.agent_start[0]({}, ctx);
  await tool!.execute(
    "1",
    { action: "session", sub: "end" },
    undefined,
    () => {},
    {},
  );
  calls.length = 0;
  await h.agent_settled[0]({}, ctx);
  expect(calls.some((c) => c.includes("end"))).toBe(false);
});

// A tool start re-points the run at a new session, so shutdown still has a
// manifest to release even when the hooks only ever knew the placeholder.
it("ends the session a tool start opened on shutdown", async () => {
  const h: Record<string, ((e: unknown, c: unknown) => Promise<void>)[]> = {};
  let tool: { execute: (...a: unknown[]) => Promise<unknown> } | undefined;
  const calls: string[][] = [];
  const pi: any = {
    registerTool: (t: typeof tool) => {
      tool = t;
    },
    on: (n: string, f: never) => {
      h[n] ??= [];
      h[n].push(f);
    },
    exec: async (_bin: string, args: string[]) => {
      calls.push(args);
      return {
        code: 0,
        stdout: '{"data":{"session_id":"run-a-0"}}',
        stderr: "",
      };
    },
  };
  start(pi);
  const ctx: any = {
    hasUI: false,
    mode: "tui",
    ui: { setStatus: () => {}, notify: () => {} },
  };
  await h.session_start[0]({ reason: "startup" }, ctx);
  await tool!.execute(
    "1",
    { action: "session", sub: "start" },
    undefined,
    () => {},
    {},
  );
  calls.length = 0;
  await h.session_shutdown[0]({}, ctx);
  expect(
    calls.some(
      (c) =>
        c.includes("end") &&
        c.some((a) => a.includes("AGENT_DESKTOP_SESSION='run-a-0'")),
    ),
  ).toBe(true);
});

// A reload never settles and never shuts down, so the records it strands are
// only reachable at the next startup — waiting for a shutdown would leave them
// collected only when the operator happens not to reload again.
it("prunes what a dead reload left when the next session starts", async () => {
  const h: Record<string, ((e: unknown, c: unknown) => Promise<void>)[]> = {};
  const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "ad-home-"));
  const store = join(home, ".agent-desktop", "sessions");
  const orphan = "run-1-2000001-0"; // well past any live pid
  await mkdir(join(store, orphan), { recursive: true });
  await writeFile(join(store, orphan, "session.json"), "{}");
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const pi: any = {
      registerTool: () => {},
      on: (n: string, f: never) => {
        h[n] ??= [];
        h[n].push(f);
      },
      exec: async () => ({
        code: 0,
        stdout: '{"data":{}}',
        stderr: "",
        killed: false,
        truncated: false,
      }),
    };
    start(pi);
    const ctx: any = {
      hasUI: false,
      mode: "tui",
      ui: { setStatus: () => {}, notify: () => {} },
    };
    await h.session_start[0]({ reason: "startup" }, ctx);
    // rm is recursive and resolves before its last entry is gone.
    await expect.poll(() => existsSync(join(store, orphan))).toBe(false);
  } finally {
    process.env.HOME = before;
  }
});
