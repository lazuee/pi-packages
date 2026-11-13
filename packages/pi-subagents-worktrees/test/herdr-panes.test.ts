import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The herdr reach is shelled out to, so these cover the parts that decide
 * *whether* herdr is touched at all — the guard and the stamp naming. The pane
 * lifecycle itself needs a live herdr and is exercised by hand.
 */
describe("herdr panes", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
    vi.resetModules();
  });

  async function load() {
    vi.resetModules();
    return import("#src/herdr-panes");
  }

  function setHerdrEnv(over: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(over)) {
      // Assigning undefined stringifies, so unset keys need a real removal.
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }

  it("is unavailable outside a herdr pane", async () => {
    setHerdrEnv({
      HERDR_ENV: undefined,
      HERDR_SOCKET_PATH: undefined,
      HERDR_PANE_ID: undefined,
    });
    expect((await load()).herdrAvailable()).toBe(false);
  });

  it("needs the env flag, the socket and the pane id together", async () => {
    setHerdrEnv({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s", HERDR_PANE_ID: undefined });
    expect((await load()).herdrAvailable()).toBe(false);

    setHerdrEnv({ HERDR_PANE_ID: "w1:p2" });
    expect((await load()).herdrAvailable()).toBe(true);

    setHerdrEnv({ HERDR_ENV: "0" });
    expect((await load()).herdrAvailable()).toBe(false);
  });

  it("reaps nothing outside herdr, without shelling out", async () => {
    setHerdrEnv({ HERDR_ENV: undefined });
    const { reapOrphanedPanes } = await load();
    await expect(reapOrphanedPanes("w1:p1")).resolves.toEqual([]);
  });

  it("names stamps under the temp dir, shell-safely", async () => {
    const { stampPath } = await load();
    const stamp = stampPath("w1:p2");
    expect(stamp.startsWith(tmpdir() + path.sep)).toBe(true);
    expect(stamp.endsWith("pi-herdr-pane-w1-p2.stamp")).toBe(true);
    // A literal colon would still work unquoted, but not in every shell.
    expect(stamp).not.toContain(":");
  });
});