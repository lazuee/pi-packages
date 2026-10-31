import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace, WorkspaceDisposeResult } from "#src/lifecycle/workspace";
import { WorkspaceBracket } from "#src/lifecycle/workspace-bracket";
import {
	makeResumableWorkspace,
	makeWorkspace,
	makeWorkspaceProvider,
} from "#test/helpers/make-workspace";

const ctx = {
	agentId: "agent-1",
	agentType: "general-purpose" as const,
	baseCwd: "/parent",
};

/** Construct a bracket over a prepared "/ws/dir" workspace; the act (dispose) stays in each test. */
async function preparedBracket(disposeResult?: WorkspaceDisposeResult) {
	const workspace = makeWorkspace("/ws/dir", disposeResult);
	const bracket = new WorkspaceBracket(() => makeWorkspaceProvider(workspace));
	await bracket.prepare(ctx);
	return { bracket, workspace };
}

describe("WorkspaceBracket — hasProvider", () => {
	it("returns false when no provider is registered", () => {
		const bracket = new WorkspaceBracket(() => undefined);
		expect(bracket.hasProvider()).toBe(false);
	});

	it("returns true when a provider is registered", () => {
		const workspace = makeWorkspace("/ws/dir");
		const bracket = new WorkspaceBracket(() => makeWorkspaceProvider(workspace));
		expect(bracket.hasProvider()).toBe(true);
	});
});

describe("WorkspaceBracket — prepare", () => {
	it("returns undefined when there is no provider", async () => {
		const bracket = new WorkspaceBracket(() => undefined);
		const cwd = await bracket.prepare(ctx);
		expect(cwd).toBeUndefined();
	});

	it("returns the workspace cwd when the provider prepares one", async () => {
		const workspace = makeWorkspace("/ws/dir");
		const bracket = new WorkspaceBracket(() => makeWorkspaceProvider(workspace));
		const cwd = await bracket.prepare(ctx);
		expect(cwd).toBe("/ws/dir");
	});

	it("returns undefined when the provider resolves to undefined", async () => {
		const bracket = new WorkspaceBracket(() => makeWorkspaceProvider(undefined));
		const cwd = await bracket.prepare(ctx);
		expect(cwd).toBeUndefined();
	});

	it("passes the full context to provider.prepare", async () => {
		const workspace = makeWorkspace("/ws/dir");
		const provider = makeWorkspaceProvider(workspace);
		const bracket = new WorkspaceBracket(() => provider);
		await bracket.prepare(ctx);
		expect(provider.prepare).toHaveBeenCalledWith(ctx);
	});
});

describe("WorkspaceBracket — dispose", () => {
	const outcome = { status: "completed" as const, description: "test agent" };

	it("returns empty string when prepare was not called (no workspace)", () => {
		const bracket = new WorkspaceBracket(() => undefined);
		expect(bracket.dispose(outcome)).toBe("");
	});

	it("returns empty string when the provider resolved to undefined", async () => {
		const bracket = new WorkspaceBracket(() => makeWorkspaceProvider(undefined));
		await bracket.prepare(ctx);
		expect(bracket.dispose(outcome)).toBe("");
	});

	it("returns the resultAddendum from the workspace", async () => {
		const { bracket } = await preparedBracket({ resultAddendum: "\n\n---\nsaved to branch foo" });
		const addendum = bracket.dispose(outcome);
		expect(addendum).toBe("\n\n---\nsaved to branch foo");
	});

	it("returns empty string when workspace.dispose returns no addendum", async () => {
		const { bracket } = await preparedBracket();
		expect(bracket.dispose(outcome)).toBe("");
	});

	it("returns empty string when workspace.dispose returns an empty resultAddendum", async () => {
		const { bracket } = await preparedBracket({ resultAddendum: "" });
		expect(bracket.dispose(outcome)).toBe("");
	});

	it("passes the outcome to workspace.dispose", async () => {
		const { bracket, workspace } = await preparedBracket();
		bracket.dispose(outcome);
		expect(workspace.dispose).toHaveBeenCalledWith(outcome);
	});

	it("propagates a throwing dispose (does not swallow)", async () => {
		const workspace: Workspace = {
			cwd: "/ws/dir",
			dispose: vi.fn(() => { throw new Error("dispose failed"); }),
		};
		const bracket = new WorkspaceBracket(() => makeWorkspaceProvider(workspace));
		await bracket.prepare(ctx);
		expect(() => bracket.dispose(outcome)).toThrow("dispose failed");
	});

	it("disposes the workspace only once across repeated calls", async () => {
		const { bracket, workspace } = await preparedBracket({ resultAddendum: "\n\n---\nsaved" });
		expect(bracket.dispose(outcome)).toBe("\n\n---\nsaved");
		expect(bracket.dispose(outcome)).toBe("");
		expect(workspace.dispose).toHaveBeenCalledOnce();
	});
});

describe("WorkspaceBracket — wasDisposed", () => {
	const outcome = { status: "completed" as const, description: "test agent" };

	it("is false on a bracket that never prepared anything", () => {
		expect(new WorkspaceBracket(() => undefined).wasDisposed()).toBe(false);
	});

	it("is false when the provider declined to supply a workspace", async () => {
		const bracket = new WorkspaceBracket(() => makeWorkspaceProvider(undefined));
		await bracket.prepare(ctx);
		bracket.dispose(outcome);
		expect(bracket.wasDisposed()).toBe(false);
	});

	it("is false while a prepared workspace is still held", async () => {
		const { bracket } = await preparedBracket();
		expect(bracket.wasDisposed()).toBe(false);
	});

	it("is true once the prepared workspace has been disposed", async () => {
		const { bracket } = await preparedBracket();
		bracket.dispose(outcome);
		expect(bracket.wasDisposed()).toBe(true);
	});

	it("is true even when the workspace's dispose threw", async () => {
		const workspace: Workspace = {
			cwd: "/ws/dir",
			dispose: vi.fn(() => { throw new Error("dispose failed"); }),
		};
		const bracket = new WorkspaceBracket(() => makeWorkspaceProvider(workspace));
		await bracket.prepare(ctx);
		expect(() => bracket.dispose(outcome)).toThrow("dispose failed");
		// A teardown that failed makes resume no safer than one that succeeded.
		expect(bracket.wasDisposed()).toBe(true);
	});
});

describe("WorkspaceBracket — canResume", () => {
	const outcome = { status: "completed" as const, description: "test agent" };
	let wsDir: string;

	beforeEach(() => {
		wsDir = mkdtempSync(join(tmpdir(), "pi-ws-bracket-"));
	});

	afterEach(() => {
		rmSync(wsDir, { recursive: true, force: true });
	});

	/** A prepared bracket over a resumable workspace at a real temp directory. */
	async function preparedResumableBracket(onResume?: () => void | Promise<void>) {
		const workspace = makeResumableWorkspace(wsDir, { onResume });
		const bracket = new WorkspaceBracket(() => makeWorkspaceProvider(workspace));
		await bracket.prepare(ctx);
		return { bracket, workspace };
	}

	it("is false for a bracket that never prepared anything", () => {
		expect(new WorkspaceBracket(() => undefined).canResume()).toBe(false);
	});

	it("is false for a workspace whose provider declares no resume", async () => {
		const { bracket } = await preparedBracket();
		bracket.dispose(outcome);
		expect(bracket.canResume()).toBe(false);
	});

	it("is false while the workspace is still held", async () => {
		const { bracket } = await preparedResumableBracket();
		expect(bracket.canResume()).toBe(false);
	});

	it("is true after a resumable workspace was disposed", async () => {
		const { bracket } = await preparedResumableBracket();
		bracket.dispose(outcome);
		expect(bracket.canResume()).toBe(true);
	});

	it("is false when the resumable workspace's dispose threw", async () => {
		const workspace = makeResumableWorkspace(wsDir);
		workspace.dispose.mockImplementation(() => { throw new Error("dispose failed"); });
		const bracket = new WorkspaceBracket(() => makeWorkspaceProvider(workspace));
		await bracket.prepare(ctx);
		expect(() => bracket.dispose(outcome)).toThrow("dispose failed");
		// A teardown that failed said nothing about where the work went: no reopen.
		expect(bracket.canResume()).toBe(false);
	});
});

describe("WorkspaceBracket — needsRestore", () => {
	const outcome = { status: "completed" as const, description: "test agent" };
	let wsDir: string;

	beforeEach(() => {
		wsDir = mkdtempSync(join(tmpdir(), "pi-ws-bracket-"));
	});

	afterEach(() => {
		rmSync(wsDir, { recursive: true, force: true });
	});

	async function preparedResumableBracket(onResume?: () => void | Promise<void>) {
		const workspace = makeResumableWorkspace(wsDir, { onResume });
		const bracket = new WorkspaceBracket(() => makeWorkspaceProvider(workspace));
		await bracket.prepare(ctx);
		return { bracket, workspace };
	}

	it("is false before anything was prepared", () => {
		expect(new WorkspaceBracket(() => undefined).needsRestore()).toBe(false);
	});

	it("is false while the workspace is still held — a resume re-enters it as it stands", async () => {
		const { bracket } = await preparedResumableBracket();
		expect(bracket.needsRestore()).toBe(false);
	});

	it("is true once a resumable workspace has been disposed", async () => {
		const { bracket } = await preparedResumableBracket();
		bracket.dispose(outcome);
		expect(bracket.needsRestore()).toBe(true);
	});

	it("is false for a disposed workspace with no way to reopen it", async () => {
		const { bracket } = await preparedBracket();
		bracket.dispose(outcome);
		expect(bracket.needsRestore()).toBe(false);
	});
});

describe("WorkspaceBracket — restore", () => {
	const outcome = { status: "completed" as const, description: "test agent" };
	let wsDir: string;

	beforeEach(() => {
		wsDir = mkdtempSync(join(tmpdir(), "pi-ws-bracket-"));
	});

	afterEach(() => {
		rmSync(wsDir, { recursive: true, force: true });
	});

	async function preparedResumableBracket(onResume?: () => void | Promise<void>) {
		const workspace = makeResumableWorkspace(wsDir, { onResume });
		const bracket = new WorkspaceBracket(() => makeWorkspaceProvider(workspace));
		await bracket.prepare(ctx);
		return { bracket, workspace };
	}

	/** Dispose the held workspace, then reopen it. */
	async function disposedResumableBracket(onResume?: () => void | Promise<void>) {
		const prepared = await preparedResumableBracket(onResume);
		prepared.bracket.dispose(outcome);
		return prepared;
	}

	it("does nothing when there is no workspace to reopen", async () => {
		const bracket = new WorkspaceBracket(() => makeWorkspaceProvider(makeWorkspace(wsDir)));
		await bracket.prepare(ctx);
		bracket.dispose(outcome);
		await expect(bracket.restore()).resolves.toBeUndefined();
		expect(bracket.wasDisposed()).toBe(true);
	});

	it("reopens the disposed workspace once and holds it again", async () => {
		const { bracket, workspace } = await disposedResumableBracket();

		await bracket.restore();

		expect(workspace.resume).toHaveBeenCalledOnce();
		expect(bracket.wasDisposed()).toBe(false);
		expect(bracket.needsRestore()).toBe(false);
		expect(bracket.canResume()).toBe(false);
	});

	it("hands the reopened workspace back to a second disposal", async () => {
		const { bracket, workspace } = await disposedResumableBracket();

		await bracket.restore();
		const addendum = bracket.dispose(outcome);

		expect(addendum).toBe("");
		expect(workspace.dispose).toHaveBeenCalledTimes(2);
		expect(bracket.wasDisposed()).toBe(true);
		expect(bracket.canResume()).toBe(true);
	});

	it("propagates a rejected restore and keeps the workspace reopenable", async () => {
		const { bracket } = await disposedResumableBracket(() => {
			throw new Error("commit is gone");
		});

		await expect(bracket.restore()).rejects.toThrow("commit is gone");

		// Nothing was held: the resumed run must not find a workspace it cannot use.
		expect(bracket.wasDisposed()).toBe(true);
		expect(bracket.needsRestore()).toBe(true);
		// Still reopenable, so the caller's retry is a resume rather than a refusal.
		expect(bracket.canResume()).toBe(true);
	});

	it("reopens on a retry after a rejected restore", async () => {
		let fail = true;
		const { bracket, workspace } = await disposedResumableBracket(() => {
			if (fail) throw new Error("git worktree add failed");
		});

		await expect(bracket.restore()).rejects.toThrow("git worktree add failed");
		fail = false;
		await bracket.restore();

		expect(workspace.resume).toHaveBeenCalledTimes(2);
		expect(bracket.wasDisposed()).toBe(false);
	});

	it("rejects a restore that hands the workspace back at another cwd", async () => {
		const { bracket, workspace } = await disposedResumableBracket(() => {
			workspace.cwd = "/ws/elsewhere";
		});

		await expect(bracket.restore()).rejects.toThrow(
			`came back at "/ws/elsewhere" instead of "${wsDir}"`,
		);
		expect(bracket.wasDisposed()).toBe(true);
		expect(bracket.needsRestore()).toBe(true);
	});

	it("rejects a restore whose cwd is not on disk", async () => {
		const { bracket } = await disposedResumableBracket();
		rmSync(wsDir, { recursive: true, force: true });

		await expect(bracket.restore()).rejects.toThrow("is not a directory");
		expect(bracket.wasDisposed()).toBe(true);
		expect(bracket.needsRestore()).toBe(true);
	});

	it("rejects a restore whose cwd is a file rather than a directory", async () => {
		const { bracket } = await disposedResumableBracket();
		rmSync(wsDir, { recursive: true, force: true });
		writeFileSync(wsDir, "not a directory");

		await expect(bracket.restore()).rejects.toThrow("is not a directory");
	});
});
