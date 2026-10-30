import { describe, expect, it } from "vitest";
import { posixPathFlavor } from "#src/path/path-flavor";
import { PermissionManager } from "#src/policy/permission-manager";
import type { PolicyPosture } from "#src/policy/policy-posture";
import type { ScopeConfig } from "#src/types";
import { createInMemoryPolicyLoader } from "#test/helpers/manager-harness";

function postureOf(
  scopes: Parameters<typeof createInMemoryPolicyLoader>[0],
  options: { yolo?: boolean; agentName?: string } = {},
): PolicyPosture {
  const manager = new PermissionManager({
    policyLoader: createInMemoryPolicyLoader(scopes),
    flavor: posixPathFlavor,
    isYoloEnabled: () => options.yolo === true,
  });
  return manager.describePosture(options.agentName);
}

const scope = (permission: Record<string, unknown>): ScopeConfig =>
  ({ permission }) as ScopeConfig;

describe("PermissionManager.describePosture", () => {
  describe("yolo rewrite", () => {
    it("reports asks auto-allowed while every deny rule is kept", () => {
      const posture = postureOf(
        {
          global: scope({
            "*": "ask",
            bash: { "*": "ask", "rm *": "deny", "git push *": "deny" },
            write: "deny",
          }),
        },
        { yolo: true },
      );
      expect(posture).toEqual({
        asksAutoAllowed: true,
        fallback: { action: "allow", origin: "global" },
        ruleCounts: { allow: 1, ask: 0, deny: 3 },
        scopes: ["global"],
        loosenedBy: [],
        failClosedScopes: [],
      });
    });

    it("keeps asks as asks when yolo is off", () => {
      const posture = postureOf({
        global: scope({ "*": "ask", bash: { "*": "ask", "rm *": "deny" } }),
      });
      expect(posture.asksAutoAllowed).toBe(false);
      expect(posture.fallback).toEqual({ action: "ask", origin: "global" });
      expect(posture.ruleCounts).toEqual({ allow: 0, ask: 1, deny: 1 });
    });

    it("reports the built-in ask fallback when no config sets one", () => {
      const posture = postureOf({});
      expect(posture.fallback).toEqual({ action: "ask", origin: "builtin" });
      expect(posture.scopes).toEqual([]);
    });
  });

  describe("contributing scopes", () => {
    it("lists every scope that wrote a rule, lowest precedence first", () => {
      const posture = postureOf(
        {
          global: scope({ "*": "ask" }),
          project: scope({ write: "deny" }),
          agent: { reviewer: scope({ edit: "deny" }) },
        },
        { agentName: "reviewer" },
      );
      expect(posture.scopes).toEqual(["global", "project", "agent"]);
      expect(posture.ruleCounts.deny).toBe(2);
    });

    it("leaves an agent scope out for a session with no agent", () => {
      const posture = postureOf({
        global: scope({ "*": "ask" }),
        agent: { reviewer: scope({ edit: "deny" }) },
      });
      expect(posture.scopes).toEqual(["global"]);
    });
  });

  describe("loosening", () => {
    it("flags a project rule that allows what global denies", () => {
      const posture = postureOf({
        global: scope({ "*": "ask", bash: { "*": "ask", "rm *": "deny" } }),
        project: scope({ bash: { "rm *": "allow" } }),
      });
      expect(posture.loosenedBy).toEqual(["project"]);
    });

    it("flags a project catch-all appended after a global deny", () => {
      // The shallow merge appends the project's "*" after global's "rm *", so
      // last-match-wins lets it reach `rm` too.
      const posture = postureOf({
        global: scope({ "*": "ask", bash: { "rm *": "deny" } }),
        project: scope({ bash: { "*": "allow" } }),
      });
      expect(posture.loosenedBy).toEqual(["project"]);
    });

    it("flags a project universal fallback looser than global's", () => {
      const posture = postureOf({
        global: scope({ "*": "ask" }),
        project: scope({ "*": "allow" }),
      });
      expect(posture.loosenedBy).toEqual(["project"]);
    });

    it("flags an agent rule that loosens global", () => {
      const posture = postureOf(
        {
          global: scope({ "*": "ask", write: "deny" }),
          agent: { coder: scope({ write: "allow" }) },
        },
        { agentName: "coder" },
      );
      expect(posture.loosenedBy).toEqual(["agent"]);
    });

    it("does not flag a project that only tightens", () => {
      const posture = postureOf({
        global: scope({ "*": "allow" }),
        project: scope({ write: "deny", bash: { "git push *": "ask" } }),
      });
      expect(posture.loosenedBy).toEqual([]);
    });

    it("does not flag a project ask that yolo makes equal to global's allow", () => {
      const posture = postureOf(
        {
          global: scope({ "*": "allow" }),
          project: scope({ bash: "ask" }),
        },
        { yolo: true },
      );
      expect(posture.loosenedBy).toEqual([]);
    });

    it("flags a project deny→ask under yolo, since yolo then allows it", () => {
      const posture = postureOf(
        {
          global: scope({ "*": "ask", write: "deny" }),
          project: scope({ write: "ask" }),
        },
        { yolo: true },
      );
      expect(posture.loosenedBy).toEqual(["project"]);
    });
  });

  describe("fail-closed scopes", () => {
    it("names an invalid project scope", () => {
      const posture = postureOf({
        global: scope({ "*": "allow" }),
        project: { invalid: true },
      });
      expect(posture.failClosedScopes).toEqual(["project"]);
      expect(posture.fallback.action).toBe("ask");
    });

    it("keeps floored allows as asks under yolo and still names their scope", () => {
      const posture = postureOf(
        {
          global: scope({ "*": "allow", bash: { "*": "ask", "rm *": "deny" } }),
          project: { invalid: true },
        },
        { yolo: true },
      );
      expect(posture).toEqual({
        asksAutoAllowed: true,
        fallback: { action: "ask", origin: "global" },
        ruleCounts: { allow: 1, ask: 0, deny: 1 },
        scopes: ["global"],
        loosenedBy: [],
        failClosedScopes: ["project"],
      });
    });
  });
});
