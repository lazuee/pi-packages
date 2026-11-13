import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig } from "#src/config";

/** Scratch dirs made by a test, removed once the file is done. */
const dirs: string[] = [];

function dir(): string {
  const path = mkdtempSync(join(tmpdir(), "pi-continue-"));
  dirs.push(path);
  return path;
}

afterAll(() => {
  for (const path of dirs) {
    rmSync(path, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe("normalizeConfig", () => {
  it("keeps well-typed fields", () => {
    expect(normalizeConfig({ enabled: false, maxConsecutive: 5 })).toEqual({
      enabled: false,
      maxConsecutive: 5,
    });
  });

  it("drops wrong types", () => {
    expect(normalizeConfig({ enabled: "yes", maxConsecutive: "5" })).toEqual(
      {},
    );
  });

  it("floors fractional counts", () => {
    expect(normalizeConfig({ maxConsecutive: 2.7 }).maxConsecutive).toBe(2);
  });

  it("allows a zero interval but not a zero count", () => {
    expect(normalizeConfig({ minIntervalMs: 0 }).minIntervalMs).toBe(0);
    expect(
      normalizeConfig({ maxConsecutive: 0 }).maxConsecutive,
    ).toBeUndefined();
  });

  it("keeps a non-empty continue text and drops a blank one", () => {
    expect(normalizeConfig({ emptyText: "go on" }).emptyText).toBe("go on");
    expect(normalizeConfig({ emptyText: "   " }).emptyText).toBeUndefined();
  });

  it("keeps a complete judge model only", () => {
    expect(
      normalizeConfig({ judgeModel: { provider: "p", model: "m" } }).judgeModel,
    ).toEqual({ provider: "p", model: "m" });
    expect(
      normalizeConfig({ judgeModel: { provider: "p" } }).judgeModel,
    ).toBeUndefined();
  });

  it("keeps a valid judge mode and drops an unknown one", () => {
    expect(normalizeConfig({ judgeMode: "always" }).judgeMode).toBe("always");
    expect(
      normalizeConfig({ judgeMode: "sometimes" }).judgeMode,
    ).toBeUndefined();
  });

  it("drops a pattern list with a non-string member", () => {
    expect(
      normalizeConfig({ alreadyRetriedPatterns: ["a", 3] })
        .alreadyRetriedPatterns,
    ).toBeUndefined();
  });

  it("ignores non-objects", () => {
    expect(normalizeConfig([])).toEqual({});
    expect(normalizeConfig(null)).toEqual({});
  });
});

describe("loadConfig", () => {
  it("defaults when neither file exists", () => {
    const root = dir();
    const config = loadConfig({
      globalConfigPath: join(root, "g.json"),
      projectConfigPath: join(root, "p.json"),
    });
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("lets the project override the global file", () => {
    const root = dir();
    const globalConfigPath = join(root, "g.json");
    const projectConfigPath = join(root, "p.json");
    writeFileSync(
      globalConfigPath,
      JSON.stringify({ maxConsecutive: 9, notify: false }),
    );
    writeFileSync(projectConfigPath, JSON.stringify({ maxConsecutive: 1 }));
    const config = loadConfig({ globalConfigPath, projectConfigPath });
    expect(config.maxConsecutive).toBe(1);
    expect(config.notify).toBe(false);
  });

  it("falls back to defaults on a malformed file", () => {
    const root = dir();
    const globalConfigPath = join(root, "g.json");
    writeFileSync(globalConfigPath, "{not json");
    const config = loadConfig({
      globalConfigPath,
      projectConfigPath: join(root, "p.json"),
    });
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});
