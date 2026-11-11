import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The checkout under upstream/ is a Node launcher, not a binary: it is always
// executable and dies on the native binary that npm's postinstall would put
// beside it. A submodule clone (and CI, which checks no submodules) is exactly
// that state, so accepting the checkout on mode alone would never reach the
// PATH fallback and every call would fail. These tests pin that a candidate has
// to answer before it is used.
const ON_PATH = "/usr/local/bin/agent-desktop";

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

const handlers = new Map<string, Handler>();
const exec = vi.fn();
// The registered tool, so a test can call it the way the agent would.
let tool_: { execute: (...a: unknown[]) => Promise<unknown> } | undefined;

// Only the session-lifecycle surface this extension touches.
const fakePi = {
  on: (name: string, handler: Handler) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  },
  registerTool: (tool: typeof tool_) => {
    tool_ = tool;
  },
  exec,
};

/**
 * A checkout that loads but has no native binary, like a real bare clone: it
 * answers `--version` and fails everything else. `working` names the candidate
 * that answers every call, or undefined for one that answers nothing.
 */
function execAnswers(working: string | undefined) {
  exec.mockImplementation(async (bin: string, args: string[]) => {
    if (bin === "which") return { code: 0, stdout: `${ON_PATH}\n` };
    // The session wrapper is always /bin/sh and names its payload as `$0`, so the
    // real binary is the first argument after the flag, never the command.
    const payload = args[args.indexOf("-c") + 2] ?? bin;
    const target = payload === ON_PATH ? "path" : "checkout";
    if (working === target) return { code: 0, stdout: "", stderr: "" };
    if (args.at(-1) === "--version")
      return { code: 0, stdout: "agent-desktop 1.0.0", stderr: "" };
    return { code: 1, stdout: "", stderr: "Error: Native binary not found" };
  });
}

const ctx = { hasUI: false, mode: "tui", ui: { setStatus: vi.fn() } };

async function start() {
  const { default: piAgentDesktop } = await import("#src/extension");
  piAgentDesktop(fakePi as unknown as ExtensionAPI);
  await handlers.get("session_start")?.({ reason: "startup" }, ctx);
}

/** The bin the extension settled on, read off the session it opens. */
async function chosenBin(): Promise<string | undefined> {
  await handlers.get("agent_start")?.({}, ctx);
  const sessionStart = exec.mock.calls.find((c) =>
    String(c[1]).includes("session,start"),
  );
  // A start runs unprefixed, so the binary is the command itself rather than
  // the `$0` of a sh wrapper, i.e. exec's first argument.
  return sessionStart?.[0] as string | undefined;
}

describe("cli discovery", () => {
  beforeEach(() => {
    vi.resetModules();
    handlers.clear();
    exec.mockReset();
    tool_ = undefined;
    ctx.ui.setStatus.mockReset();
  });

  it("falls back to PATH when the checkout has no native binary", async () => {
    execAnswers("path");
    await start();

    await expect(chosenBin()).resolves.toBe(ON_PATH);
  });

  it("prefers the checkout when it answers, so a local patch is live", async () => {
    execAnswers("checkout");
    await start();

    await expect(chosenBin()).resolves.toContain("upstream/npm/bin");
  });

  it("stays silent when no candidate answers", async () => {
    execAnswers(undefined);
    await start();

    await expect(chosenBin()).resolves.toBeUndefined();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("re-probes on a call, so a CLI installed mid-session needs no restart", async () => {
    // Nothing at session start, then the CLI appears: the first call must find
    // it rather than keep answering "not on PATH" until Pi restarts.
    execAnswers(undefined);
    await start();
    await expect(chosenBin()).resolves.toBeUndefined();

    execAnswers("path");
    await tool_?.execute(
      "id",
      { action: "list_apps" },
      undefined,
      undefined,
      ctx,
    );

    await expect(chosenBin()).resolves.toBe(ON_PATH);
  });

  it("still reports a missing CLI when the retry finds nothing", async () => {
    execAnswers(undefined);
    await start();

    await expect(
      tool_?.execute("id", { action: "list_apps" }, undefined, undefined, ctx),
    ).rejects.toThrow(/not on PATH/);
  });
});
