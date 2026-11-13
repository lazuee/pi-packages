import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createCachedCommandProbe,
  defaultCommandProbe,
} from "#src/command-probe";

const previousPath = process.env.PATH;

/** Probe roots made by a test, removed after it. */
const probeRoots: string[] = [];

/** mkdtemp under tmp, tracked for cleanup. */
function probeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-autoformat-probe-"));
  probeRoots.push(dir);
  return dir;
}

afterEach(() => {
  process.env.PATH = previousPath;
  for (const dir of probeRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("defaultCommandProbe", () => {
  it("finds an executable on PATH", () => {
    const root = probeRoot();
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const exe = join(bin, "fakefmt");
    writeFileSync(exe, "#!/bin/sh\nexit 0\n");
    chmodSync(exe, 0o755);

    process.env.PATH = bin;
    expect(defaultCommandProbe("fakefmt")).toBe(true);
  });

  it("returns false for a command not on PATH", () => {
    const root = probeRoot();
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    process.env.PATH = bin;
    expect(defaultCommandProbe("definitely-not-installed-xyz")).toBe(false);
  });

  it("accepts an absolute path that points at an executable", () => {
    const root = probeRoot();
    const exe = join(root, "fakefmt");
    writeFileSync(exe, "#!/bin/sh\nexit 0\n");
    chmodSync(exe, 0o755);

    expect(defaultCommandProbe(exe)).toBe(true);
  });

  it("returns false for an absolute path that does not exist", () => {
    expect(defaultCommandProbe("/no/such/binary/please")).toBe(false);
  });

  it("returns false for a non-executable file on PATH", () => {
    const root = probeRoot();
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const file = join(bin, "notexec");
    writeFileSync(file, "");
    chmodSync(file, 0o644);
    process.env.PATH = bin;

    expect(defaultCommandProbe("notexec")).toBe(false);
  });
});

describe("createCachedCommandProbe", () => {
  it("caches per-command results across calls", () => {
    let calls = 0;
    const cached = createCachedCommandProbe((command) => {
      calls += 1;
      return command === "yes";
    });

    expect(cached("yes")).toBe(true);
    expect(cached("yes")).toBe(true);
    expect(cached("no")).toBe(false);
    expect(cached("no")).toBe(false);
    expect(calls).toBe(2);
  });
});
