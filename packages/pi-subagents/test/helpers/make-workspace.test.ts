import { describe, expect, it } from "vitest";
import {
	makeResumableWorkspace,
	makeWorkspace,
	makeWorkspaceProvider,
} from "#test/helpers/make-workspace";

const outcome = { status: "completed" as const, description: "test agent" };

describe("makeWorkspace", () => {
	it("exposes the cwd it was built with", () => {
		expect(makeWorkspace("/ws/dir").cwd).toBe("/ws/dir");
	});

	it("disposes to undefined when no dispose result was supplied", () => {
		expect(makeWorkspace("/ws/dir").dispose(outcome)).toBeUndefined();
	});

	it("disposes to the supplied result", () => {
		const workspace = makeWorkspace("/ws/dir", { resultAddendum: "\n\n---\nsaved" });
		expect(workspace.dispose(outcome)).toEqual({ resultAddendum: "\n\n---\nsaved" });
	});

	it("records the outcome it was disposed with", () => {
		const workspace = makeWorkspace("/ws/dir");
		workspace.dispose(outcome);
		expect(workspace.dispose).toHaveBeenCalledWith(outcome);
	});
});

describe("makeWorkspaceProvider", () => {
	it("prepares the workspace it was built with", async () => {
		const workspace = makeWorkspace("/ws/dir");
		const provider = makeWorkspaceProvider(workspace);
		await expect(provider.prepare({ agentId: "a", agentType: "general-purpose", baseCwd: "/p" }))
			.resolves.toBe(workspace);
	});

	it("prepares to undefined for a provider that declines the agent type", async () => {
		const provider = makeWorkspaceProvider(undefined);
		await expect(provider.prepare({ agentId: "a", agentType: "general-purpose", baseCwd: "/p" }))
			.resolves.toBeUndefined();
	});

	it("records the prepare context", async () => {
		const provider = makeWorkspaceProvider(makeWorkspace("/ws/dir"));
		const ctx = { agentId: "a", agentType: "general-purpose" as const, baseCwd: "/p" };
		await provider.prepare(ctx);
		expect(provider.prepare).toHaveBeenCalledWith(ctx);
	});
});

describe("makeResumableWorkspace", () => {
	it("exposes the cwd it was built with", () => {
		expect(makeResumableWorkspace("/ws/dir").cwd).toBe("/ws/dir");
	});

	it("records every resume", async () => {
		const workspace = makeResumableWorkspace("/ws/dir");
		await workspace.resume();
		await workspace.resume();
		expect(workspace.resume).toHaveBeenCalledTimes(2);
	});

	it("runs the supplied onResume hook", async () => {
		const workspace = makeResumableWorkspace("/ws/dir", {
			onResume: () => { workspace.cwd = "/ws/moved"; },
		});
		await workspace.resume();
		expect(workspace.cwd).toBe("/ws/moved");
	});

	it("disposes to the supplied result", () => {
		const workspace = makeResumableWorkspace("/ws/dir", { disposeResult: { resultAddendum: "\n\n---\nsaved" } });
		expect(workspace.dispose(outcome)).toEqual({ resultAddendum: "\n\n---\nsaved" });
	});
});
