import { vi } from "vitest";
import type {
	Workspace,
	WorkspaceDisposeOutcome,
	WorkspaceDisposeResult,
	WorkspacePrepareContext,
} from "#src/lifecycle/workspace";

/**
 * A Workspace stub whose dispose is recorded and returns `disposeResult`.
 *
 * The return type is left unannotated on purpose: annotating it `Workspace`
 * erases the `Mock` methods callers assert on (`toHaveBeenCalledWith`, call
 * counts), which is the whole reason the stub exists.
 */
export function makeWorkspace(cwd: string, disposeResult?: WorkspaceDisposeResult) {
	return {
		cwd,
		dispose: vi.fn(
			(_outcome: WorkspaceDisposeOutcome): WorkspaceDisposeResult | undefined => disposeResult,
		),
	};
}

/**
 * A WorkspaceProvider whose recorded prepare resolves to `workspace`.
 *
 * Pass `undefined` for the provider that declines an agent type — the shape a
 * real provider takes when the agent is not opted into isolation.
 */
export function makeWorkspaceProvider(workspace: Workspace | undefined) {
	return {
		prepare: vi.fn(
			(_ctx: WorkspacePrepareContext): Promise<Workspace | undefined> =>
				Promise.resolve(workspace),
		),
	};
}

/**
 * A Workspace stub that can also be reopened: `onResume` runs on every
 * `resume()`, so a test can recreate the directory the workspace reports,
 * hand it back at another cwd, or reject to fail the restore.
 *
 * The shape is a plain object rather than a `Workspace`, for the same reason as
 * makeWorkspace: the `Mock` methods are what the tests assert on.
 */
export function makeResumableWorkspace(
	cwd: string,
	options: {
		disposeResult?: WorkspaceDisposeResult;
		onResume?: () => void | Promise<void>;
	} = {},
) {
	const { disposeResult, onResume } = options;
	return {
		// Writable on purpose: one test asserts what the bracket does when a
		// restore hands the workspace back at a different directory.
		cwd,
		dispose: vi.fn(
			(_outcome: WorkspaceDisposeOutcome): WorkspaceDisposeResult | undefined => disposeResult,
		),
		resume: vi.fn(async (): Promise<void> => {
			await onResume?.();
		}),
	};
}
