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
