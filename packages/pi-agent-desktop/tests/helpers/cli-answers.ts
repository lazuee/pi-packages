import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Whether this checkout can actually run the CLI here.
//
// `prebuilt/bin/agent-desktop` is a committed script present on every platform,
// so its existence proves nothing: the native binary beside it is
// platform-suffixed and `prebuilt/` holds only the pair for the machine that
// built it. Anywhere else (CI runs Ubuntu against a darwin-arm64 build) the
// launcher is there and dies on load, which reads as an empty stdout and
// surfaces as `JSON Parse error: Unexpected EOF` far from the cause.
//
// So this probes for an answer, not a file, the same way discovery does: only a
// launcher that really reports a version is trusted. A suite gates on it rather
// than failing for a binary that was never in the tree.
const BIN = fileURLToPath(
  new URL("../../prebuilt/bin/agent-desktop", import.meta.url)
);

export const cliAnswers = (): boolean => {
  const probe = spawnSync(BIN, ["version"], { encoding: "utf-8" });
  if (probe.status !== 0 || !probe.stdout) return false;
  try {
    return Boolean(JSON.parse(probe.stdout).ok);
  } catch {
    return false;
  }
};
