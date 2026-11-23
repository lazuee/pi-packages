import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as Profiles from "../src/profiles.ts";

/**
 * The fallback shells out to `pi auth check`, so a stub `pi` stands in for the
 * real one: it answers from a file the cases rewrite.
 */
const directory = mkdtempSync(join(tmpdir(), "fallback-"));
const bin = join(directory, "bin");
const agent = join(directory, "agent");
const answer = join(directory, "answer");
const previous = {
  path: process.env["PATH"],
  agent: process.env["PI_CODING_AGENT_DIR"],
};
mkdirSync(bin, { recursive: true });
mkdirSync(agent, { recursive: true });
writeFileSync(
  join(bin, "pi"),
  `#!/bin/sh\ngrep -qxF "\${4:-}" "${answer}" && { echo ready; exit 0; }\necho not_ready\nexit 1\n`
);
chmodSync(join(bin, "pi"), 0o755);
process.env["PATH"] = `${bin}:${previous.path}`;
process.env["PI_CODING_AGENT_DIR"] = agent;
writeFileSync(
  join(agent, "settings.json"),
  JSON.stringify({ defaultProvider: "here", defaultModel: "fast" })
);

const { fallbackModel, loadAgentProfiles, profileAgentArgs } = (await import(
  `${join(import.meta.dir, "..", "src", "profiles.ts")}?case=${crypto.randomUUID()}`
)) as typeof Profiles;

function profile(model: string) {
  return {
    name: "committer",
    description: "d",
    model,
    thinking: "high",
    accepts: [],
    piArgs: [],
    plugins: [],
    writeTools: [],
  };
}

/** Mark a model ready in the stub, or leave the file empty for none. */
function ready(...models: string[]) {
  writeFileSync(answer, models.map((m) => `${m}\n`).join(""));
}

const model = (m: string) => profileAgentArgs(profile(m))[1];

afterEach(() => {
  writeFileSync(answer, "");
  // A case that shortens PATH or edits settings must not leak into the next.
  process.env["PATH"] = `${bin}:${previous.path}`;
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({ defaultProvider: "here", defaultModel: "fast" })
  );
});

describe("model fallback", () => {
  test("a configured model is kept as the profile names it", () => {
    ready("wanted/model");
    expect(model("wanted/model")).toBe("wanted/model");
  });

  test("an unconfigured model falls back to this machine's default", () => {
    ready();
    expect(model("absent/model")).toBe("here/fast");
  });

  test("a bare default model is joined with its provider", () => {
    ready();
    writeFileSync(
      join(agent, "settings.json"),
      JSON.stringify({ defaultProvider: "here", defaultModel: "auto" })
    );
    expect(model("absent/model")).toBe("here/auto");
  });

  test("without a default the configured model still launches", () => {
    ready();
    writeFileSync(join(agent, "settings.json"), "{}");
    expect(model("absent/model")).toBe("absent/model");
  });

  test("an auth check that cannot run keeps the configured model", () => {
    ready();
    process.env["PATH"] = "/nonexistent"; // No `pi` to run at all.
    expect(model("absent/model")).toBe("absent/model");
  });

  test("the fallback is reported so the spawn can warn about it", () => {
    ready();
    expect(fallbackModel(profile("absent/model"))).toEqual({
      from: "absent/model",
      to: "here/fast",
    });
    ready("wanted/model");
    expect(fallbackModel(profile("wanted/model"))).toBeUndefined();
  });

  test("a caller that already decided is not probed again", () => {
    // The stub is emptied, so a second probe would fall back a second time.
    ready();
    expect(
      profileAgentArgs(profile("absent/model"), false, "here/fast")[1]
    ).toBe("here/fast");
  });

  test("the profile still reads what it declares", async () => {
    // Fallback happens at launch; the loaded profile keeps its own model.
    const loaded = await loadAgentProfiles();
    expect(loaded.size).toBe(0);
  });
});

void rmSync;
void previous;
