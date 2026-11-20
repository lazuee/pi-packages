import { expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

import start, { pidOf } from "#src/extension";

import { cliAnswers } from "./helpers/cli-answers";

/** A handler recorded off the fake `on`, keyed by the event it was bound to. */
type Handler = (e: unknown, c: unknown) => Promise<void>;
/**
 * The lifecycle events these tests fire, `on` appends each one it receives, and
 * each is a non-empty tuple so `[0]` needs no guard.
 */
interface Handlers {
  session_start: [Handler, ...Handler[]];
  agent_start: [Handler, ...Handler[]];
  agent_settled: [Handler, ...Handler[]];
  session_shutdown: [Handler, ...Handler[]];
}

/**
 * Empty lists for every event. The `on` fake appends the real handler, and a
 * test that fires an event it never bound still gets a callable placeholder.
 */
const handlers = (): Handlers => {
  const noop: Handler = async () => {};
  return {
    session_start: [noop],
    agent_start: [noop],
    agent_settled: [noop],
    session_shutdown: [noop],
  };
};

/**
 * A fixture store the CLI accepts. It refuses a `.agent-desktop` that group or
 * other users can read, and `mkdir` is 0755 by default, so both levels are
 * made private the way the CLI would have made them itself.
 */
async function privateStore(home: string): Promise<string> {
  const { chmod, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const store = join(home, ".agent-desktop", "sessions");
  await mkdir(store, { recursive: true, mode: 0o700 });
  await chmod(join(home, ".agent-desktop"), 0o700);
  await chmod(store, 0o700);
  return store;
}

/**
 * Wait for a predicate to hold. A lock is dropped by a child process, so the
 * statement after the call can still see it; this is vitest's `expect.poll`
 * without the runner supporting it.
 */
async function poll(ok: () => boolean, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return ok();
}

const exec = promisify(execFile);
const HOME = process.env.HOME!;
// The only test here that reads the real store; the rest assert on a fake exec.
// That store is the CLI's own, so a checkout with no binary for this platform
// has nothing to list.
const answers = cliAnswers();

it.skipIf(!answers)("adopts the id the hook's own start mints", async () => {
  const h: Handlers = handlers();
  let seen: string | undefined;
  const pi: any = {
    registerTool: () => {},
    on: (n: keyof Handlers, f: Handler) => {
      // Newest handler first, so the real one is `[0]` over the placeholder.
      h[n].unshift(f);
    },
    exec: async (bin: string, args: string[]) => {
      // Record the namespace every call runs under.
      seen = args.join(" ");
      return exec(bin, args).then(
        (v) => ({ code: 0, stdout: v.stdout, stderr: v.stderr }),
        (error: unknown) => {
          const { code, stdout, stderr } = error as {
            code?: number;
            stdout?: string;
            stderr?: string;
          };
          return {
            code: code ?? 1,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          };
        }
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
    `ls -t "$HOME/.agent-desktop/sessions" | head -1`
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
  const h: Handlers = handlers();
  const starts: string[] = [];
  const pi: any = {
    registerTool: () => {},
    on: (n: keyof Handlers, f: Handler) => {
      // Newest handler first, so the real one is `[0]` over the placeholder.
      h[n].unshift(f);
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
  const h: Handlers = handlers();
  const calls: string[][] = [];
  const pi: any = {
    registerTool: () => {},
    on: (n: keyof Handlers, f: Handler) => {
      // Newest handler first, so the real one is `[0]` over the placeholder.
      h[n].unshift(f);
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
  expect(gc?.slice(-3)).toEqual(["session", "gc", "--ended"]);
});

// A reload tears the process tree down mid-run, so no settle ends the run's
// session and shutdown has no manifest to end; the placeholder id it would end
// is not a session, and the CLI answers "has no manifest". Only an open run is
// worth an end, and gc still runs.
it("does not end a session that no start opened", async () => {
  const h: Handlers = handlers();
  const calls: string[][] = [];
  const pi: any = {
    registerTool: () => {},
    on: (n: keyof Handlers, f: Handler) => {
      // Newest handler first, so the real one is `[0]` over the placeholder.
      h[n].unshift(f);
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
  const h: Handlers = handlers();
  const status: (string | undefined)[] = [];
  const pi: any = {
    registerTool: () => {},
    on: (n: keyof Handlers, f: Handler) => {
      // Newest handler first, so the real one is `[0]` over the placeholder.
      h[n].unshift(f);
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
  const h: Handlers = handlers();
  let tool: { execute: (...a: unknown[]) => Promise<unknown> } | undefined;
  const calls: string[][] = [];
  const pi: any = {
    registerTool: (t: typeof tool) => {
      tool = t;
    },
    on: (n: keyof Handlers, f: Handler) => {
      // Newest handler first, so the real one is `[0]` over the placeholder.
      h[n].unshift(f);
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
    {}
  );
  calls.length = 0;
  await h.agent_settled[0]({}, ctx);
  expect(calls.some((c) => c.includes("end"))).toBe(false);
});

// A tool start re-points the run at a new session, so shutdown still has a
// manifest to release even when the hooks only know the placeholder.
it("ends the session a tool start opened on shutdown", async () => {
  const h: Handlers = handlers();
  let tool: { execute: (...a: unknown[]) => Promise<unknown> } | undefined;
  const calls: string[][] = [];
  const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "ad-home-"));
  // The start answers with an id the CLI really minted, so it has a manifest.
  await privateStore(home);
  await mkdir(join(home, ".agent-desktop", "sessions", "run-a-0"), {
    recursive: true,
  });
  await writeFile(
    join(home, ".agent-desktop", "sessions", "run-a-0", "session.json"),
    "{}"
  );
  const before = process.env.HOME;
  process.env.HOME = home;
  const pi: any = {
    registerTool: (t: typeof tool) => {
      tool = t;
    },
    on: (n: keyof Handlers, f: Handler) => {
      // Newest handler first, so the real one is `[0]` over the placeholder.
      h[n].unshift(f);
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
    {}
  );
  calls.length = 0;
  await h.session_shutdown[0]({}, ctx);
  process.env.HOME = before;
  expect(calls.some((c) => c.includes("end"))).toBe(true);
});

// The agent may run `session start`/`end` as a tool. A tool end closes the run's
// session, so the settle hook must not end it again — the CLI answers "has no
// manifest" for the closed id and the operator sees a warning on every turn.
it("does not end a session a tool already ended", async () => {
  const h: Handlers = handlers();
  let tool: { execute: (...a: unknown[]) => Promise<unknown> } | undefined;
  const calls: string[][] = [];
  const pi: any = {
    registerTool: (t: typeof tool) => {
      tool = t;
    },
    on: (n: keyof Handlers, f: Handler) => {
      // Newest handler first, so the real one is `[0]` over the placeholder.
      h[n].unshift(f);
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
    {}
  );
  calls.length = 0;
  await h.agent_settled[0]({}, ctx);
  expect(calls.some((c) => c.includes("end"))).toBe(false);
});

// A tool start re-points the run at a new session, so shutdown still has a
// manifest to release even when the hooks only ever knew the placeholder.
it("ends the session a tool start opened on shutdown", async () => {
  const h: Handlers = handlers();
  let tool: { execute: (...a: unknown[]) => Promise<unknown> } | undefined;
  const calls: string[][] = [];
  const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "ad-home-"));
  // The start answers with an id the CLI really minted, so it has a manifest.
  await privateStore(home);
  await mkdir(join(home, ".agent-desktop", "sessions", "run-a-0"), {
    recursive: true,
  });
  await writeFile(
    join(home, ".agent-desktop", "sessions", "run-a-0", "session.json"),
    "{}"
  );
  const before = process.env.HOME;
  process.env.HOME = home;
  const pi: any = {
    registerTool: (t: typeof tool) => {
      tool = t;
    },
    on: (n: keyof Handlers, f: Handler) => {
      // Newest handler first, so the real one is `[0]` over the placeholder.
      h[n].unshift(f);
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
    {}
  );
  calls.length = 0;
  await h.session_shutdown[0]({}, ctx);
  process.env.HOME = before;
  expect(
    calls.some(
      (c) =>
        c.includes("end") &&
        c.some((a) => a.includes("AGENT_DESKTOP_SESSION='run-a-0'"))
    )
  ).toBe(true);
});

// A reload never settles and never shuts down, so the records it strands are
// only reachable at the next startup — waiting for a shutdown would leave them
// collected only when the operator happens not to reload again.
it("prunes what a dead reload left when the next session starts", async () => {
  const h: Handlers = handlers();
  const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "ad-home-"));
  const store = join(home, ".agent-desktop", "sessions");
  // `run-<µs>-<pid>-<n>`: a real timestamp first, then a pid that is gone.
  const orphan = "run-1795000000000-2000001-0";
  await mkdir(join(store, orphan), { recursive: true });
  await writeFile(join(store, orphan, "session.json"), "{}");
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const pi: any = {
      registerTool: () => {},
      on: (n: keyof Handlers, f: Handler) => {
        // Newest handler first, so the real one is `[0]` over the placeholder.
        h[n].unshift(f);
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
    expect(await poll(() => !existsSync(join(store, orphan)))).toBe(true);
  } finally {
    process.env.HOME = before;
  }
});

// The CLI keeps a directory without a manifest out of its own list and answers
// "has no manifest" if the id is handed back, so ending one is a warning for
// nothing. A start can land that way, so the directory is what decides.
it("skips the end for a session id with no manifest", async () => {
  const h: Handlers = handlers();
  const calls: string[][] = [];
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "ad-home-")); // no manifest at all
  const before = process.env.HOME;
  process.env.HOME = home;
  const pi: any = {
    registerTool: () => {},
    on: (n: keyof Handlers, f: Handler) => {
      // Newest handler first, so the real one is `[0]` over the placeholder.
      h[n].unshift(f);
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
  calls.length = 0;
  await h.agent_settled[0]({}, ctx);
  await h.session_shutdown[0]({}, ctx);
  process.env.HOME = before;
  expect(calls.some((c) => c.includes("end"))).toBe(false);
});

// Tool calls run after the settle, so a record created *now* cannot be pruned
// just because its pid is gone: the next call would land in a fresh empty
// directory and the run's trace would start over.
it("leaves a record of this very turn alone", async () => {
  let mine = "";
  const h: Handlers = handlers();
  const tool: { execute: (...a: unknown[]) => Promise<unknown> }[] = [];
  const { existsSync } = await import("node:fs");
  const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "ad-home-"));
  // The pid belongs to a shell that has exited by the time the settle runs, as a
  // start's own child does, so only the open manifest and the grace can hold it.
  const before = process.env.HOME;
  process.env.HOME = home;
  const pi: any = {
    registerTool: (t: never) => tool.push(t),
    on: (n: keyof Handlers, f: Handler) => {
      // Newest handler first, so the real one is `[0]` over the placeholder.
      h[n].unshift(f);
    },
    exec: async () => ({
      code: 0,
      stdout: `{"data":{"session_id":"${mine}"}}`,
      stderr: "",
      killed: false,
      truncated: false,
    }),
  };
  try {
    start(pi);
    const ctx: any = {
      hasUI: false,
      mode: "tui",
      ui: { setStatus: () => {}, notify: () => {} },
    };
    await h.session_start[0]({ reason: "startup" }, ctx);
    // Created after discovery, and ended nowhere: the settle is what would drop
    // it if the grace did not hold. `run-<µs>-<pid>-0`, the CLI's own shape;
    // the pid is the parent, which is still alive, so only the grace spares it.
    mine = `run-${Date.now() * 1000}-${process.pid}-0`;
    await mkdir(join(home, ".agent-desktop", "sessions", mine), {
      recursive: true,
    });
    await writeFile(
      join(home, ".agent-desktop", "sessions", mine, "session.json"),
      `{"id":"${mine}"}` // open: no ended_at
    );
    await h.agent_start[0]({}, ctx);
    await h.agent_settled[0]({}, ctx);
    expect(existsSync(join(home, ".agent-desktop", "sessions", mine))).toBe(
      true
    );
  } finally {
    process.env.HOME = before;
  }
});

// The id is `run-<µs>-<pid>-<n>`. Reading the timestamp field instead of the
// pid gives a 13-digit number that no live process has, so every session looks
// dead the instant it is checked and a running run is pruned under itself.
it("reads the pid out of a session id, not the timestamp", () => {
  expect(pidOf(`run-${1_795_062_551_541}-7249-0`)).toBe(7249);
  expect(pidOf(`run-${1_795_062_551_541}-7249-3`)).toBe(7249);
  // The timestamp is never the answer, even though it is a valid number.
  expect(pidOf(`run-${1_795_062_551_541}-7249-0`)).not.toBe(1_795_062_551_541);
  expect(pidOf("run-a-0")).toBeUndefined();
});

// `session gc` is store-wide and refuses a session scope, so the wrapper that
// scopes everything else makes it warn on every shutdown.
it("runs gc unprefixed", async () => {
  const h: Handlers = handlers();
  const calls: { bin: string; args: string[] }[] = [];
  const pi: any = {
    registerTool: () => {},
    on: (n: keyof Handlers, f: Handler) => {
      // Newest handler first, so the real one is `[0]` over the placeholder.
      h[n].unshift(f);
    },
    exec: async (bin: string, args: string[]) => {
      calls.push({ bin, args });
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
  await h.session_shutdown[0]({}, ctx);
  const gc = calls.find((c) => c.args.includes("gc"));
  expect(gc?.bin).not.toBe("/bin/sh");
  expect(gc?.args).toContain("--ended");
});

// A store lock is held by whatever held file 8, so a lock file whose holder is
// gone stays and makes `session gc` keep the session forever. The start gives
// its own lock up, but only when nobody holds it.
it("drops its own store lock after a start", async () => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const h: Handlers = handlers();
  const home = await mkdtemp(join(tmpdir(), "ad-home-"));
  const id = "run-a-0";
  const store = join(home, ".agent-desktop", "sessions");
  await mkdir(join(store, id), { recursive: true });
  await writeFile(
    join(home, ".agent-desktop", "sessions", id, "refstore.lock"),
    ""
  );
  const before = process.env.HOME;
  process.env.HOME = home;
  const pi: any = {
    registerTool: () => {},
    on: (n: keyof Handlers, f: Handler) => {
      // Newest handler first, so the real one is `[0]` over the placeholder.
      h[n].unshift(f);
    },
    exec: async (bin: string, args: string[]) => {
      if (bin !== "python3")
        return {
          code: 0,
          stdout: `{"data":{"session_id":"${id}"}}`,
          stderr: "",
        };
      try {
        execFileSync(bin, args);
        return { code: 0, stdout: "", stderr: "" };
      } catch {
        return { code: 1, stdout: "", stderr: "" };
      }
    },
  };
  try {
    start(pi);
    const ctx: any = {
      hasUI: false,
      mode: "tui",
      ui: { setStatus: () => {}, notify: () => {} },
    };
    await h.session_start[0]({ reason: "startup" }, ctx);
    await h.agent_start[0]({}, ctx);
    expect(
      await poll(() => !existsSync(join(store, id, "refstore.lock")))
    ).toBe(true);
    expect(
      existsSync(join(home, ".agent-desktop", "sessions", id, "session.json"))
    ).toBe(false);
  } finally {
    process.env.HOME = before;
  }
});
