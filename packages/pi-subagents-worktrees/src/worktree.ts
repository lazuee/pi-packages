/**
 * worktree.ts — Git worktree isolation for subagents.
 *
 * Creates a temporary git worktree so an agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 * A worktree is only ever removed once its outcome is certain: when cleanup
 * fails partway, it is left on disk so the agent's work stays recoverable.
 *
 * Lifted from the pi-subagents core (Phase 16 Step 3, ADR 0002): git plumbing is
 * a workspace strategy, not core behavior, and now lives behind the
 * WorkspaceProvider seam in this package.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debugLog } from "#src/debug";

/** Name prefix shared by every worktree and branch this package creates. */
export const AGENT_WORKTREE_PREFIX = "pi-agent-";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Preferred branch name for the work it holds (a collision gets a suffix). */
  branch: string;
  /**
   * The commit this worktree currently descends from: the one it was created at,
   * then the one a resume restored it at. Cleanup compares the worktree's HEAD
   * with it to tell a run that changed nothing from one that committed its own
   * work.
   */
  commit: string;
}

/** How a worktree's cleanup ended. Each outcome carries only its own data. */
export type WorktreeCleanupResult =
  /**
   * Nothing was saved: the worktree was removed, and `commit` is the state it
   * held (the commit it started at, when the child changed nothing).
   */
  | { outcome: "clean"; commit: string }
  /**
   * Changes were committed to `branch`, at `commit`; the worktree was removed.
   * `hooksBypassed` records whether the commit hooks had to be skipped.
   */
  | {
      outcome: "committed";
      branch: string;
      commit: string;
      hooksBypassed: boolean;
    }
  /** Cleanup failed partway; the worktree was left at `path` for recovery. */
  | { outcome: "failed"; path: string; error: string };

/**
 * Create a temporary git worktree for an agent, detached at the repository's
 * current commit.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export function createWorktree(
  cwd: string,
  agentId: string,
): WorktreeInfo | undefined {
  // Verify we're in a git repo with at least one commit (HEAD must exist), and
  // take that commit as the worktree's baseline: restoring from it, rather than
  // from whatever HEAD is at the time of the restore, is what makes a reopened
  // worktree the state the child left, not the parent's newer one.
  let commit: string;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    });
    commit = revParseHead(cwd);
  } catch (err) {
    debugLog("createWorktree git rev-parse", err);
    return undefined;
  }

  const branch = `${AGENT_WORKTREE_PREFIX}${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `${branch}-${suffix}`);

  try {
    // Create detached worktree at the commit taken above
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, commit], {
      cwd,
      stdio: "pipe",
      timeout: 30000,
    });
    return { path: worktreePath, branch, commit };
  } catch (err) {
    debugLog("git worktree add", err);
    return undefined;
  }
}

/**
 * Recreate a removed worktree at its own path, detached at exactly `commit`.
 *
 * The path is reused because the child's session is fixed on it — a restore
 * anywhere else would not be where the resumed child runs. It is never
 * overwritten: a directory already at that path may be a preserved worktree
 * holding work no branch reaches, another repository's worktree, or something
 * that has nothing to do with this package, so its presence fails the restore
 * rather than being cleared. Git's own refusal (a commit the object database no
 * longer has, a path it considers occupied) propagates for the same reason.
 */
export function restoreWorktree(
  cwd: string,
  worktreePath: string,
  commit: string,
): void {
  if (existsSync(worktreePath)) {
    throw new Error(
      `Cannot reopen the worktree at \`${worktreePath}\`: the path already exists. ` +
        "Leaving it untouched — remove it yourself if you are sure it holds no work you need.",
    );
  }
  runGit(cwd, ["worktree", "add", "--detach", worktreePath, commit], 30000);
}

/**
 * Clean up a worktree after agent completion.
 * - If the tree is clean and still at the commit it started from: remove the
 *   worktree entirely.
 * - If the tree is clean but its HEAD moved — the child committed its own work —
 *   or has changes: commit what is left, save it to a branch, then remove the
 *   worktree.
 *   A commit hook that rejects the rescue commit is retried past with `--no-verify`.
 * - If any of that fails: leave the worktree in place and report the error.
 */
export function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): WorktreeCleanupResult {
  if (!existsSync(worktree.path)) {
    return { outcome: "failed", path: worktree.path, error: "Worktree disappeared before its changes could be saved." };
  }

  try {
    if (!statusPorcelain(worktree.path)) {
      // A clean tree says nothing about commits: a child that ran `git commit`
      // itself leaves no status behind, and removing the worktree would drop the
      // only reference to that work. Anything past the commit this run started
      // from is the child's, so it is saved to a branch like a dirty tree.
      const head = revParseHead(worktree.path);
      if (head !== worktree.commit) {
        const branch = createBranch(worktree.path, worktree.branch);
        removeWorktree(cwd, worktree.path);
        return {
          outcome: "committed",
          branch,
          commit: head,
          hooksBypassed: false,
        };
      }
      // No changes — remove worktree
      removeWorktree(cwd, worktree.path);
      return { outcome: "clean", commit: head };
    }

    // Changes exist — stage, commit, and create a branch
    stageAll(worktree.path);
    // Truncate description for commit message (no shell sanitization needed — execFileSync uses argv)
    const safeDesc = agentDescription.slice(0, 200);
    const hooksBypassed = commitStaged(worktree.path, `pi-agent: ${safeDesc}`);
    const branch = createBranch(worktree.path, worktree.branch);
    // Read the commit before the worktree goes: it is what a resume restores.
    const commit = revParseHead(worktree.path);

    // Remove the worktree (branch persists in main repo)
    removeWorktree(cwd, worktree.path);

    return { outcome: "committed", branch, commit, hooksBypassed };
  } catch (err) {
    // Never remove a worktree whose fate is uncertain: it can hold work that
    // was never written to the object database, which no `git fsck` recovers.
    // Leave it on disk and report where, so the caller can surface it.
    debugLog("cleanupWorktree", err);
    return {
      outcome: "failed",
      path: worktree.path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Names of this package's branches whose work is not yet on `HEAD`.
 *
 * The glob is built from the shared prefix, so it also covers the
 * `<branch>-<timestamp>` fallback `createBranch` falls back to on a collision.
 * `--no-merged` is what keeps the answer self-validating: a branch drops out
 * the moment its work is merged, with nothing to clear.
 */
export function listUnmergedRescueBranches(cwd: string): string[] {
  return runGit(cwd, [
    "branch",
    "--list",
    `${AGENT_WORKTREE_PREFIX}*`,
    "--no-merged",
    "HEAD",
    "--format=%(refname:short)",
  ])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Paths of every worktree registered with the repository, as git resolves them. */
export function listWorktreePaths(cwd: string): string[] {
  return runGit(cwd, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}

/** Porcelain status of a worktree, trimmed. An empty string means a clean tree. */
function statusPorcelain(worktreePath: string): string {
  return runGit(worktreePath, ["status", "--porcelain"]).trim();
}

/** The commit a worktree's HEAD points at. */
function revParseHead(worktreePath: string): string {
  return runGit(worktreePath, ["rev-parse", "HEAD"]).trim();
}

/** Stage every change in the worktree, including untracked files. */
function stageAll(worktreePath: string): void {
  runGit(worktreePath, ["add", "-A"]);
}

/**
 * Commit the staged snapshot, returning whether hooks had to be bypassed.
 *
 * This commit exists solely to rescue an agent's work, so a hook that rejects
 * it costs the user that work. Retry once past the hooks rather than lose it.
 */
function commitStaged(worktreePath: string, message: string): boolean {
  try {
    runGit(worktreePath, ["commit", "-m", message]);
    return false;
  } catch (err) {
    debugLog("git commit rejected — retrying with --no-verify", err);
    // A hook may have rewritten files (prettier --write, rumdl fmt) before
    // failing; re-stage so those rewrites ride along instead of being lost.
    stageAll(worktreePath);
    runGit(worktreePath, ["commit", "--no-verify", "-m", message]);
    return true;
  }
}

/** Save an immutable result branch, using the native collision suffix when needed. */
function createBranch(worktreePath: string, preferred: string): string {
  try {
    runGit(worktreePath, ["branch", preferred], 5000);
    return preferred;
  } catch (err) {
    debugLog("git branch", err);
    const fallback = `${preferred}-${Date.now()}`;
    runGit(worktreePath, ["branch", fallback], 5000);
    return fallback;
  }
}

/** Run a git command, returning its captured stdout. */
function runGit(cwd: string, args: string[], timeout = 10000): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout }).toString();
}

/**
 * Force-remove a worktree, discarding anything uncommitted in it.
 *
 * Throws when git refuses, so a caller acting on a user's instruction can say
 * why — unlike the internal best-effort removal below.
 */
export function discardWorktree(cwd: string, worktreePath: string): void {
  runGit(cwd, ["worktree", "remove", "--force", worktreePath]);
}

/**
 * Remove a saved worktree; propagate failure so cleanup cannot claim it is gone.
 */
function removeWorktree(cwd: string, worktreePath: string): void {
  try {
    discardWorktree(cwd, worktreePath);
  } catch (err) {
    debugLog("git worktree remove", err);
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch (pruneErr) {
      debugLog("git worktree prune", pruneErr);
    }
    throw err;
  }
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export function pruneWorktrees(cwd: string): void {
  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    });
  } catch (err) {
    debugLog("pruneWorktrees", err);
  }
}
