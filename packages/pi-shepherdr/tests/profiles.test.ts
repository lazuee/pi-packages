import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The profiles module resolves the agent directory at import time, so each case
 * builds a throwaway one and imports the module fresh against it.
 */
async function withAgentDirectory(run: (agentDirectory: string) => Promise<void>) {
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
	return module as typeof import("../src/profiles.ts");
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
				const installed = readFileSync(installedPath(agentDirectory, name), "utf8");
				const shipped = readFileSync(join(bundled, name, "prompt.md"), "utf8");
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
			const manifestPath = join(agentDirectory, "shepherdr", "profiles-installed.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest["explorer/prompt.md"] = createHash("sha256").update(stale).digest("hex");
			writeFileSync(manifestPath, JSON.stringify(manifest));

			// Point the module at a fake bundle whose explorer prompt moved on.
			const bundle = mkdtempSync(join(tmpdir(), "bundle-"));
			cpSync(bundled, bundle, { recursive: true });
			writeFileSync(join(bundle, "explorer", "prompt.md"), "newer shipped text\n");

			const second = await freshImport(bundle);
			await second.installAgentProfiles();
			rmSync(bundle, { force: true, recursive: true });

			expect(readFileSync(installedPath(agentDirectory, "explorer"), "utf8")).toBe(
				"newer shipped text\n",
			);
		}));

	test("keeps a locally edited file instead of overwriting it", () =>
		withAgentDirectory(async (agentDirectory) => {
			const first = await freshImport();
			await first.installAgentProfiles();

			writeFileSync(installedPath(agentDirectory, "explorer"), "my local edit\n");
			const manifestPath = join(agentDirectory, "shepherdr", "profiles-installed.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest["explorer/prompt.md"] = "0".repeat(64);
			writeFileSync(manifestPath, JSON.stringify(manifest));

			const second = await freshImport();
			await second.installAgentProfiles();

			expect(readFileSync(installedPath(agentDirectory, "explorer"), "utf8")).toBe(
				"my local edit\n",
			);
		}));

	test("records the manifest so the next start has a baseline", () =>
		withAgentDirectory(async (agentDirectory) => {
			const { installAgentProfiles } = await freshImport();
			await installAgentProfiles();

			const manifest = JSON.parse(
				readFileSync(join(agentDirectory, "shepherdr", "profiles-installed.json"), "utf8"),
			);
			expect(Object.keys(manifest)).toContain("explorer/prompt.md");
			expect(manifest["explorer/prompt.md"]).toMatch(/^[a-f0-9]{64}$/);
		}));

	test("is a no-op when nothing changed", () =>
		withAgentDirectory(async (agentDirectory) => {
			const { installAgentProfiles } = await freshImport();
			await installAgentProfiles();
			const before = readFileSync(installedPath(agentDirectory, "reviewer"), "utf8");

			await installAgentProfiles();

			expect(readFileSync(installedPath(agentDirectory, "reviewer"), "utf8")).toBe(before);
		}));

	test("leaves a removed profile alone", () =>
		withAgentDirectory(async (agentDirectory) => {
			const { installAgentProfiles } = await freshImport();
			await installAgentProfiles();
			rmSync(join(agentDirectory, "shepherdr", "profiles", "committer"), { recursive: true });

			await installAgentProfiles();

			expect(() => readFileSync(installedPath(agentDirectory, "committer"), "utf8")).toThrow();
		}));
});

void mkdirSync;
