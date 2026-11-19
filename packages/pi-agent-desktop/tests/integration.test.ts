import { it } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import start from "#src/extension";

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

const exec = promisify(execFile);

// A reload kills pi and leaves its session directory open, and nothing collects
// it: the CLI's gc reaches only what is a day old. Shutdown drops those, but
// only a record a dead process left open — never another live Pi's, and never
// one already ended.
it("removes a dead run's open session, not a live one's", async () => {
  const h: Handlers = handlers();
  const home = await mkdtemp(join(tmpdir(), "ad-home-"));
  const store = join(home, ".agent-desktop", "sessions");
  const make = async (id: string, ended: boolean) => {
    await mkdir(join(store, id), { recursive: true });
    await writeFile(
      join(store, id, "session.json"),
      JSON.stringify(ended ? { ended_at: 1 } : {})
    );
  };
  const open = "run-1-2000001-0"; // well past any live pid
  const ended = "run-2-1000-0";
  // A pid that exists but has no session directory behind its name: another
  // live Pi is the case that must survive. The parent is the only pid certain to
  // exist while a worker or fork runs the file.
  const live = `run-3-${process.ppid}-0`;
  await make(open, false);
  await make(ended, true);
  await make(live, false);
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const pi: any = {
      registerTool: () => {},
      on: (n: keyof Handlers, f: Handler) => {
        // Newest handler first, so the real one is `[0]` over the placeholder.
        h[n].unshift(f);
      },
      exec: (bin: string, args: string[]) =>
        exec(bin, args, { env: { ...process.env, HOME: home } }).then(
          (v) => ({
            code: 0,
            stdout: v.stdout,
            stderr: v.stderr,
            killed: false,
            truncated: false,
          }),
          () => ({
            code: 1,
            stdout: "",
            stderr: "",
            killed: false,
            truncated: false,
          })
        ),
    };
    start(pi);
    process.stdout.write(
      `pre live=${live} ppid=${process.ppid} exists=${existsSync(join(store, live))}\n`
    );
    const ctx: any = {
      hasUI: false,
      mode: "tui",
      ui: { setStatus: () => {}, notify: () => {} },
    };
    await h.session_start[0]({ reason: "startup" }, ctx);
    await h.session_shutdown[0]({}, ctx);
    // rm is recursive and resolves before its last entry is gone, so both sides
    // are polled rather than read once.
    for (let i = 0; i < 4; i += 1) {
      process.stdout.write(
        `snap ${i} live=${existsSync(join(store, live))} store=${JSON.stringify(await (await import("node:fs/promises")).readdir(store))}\n`
      );
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    process.env.HOME = before;
  }
});
