import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupWorktree,
  createWorktree,
  discardWorktree,
  pruneWorktrees,
  restoreWorktree,
  type WorktreeCleanupResult,
  type WorktreeInfo,
} from "#src/worktree";
import {
  initGitRepo,
  installPreCommitHook,
  lockGitIndex,
} from "#test/support/git-fixture";

/** Narrow a cleanup result to the expected outcome, failing the test otherwise. */
function assertOutcome<T extends WorktreeCleanupResult["outcome"]>(
  result: WorktreeCleanupResult,
  outcome: T,
): asserts result is Extract<WorktreeCleanupResult, { outcome: T }> {
  if (result.outcome !== outcome) {
    throw new Error(
      `expected outcome "${outcome}", got "${result.outcome}": ${JSON.stringify(result)}`,
    );
  }
}

/** The sha a ref points at, resolved in `cwd`. */
function revParse(cwd: string, ref: string): string {
  return execFileSync("git", ["rev-parse", ref], { cwd, stdio: "pipe" })
    .toString()
    .trim();
}

describe("worktree", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = initGitRepo("pi-wt-test-");
  });

  afterEach(() => {
    // Clean up any lingering worktrees first, then remove repo
    try {
      pruneWorktrees(repoDir);
    } catch {
      /* ignore */
    }
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("createWorktree", () => {
    it("creates a worktree in tmpdir", () => {
      const wt = createWorktree(repoDir, "test-id-1");
      expect(wt).toBeDefined();
      expect(existsSync(wt!.path)).toBe(true);
      expect(wt!.branch).toBe("pi-agent-test-id-1");

      // Verify it's a valid worktree with the repo's files
      expect(existsSync(join(wt!.path, "README.md"))).toBe(true);

      // Cleanup
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt!.path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
    });

    it("returns undefined for non-git directory", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        const wt = createWorktree(nonGit, "test-id-2");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });

    it("returns undefined for git repo with no commits", () => {
      const emptyRepo = mkdtempSync(join(tmpdir(), "pi-wt-empty-"));
      try {
        execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "pipe" });
        const wt = createWorktree(emptyRepo, "no-commits");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(emptyRepo, { recursive: true, force: true });
      }
    });

    it("uses unique paths for multiple worktrees", () => {
      const wt1 = createWorktree(repoDir, "multi-1");
      const wt2 = createWorktree(repoDir, "multi-2");
      expect(wt1).toBeDefined();
      expect(wt2).toBeDefined();
      expect(wt1!.path).not.toBe(wt2!.path);

      // Cleanup
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt1!.path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt2!.path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
    });
  });

  describe("cleanupWorktree", () => {
    /**
     * Worktrees a test created. Cleanup normally removes them itself, but a
     * failure path deliberately leaves one on disk — and worktrees live under
     * `tmpdir`, so deleting `repoDir` does not reclaim them.
     */
    let created: string[];

    beforeEach(() => {
      created = [];
    });

    afterEach(() => {
      for (const path of created) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", path], {
            cwd: repoDir,
            stdio: "pipe",
          });
        } catch {
          /* already removed by the code under test */
        }
      }
    });

    /** Create a worktree and register it for post-test cleanup. */
    function worktreeFor(agentId: string) {
      const wt = createWorktree(repoDir, agentId);
      expect(wt).toBeDefined();
      created.push(wt!.path);
      return wt!;
    }

    it("removes worktree when no changes made", () => {
      const wt = worktreeFor("clean-1");

      const result = cleanupWorktree(repoDir, wt, "test cleanup");
      assertOutcome(result, "clean");
      // Nothing was saved, so the commit a resume restores is the one the run
      // started from.
      expect(result.commit).toBe(wt.commit);
    });

    it("commits changes and creates branch when changes exist", () => {
      const wt = worktreeFor("dirty-1");

      // Make a change in the worktree
      writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");

      const result = cleanupWorktree(repoDir, wt, "added new file");
      assertOutcome(result, "committed");
      expect(result.hooksBypassed).toBe(false);
      expect(result.branch).toContain("pi-agent-dirty-1");

      // Verify the branch exists in the main repo
      const branches = execFileSync(
        "git",
        ["branch", "--list", result.branch],
        {
          cwd: repoDir,
          stdio: "pipe",
        },
      )
        .toString()
        .trim();
      expect(branches).toContain(result.branch);

      // Verify the commit message
      const log = execFileSync(
        "git",
        ["log", "--oneline", "-1", result.branch],
        {
          cwd: repoDir,
          stdio: "pipe",
        },
      )
        .toString()
        .trim();
      expect(log).toContain("pi-agent: added new file");
    });

    it("does not force-overwrite existing branch", () => {
      // Create first worktree, make changes, cleanup → creates branch
      const wt1 = worktreeFor("conflict-1");
      writeFileSync(join(wt1.path, "file1.txt"), "first run");
      const result1 = cleanupWorktree(repoDir, wt1, "first");
      assertOutcome(result1, "committed");
      expect(result1.branch).toBe("pi-agent-conflict-1");

      // Create second worktree with same agent ID, make changes
      const wt2 = worktreeFor("conflict-1");
      writeFileSync(join(wt2.path, "file2.txt"), "second run");
      const result2 = cleanupWorktree(repoDir, wt2, "second");

      // Should use a different branch name (timestamp suffix)
      assertOutcome(result2, "committed");
      expect(result2.branch).not.toBe("pi-agent-conflict-1");
      expect(result2.branch).toContain("pi-agent-conflict-1-");

      // Both branches should exist
      const branches = execFileSync(
        "git",
        ["branch", "--list", "pi-agent-conflict-1*"],
        {
          cwd: repoDir,
          stdio: "pipe",
        },
      )
        .toString()
        .trim();
      expect(branches).toContain("pi-agent-conflict-1");
      expect(branches).toContain(result2.branch);
    });

    it("handles already-deleted worktree gracefully", () => {
      const wt = worktreeFor("gone-1");
      // Manually delete the worktree directory
      rmSync(wt.path, { recursive: true, force: true });

      const result = cleanupWorktree(repoDir, wt, "already gone");
      assertOutcome(result, "failed");
      expect(result.error).toContain("disappeared");
    });

    it("bypasses hooks to save the work when the rescue commit is rejected", () => {
      const wt = worktreeFor("hooked-1");
      writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");
      installPreCommitHook(repoDir, "exit 1");

      const result = cleanupWorktree(repoDir, wt, "rejected by hook");

      assertOutcome(result, "committed");
      expect(result.hooksBypassed).toBe(true);
      expect(existsSync(wt.path)).toBe(false);

      const committed = execFileSync(
        "git",
        ["show", `${result.branch}:new-file.txt`],
        { cwd: repoDir, stdio: "pipe" },
      ).toString();
      expect(committed).toBe("agent wrote this");
    });

    it("includes files a rejecting hook rewrote in the rescue commit", () => {
      const wt = worktreeFor("formatter-1");
      writeFileSync(join(wt.path, "new-file.txt"), "unformatted");
      // The formatter pattern: rewrite the file, then fail the commit anyway.
      installPreCommitHook(repoDir, "echo formatted > new-file.txt\nexit 1");

      const result = cleanupWorktree(repoDir, wt, "formatter rewrote the file");

      assertOutcome(result, "committed");
      const committed = execFileSync(
        "git",
        ["show", `${result.branch}:new-file.txt`],
        { cwd: repoDir, stdio: "pipe" },
      ).toString();
      expect(committed).toBe("formatted\n");
    });

    it("preserves the worktree and reports the error when cleanup fails", () => {
      const wt = worktreeFor("locked-1");
      writeFileSync(join(wt.path, "precious.txt"), "agent work");
      lockGitIndex(wt.path);

      const result = cleanupWorktree(repoDir, wt, "work that must survive");

      assertOutcome(result, "failed");
      expect(result.path).toBe(wt.path);
      expect(result.error).toBeTruthy();
      // The point of preserving: the work is still there to recover.
      expect(readFileSync(join(wt.path, "precious.txt"), "utf8")).toBe(
        "agent work",
      );
    });

    it("reports failed removal truthfully and preserves the saved worktree", () => {
      const wt = worktreeFor("locked-removal");
      writeFileSync(join(wt.path, "precious.txt"), "keep this");
      execFileSync("git", ["worktree", "lock", wt.path], { cwd: repoDir, stdio: "pipe" });
      try {
        const result = cleanupWorktree(repoDir, wt, "locked removal");
        assertOutcome(result, "failed");
        expect(existsSync(wt.path)).toBe(true);
        expect(readFileSync(join(wt.path, "precious.txt"), "utf8")).toBe("keep this");
        expect(revParse(repoDir, wt.branch)).toBe(revParse(wt.path, "HEAD"));
      } finally {
        execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir, stdio: "pipe" });
      }
    });

    it("saves a child's own commit even though its tree is clean", () => {
      const wt = worktreeFor("self-commit-1");
      writeFileSync(join(wt.path, "committed.txt"), "the child committed this");
      execFileSync("git", ["add", "-A"], { cwd: wt.path, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "the child's own commit"], {
        cwd: wt.path,
        stdio: "pipe",
      });
      const head = revParse(wt.path, "HEAD");
      // Clean by `git status`, and holding the only reference to that commit:
      // removing the worktree here would drop the child's work on the floor.
      expect(
        execFileSync("git", ["status", "--porcelain"], {
          cwd: wt.path,
          stdio: "pipe",
        })
          .toString()
          .trim(),
      ).toBe("");

      const result = cleanupWorktree(repoDir, wt, "clean but committed");

      assertOutcome(result, "committed");
      expect(result.branch).toBe("pi-agent-self-commit-1");
      expect(result.commit).toBe(head);
      expect(result.hooksBypassed).toBe(false);
      expect(existsSync(wt.path)).toBe(false);
      expect(revParse(repoDir, result.branch)).toBe(head);
      expect(
        execFileSync("git", ["show", `${result.branch}:committed.txt`], {
          cwd: repoDir,
          stdio: "pipe",
        }).toString(),
      ).toBe("the child committed this");
    });

    it("reports the commit it saved, so a resume can restore exactly that state", () => {
      const wt = worktreeFor("exact-1");
      writeFileSync(join(wt.path, "work.txt"), "child work");
      const result = cleanupWorktree(repoDir, wt, "did work");
      assertOutcome(result, "committed");
      expect(revParse(repoDir, result.branch)).toBe(result.commit);
    });

    it("saves each resumed cycle without moving the previous result branch", () => {
      const wt = worktreeFor("cycle-1");
      writeFileSync(join(wt.path, "a.txt"), "first cycle");
      const first = cleanupWorktree(repoDir, wt, "first");
      assertOutcome(first, "committed");

      // The next cycle: the worktree is reopened at the saved commit, as a resume
      // does, and the child works on from there.
      restoreWorktree(repoDir, wt.path, first.commit);
      const second: WorktreeInfo = {
        ...wt,
        commit: first.commit,
      };
      writeFileSync(join(wt.path, "b.txt"), "second cycle");
      const result = cleanupWorktree(repoDir, second, "second");

      assertOutcome(result, "committed");
      expect(result.branch).not.toBe(first.branch);
      expect(revParse(repoDir, first.branch)).toBe(first.commit);
      expect(result.commit).not.toBe(first.commit);
      expect(
        execFileSync("git", ["show", `${result.branch}:a.txt`], {
          cwd: repoDir,
          stdio: "pipe",
        }).toString(),
      ).toBe("first cycle");
      expect(
        execFileSync("git", ["show", `${result.branch}:b.txt`], {
          cwd: repoDir,
          stdio: "pipe",
        }).toString(),
      ).toBe("second cycle");
    });

    it("does not move a saved branch that has since moved", () => {
      const wt = worktreeFor("moved-1");
      // Someone else owns that branch name now, and it points at unrelated work.
      const elsewhere = revParse(repoDir, "HEAD");
      execFileSync("git", ["branch", wt.branch, elsewhere], {
        cwd: repoDir,
        stdio: "pipe",
      });
      writeFileSync(join(wt.path, "work.txt"), "new work");

      const result = cleanupWorktree(
        repoDir,
        {
          ...wt,
          commit: "0000000000000000000000000000000000000000",
        },
        "moved on",
      );

      assertOutcome(result, "committed");
      expect(result.branch).not.toBe(wt.branch);
      expect(result.branch).toContain(`${wt.branch}-`);
      expect(revParse(repoDir, wt.branch)).toBe(elsewhere);
    });

    it("truncates commit message at 200 chars", () => {
      const wt = worktreeFor("long-msg");
      writeFileSync(join(wt.path, "change.txt"), "something");
      const longDesc = "x".repeat(300);
      const result = cleanupWorktree(repoDir, wt, longDesc);
      assertOutcome(result, "committed");

      const log = execFileSync(
        "git",
        ["log", "--oneline", "-1", result.branch],
        {
          cwd: repoDir,
          stdio: "pipe",
        },
      )
        .toString()
        .trim();
      // "pi-agent: " prefix (10 chars) + 200 chars of x = 210 total max
      expect(log.length).toBeLessThanOrEqual(220); // some slack for hash prefix
    });
  });

  describe("restoreWorktree", () => {
    /** Worktrees a test restored; the suite's afterEach only prunes admin entries. */
    let restored: string[];

    beforeEach(() => {
      restored = [];
    });

    afterEach(() => {
      for (const path of restored) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", path], {
            cwd: repoDir,
            stdio: "pipe",
          });
        } catch {
          /* already gone */
        }
      }
    });

    it("recreates the worktree at exactly the commit it was left at", () => {
      const wt = createWorktree(repoDir, "restore-1")!;
      restored.push(wt.path);
      writeFileSync(join(wt.path, "work.txt"), "child work");
      const result = cleanupWorktree(repoDir, wt, "did work");
      assertOutcome(result, "committed");
      expect(existsSync(wt.path)).toBe(false);

      // The parent repository moves on after the child was disposed.
      writeFileSync(join(repoDir, "later.txt"), "parent work");
      execFileSync("git", ["add", "later.txt"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["commit", "-m", "parent moved on"], {
        cwd: repoDir,
        stdio: "pipe",
      });

      restoreWorktree(repoDir, wt.path, result.commit);

      // The resumed child finds its own work, and none of the parent's newer one.
      expect(readFileSync(join(wt.path, "work.txt"), "utf8")).toBe(
        "child work",
      );
      expect(existsSync(join(wt.path, "later.txt"))).toBe(false);
      expect(revParse(wt.path, "HEAD")).toBe(result.commit);
    });

    it("refuses to restore over a directory that already exists", () => {
      const occupied = join(tmpdir(), `pi-agent-occupied-${Date.now()}`);
      mkdirSync(occupied);
      writeFileSync(join(occupied, "unknown.txt"), "not this package's");
      try {
        expect(() =>
          restoreWorktree(repoDir, occupied, revParse(repoDir, "HEAD")),
        ).toThrow(/already exists/);
        // Fail closed: whatever was there is still there, untouched.
        expect(readFileSync(join(occupied, "unknown.txt"), "utf8")).toBe(
          "not this package's",
        );
      } finally {
        rmSync(occupied, { recursive: true, force: true });
      }
    });

    it("fails when the commit it was asked to restore is gone", () => {
      const target = join(tmpdir(), `pi-agent-nocommit-${Date.now()}`);
      restored.push(target);
      expect(() =>
        restoreWorktree(
          repoDir,
          target,
          "0000000000000000000000000000000000000000",
        ),
      ).toThrow();
      expect(existsSync(target)).toBe(false);
    });
  });

  describe("discardWorktree", () => {
    it("removes a worktree along with its uncommitted work", () => {
      const wt = createWorktree(repoDir, "discard-1")!;
      writeFileSync(join(wt.path, "unwanted.txt"), "abandoned work");

      discardWorktree(repoDir, wt.path);

      expect(existsSync(wt.path)).toBe(false);
    });

    it("reports failure instead of swallowing it", () => {
      expect(() =>
        discardWorktree(repoDir, join(tmpdir(), "pi-agent-never-registered")),
      ).toThrow();
    });
  });

  describe("pruneWorktrees", () => {
    it("does not throw on a clean repo", () => {
      expect(() => pruneWorktrees(repoDir)).not.toThrow();
    });

    it("does not throw on non-git directory", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        expect(() => pruneWorktrees(nonGit)).not.toThrow();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });
});
