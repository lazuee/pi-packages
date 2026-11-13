import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "@lazuee/pi-subagents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActiveWorktrees } from "#src/active-worktrees";
import { childStillRunning, WorktreeWorkspaceProvider } from "#src/workspace-provider";
import {
  initGitRepo,
  installPreCommitHook,
  lockGitIndex,
} from "#test/support/git-fixture";

/** Build a prepare context with sensible defaults. */
function ctx(overrides: {
  agentType: string;
  baseCwd: string;
  agentId?: string;
}) {
  return { agentId: "agent-1", ...overrides };
}

/** Build a provider that isolates the given agent types. */
function makeProvider(
  live: ActiveWorktrees = new ActiveWorktrees(),
  worktreeAgents = ["Explore"],
) {
  return new WorktreeWorkspaceProvider({ worktreeAgents }, live);
}

describe("childStillRunning", () => {
  it("keeps the pane following only while the child reports running", () => {
    const outcome = (status: string) => ({ status, description: "d" }) as never;
    expect(childStillRunning(outcome("running"))).toBe(true);
    // A finished, stopped or failed child has nothing left to follow.
    for (const status of ["completed", "aborted", "stopped", "error", "queued"]) {
      expect(childStillRunning(outcome(status))).toBe(false);
    }
  });
});

describe("WorktreeWorkspaceProvider", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = initGitRepo("pi-wt-prov-");
  });

  afterEach(() => {
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch {
      /* ignore */
    }
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns undefined for an agent type not in worktreeAgents (no opt-in)", async () => {
    const provider = makeProvider();
    const workspace = await provider.prepare(
      ctx({ agentType: "general-purpose", baseCwd: repoDir }),
    );
    expect(workspace).toBeUndefined();
  });

  it("prepares a born-complete worktree for an opted-in agent type", async () => {
    const provider = makeProvider();
    const workspace = await provider.prepare(
      ctx({ agentType: "Explore", baseCwd: repoDir }),
    );
    expect(workspace).toBeDefined();
    expect(workspace?.cwd).toBeDefined();
    expect(workspace?.cwd).not.toBe(repoDir);
    expect(existsSync(workspace!.cwd)).toBe(true);
    // Clean up the worktree created by this test.
    workspace?.dispose({ status: "completed", description: "test" });
  });

  it("throws for an opted-in agent when the base dir is not a git repo", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "pi-wt-nonrepo-"));
    const provider = makeProvider();
    await expect(
      provider.prepare(ctx({ agentType: "Explore", baseCwd: nonRepo })),
    ).rejects.toThrow(/worktree isolation/);
    rmSync(nonRepo, { recursive: true, force: true });
  });

  it("dispose returns undefined and removes the worktree when there are no changes", async () => {
    const provider = makeProvider();
    const workspace = await provider.prepare(
      ctx({ agentType: "Explore", baseCwd: repoDir }),
    );
    const wtPath = workspace!.cwd;
    const result = workspace!.dispose({
      status: "completed",
      description: "no-op run",
    });
    expect(result).toBeUndefined();
    expect(existsSync(wtPath)).toBe(false);
  });

  it("dispose returns a branch addendum and removes the worktree when changes exist", async () => {
    const provider = makeProvider();
    const workspace = await provider.prepare(
      ctx({ agentType: "Explore", baseCwd: repoDir, agentId: "abc123" }),
    );
    const wtPath = workspace!.cwd;
    writeFileSync(join(wtPath, "new-file.txt"), "agent output");

    const result = workspace!.dispose({
      status: "completed",
      description: "did work",
    });
    expect(result?.resultAddendum).toContain("Changes saved to branch");
    expect(result?.resultAddendum).toContain("pi-agent-abc123");
    expect(result?.resultAddendum).toContain("git merge");
    expect(existsSync(wtPath)).toBe(false);

    // The branch persists in the base repo.
    const branches = execFileSync("git", ["branch", "--list"], {
      cwd: repoDir,
    }).toString();
    expect(branches).toContain("pi-agent-abc123");
  });

  it("dispose notes when hooks were bypassed to save the work", async () => {
    const provider = makeProvider();
    const workspace = await provider.prepare(
      ctx({ agentType: "Explore", baseCwd: repoDir, agentId: "bypass-1" }),
    );
    writeFileSync(join(workspace!.cwd, "agent-output.txt"), "agent output");
    installPreCommitHook(repoDir, "exit 1");

    const result = workspace!.dispose({
      status: "completed",
      description: "did work",
    });

    expect(result?.resultAddendum).toContain("Changes saved to branch");
    expect(result?.resultAddendum).toContain("hooks were bypassed");
  });

  it("dispose reports the preserved worktree when cleanup fails", async () => {
    const provider = makeProvider();
    const workspace = await provider.prepare(
      ctx({ agentType: "Explore", baseCwd: repoDir, agentId: "fail-1" }),
    );
    const wtPath = workspace!.cwd;
    writeFileSync(join(wtPath, "agent-output.txt"), "agent output");
    lockGitIndex(wtPath);

    const result = workspace!.dispose({
      status: "completed",
      description: "did work",
    });

    expect(result?.resultAddendum).toContain("left in place");
    expect(result?.resultAddendum).toContain(wtPath);
    expect(existsSync(wtPath)).toBe(true);

    // This test deliberately leaves a worktree behind; remove it here since
    // the shared afterEach only prunes administrative entries.
    execFileSync("git", ["worktree", "remove", "--force", wtPath], {
      cwd: repoDir,
      stdio: "pipe",
    });
  });

  describe("live worktree registration", () => {
    it("records the worktree while the child runs and forgets it on dispose", async () => {
      const live = new ActiveWorktrees();
      const provider = makeProvider(live);
      const workspace = await provider.prepare(
        ctx({ agentType: "Explore", baseCwd: repoDir }),
      );
      const resolved = realpathSync(workspace!.cwd);

      expect(live.contains(resolved)).toBe(true);

      workspace!.dispose({ status: "completed", description: "no-op run" });

      expect(live.contains(resolved)).toBe(false);
    });

    it("forgets the worktree once its changes are committed", async () => {
      const live = new ActiveWorktrees();
      const provider = makeProvider(live);
      const workspace = await provider.prepare(
        ctx({ agentType: "Explore", baseCwd: repoDir, agentId: "live-1" }),
      );
      const resolved = realpathSync(workspace!.cwd);
      writeFileSync(join(workspace!.cwd, "new-file.txt"), "agent output");

      workspace!.dispose({ status: "completed", description: "did work" });

      expect(live.contains(resolved)).toBe(false);
    });

    it("forgets a preserved worktree, so the scan can report it", async () => {
      const live = new ActiveWorktrees();
      const provider = makeProvider(live);
      const workspace = await provider.prepare(
        ctx({ agentType: "Explore", baseCwd: repoDir, agentId: "live-2" }),
      );
      const wtPath = workspace!.cwd;
      const resolved = realpathSync(wtPath);
      writeFileSync(join(wtPath, "agent-output.txt"), "agent output");
      lockGitIndex(wtPath);

      workspace!.dispose({ status: "completed", description: "did work" });

      expect(live.contains(resolved)).toBe(false);
      expect(existsSync(wtPath)).toBe(true);

      execFileSync("git", ["worktree", "remove", "--force", wtPath], {
        cwd: repoDir,
        stdio: "pipe",
      });
    });
  });
});

describe("WorktreeWorkspaceProvider — reopening a disposed worktree", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = initGitRepo("pi-wt-resume-");
  });

  afterEach(() => {
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch {
      /* ignore */
    }
    rmSync(repoDir, { recursive: true, force: true });
  });

  /** The reopenable half of the workspace seam the core calls before a resume. */
  type ReopenableWorkspace = Workspace & { resume(): Promise<void> };

  /**
   * Narrow a prepared workspace to the reopenable shape.
   *
   * The core treats `resume()` as an optional member and the published types
   * this package compiles against predate it, so the assertion lives here rather
   * than in a cast at each call: a provider that stopped offering it should fail
   * the test loudly.
   */
  function reopenable(workspace: Workspace | undefined): ReopenableWorkspace {
    if (
      !workspace ||
      typeof (workspace as Partial<ReopenableWorkspace>).resume !== "function"
    ) {
      throw new Error("the prepared workspace is not reopenable");
    }
    return workspace as ReopenableWorkspace;
  }

  /** Prepare a worktree for an opted-in agent, with a stable agent id. */
  async function prepare(agentId = "agent-1") {
    const provider = makeProvider();
    const workspace = await provider.prepare(
      ctx({ agentType: "Explore", baseCwd: repoDir, agentId }),
    );
    return reopenable(workspace);
  }

  it("restores the same path, and marks it live again", async () => {
    const live = new ActiveWorktrees();
    const provider = makeProvider(live);
    const workspace = reopenable(
      await provider.prepare(ctx({ agentType: "Explore", baseCwd: repoDir })),
    );
    const wtPath = workspace.cwd;
    const resolved = realpathSync(wtPath);

    workspace.dispose({ status: "completed", description: "no work" });
    expect(existsSync(wtPath)).toBe(false);
    expect(live.contains(resolved)).toBe(false);

    await workspace.resume();

    expect(workspace.cwd).toBe(wtPath);
    expect(existsSync(wtPath)).toBe(true);
    expect(live.contains(resolved)).toBe(true);

    workspace.dispose({ status: "completed", description: "still no work" });
    expect(existsSync(wtPath)).toBe(false);
  });

  it("restores the exact commit cleanup recorded, not the repository's HEAD", async () => {
    const workspace = await prepare("exact-1");
    const wtPath = workspace.cwd;
    writeFileSync(join(wtPath, "child-work.txt"), "the child's work");
    const addendum = workspace.dispose({
      status: "completed",
      description: "did work",
    });
    expect(addendum?.resultAddendum).toContain("Changes saved to branch");

    // The parent repository moves on after the child was disposed.
    writeFileSync(join(repoDir, "parent-work.txt"), "parent");
    execFileSync("git", ["add", "parent-work.txt"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    execFileSync("git", ["commit", "-m", "parent moved on"], {
      cwd: repoDir,
      stdio: "pipe",
    });

    await workspace.resume();

    expect(readFileSync(join(wtPath, "child-work.txt"), "utf8")).toBe(
      "the child's work",
    );
    expect(existsSync(join(wtPath, "parent-work.txt"))).toBe(false);
  });

  it("survives repeated complete-and-reopen cycles without losing earlier work", async () => {
    const workspace = await prepare("cycles-1");
    const wtPath = workspace.cwd;

    writeFileSync(join(wtPath, "cycle-1.txt"), "first");
    const first = workspace.dispose({
      status: "completed",
      description: "first",
    });
    expect(first?.resultAddendum).toContain("pi-agent-cycles-1");

    await workspace.resume();
    writeFileSync(join(wtPath, "cycle-2.txt"), "second");
    const second = workspace.dispose({
      status: "completed",
      description: "second",
    });
    expect(second?.resultAddendum).toContain("pi-agent-cycles-1");
    expect(second?.resultAddendum).toContain("pi-agent-cycles-1-");

    await workspace.resume();
    expect(readFileSync(join(wtPath, "cycle-1.txt"), "utf8")).toBe("first");
    expect(readFileSync(join(wtPath, "cycle-2.txt"), "utf8")).toBe("second");
    // A cycle with nothing to save restores cleanly and leaves no new branch.
    const third = workspace.dispose({
      status: "completed",
      description: "third",
    });
    expect(third).toBeUndefined();
    expect(existsSync(wtPath)).toBe(false);
  });

  it("rejects a resume after a failed cleanup and leaves the worktree untouched", async () => {
    const workspace = await prepare("failed-1");
    const wtPath = workspace.cwd;
    writeFileSync(join(wtPath, "precious.txt"), "work that must survive");
    lockGitIndex(wtPath);

    const result = workspace.dispose({
      status: "completed",
      description: "did work",
    });
    expect(result?.resultAddendum).toContain("left in place");

    // No cleanup recorded where that work ended up, so a restore would have to
    // guess — it refuses instead, and the preserved worktree stays as it is.
    await expect(workspace.resume()).rejects.toThrow(/no cleanup recorded/);
    expect(readFileSync(join(wtPath, "precious.txt"), "utf8")).toBe(
      "work that must survive",
    );

    execFileSync("git", ["worktree", "remove", "--force", wtPath], {
      cwd: repoDir,
      stdio: "pipe",
    });
  });

  it("rejects a resume whose path is occupied, leaving the occupant untouched", async () => {
    const workspace = await prepare("occupied-1");
    const wtPath = workspace.cwd;
    workspace.dispose({ status: "completed", description: "no work" });

    mkdirSync(wtPath);
    writeFileSync(join(wtPath, "unknown.txt"), "not this package's");
    try {
      await expect(workspace.resume()).rejects.toThrow(/already exists/);
      expect(readFileSync(join(wtPath, "unknown.txt"), "utf8")).toBe(
        "not this package's",
      );
    } finally {
      rmSync(wtPath, { recursive: true, force: true });
    }
  });

  it("rejects a resume before any cleanup recorded where the work ended", async () => {
    const provider = makeProvider();
    const workspace = reopenable(
      await provider.prepare(ctx({ agentType: "Explore", baseCwd: repoDir })),
    );
    const wtPath = workspace.cwd;

    await expect(workspace.resume()).rejects.toThrow(/no cleanup recorded/);

    execFileSync("git", ["worktree", "remove", "--force", wtPath], {
      cwd: repoDir,
      stdio: "pipe",
    });
  });
});
