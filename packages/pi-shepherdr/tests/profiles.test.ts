import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as Profiles from "../src/profiles.ts";

/**
 * Each case builds a throwaway agent directory and points the module at it for
 * the duration.
 */
async function withAgentDirectory(
  run: (agentDirectory: string) => Promise<void>
) {
  const directory = mkdtempSync(join(tmpdir(), "profiles-"));
  const previous = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = directory;
  try {
    await run(directory);
  } finally {
    if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previous;
    rmSync(directory, { force: true, recursive: true });
  }
}

const profilesModule = join(import.meta.dir, "..", "src", "profiles.ts");

async function freshImport(bundle?: string) {
  if (bundle === undefined) delete process.env["PI_SHEPHERDR_PROFILES"];
  else process.env["PI_SHEPHERDR_PROFILES"] = bundle;
  const module = await import(`${profilesModule}?case=${crypto.randomUUID()}`);
  return module as typeof Profiles;
}

const bundled = join(import.meta.dir, "..", "profiles");

function installedPath(agentDirectory: string, name: string) {
  return join(agentDirectory, "shepherdr", "profiles", name, "prompt.md");
}

afterEach(() => {});

describe("profile installation", () => {
  test("seeds every bundled profile on a fresh install", () =>
    withAgentDirectory(async (agentDirectory) => {
      const { installAgentProfiles } = await freshImport();
      await installAgentProfiles();

      for (const name of ["explorer", "general", "reviewer", "committer"]) {
        const installed = readFileSync(
          installedPath(agentDirectory, name),
          "utf-8"
        );
        const shipped = readFileSync(join(bundled, name, "prompt.md"), "utf-8");
        expect(installed).toBe(shipped);
      }
    }));

  test("rolls a shipped edit forward when the installed copy is untouched", () =>
    withAgentDirectory(async (agentDirectory) => {
      const first = await freshImport();
      await first.installAgentProfiles();

      // The install matches what the old bundle shipped; the new bundle differs.
      const stale = "older shipped text\n";
      writeFileSync(installedPath(agentDirectory, "explorer"), stale);
      const manifestPath = join(
        agentDirectory,
        "shepherdr",
        "profiles-installed.json"
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      manifest["explorer/prompt.md"] = createHash("sha256")
        .update(stale)
        .digest("hex");
      writeFileSync(manifestPath, JSON.stringify(manifest));

      // Point the module at a fake bundle whose explorer prompt moved on.
      const bundle = mkdtempSync(join(tmpdir(), "bundle-"));
      cpSync(bundled, bundle, { recursive: true });
      writeFileSync(
        join(bundle, "explorer", "prompt.md"),
        "newer shipped text\n"
      );

      const second = await freshImport(bundle);
      await second.installAgentProfiles();
      rmSync(bundle, { force: true, recursive: true });

      expect(
        readFileSync(installedPath(agentDirectory, "explorer"), "utf-8")
      ).toBe("newer shipped text\n");
    }));

  test("keeps a locally edited file instead of overwriting it", () =>
    withAgentDirectory(async (agentDirectory) => {
      const first = await freshImport();
      await first.installAgentProfiles();

      writeFileSync(
        installedPath(agentDirectory, "explorer"),
        "my local edit\n"
      );
      const manifestPath = join(
        agentDirectory,
        "shepherdr",
        "profiles-installed.json"
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      manifest["explorer/prompt.md"] = "0".repeat(64);
      writeFileSync(manifestPath, JSON.stringify(manifest));

      const second = await freshImport();
      await second.installAgentProfiles();

      expect(
        readFileSync(installedPath(agentDirectory, "explorer"), "utf-8")
      ).toBe("my local edit\n");
    }));

  test("delivers a file the bundle grew after the last install", () =>
    withAgentDirectory(async (agentDirectory) => {
      // An install seeded by a bundle from before the file existed.
      const before = mkdtempSync(join(tmpdir(), "bundle-"));
      cpSync(bundled, before, { recursive: true });
      rmSync(join(before, "committer", "plugin.mjs"));
      const manifestSeed = await freshImport(before);
      await manifestSeed.installAgentProfiles();
      expect(() =>
        readFileSync(
          join(
            agentDirectory,
            "shepherdr",
            "profiles",
            "committer",
            "plugin.mjs"
          )
        )
      ).toThrow();

      // The next bundle ships it; the install was never edited, so it arrives.
      const second = await freshImport(bundled);
      await second.installAgentProfiles();
      rmSync(before, { force: true, recursive: true });

      expect(
        readFileSync(
          join(
            agentDirectory,
            "shepherdr",
            "profiles",
            "committer",
            "plugin.mjs"
          ),
          "utf-8"
        )
      ).toContain("pi.dev");
    }));

  test("records the manifest so the next start has a baseline", () =>
    withAgentDirectory(async (agentDirectory) => {
      const { installAgentProfiles } = await freshImport();
      await installAgentProfiles();

      const manifest = JSON.parse(
        readFileSync(
          join(agentDirectory, "shepherdr", "profiles-installed.json"),
          "utf-8"
        )
      );
      expect(Object.keys(manifest)).toContain("explorer/prompt.md");
      expect(manifest["explorer/prompt.md"]).toMatch(/^[a-f0-9]{64}$/);
    }));

  test("is a no-op when nothing changed", () =>
    withAgentDirectory(async (agentDirectory) => {
      const { installAgentProfiles } = await freshImport();
      await installAgentProfiles();
      const before = readFileSync(
        installedPath(agentDirectory, "reviewer"),
        "utf-8"
      );

      await installAgentProfiles();

      expect(
        readFileSync(installedPath(agentDirectory, "reviewer"), "utf-8")
      ).toBe(before);
    }));

  test("reinstalls a bundled profile that was deleted from the install", () =>
    withAgentDirectory(async (agentDirectory) => {
      // A deleted profile keeps its manifest entries, which used to leave it
      // gone for good while element-based guidance still offered it.
      const { installAgentProfiles } = await freshImport();
      await installAgentProfiles();
      const target = join(agentDirectory, "shepherdr", "profiles", "committer");
      rmSync(target, { recursive: true });

      await installAgentProfiles();

      expect(readFileSync(join(target, "plugin.mjs"), "utf-8")).toContain(
        "pi.dev"
      );
    }));

  test("leaves a removed profile file inside a kept profile alone", () =>
    withAgentDirectory(async (agentDirectory) => {
      const { installAgentProfiles } = await freshImport();
      await installAgentProfiles();
      rmSync(installedPath(agentDirectory, "committer"));

      await installAgentProfiles();

      expect(() =>
        readFileSync(installedPath(agentDirectory, "committer"), "utf-8")
      ).toThrow();
    }));
});

void mkdirSync;
