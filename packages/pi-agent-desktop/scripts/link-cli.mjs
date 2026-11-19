// Put the native binary where the launcher looks for it.
//
// The checkout's `upstream/npm/bin` is a launcher plus a copied binary, and
// upstream's own wrapper tests treat that directory as scratch: they unlink the
// installed binary and never put it back, and the signal test overwrites it with
// a stub first. Both the binary and the helper are therefore gone after a run,
// which leaves the CLI dead for every later test in the same run and for a Pi
// session left open beside it. This restores them, building first when a fresh
// checkout has no binary to copy.
//
// Both come from the same build, so a stale one is replaced rather than kept: a
// helper from a different build is refused at run time. Only debug builds are
// used, which is what the contract tests exercise.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const upstream = join(import.meta.dirname, "..", "upstream");
const bin = join(upstream, "npm", "bin");

// The checkout has no root package.json and upstream does not track one, so Node
// resolves upstream/scripts/*.js against this package instead. Without the pin
// they are read as ESM and every `require` in them fails, taking the release
// tests with it. A file tree that loses this only regresses silently, so it is
// written here on every run rather than left to whatever a clone happened to do.
writeFileSync(
  join(upstream, "package.json"),
  `${JSON.stringify({ name: "agent-desktop-upstream", private: true, type: "commonjs" }, null, 2)}\n`
);

// The build artifact keeps its plain name; only the copy the launcher looks for
// carries the platform suffix. The macOS helper needs no suffix.
const link = [
  {
    from: "agent-desktop",
    to: `agent-desktop-${process.platform}-${process.arch}`,
  },
];
if (process.platform === "darwin") {
  link.push({
    from: "agent-desktop-macos-helper",
    to: "agent-desktop-macos-helper",
  });
}

const built = (name) => join(upstream, "target", "debug", name);

if (!link.every(({ from }) => existsSync(built(from)))) {
  const build = spawnSync(
    "cargo",
    ["build", ...link.flatMap(({ from }) => ["--bin", from])],
    { cwd: upstream, stdio: "inherit" }
  );
  if (build.status !== 0) {
    console.error("link-cli: cargo build failed, no binary to link");
    process.exit(build.status ?? 1);
  }
}

mkdirSync(bin, { recursive: true });
let copied = 0;
for (const { from, to } of link) {
  const source = built(from);
  const target = join(bin, to);
  // A copy at least as new as the build is that build's output: skip it, so
  // this stays cheap enough to run after every test run. The stub a test writes
  // is smaller and older than the build, so it is always replaced.
  if (
    existsSync(target) &&
    statSync(target).mtimeMs >= statSync(source).mtimeMs &&
    statSync(target).size === statSync(source).size
  )
    continue;
  copyFileSync(source, target);
  copied += 1;
}
if (copied)
  console.log(`link-cli: restored ${copied} file(s) in upstream/npm/bin`);
