// Put the native binary where the launcher looks for it.
//
// The binary is not built here by default. `prebuilt/` holds the committed ones,
// so a checkout works with no Rust toolchain and a published package ships a
// working CLI. `--build` compiles from `upstream/` instead and rewrites
// `prebuilt/`, which is what to run after moving the submodule: the two are
// synced by hand, on purpose, rather than one drifting from the other silently.
//
// Nothing is written inside `upstream/` that can be avoided, so `git status`
// there stays clean. Two things still are, both unavoidable: `npm/bin` is where
// the launcher looks, and upstream does not track a root package.json.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const build = process.argv.includes("--build");
const root = join(import.meta.dirname, "..");
const upstream = join(root, "upstream");
const prebuilt = join(root, "prebuilt");
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

// The macOS helper needs no platform suffix; the CLI does, and this machine's
// pair is the only one `prebuilt/` holds.
const pair = [
  {
    artifact: "agent-desktop",
    name: `agent-desktop-${process.platform}-${process.arch}`,
  },
];
if (process.platform === "darwin")
  pair.push({
    artifact: "agent-desktop-macos-helper",
    name: "agent-desktop-macos-helper",
  });

if (build) {
  const cargo = spawnSync(
    "cargo",
    [
      "build",
      "--release",
      ...pair.flatMap(({ artifact }) => ["--bin", artifact]),
    ],
    { cwd: upstream, stdio: "inherit" }
  );
  if (cargo.status !== 0) {
    console.error("link-cli: cargo build failed, nothing to install");
    process.exit(cargo.status ?? 1);
  }
  mkdirSync(prebuilt, { recursive: true });
  for (const { artifact, name } of pair)
    copyFileSync(
      join(upstream, "target", "release", artifact),
      join(prebuilt, name)
    );
  console.log(
    `link-cli: rebuilt prebuilt/${pair.map((p) => p.name).join(", ")}`
  );
}

mkdirSync(bin, { recursive: true });
let copied = 0;
for (const { name } of pair) {
  const source = join(prebuilt, name);
  const target = join(bin, name);
  if (!existsSync(source)) {
    console.error(
      `link-cli: prebuilt/${name} is missing for this platform; run with --build on a machine that has the toolchain`
    );
    process.exit(1);
  }
  // An identical copy is already installed: skip it, so this stays cheap enough
  // to run either side of a test run. The stub a test writes differs in size.
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
  console.log(`link-cli: installed ${copied} file(s) into upstream/npm/bin`);
