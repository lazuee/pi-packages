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
 *
 * A child opted into `herdrAgents` additionally gets a herdr pane of its own to be
 * watched in, when the parent runs inside herdr. The pane is orthogonal to the
 * worktree: the child still runs in-process and in its worktree, the pane only
 * follows its transcript.
 */

import type {
  Workspace,
  WorkspaceDisposeOutcome,
  WorkspacePrepareContext,
  WorkspaceProvider,
} from "@lazuee/pi-subagents";
import type { ActiveWorktrees } from "#src/active-worktrees";
import type { WorktreesConfig } from "#src/config";
import { type ChildPane, openPane } from "#src/herdr-panes";
import {
  cleanupWorktree,
  createWorktree,
  restoreWorktree,
  type WorktreeInfo,
} from "#src/worktree";

/**
 * True when a dispose reports a child that is still going.
 *
 * A background child's tool call returns when it is spawned, not when it ends. The
 * pane keeps following while that is possible, so it is not frozen mid-run.
 */
export function childStillRunning(outcome: WorkspaceDisposeOutcome): boolean {
  return outcome.status === "running";
}

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
    private readonly pane?: ChildPane,
  ) {}

  /** The worktree directory — already exists when this workspace is handed back. */
  get cwd(): string {
    return this.info.path;
  }

  /** Point the pane at the child's transcript once its session directory exists. */
  followSession(sessionDir: string): void {
    this.pane?.follow(sessionDir);
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
    // The pane note is written after the switch so it can carry where the work
    // went: a human watching the pane reads that, not the agent's result.
    const note = (detail?: string) => {
      const line = detail
        ? `${outcome.status}: ${outcome.description} — ${detail}`
        : `${outcome.status}: ${outcome.description}`;
      this.pane?.finish(line, childStillRunning(outcome));
    };
    switch (result.outcome) {
      case "clean":
        // Nothing to save, so a resume restores the state the child started
        // with, at the exact commit this run was created from.
        this.resumePoint = { commit: result.commit };
        note();
        return undefined;
      case "committed":
        this.resumePoint = { commit: result.commit };
        {
          const bypassNote = result.hooksBypassed
            ? "\nCommit hooks were bypassed to save this work — review the commit before merging."
            : "";
          note(`saved to branch ${result.branch}${result.hooksBypassed ? " (hooks bypassed)" : ""}`);
          return {
            resultAddendum: `\n\n---\nChanges saved to branch \`${result.branch}\`. Merge with: \`git merge ${result.branch}\`${bypassNote}`,
          };
        }
      case "failed":
        // The worktree is still there, holding work no branch reaches and in a
        // state cleanup could not read. Reopening it would mean guessing, so
        // there is no restore point and a resume is refused by the core.
        this.resumePoint = undefined;
        note(`left in place at ${result.path}`);
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

  async prepare(ctx: WorkspacePrepareContext): Promise<Workspace | undefined> {
    const pane = this.config.herdrAgents?.includes(ctx.agentType)
      ? await openPane(ctx.agentType, ctx.baseCwd)
      : undefined;

    if (!this.config.worktreeAgents.includes(ctx.agentType)) {
      // No worktree wanted, but a pane may still have been opened. The provider
      // has to hand back a workspace for the pane to outlive this call, so it
      // returns one over the parent cwd with no teardown of its own.
      return pane ? new PanedCwdWorkspace(ctx.baseCwd, pane) : undefined;
    }

    const info = createWorktree(ctx.baseCwd, ctx.agentId);
    if (!info) {
      pane?.finish(`failed: no worktree from ${ctx.baseCwd}`);
      throw new Error(
        `Cannot run agent "${ctx.agentType}" with worktree isolation in \`${ctx.baseCwd}\` — ` +
          "not a git repo, no commits yet, or `git worktree add` failed. " +
          "Start pi inside the repository, commit at least once, or remove the agent from worktreeAgents.",
      );
    }
    this.live.add(info.path);
    return new WorktreeWorkspace(ctx.baseCwd, info, this.live, pane);
  }
}

/** A child in the parent cwd that only carries a pane — no teardown to do. */
export class PanedCwdWorkspace implements Workspace {
  constructor(
    readonly cwd: string,
    private readonly pane: ChildPane,
  ) {}

  followSession(sessionDir: string): void {
    this.pane.follow(sessionDir);
  }

  dispose(outcome: WorkspaceDisposeOutcome): undefined {
    this.pane.finish(`${outcome.status}: ${outcome.description}`, childStillRunning(outcome));
    return undefined;
  }
}
