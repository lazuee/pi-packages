import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadUnifiedConfig } from "#src/config/config-loader";
import {
  denyRuleReason,
  type FileApprovalDeps,
  listFileApprovals,
  parseFileApprovalArgs,
  resolveFilePath,
  runFileApprovalCommand,
  secretFileReason,
  withFileApproval,
  withoutFileApproval,
} from "#src/config/file-approvals";
import type { Rule } from "#src/policy/rule";

function denyRule(surface: string, pattern: string): Rule {
  return {
    surface,
    pattern,
    action: "deny",
    layer: "config",
    origin: "global",
  };
}

describe("parseFileApprovalArgs", () => {
  test("returns undefined for other subcommands", () => {
    expect(parseFileApprovalArgs("show")).toBeUndefined();
    expect(parseFileApprovalArgs("")).toBeUndefined();
  });

  test("parses allow-file and keeps the path's case", () => {
    expect(parseFileApprovalArgs("allow-file ./Docs/Notes.md BOTH")).toEqual({
      kind: "allow",
      path: "./Docs/Notes.md",
      access: "both",
    });
  });

  test("keeps a quoted path with spaces whole", () => {
    expect(parseFileApprovalArgs('allow-file "My Notes/a b.md" read')).toEqual({
      kind: "allow",
      path: "My Notes/a b.md",
      access: "read",
    });
  });

  test("remove-file defaults to both", () => {
    expect(parseFileApprovalArgs("remove-file a.md")).toEqual({
      kind: "remove",
      path: "a.md",
      access: "both",
    });
  });

  test("returns usage for a missing or unknown access, or extra words", () => {
    expect(parseFileApprovalArgs("allow-file a.md")).toEqual({ kind: "usage" });
    expect(parseFileApprovalArgs("allow-file a.md write")).toEqual({
      kind: "usage",
    });
    expect(parseFileApprovalArgs("allow-file a.md read extra")).toEqual({
      kind: "usage",
    });
    expect(parseFileApprovalArgs("list-files now")).toEqual({ kind: "usage" });
    expect(parseFileApprovalArgs("list-files")).toEqual({ kind: "list" });
  });
});

describe("resolveFilePath", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-approvals-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves a relative path against the cwd", () => {
    expect(resolveFilePath("docs/a.md", "/repo")).toEqual({
      path: "/repo/docs/a.md",
    });
  });

  test("expands ~", () => {
    expect(resolveFilePath("~/notes.md", "/repo")).toEqual({
      path: join(homedir(), "notes.md"),
    });
  });

  test("refuses wildcards", () => {
    expect(resolveFilePath("docs/*.md", "/repo")).toHaveProperty("error");
    expect(resolveFilePath("a?.md", "/repo")).toHaveProperty("error");
  });

  test("refuses a folder", () => {
    mkdirSync(join(dir, "sub"));

    expect(resolveFilePath("sub", dir)).toHaveProperty("error");
  });
});

describe("secretFileReason", () => {
  test.each([
    "/repo/.env",
    "/repo/.env.local",
    "/repo/.env.production",
    "/home/q/.ssh/config",
    "/home/q/.pi/agent/auth.json",
    "/repo/server.pem",
    "/repo/tls.key",
    "/home/q/id_rsa",
    "/home/q/.npmrc",
  ])("refuses %s", (path) => {
    expect(secretFileReason(path)).toBeDefined();
  });

  test.each([
    "/repo/.env.example",
    "/repo/.env.sample",
    "/repo/.env.template",
    "/repo/README.md",
    "/home/q/.pi/agent/extensions/pi-permission-ai-guard/config.json",
  ])("allows %s", (path) => {
    expect(secretFileReason(path)).toBeUndefined();
  });
});

describe("denyRuleReason", () => {
  test("refuses when a deny on the same direction matches", () => {
    const rules = [denyRule("path_read", "/repo/*.md")];

    expect(denyRuleReason("/repo/a.md", "read", rules)).toContain(
      'path_read["/repo/*.md"]',
    );
  });

  test("a bare path deny covers both directions", () => {
    const rules = [denyRule("path", "/repo/secret/*")];

    expect(denyRuleReason("/repo/secret/a.txt", "edit", rules)).toBeDefined();
  });

  test("a deny on the other direction does not block", () => {
    const rules = [denyRule("path_write", "/repo/*")];

    expect(denyRuleReason("/repo/a.md", "read", rules)).toBeUndefined();
    expect(denyRuleReason("/repo/a.md", "both", rules)).toBeDefined();
  });

  test("ignores allow and ask rules and other surfaces", () => {
    const rules: Rule[] = [
      { ...denyRule("path_read", "*"), action: "ask" },
      denyRule("bash", "*"),
    ];

    expect(denyRuleReason("/repo/a.md", "both", rules)).toBeUndefined();
  });
});

describe("withFileApproval / withoutFileApproval / listFileApprovals", () => {
  test("adds allow rules last, on both path families", () => {
    const config = {
      yoloMode: false,
      permission: {
        path_read: { "/repo/a.md": "allow", "*": "ask" },
        external_directory_read: "ask",
      },
    };

    const next = withFileApproval(config, "/repo/a.md", "read");
    const permission = next.permission as Record<
      string,
      Record<string, string>
    >;

    expect(next.yoloMode).toBe(false);
    expect(Object.keys(permission.path_read)).toEqual(["*", "/repo/a.md"]);
    expect(permission.external_directory_read).toEqual({
      "*": "ask",
      "/repo/a.md": "allow",
    });
    expect(permission.path_write).toBeUndefined();
  });

  test("removes only allow rules, and drops a surface that becomes empty", () => {
    const config = {
      permission: {
        path_read: { "/repo/a.md": "allow" },
        path_write: { "/repo/a.md": "deny" },
      },
    };

    const result = withoutFileApproval(config, "/repo/a.md", "both");

    expect(result.changed).toBe(true);
    expect(result.config.permission).toEqual({
      path_write: { "/repo/a.md": "deny" },
    });
  });

  test("reports no change when there is nothing to remove", () => {
    expect(withoutFileApproval({}, "/repo/a.md", "both").changed).toBe(false);
  });

  test("lists exact-path allows and skips wildcards", () => {
    const config = {
      permission: {
        path_read: {
          "/repo/a.md": "allow",
          "/repo/b.md": "allow",
          "*": "allow",
        },
        path_write: { "/repo/a.md": "allow", "/repo/*.ts": "allow" },
      },
    };

    expect([...listFileApprovals(config)]).toEqual([
      ["/repo/a.md", "both"],
      ["/repo/b.md", "read"],
    ]);
  });
});

describe("runFileApprovalCommand", () => {
  let dir: string;
  let configPath: string;
  let messages: { message: string; level: string }[];
  let deps: FileApprovalDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-approvals-run-"));
    configPath = join(dir, "config.json");
    messages = [];
    deps = {
      cwd: "/repo",
      configPath,
      rules: () => [],
      notify: (message, level) => {
        messages.push({ message, level });
      },
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("allow-file writes a config that still loads, and keeps other keys", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ yoloMode: false, permission: { bash: "ask" } }),
    );

    runFileApprovalCommand(
      { kind: "allow", path: "docs/a.md", access: "both" },
      deps,
    );

    const loaded = loadUnifiedConfig(configPath);
    expect(loaded.issues).toEqual([]);
    expect(loaded.config).toMatchObject({
      yoloMode: false,
      permission: {
        bash: "ask",
        path_read: { "/repo/docs/a.md": "allow" },
        path_write: { "/repo/docs/a.md": "allow" },
        external_directory_read: { "/repo/docs/a.md": "allow" },
        external_directory_write: { "/repo/docs/a.md": "allow" },
      },
    });
    expect(messages.at(-1)?.level).toBe("info");
  });

  test("edit alone adds a hint that the edit tool also reads", () => {
    runFileApprovalCommand(
      { kind: "allow", path: "a.md", access: "edit" },
      deps,
    );

    expect(messages.at(-1)?.message).toContain("Use 'both'");
  });

  test("refuses a secret file and does not write", () => {
    writeFileSync(configPath, "{}\n");

    runFileApprovalCommand(
      { kind: "allow", path: ".env.local", access: "read" },
      deps,
    );

    expect(readFileSync(configPath, "utf-8")).toBe("{}\n");
    expect(messages.at(-1)?.level).toBe("warning");
  });

  test("refuses when a deny rule matches, and does not write", () => {
    deps.rules = () => [denyRule("path_read", "/repo/private/*")];

    runFileApprovalCommand(
      { kind: "allow", path: "private/a.md", access: "read" },
      deps,
    );

    expect(messages.at(-1)?.message).toContain("deny rule");
    expect(() => readFileSync(configPath)).toThrow();
  });

  test("refuses to rewrite a config that has comments", () => {
    const raw = '{\n  // keep me\n  "yoloMode": false\n}\n';
    writeFileSync(configPath, raw);

    runFileApprovalCommand(
      { kind: "allow", path: "a.md", access: "read" },
      deps,
    );

    expect(readFileSync(configPath, "utf-8")).toBe(raw);
    expect(messages.at(-1)?.message).toContain("comments");
  });

  test("refuses to overwrite a config that is not valid JSON", () => {
    writeFileSync(configPath, "{ not json");

    runFileApprovalCommand(
      { kind: "allow", path: "a.md", access: "read" },
      deps,
    );

    expect(readFileSync(configPath, "utf-8")).toBe("{ not json");
  });

  test("remove-file and list-files", () => {
    runFileApprovalCommand(
      { kind: "allow", path: "a.md", access: "both" },
      deps,
    );
    runFileApprovalCommand({ kind: "list" }, deps);
    expect(messages.at(-1)?.message).toContain("both  /repo/a.md");

    runFileApprovalCommand(
      { kind: "remove", path: "a.md", access: "both" },
      deps,
    );
    runFileApprovalCommand({ kind: "list" }, deps);
    expect(messages.at(-1)?.message).toBe("No always-allowed files.");
  });
});
