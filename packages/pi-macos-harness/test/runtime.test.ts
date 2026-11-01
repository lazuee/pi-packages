import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The extension drives the bundled checkout, resolved from its own file's place so
 * the package works wherever it is installed. These pin that it is still there. */

const BIN = fileURLToPath(
  new URL("../upstream/macos-harness", import.meta.url),
);

describe("the bundled runtime", () => {
  it("resolves the checkout the extension drives", async () => {
    await expect(access(BIN, constants.X_OK)).resolves.toBeUndefined();
  });

  it("ships the patched coordinate handling with it", async () => {
    const model = fileURLToPath(
      new URL("../upstream/src/macos_harness/model.py", import.meta.url),
    );
    const source = await access(model).then(
      () => true,
      () => false,
    );
    expect(source).toBe(true);
  });

  it("carries the line cap that keeps a busy page readable", async () => {
    const elements = fileURLToPath(
      new URL("../upstream/src/macos_harness/elements.py", import.meta.url),
    );
    const text = await import("node:fs").then((fs) =>
      fs.readFileSync(elements, "utf8"),
    );
    expect(text).toContain("MAX_LINES");
  });
});
