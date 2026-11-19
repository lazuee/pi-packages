import { afterAll } from "bun:test";
// Restore the native binaries after a test run.
//
// upstream/tests/npm/wrapper.test.js treats the checkout's `upstream/npm/bin` as
// scratch: its signal test overwrites the darwin binary with a stub and its
// afterEach unlinks the stub and the helper. Nothing puts the real files back, so
// a run that reaches those tests leaves the CLI dead for any Pi session left open
// beside it. `bun test` runs no `pretest`, so this afterAll is the one hook that
// fires at the end of every run under the plain `bun test` this package uses.
import { spawnSync } from "node:child_process";

afterAll(() => {
  const link = spawnSync("node", ["scripts/link-cli.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: "ignore",
  });
  if (link.status !== 0) console.warn("tests/setup: could not restore the CLI");
});
