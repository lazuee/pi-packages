// Put the native binary where the launcher looks for it.
//
// Nothing is compiled by default. `prebuilt/` is a self-contained copy of the
// upstream npm package — its launcher, its lib, the binaries under `bin/` — so a
// checkout needs no Rust toolchain and a published package ships a working CLI
// with no submodule. `--build` compiles from `upstream/` and rewrites those
// binaries, which is what to run after moving the submodule: the two are synced
// by hand, on purpose, rather than one drifting from the other silently.
//
// Nothing is written inside `upstream/` that can be avoided, so `git status`
// there stays clean. Two things still are, both unavoidable: `npm/bin` is where
// the launcher looks, and upstream does not track a root package.json.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const build = process.argv.includes("--build");
const root = join(import.meta.dirname, "..");
const upstream = join(root, "upstream");
const prebuilt = join(root, "prebuilt", "bin");
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
  // The launcher, its lib and the npm manifest it reads belong to the same
  // release as the binaries, so a sync refreshes them too rather than letting a
  // newer launcher drift onto an older binary.
  const npm = join(upstream, "npm");
  copyFileSync(
    join(npm, "bin", "agent-desktop"),
    join(prebuilt, "agent-desktop")
  );
  copyFileSync(
    join(npm, "package.json"),
    join(root, "prebuilt", "package.json")
  );
  cpSync(join(npm, "lib"), join(root, "prebuilt", "lib"), { recursive: true });
  for (const { artifact, name } of pair)
    copyFileSync(
      join(upstream, "target", "release", artifact),
      join(prebuilt, name)
    );
  console.log(
    `link-cli: rebuilt prebuilt/bin/${pair.map((p) => p.name).join(", ")}`
  );
}

mkdirSync(bin, { recursive: true });
let copied = 0;
for (const { name } of pair) {
  const source = join(prebuilt, name);
  const target = join(bin, name);
  if (!existsSync(source)) {
    console.error(
      `link-cli: prebuilt/bin/${name} is missing for this platform; run with --build on a machine that has the toolchain`
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
