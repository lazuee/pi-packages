import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  findConfigProblems,
  loadProjectPermissionConfig,
  MAX_REASON_LENGTH,
  schemaRepoPath,
} from "../../scripts/permission-config/tripwire-rules.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** A config carrying exactly the given `bash` surface. */
function config(bash) {
  return { permission: { bash } };
}

const VALID_REASON = "Drop the `-r`; spell `--replace` if you mean it";

describe("findConfigProblems", () => {
  describe("a well-formed config", () => {
    it("reports nothing for a deny rule with a reason", () => {
      expect(
        findConfigProblems(
          config({ "rg -r*": { action: "deny", reason: VALID_REASON } }),
        ),
      ).toEqual([]);
    });

    it("reports nothing for a bare permission state", () => {
      expect(
        findConfigProblems(config({ "*": "allow", "sudo *": "ask" })),
      ).toEqual([]);
    });

    it("reports nothing for a config with no permission block", () => {
      expect(findConfigProblems({})).toEqual([]);
    });
  });

  describe("the surface value", () => {
    it("rejects a misspelled permission state on the surface itself", () => {
      expect(findConfigProblems({ permission: { bash: "alow" } })).toEqual([
        'bash: surface value must be "allow", "deny", "ask", or a map of patterns',
      ]);
    });

    it("rejects an array, which carries no patterns", () => {
      expect(findConfigProblems({ permission: { bash: [] } })).toEqual([
        'bash: surface value must be "allow", "deny", "ask", or a map of patterns',
      ]);
    });

    it("rejects null", () => {
      expect(findConfigProblems({ permission: { bash: null } })).toEqual([
        'bash: surface value must be "allow", "deny", "ask", or a map of patterns',
      ]);
    });

    it("reports nothing for a bare permission state on the surface", () => {
      expect(findConfigProblems({ permission: { bash: "ask" } })).toEqual([]);
    });
  });

  describe("the value shape", () => {
    it("rejects a state string that is not allow, deny, or ask", () => {
      expect(findConfigProblems(config({ "rm *": "prompt" }))).toEqual([
        'bash \'rm *\': value must be "allow", "deny", "ask", or { action: "deny", reason }',
      ]);
    });

    it("rejects a deny object carrying a key the schema does not define", () => {
      expect(
        findConfigProblems(
          config({
            "rm *": { action: "deny", reason: VALID_REASON, retry: false },
          }),
        ),
      ).toEqual(["bash 'rm *': unknown key 'retry' on a deny rule"]);
    });

    it("rejects an object whose action is not deny", () => {
      expect(
        findConfigProblems(config({ "rm *": { action: "ask", reason: "x" } })),
      ).toEqual([
        'bash \'rm *\': value must be "allow", "deny", "ask", or { action: "deny", reason }',
      ]);
    });
  });

  describe("the reason", () => {
    it("requires one on a deny object", () => {
      expect(
        findConfigProblems(config({ "rm *": { action: "deny" } })),
      ).toEqual(["bash 'rm *': a deny rule must carry a non-empty reason"]);
    });

    it("rejects an empty one", () => {
      expect(
        findConfigProblems(config({ "rm *": { action: "deny", reason: "" } })),
      ).toEqual(["bash 'rm *': a deny rule must carry a non-empty reason"]);
    });

    it("rejects one longer than the cap", () => {
      expect(
        findConfigProblems(
          config({
            "rm *": {
              action: "deny",
              reason: "x".repeat(MAX_REASON_LENGTH + 1),
            },
          }),
        ),
      ).toEqual([
        `bash 'rm *': reason exceeds ${MAX_REASON_LENGTH} characters`,
      ]);
    });

    it("accepts one exactly at the cap", () => {
      expect(
        findConfigProblems(
          config({
            "rm *": { action: "deny", reason: "x".repeat(MAX_REASON_LENGTH) },
          }),
        ),
      ).toEqual([]);
    });

    it("rejects one ending in a full stop, which the renderer appends", () => {
      expect(
        findConfigProblems(
          config({ "rm *": { action: "deny", reason: "Do not do that." } }),
        ),
      ).toEqual([
        "bash 'rm *': reason must not end with '.' — the renderer appends one",
      ]);
    });
  });

  describe("the pattern", () => {
    it("rejects a pattern spanning a pipe, which matches no command unit", () => {
      expect(
        findConfigProblems(
          config({
            "git rev-parse * | wc -c": {
              action: "deny",
              reason: "Re-resolve the identifier you typed",
            },
          }),
        ),
      ).toEqual([
        "bash 'git rev-parse * | wc -c': a pattern containing '|' matches nothing, because a pipeline enumerates into separate command units",
      ]);
    });
  });

  describe("several problems", () => {
    it("reports one per offending rule, in config order", () => {
      expect(
        findConfigProblems(
          config({
            "a | b": { action: "deny", reason: VALID_REASON },
            "rm *": { action: "deny" },
          }),
        ),
      ).toEqual([
        "bash 'a | b': a pattern containing '|' matches nothing, because a pipeline enumerates into separate command units",
        "bash 'rm *': a deny rule must carry a non-empty reason",
      ]);
    });
  });
});

describe("schemaRepoPath", () => {
  it("returns the repo-relative path a canonical raw URL names", () => {
    expect(
      schemaRepoPath(
        "https://raw.githubusercontent.com/lazuee/pi-packages/main/packages/pi-permission-system/schemas/permissions.schema.json",
      ),
    ).toBe("packages/pi-permission-system/schemas/permissions.schema.json");
  });

  it("returns null for another repository's raw URL", () => {
    expect(
      schemaRepoPath(
        "https://raw.githubusercontent.com/lazuee/pi-autoformat/main/schemas/pi-autoformat.schema.json",
      ),
    ).toBeNull();
  });

  it("returns null for a URL that is not a raw.githubusercontent.com path", () => {
    expect(schemaRepoPath("https://example.com/permissions.schema.json")).toBe(
      null,
    );
  });

  it("returns null when there is no $schema at all", () => {
    expect(schemaRepoPath(undefined)).toBeNull();
  });
});

describe("this repository's own project-scope config", () => {
  const config = loadProjectPermissionConfig(REPO_ROOT);

  it("has no problems", () => {
    expect(findConfigProblems(config)).toEqual([]);
  });

  it("names a $schema that exists in this repository", () => {
    const schemaPath = schemaRepoPath(config.$schema);
    expect(schemaPath).not.toBeNull();
    expect(existsSync(path.join(REPO_ROOT, schemaPath))).toBe(true);
  });
});
