/**
 * workspace.ts — The single generative extension seam (ADR 0002, Phase 16 Step 2).
 *
 * "Where does a child run, and what brackets the run?" is a strategy (git
 * worktree, container, tmpdir, remote sandbox), not core behavior. The core
 * needs only a working directory plus a disposal hook; the default — the
 * parent's cwd, with no setup/teardown — is always correct.
 *
 * Unlike the observational lifecycle events in child-lifecycle.ts, this is a
 * *generative* seam: a registered provider returns a value the core consumes
 * synchronously at run-start. The core has no knowledge of git or worktrees.
 */

import type { SubagentStatus } from "#src/lifecycle/subagent";
import type { SubagentType } from "#src/types";

/** Context the core hands a provider when a child run starts. */
export interface WorkspacePrepareContext {
  agentId: string;
  agentType: SubagentType;
  baseCwd: string;
}

/** Outcome the core reports to a workspace when the run ends. */
export interface WorkspaceDisposeOutcome {
  status: SubagentStatus;
  description: string;
}

/** What dispose may hand back for the core to fold into the child result. */
export interface WorkspaceDisposeResult {
  /** Appended verbatim to the child's result text — the provider owns the wording. */
  resultAddendum?: string;
}

/** A prepared working directory plus its bracketed teardown. Born complete. */
export interface Workspace {
  /** The working directory — already exists when the workspace is handed back. */
  readonly cwd: string;
  dispose(outcome: WorkspaceDisposeOutcome): WorkspaceDisposeResult | undefined;
  /**
   * Bring this workspace back at the same `cwd`, after dispose() tore it down.
   *
   * Declaring it is how a provider says a disposed workspace can be reopened,
   * so a resume of the settled child continues in its own directory instead of
   * being refused as `workspace-disposed`. The contract is the *same* cwd: the
   * child session's working directory is fixed when the session is created, so
   * a workspace handed back at any other path is not where the resumed child
   * would run.
   *
   * Rejecting is how a restore fails — the directory is gone, or the state it
   * has to reproduce (a commit, a snapshot) is no longer available. The core
   * then runs no turn loop and reports the rejection as the resumed run's
   * error, and the workspace stays reopenable, so the caller can retry.
   *
   * Absent means "cannot be reopened": a disposed workspace ends the child's
   * run for good, exactly as it did before this existed. That keeps the seam
   * optional — a provider written against the older contract keeps working.
   */
  resume?(): Promise<void>;
}

/** The single generative seam: supplies a child's workspace. */
export interface WorkspaceProvider {
  prepare(ctx: WorkspacePrepareContext): Promise<Workspace | undefined>;
}
