import { afterAll, beforeAll } from "bun:test";
// Keep `upstream/` in the state upstream's own tests assume, before and after a
// run. The extension does not run from there — it runs `prebuilt/` — but the
// submodule's npm tests do, and two things break it without being repaired:
//
// - `upstream/tests/npm/wrapper.test.js` treats `upstream/npm/bin` as scratch:
//   its signal test overwrites the darwin binary with a stub and its afterEach
//   unlinks the stub and the helper. A run that reaches it leaves the CLI dead
//   for every later test in the same run, and for a Pi session left open beside
//   it.
// - `upstream/` is a checkout with no root package.json, and upstream does not
//   track one, so its `.js` scripts resolve against this package as ESM and
//   every `require` in them fails. Tests read the files rather than the scripts,
//   so early files fail while later ones pass on whatever an earlier hook wrote.
//
// `bun test` runs no npm `pretest`, so the preloaded beforeAll/afterAll pair is
// the only hook that fires on both sides of a plain `bun test`.
import { spawnSync } from "node:child_process";

// A missing binary for this platform is not a setup failure any more: the
// suites that need the CLI gate on it answering and skip, and the unit tests do
// not touch it. Say so plainly, though, because it is surprising when the whole
// contract suite silently skips on a machine that never built the binaries.
const link = () => {
  const run = spawnSync("node", ["scripts/link-cli.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: "ignore",
  });
  if (run.status !== 0)
    console.warn(
      "tests/setup: no CLI for this platform, so the suites that run it will skip (build it with `npm run link:cli:build`)"
    );
};

beforeAll(link);
afterAll(link);
