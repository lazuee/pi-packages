// Rewrites the aggregate bundle so it can be published standalone.
//
// In the workspace `@lazuee/pi-extensions` imports its siblings through the
// `@lazuee/*` package names resolved from local symlinks. When the bundle is
// packed for registry install, those names resolve to whatever versions the
// registry has, so each sibling is pinned to the version this monorepo ships.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const aggregate = join(root, "packages", "pi-extensions");
const manifestPath = join(aggregate, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

const dependencies = manifest.dependencies ?? {};
for (const name of Object.keys(dependencies)) {
  if (!name.startsWith("@lazuee/")) continue;
  const sibling = join(root, "packages", name.slice("@lazuee/".length));
  const { version } = JSON.parse(
    readFileSync(join(sibling, "package.json"), "utf-8")
  );
  dependencies[name] = version;
}

manifest.dependencies = Object.fromEntries(
  Object.entries(dependencies).toSorted(([a], [b]) => a.localeCompare(b))
);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
