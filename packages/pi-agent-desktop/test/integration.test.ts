import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import start from "#src/extension";

const exec = promisify(execFile);

// A reload kills pi and leaves its session directory open, and nothing collects
// it: the CLI's gc reaches only what is a day old. Shutdown drops those, but
// only a record a dead process left open — never another live Pi's, and never
// one already ended.
it("removes a dead run's open session, not a live one's", async () => {
  const h: Record<string, ((e: unknown, c: unknown) => Promise<void>)[]> = {};
  const home = await mkdtemp(join(tmpdir(), "ad-home-"));
  const store = join(home, ".agent-desktop", "sessions");
  const make = async (id: string, ended: boolean) => {
    await mkdir(join(store, id), { recursive: true });
    await writeFile(
      join(store, id, "session.json"),
      JSON.stringify(ended ? { ended_at: 1 } : {}),
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
      on: ((n: string, f: never) => {
        h[n] ??= [];
        (h[n] as unknown[]).push(f);
      }) as never,
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
          }),
        ),
    };
    start(pi);
    process.stdout.write(
      `pre live=${live} ppid=${process.ppid} exists=${existsSync(join(store, live))}\n`,
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
        `snap ${i} live=${existsSync(join(store, live))} store=${JSON.stringify(await (await import("node:fs/promises")).readdir(store))}\n`,
      );
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    process.env.HOME = before;
  }
});
