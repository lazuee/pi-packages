/**
 * workspace-bracket.ts — Owned prepare/dispose/resume lifecycle for a child workspace.
 *
 * Captures the provider resolver (not the provider itself) so provider
 * resolution stays lazy at run-start. The prepared Workspace is held
 * privately; dispose() centralises the guard and addendum-unwrap so callers
 * never reach through to workspace.dispose().resultAddendum directly.
 *
 * dispose() is idempotent — a workspace can outlive the run that prepared it
 * (a child holding it for a resume), so more than one lifecycle edge may reach
 * for it — and it deliberately does NOT catch errors: the best-effort
 * try/catch belongs at the call site, preserving the per-caller semantics.
 *
 * A provider whose Workspace also offers resume() can be asked to reopen what
 * its dispose() tore down. The bracket remembers that pair only when the
 * teardown returned, and restore() re-holds the workspace so the resumed run's
 * own terminal edge disposes it like the first one.
 */

import { statSync } from "node:fs";
import type {
	Workspace,
	WorkspaceDisposeOutcome,
	WorkspacePrepareContext,
	WorkspaceProvider,
} from "#src/lifecycle/workspace";

/** A workspace a successful teardown released, with the cwd a restore must reproduce. */
interface ReopenableWorkspace {
	workspace: Workspace;
	/** The cwd the workspace was disposed at — the directory the child's session is fixed on. */
	cwd: string;
	/** The workspace's own way back in, captured so restore() need not re-narrow the optional member. */
	reopen: () => Promise<void>;
}

/** Owns the child workspace lifecycle: prepare at run-start, dispose at run-end, reopen for a resume. */
export class WorkspaceBracket {
	private prepared?: Workspace;
	private disposedWorkspace = false;
	private reopenable?: ReopenableWorkspace;

	constructor(private readonly resolveProvider: () => WorkspaceProvider | undefined) {}

	/**
	 * True once a prepared workspace has been torn down — the directory the run
	 * used is gone. False for a bracket that never held one, and false while one
	 * is still held, so it distinguishes "no workspace" from "workspace removed".
	 */
	wasDisposed(): boolean {
		return this.disposedWorkspace;
	}

	/**
	 * True when a disposed workspace can be brought back for a resume: its
	 * provider declared resume() and its teardown returned.
	 *
	 * A provider without that member keeps the older answer, where a disposed
	 * workspace refuses the resume outright.
	 */
	canResume(): boolean {
		return this.reopenable !== undefined;
	}

	/**
	 * True when a resume has to restore the workspace before its run can start.
	 *
	 * False while a workspace is still held — the question-ending child's case,
	 * which resumes into it as it stands, with nothing to rebuild — and false for
	 * a child that never had one.
	 */
	needsRestore(): boolean {
		return this.prepared === undefined && this.reopenable !== undefined;
	}

	/**
	 * Returns true when a workspace provider is currently registered.
	 * Use to guard the `await prepare(...)` call and avoid an unnecessary
	 * microtask boundary in the no-provider path.
	 */
	hasProvider(): boolean {
		return this.resolveProvider() !== undefined;
	}

	/**
	 * Resolve the registered provider and prepare the child workspace.
	 * Returns the workspace's cwd, or undefined when no provider is registered
	 * or the provider resolves to undefined.
	 */
	async prepare(ctx: WorkspacePrepareContext): Promise<string | undefined> {
		const provider = this.resolveProvider();
		if (!provider) return undefined;
		this.prepared = await provider.prepare(ctx);
		return this.prepared?.cwd;
	}

	/**
	 * Dispose the prepared workspace (if any) and return the result addendum
	 * verbatim. Returns an empty string when no workspace was prepared, when one
	 * was already disposed, or when the workspace returns no addendum.
	 *
	 * The workspace is released and recorded as disposed before it is torn down,
	 * so a provider whose dispose() throws still leaves the bracket reporting a
	 * gone workspace — a failed teardown makes reuse no safer than a clean one.
	 * The throw itself still propagates.
	 *
	 * A teardown that throws also leaves nothing reopenable: the provider said
	 * nothing about where the work it could not clean up ended up, so a resume
	 * must not guess by rebuilding over it.
	 */
	dispose(outcome: WorkspaceDisposeOutcome): string {
		const workspace = this.prepared;
		if (!workspace) return "";
		this.prepared = undefined;
		this.disposedWorkspace = true;
		this.reopenable = undefined;
		const cwd = workspace.cwd;
		const addendum = workspace.dispose(outcome)?.resultAddendum ?? "";
		// Bound here rather than called through the workspace later: the bracket
		// holds the capability, not a receiver it might get wrong.
		const reopen = workspace.resume?.bind(workspace);
		if (reopen) this.reopenable = { workspace, cwd, reopen };
		return addendum;
	}

	/** Validate a held reopenable workspace without adding an asynchronous boundary. */
	validateHeld(): void {
		if (this.prepared?.resume && !isDirectory(this.prepared.cwd)) {
			throw new Error(`Workspace resume failed: "${this.prepared.cwd}" is not a directory.`);
		}
	}

	/**
	 * Bring a disposed workspace back at its original cwd and hold it again, so
	 * the resumed run's terminal edge disposes it like any other.
	 *
	 * Validated rather than trusted, because the resumed child runs in the
	 * directory its session froze at creation: a workspace that reports any other
	 * cwd is not where its next turn would happen, and one that is not on disk
	 * has nothing to run in. Both reject before anything is held, which is what
	 * keeps a failed restore from letting a turn loop run in a directory that
	 * does not exist — and leaves the workspace reopenable, so a retry is a
	 * second resume rather than a lost agent.
	 */
	async restore(): Promise<void> {
		const reopenable = this.reopenable;
		if (!reopenable) return;
		const { workspace, cwd: expectedCwd } = reopenable;
		await reopenable.reopen();
		if (workspace.cwd !== expectedCwd) {
			throw new Error(
				`Workspace resume failed: the workspace came back at "${workspace.cwd}" instead of "${expectedCwd}". ` +
					"A resumed child runs in the directory its session was created in, so it was not started.",
			);
		}
		if (!isDirectory(expectedCwd)) {
			throw new Error(
				`Workspace resume failed: "${expectedCwd}" is not a directory, so the resumed child had nowhere to run.`,
			);
		}
		this.reopenable = undefined;
		this.prepared = workspace;
		this.disposedWorkspace = false;
	}
}

/** True when `path` exists and is a directory. */
function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
