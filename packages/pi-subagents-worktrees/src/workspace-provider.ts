/**
 * workspace-provider.ts — git worktree implementation of the pi-subagents
 * WorkspaceProvider seam (ADR 0002, Phase 16 Step 3).
 *
 * The core consults a registered provider for every child run. This provider
 * isolates a child in a git worktree only when its agent type is opted in via
 * `worktreeAgents`; for any other agent it returns `undefined`, leaving the
 * child to run in the parent cwd. On worktree-creation failure for an opted-in
 * agent it throws, failing the run loudly rather than silently running
 * unisolated (preserving the core's former strict behavior).
 *
 * A prepared worktree is also reopenable: cleanup records the exact commit it
 * left the work at, and a resume restores the worktree at that commit on the
 * same path, because the resumed child's session is fixed on that directory.
 * A cleanup that failed records nothing, so a resume fails closed instead of
 * rebuilding over the work the preserved worktree still holds.
 */

import type {
  Workspace,
  WorkspaceDisposeOutcome,
  WorkspacePrepareContext,
  WorkspaceProvider,
} from "@lazuee/pi-subagents";
import type { ActiveWorktrees } from "#src/active-worktrees";
import type { WorktreesConfig } from "#src/config";
import {
  cleanupWorktree,
  createWorktree,
  restoreWorktree,
  type WorktreeInfo,
} from "#src/worktree";

/** What a cleanup left behind, as a resume needs to know it. */
interface ResumePoint {
  /** The commit the worktree was left at — restores detach here, never at HEAD. */
  commit: string;
}

/** A prepared git worktree plus its bracketed teardown, and its way back in. */
class WorktreeWorkspace implements Workspace {
  private resumePoint?: ResumePoint;

  constructor(
    private readonly repoCwd: string,
    private readonly info: WorktreeInfo,
    private readonly live: ActiveWorktrees,
  ) {}

  /** The worktree directory — already exists when this workspace is handed back. */
  get cwd(): string {
    return this.info.path;
  }

  dispose(
    outcome: WorkspaceDisposeOutcome,
  ): { resultAddendum?: string } | undefined {
    const result = cleanupWorktree(
      this.repoCwd,
      this.info,
      outcome.description,
    );
    // No child is running here any more — a worktree cleanup left behind is a
    // preserved one from this point on, and the scan may report it.
    this.live.remove(this.info.path);
    switch (result.outcome) {
      case "clean":
        // Nothing to save, so a resume restores the state the child started
        // with, at the exact commit this run was created from.
        this.resumePoint = { commit: result.commit };
        return undefined;
      case "committed":
        this.resumePoint = { commit: result.commit };
        {
          const bypassNote = result.hooksBypassed
            ? "\nCommit hooks were bypassed to save this work — review the commit before merging."
            : "";
          return {
            resultAddendum: `\n\n---\nChanges saved to branch \`${result.branch}\`. Merge with: \`git merge ${result.branch}\`${bypassNote}`,
          };
        }
      case "failed":
        // The worktree is still there, holding work no branch reaches and in a
        // state cleanup could not read. Reopening it would mean guessing, so
        // there is no restore point and a resume is refused by the core.
        this.resumePoint = undefined;
        return {
          resultAddendum: `\n\n---\nWorktree cleanup failed; the worktree was left in place at \`${result.path}\` for manual recovery: ${result.error}`,
        };
    }
  }

  /**
   * Recreate the worktree on its own path at the commit cleanup left it at, and
   * mark it live again.
   *
   * A workspace with no restore point — cleanup failed, or never ran — rejects
   * rather than rebuilding from the repository's current HEAD, which would run
   * the resumed child in a tree without its own work.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- the seam contract is async; reopening is synchronous, but staying async ensures a failure rejects the promise the core awaits
  async resume(): Promise<void> {
    const point = this.resumePoint;
    if (!point) {
      throw new Error(
        `Cannot reopen the worktree at \`${this.info.path}\`: no cleanup recorded a commit to restore it from. ` +
          "The work it holds (if any) was never saved, so it is left exactly as it is.",
      );
    }
    restoreWorktree(this.repoCwd, this.info.path, point.commit);
    // Each cycle starts from the previous cycle's exact saved commit.
    this.info.commit = point.commit;
    this.live.add(this.info.path);
  }
}

/** Registers a git worktree per opted-in agent type; runs others in the parent cwd. */
export class WorktreeWorkspaceProvider implements WorkspaceProvider {
  constructor(
    private readonly config: WorktreesConfig,
    private readonly live: ActiveWorktrees,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- the seam contract is async; worktree creation is synchronous, but staying async ensures failures reject the returned promise rather than throwing synchronously at the call site
  async prepare(ctx: WorkspacePrepareContext): Promise<Workspace | undefined> {
    if (!this.config.worktreeAgents.includes(ctx.agentType)) return undefined;

    const info = createWorktree(ctx.baseCwd, ctx.agentId);
    if (!info) {
      throw new Error(
        `Cannot run agent "${ctx.agentType}" with worktree isolation — ` +
          "not a git repo, no commits yet, or `git worktree add` failed. " +
          "Initialize git and commit at least once, or remove the agent from worktreeAgents.",
      );
    }
    this.live.add(info.path);
    return new WorktreeWorkspace(ctx.baseCwd, info, this.live);
  }
}
