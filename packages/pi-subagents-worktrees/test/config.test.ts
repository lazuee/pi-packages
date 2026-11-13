import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWorktreesConfig } from "#src/config";

const FILENAME = "subagents-worktrees.json";

describe("loadWorktreesConfig", () => {
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-wt-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "pi-wt-cwd-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeGlobal(content: string): void {
    writeFileSync(join(agentDir, FILENAME), content);
  }

  function writeProject(content: string): void {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", FILENAME), content);
  }

  it("returns an empty list when no config files exist", () => {
    expect(loadWorktreesConfig(agentDir, cwd)).toEqual({ worktreeAgents: [], herdrAgents: [] });
  });

  it("loads worktreeAgents from the global config", () => {
    writeGlobal(JSON.stringify({ worktreeAgents: ["general-purpose"] }));
    expect(loadWorktreesConfig(agentDir, cwd)).toEqual({
      worktreeAgents: ["general-purpose"],
      herdrAgents: [],
    });
  });

  it("loads worktreeAgents from the project config", () => {
    writeProject(JSON.stringify({ worktreeAgents: ["refactorer"] }));
    expect(loadWorktreesConfig(agentDir, cwd)).toEqual({
      worktreeAgents: ["refactorer"],
      herdrAgents: [],
    });
  });

  it("project config overrides global config", () => {
    writeGlobal(JSON.stringify({ worktreeAgents: ["global-agent"] }));
    writeProject(JSON.stringify({ worktreeAgents: ["project-agent"] }));
    expect(loadWorktreesConfig(agentDir, cwd)).toEqual({
      worktreeAgents: ["project-agent"],
      herdrAgents: [],
    });
  });

  it("drops worktreeAgents when it is not an array", () => {
    writeGlobal(JSON.stringify({ worktreeAgents: "general-purpose" }));
    expect(loadWorktreesConfig(agentDir, cwd)).toEqual({ worktreeAgents: [], herdrAgents: [] });
  });

  it("drops worktreeAgents when the array contains non-string entries", () => {
    writeGlobal(JSON.stringify({ worktreeAgents: ["ok", 42, null] }));
    expect(loadWorktreesConfig(agentDir, cwd)).toEqual({ worktreeAgents: [], herdrAgents: [] });
  });

  it("loads herdrAgents from the global config", () => {
    writeGlobal(JSON.stringify({ herdrAgents: ["Explore"] }));
    expect(loadWorktreesConfig(agentDir, cwd).herdrAgents).toEqual(["Explore"]);
  });

  it("drops herdrAgents when it is not an array of strings", () => {
    writeGlobal(JSON.stringify({ herdrAgents: ["ok", 42] }));
    expect(loadWorktreesConfig(agentDir, cwd).herdrAgents).toEqual([]);
  });

  it("warns and falls back to empty on malformed JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeGlobal("{ not valid json");
    expect(loadWorktreesConfig(agentDir, cwd)).toEqual({ worktreeAgents: [], herdrAgents: [] });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("Ignoring malformed settings");
  });
});
