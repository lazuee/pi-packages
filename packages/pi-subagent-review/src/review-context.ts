import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { JjReviewContext, ReviewContext } from "./types.js";

const JJ_READ_ONLY = ["--ignore-working-copy", "--color=never"];

async function runGit(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  timeout = 10_000
) {
  return pi.exec("git", args, { cwd, timeout });
}

async function runJj(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  timeout = 10_000
) {
  return pi.exec("jj", [...JJ_READ_ONLY, ...args], { cwd, timeout });
}

async function gitString(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  timeout = 10_000
): Promise<string> {
  const result = await runGit(pi, cwd, args, timeout);
  if (result.code !== 0) {
    const command = `git ${args.join(" ")}`;
    const message =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `${command} failed with exit code ${result.code}`;
    throw new Error(message);
  }
  return result.stdout.trim();
}

async function gitStringOrUndefined(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  timeout = 10_000
): Promise<string | undefined> {
  const result = await runGit(pi, cwd, args, timeout);
  if (result.code !== 0) return undefined;
  return result.stdout.trim();
}

async function hasGitCommit(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  const result = await runGit(pi, cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD",
  ]);
  return result.code === 0;
}

async function hasLocalBranch(
  pi: ExtensionAPI,
  cwd: string,
  branch: "main" | "master" | "dev"
): Promise<boolean> {
  const refResult = await runGit(pi, cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (refResult.code !== 0) return false;

  const objectName = refResult.stdout.trim();
  if (!objectName) return false;
  const commitResult = await runGit(pi, cwd, [
    "cat-file",
    "-e",
    `${objectName}^{commit}`,
  ]);
  return commitResult.code === 0;
}

async function countTrackedChangesSince(
  pi: ExtensionAPI,
  cwd: string,
  revision: string
): Promise<number | undefined> {
  const result = await runGit(pi, cwd, [
    "diff",
    "--name-only",
    revision,
    "HEAD",
  ]);
  if (result.code !== 0) return undefined;
  return result.stdout.split("\n").filter(Boolean).length;
}

async function countUnpushedCommits(
  pi: ExtensionAPI,
  cwd: string
): Promise<number | undefined> {
  const upstream = await gitStringOrUndefined(pi, cwd, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (!upstream) return undefined;
  const result = await runGit(pi, cwd, [
    "rev-list",
    "--count",
    `${upstream}..HEAD`,
  ]);
  if (result.code !== 0) return undefined;
  const count = Math.trunc(Number(result.stdout.trim()));
  return Number.isFinite(count) ? count : undefined;
}

interface WorktreeState {
  staged: number;
  sinceBase: number | undefined;
  unpushed: number | undefined;
  untracked: number;
  total: number;
  stagedSample: string[];
}

const SAMPLE_LIMIT = 4;
const SAMPLE_TIMEOUT_MS = 2500;

// Reviewers triage commit messages and file names cheaply, so the widget can
// show what was picked and keep the command visibly busy instead of silent.
function sampleItems(items: string[]): string[] {
  const sample = items.slice(0, SAMPLE_LIMIT);
  if (items.length > SAMPLE_LIMIT)
    sample.push(`+${items.length - SAMPLE_LIMIT} more`);
  return sample;
}

async function readWorktreeState(
  pi: ExtensionAPI,
  repoRoot: string,
  mergeBase: string | undefined
): Promise<WorktreeState> {
  const [stagedNames, sinceBase, unpushed, untrackedNames] = await Promise.all([
    runGit(pi, repoRoot, ["diff", "--cached", "--name-only"]).then((result) =>
      result.code === 0 ? result.stdout.split("\n").filter(Boolean) : []
    ),
    mergeBase ? countTrackedChangesSince(pi, repoRoot, mergeBase) : undefined,
    countUnpushedCommits(pi, repoRoot),
    runGit(pi, repoRoot, ["ls-files", "--others", "--exclude-standard"]).then(
      (result) =>
        result.code === 0 ? result.stdout.split("\n").filter(Boolean) : []
    ),
  ]);
  const total = (sinceBase ?? 0) + (stagedNames?.length ?? 0);
  return {
    staged: stagedNames.length,
    sinceBase,
    unpushed,
    untracked: untrackedNames.length,
    total: total || stagedNames.length,
    stagedSample: sampleItems(stagedNames),
  };
}

async function readCommitsForReview(
  pi: ExtensionAPI,
  repoRoot: string,
  commitish: string
): Promise<string[]> {
  const result = await runGit(
    pi,
    repoRoot,
    ["log", "-n", "5", "--format=%s", commitish],
    SAMPLE_TIMEOUT_MS
  );
  if (result.code !== 0) return [];
  return sampleItems(result.stdout.split("\n").filter(Boolean));
}

async function hasTrackedChangesAgainst(
  pi: ExtensionAPI,
  cwd: string,
  revision: string
): Promise<boolean> {
  const result = await runGit(pi, cwd, ["diff", "--quiet", revision]);
  if (result.code === 0) return false;
  if (result.code === 1) return true;
  throw new Error(
    result.stderr.trim() ||
      `git diff --quiet ${revision} failed with exit code ${result.code}`
  );
}

async function detectJjWorkspace(
  pi: ExtensionAPI,
  cwd: string
): Promise<string | undefined> {
  const result = await runJj(pi, cwd, ["workspace", "root"]);
  if (result.code === 0) return result.stdout.trim() || undefined;

  const message = result.stderr.trim() || result.stdout.trim();
  if (hasJjMetadata(cwd)) {
    throw new Error(
      message ||
        "JJ workspace detection failed. Resolve the JJ workspace before running /review."
    );
  }
  return undefined;
}

function hasJjMetadata(cwd: string): boolean {
  let directory = resolve(cwd);
  while (true) {
    if (existsSync(join(directory, ".jj"))) return true;
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}
async function jjString(
  pi: ExtensionAPI,
  cwd: string,
  args: string[]
): Promise<string> {
  const result = await runJj(pi, cwd, args);
  if (result.code === 0) return result.stdout.trim();
  const command = `jj ${[...JJ_READ_ONLY, ...args].join(" ")}`;
  throw new Error(
    result.stderr.trim() ||
      result.stdout.trim() ||
      `${command} failed with exit code ${result.code}`
  );
}

async function resolveSingleJjRevision(
  pi: ExtensionAPI,
  cwd: string,
  revset: string
): Promise<{ changeId: string; commitId: string }> {
  const output = await jjString(pi, cwd, [
    "log",
    "-r",
    revset,
    "--no-graph",
    "--template",
    'change_id ++ "\\n" ++ commit_id ++ "\\n"',
  ]);
  const lines = output.split("\n").filter(Boolean);
  if (lines.length !== 2 || !lines[0] || !lines[1]) {
    throw new Error(
      `JJ review base ${JSON.stringify(revset)} must resolve to exactly one revision.`
    );
  }
  return { changeId: lines[0], commitId: lines[1] };
}

interface JjRevision {
  changeId: string;
  commitId: string;
  parentChangeIds: string[];
  parentCommitIds: string[];
}

async function readJjRevision(
  pi: ExtensionAPI,
  cwd: string,
  revision: string
): Promise<JjRevision> {
  const output = await jjString(pi, cwd, [
    "log",
    "-r",
    revision,
    "--no-graph",
    "--template",
    'change_id ++ "\\n" ++ commit_id ++ "\\n" ++ parents.map(|p| p.change_id()).join(",") ++ "\\n" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\n" ++ if(conflict, "true", "false") ++ "\\n"',
  ]);
  const [changeId, commitId, parentChanges = "", parentCommits = "", conflict] =
    output.split("\n");
  if (!changeId || !commitId || !conflict) {
    throw new Error("Could not identify the selected JJ revision for /review.");
  }
  if (conflict === "true") {
    throw new Error(
      `JJ revision ${changeId} (${
        commitId
      }) has conflicts. Resolve them before running /review.`
    );
  }
  return {
    changeId,
    commitId,
    parentChangeIds: parentChanges ? parentChanges.split(",") : [],
    parentCommitIds: parentCommits ? parentCommits.split(",") : [],
  };
}

async function jjDiffSummary(
  pi: ExtensionAPI,
  cwd: string,
  commitId: string,
  baseCommitId?: string
): Promise<string> {
  return jjString(
    pi,
    cwd,
    baseCommitId
      ? ["diff", "--from", baseCommitId, "--to", commitId, "--summary"]
      : ["diff", "-r", commitId, "--summary"]
  );
}

async function detectJjReviewContext(
  pi: ExtensionAPI,
  repoRoot: string,
  stackBase?: string
): Promise<JjReviewContext> {
  const active = await readJjRevision(pi, repoRoot, "@");
  let target = active;
  let base:
    | { revision: string; changeId: string; commitId: string }
    | undefined;
  if (stackBase) {
    const resolved = await resolveSingleJjRevision(pi, repoRoot, stackBase);
    if (resolved.commitId === active.commitId) {
      throw new Error(
        `JJ review stack base ${JSON.stringify(
          stackBase
        )} is the active revision. Choose an ancestor instead.`
      );
    }
    const ancestor = await jjString(pi, repoRoot, [
      "log",
      "-r",
      ["ancestors(", active.commitId, ") & ", resolved.commitId].join(""),
      "--no-graph",
      "--template",
      "commit_id",
    ]);
    if (ancestor !== resolved.commitId) {
      throw new Error(
        `JJ review stack base ${JSON.stringify(
          stackBase
        )} must be an ancestor of active revision ${active.changeId}.`
      );
    }
    base = { revision: stackBase, ...resolved };
  }

  let changedFiles = await jjDiffSummary(
    pi,
    repoRoot,
    target.commitId,
    base?.commitId
  );
  if (!base && !changedFiles && active.parentCommitIds.length === 1) {
    const [parentCommitId] = active.parentCommitIds;
    if (parentCommitId) {
      const parent = await readJjRevision(pi, repoRoot, parentCommitId);
      const parentChanges = await jjDiffSummary(pi, repoRoot, parent.commitId);
      if (parentChanges) {
        target = parent;
        changedFiles = parentChanges;
      }
    }
  }

  return {
    vcs: "jj",
    repoRoot,
    currentRef: target.changeId,
    scope: base ? "jj-base" : "jj-parent",
    changeId: target.changeId,
    commitId: target.commitId,
    parentChangeIds: target.parentChangeIds,
    parentCommitIds: target.parentCommitIds,
    ...(target.commitId === active.commitId
      ? {}
      : {
          workspaceChangeId: active.changeId,
          workspaceCommitId: active.commitId,
        }),
    ...(base
      ? {
          baseRevision: base.revision,
          baseChangeId: base.changeId,
          baseCommitId: base.commitId,
        }
      : {}),
    changedFiles,
    hasTrackedChanges: changedFiles.length > 0,
    hasAnyChanges: changedFiles.length > 0,
  };
}
async function detectGitReviewContext(
  pi: ExtensionAPI,
  cwd: string,
  onStage?: (stage: string) => void
): Promise<ReviewContext> {
  const repoRoot = await gitString(pi, cwd, ["rev-parse", "--show-toplevel"]);
  onStage?.("checking repository state…");
  const currentBranch = await gitString(pi, repoRoot, [
    "branch",
    "--show-current",
  ]);
  const [hasDev, hasMain, hasMaster] = await Promise.all([
    hasLocalBranch(pi, repoRoot, "dev"),
    hasLocalBranch(pi, repoRoot, "main"),
    hasLocalBranch(pi, repoRoot, "master"),
  ]);

  let baseBranch: "main" | "master" | "dev" | undefined;
  if (currentBranch === "dev") {
    if (hasMain) baseBranch = "main";
    else if (hasMaster) baseBranch = "master";
  } else if (currentBranch !== "main" && currentBranch !== "master") {
    if (hasDev) baseBranch = "dev";
    else if (hasMain) baseBranch = "main";
    else if (hasMaster) baseBranch = "master";
  } else if (hasDev) baseBranch = "dev";
  else if (currentBranch === "main" && hasMaster) baseBranch = "master";
  else if (currentBranch === "master" && hasMain) baseBranch = "main";
  else baseBranch = currentBranch as "main" | "master";

  // A repository with no commit yet has no HEAD; every rev-parse below fails
  // and aborted the whole command instead of reviewing the fresh checkout.
  const committed = await hasGitCommit(pi, repoRoot);
  const currentRef = committed
    ? currentBranch ||
      (await gitString(pi, repoRoot, ["rev-parse", "--short", "HEAD"]))
    : currentBranch || "HEAD";
  const status = await gitString(pi, repoRoot, [
    "status",
    "--short",
    "--untracked-files=all",
  ]);

  if (!baseBranch || !committed) {
    return {
      vcs: "git",
      repoRoot,
      currentRef,
      scope: "current-state",
      status,
      hasTrackedChanges: false,
      hasAnyChanges: true,
    };
  }

  const baseBranchRef = `refs/heads/${baseBranch}`;
  const mergeBase = await gitStringOrUndefined(pi, repoRoot, [
    "merge-base",
    baseBranchRef,
    "HEAD",
  ]);
  if (!mergeBase) {
    return {
      vcs: "git",
      repoRoot,
      currentRef,
      scope: "current-state",
      baseBranch,
      status,
      hasTrackedChanges: false,
      hasAnyChanges: true,
    };
  }

  const baseTip = await gitStringOrUndefined(pi, repoRoot, [
    "rev-parse",
    "--short",
    baseBranchRef,
  ]);
  onStage?.("collecting the diff…");
  const recentBaseCommits = await gitStringOrUndefined(pi, repoRoot, [
    "log",
    "--oneline",
    "--decorate",
    "-n",
    "8",
    baseBranchRef,
  ]);
  const hasTrackedChanges = await hasTrackedChangesAgainst(
    pi,
    repoRoot,
    mergeBase
  );
  const hasAnyChanges = hasTrackedChanges || status.length > 0;
  const latestCommit = await gitStringOrUndefined(pi, repoRoot, [
    "rev-parse",
    "--short",
    "HEAD",
  ]);

  // Never report "no changes" on the guessed scope alone: a merge base can be
  // HEAD itself, so verify the diff is really empty before narrowing.
  if (
    !hasAnyChanges &&
    (await isDiffEmptyAgainst(pi, repoRoot, mergeBase)) &&
    latestCommit
  ) {
    return {
      vcs: "git",
      repoRoot,
      currentRef,
      scope: "latest-commit",
      baseBranch,
      mergeBase,
      baseTip,
      latestCommit,
      status,
      recentBaseCommits,
      hasTrackedChanges,
      hasAnyChanges: true,
      ...(latestCommit
        ? {
            reviewCommits: await readCommitsForReview(
              pi,
              repoRoot,
              latestCommit
            ),
          }
        : {}),
    };
  }

  const worktree = await readWorktreeState(pi, repoRoot, mergeBase);
  return {
    vcs: "git",
    repoRoot,
    currentRef,
    scope: "base-diff",
    baseBranch,
    mergeBase,
    baseTip,
    ...(latestCommit ? { latestCommit } : {}),
    status,
    recentBaseCommits,
    hasTrackedChanges,
    hasAnyChanges: true,
    ...(worktree.unpushed
      ? {
          reviewCommits: await readCommitsForReview(
            pi,
            repoRoot,
            `${mergeBase}..HEAD`
          ),
        }
      : {}),
    worktree,
  };
}

async function isDiffEmptyAgainst(
  pi: ExtensionAPI,
  cwd: string,
  revision: string
): Promise<boolean> {
  const result = await runGit(pi, cwd, ["diff", "--quiet", revision]);
  return result.code === 0;
}

export async function detectReviewContext(
  pi: ExtensionAPI,
  cwd: string,
  options: { stackBase?: string; onStage?: (stage: string) => void } = {}
): Promise<ReviewContext> {
  const jjRoot = await detectJjWorkspace(pi, cwd);
  if (jjRoot) return detectJjReviewContext(pi, jjRoot, options.stackBase);
  try {
    return await detectGitReviewContext(pi, cwd, (stage) =>
      options.onStage?.(stage)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(message)) {
      throw new Error(
        `${cwd} is neither a JJ workspace nor a Git repository, so there is nothing to review.`,
        { cause: error }
      );
    }
    throw error;
  }
}
