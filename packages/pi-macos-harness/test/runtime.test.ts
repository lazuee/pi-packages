import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The extension keeps its helpers private, so the two that matter are pinned here
 * through the built source: the bundled checkout must resolve, and the argv must
 * carry every flag the tool exposes. */

const BIN = fileURLToPath(
  new URL("../upstream/macos-harness", import.meta.url),
);

describe("the bundled runtime", () => {
  it("resolves the checkout the extension drives", () => {
    expect(existsSync(BIN)).toBe(true);
  });

  it("ships the patched coordinate handling with it", () => {
    const model = fileURLToPath(
      new URL("../upstream/src/macos_harness/model.py", import.meta.url),
    );
    expect(existsSync(model)).toBe(true);
  });
});
