import { afterAll, beforeAll } from "bun:test";
// Put the checkout back in a working state before and after a run.
//
// Two things upstream's own tests break and never repair:
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

const link = () => {
  const run = spawnSync("node", ["scripts/link-cli.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: "ignore",
  });
  if (run.status !== 0) console.warn("tests/setup: could not restore the CLI");
};

beforeAll(link);
afterAll(link);
