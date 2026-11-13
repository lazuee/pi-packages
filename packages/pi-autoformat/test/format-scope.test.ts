import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isInFormatScope, resolveFormatScope } from "#src/format-scope";

describe("resolveFormatScope", () => {
  it("uses repo root when detected", () => {
    const scope = resolveFormatScope({
      cwd: "/repo/sub",
      setting: "repoRoot",
      detectGitRoot: () => "/repo",
      platform: "linux",
    });
    expect(scope.roots).toEqual(["/repo"]);
    expect(scope.caseInsensitive).toBe(false);
  });

  it("falls back to cwd when git fails", () => {
    const scope = resolveFormatScope({
      cwd: "/repo/sub",
      setting: "repoRoot",
      detectGitRoot: () => undefined,
      platform: "linux",
    });
    expect(scope.roots).toEqual(["/repo/sub"]);
  });

  it("respects 'cwd' setting", () => {
    const scope = resolveFormatScope({
      cwd: "/repo/sub",
      setting: "cwd",
      detectGitRoot: () => "/repo",
      platform: "linux",
    });
    expect(scope.roots).toEqual(["/repo/sub"]);
  });

  it("resolves array roots relative to cwd", () => {
    const scope = resolveFormatScope({
      cwd: "/repo",
      setting: ["packages/a", "/abs/path"],
      platform: "linux",
    });
    expect(scope.roots).toEqual(["/repo/packages/a", "/abs/path"]);
  });

  it("marks darwin/win32 as case-insensitive", () => {
    expect(
      resolveFormatScope({ cwd: "/x", setting: "cwd", platform: "darwin" })
        .caseInsensitive,
    ).toBe(true);
    expect(
      resolveFormatScope({ cwd: "/x", setting: "cwd", platform: "win32" })
        .caseInsensitive,
    ).toBe(true);
    expect(
      resolveFormatScope({ cwd: "/x", setting: "cwd", platform: "linux" })
        .caseInsensitive,
    ).toBe(false);
  });
});

describe("isInFormatScope", () => {
  it("accepts paths inside the root", () => {
    const scope = { roots: ["/repo"], caseInsensitive: false };
    expect(isInFormatScope("/repo/src/index.ts", scope)).toBe(true);
  });

  it("rejects paths outside the root", () => {
    const scope = { roots: ["/repo"], caseInsensitive: false };
    expect(isInFormatScope("/other/file.ts", scope)).toBe(false);
    expect(isInFormatScope("/tmp/scratch.ts", scope)).toBe(false);
  });

  it("rejects the root itself", () => {
    const scope = { roots: ["/repo"], caseInsensitive: false };
    expect(isInFormatScope("/repo", scope)).toBe(false);
  });

  it("accepts a candidate under any of multiple roots", () => {
    const scope = {
      roots: ["/repo/a", "/repo/b"],
      caseInsensitive: false,
    };
    expect(isInFormatScope("/repo/b/src/x.ts", scope)).toBe(true);
    expect(isInFormatScope("/repo/c/src/x.ts", scope)).toBe(false);
  });

  it("honors case-insensitive comparison on darwin/win32", () => {
    const scope = { roots: ["/Repo"], caseInsensitive: true };
    expect(isInFormatScope("/repo/src/x.ts", scope)).toBe(true);
  });

  it("uses realpath to drop symlinked workspace deps that escape the root", () => {
    // Resolve tmpdir realpath up front so this test exercises the symlink
    // escape check identically on Linux (where /tmp is real) and macOS
    // (where /tmp is a symlink to /private/tmp).
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "pi-autoformat-fmtscope-")),
    );
    const repo = join(root, "repo");
    const external = join(root, "external");
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "lib.js"), "");
    symlinkSync(external, join(repo, "node_modules", "lib"));

    const scope = resolveFormatScope({
      cwd: repo,
      setting: "cwd",
      platform: "linux",
    });
    expect(
      isInFormatScope(join(repo, "node_modules", "lib", "lib.js"), scope),
    ).toBe(false);
  });

  it("includes a symlink whose realpath lands inside the root", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "pi-autoformat-fmtscope-")),
    );
    const repo = join(root, "repo");
    mkdirSync(join(repo, "real"), { recursive: true });
    writeFileSync(join(repo, "real", "x.ts"), "");
    symlinkSync(join(repo, "real"), join(repo, "link"));

    const scope = resolveFormatScope({
      cwd: repo,
      setting: "cwd",
      platform: "linux",
    });
    expect(isInFormatScope(join(repo, "link", "x.ts"), scope)).toBe(true);
  });
});
