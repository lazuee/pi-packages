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

    it("flags a project catch-all over a global deny under yolo", () => {
      // yolo makes global's `ask` fallback an allow, so comparing effective
      // actions at the project rule's own pattern saw nothing looser — while
      // `rm -rf x` resolved to the project's allow over global's deny.
      const posture = postureOf(
        {
          global: scope({ "*": "ask", bash: { "rm *": "deny" } }),
          project: scope({ bash: { "*": "allow" } }),
        },
        { yolo: true },
      );
      expect(posture.loosenedBy).toEqual(["project"]);
    });

    it("flags a project catch-all over a global deny when global allows the rest", () => {
      // Global's own catch-all is `allow`, so the project rule is no looser at
      // its own pattern; it is looser where global denied.
      const posture = postureOf({
        global: scope({ "*": "allow", bash: { "rm *": "deny" } }),
        project: scope({ bash: { "*": "allow" } }),
      });
      expect(posture.loosenedBy).toEqual(["project"]);
    });

    it("flags a project allow over a global ask under yolo", () => {
      // Under yolo both resolve to allow, but the project still turned one of
      // global's asks into an allow of its own.
      const posture = postureOf(
        {
          global: scope({ "*": "ask", write: "ask" }),
          project: scope({ write: "allow" }),
        },
        { yolo: true },
      );
      expect(posture.loosenedBy).toEqual(["project"]);
    });

    it("does not flag a project deny that a global allow is replaced by", () => {
      const posture = postureOf({
        global: scope({ "*": "ask", bash: { "*": "allow" } }),
        project: scope({ bash: { "rm *": "deny" } }),
      });
      expect(posture.loosenedBy).toEqual([]);
    });

    it("does not flag a project catch-all that a global deny still overrides", () => {
      // The project's `*` replaces global's in place, ahead of `rm *`, so
      // last-match-wins still denies `rm` and nothing resolves looser.
      const posture = postureOf({
        global: scope({ "*": "ask", bash: { "*": "ask", "rm *": "deny" } }),
        project: scope({ bash: { "*": "ask" } }),
      });
      expect(posture.loosenedBy).toEqual([]);
      expect(posture.ruleCounts.deny).toBe(1);
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

  describe("effective rule counts", () => {
    it("does not count a deny a later rule overrides at its own pattern", () => {
      const posture = postureOf({
        global: scope({ "*": "ask", bash: { "rm *": "deny" } }),
        project: scope({ bash: { "*": "allow" } }),
      });
      expect(posture.ruleCounts).toEqual({ allow: 1, ask: 0, deny: 0 });
    });

    it("counts a deny a later rule overrides only in part", () => {
      // `rm -i *` re-allows one form; `rm x` is still denied.
      const posture = postureOf({
        global: scope({
          "*": "ask",
          bash: { "rm *": "deny", "rm -i *": "allow" },
        }),
      });
      expect(posture.ruleCounts).toEqual({ allow: 1, ask: 0, deny: 1 });
    });

    it("counts a deny that overrides an earlier catch-all", () => {
      const posture = postureOf({
        global: scope({ "*": "ask", bash: { "*": "allow", "rm *": "deny" } }),
      });
      expect(posture.ruleCounts).toEqual({ allow: 1, ask: 0, deny: 1 });
    });
  });

  describe("recomputation", () => {
    it("follows a yolo toggle over an unchanged policy", () => {
      let yolo = false;
      const manager = new PermissionManager({
        policyLoader: createInMemoryPolicyLoader({
          global: scope({ "*": "ask" }),
        }),
        flavor: posixPathFlavor,
        isYoloEnabled: () => yolo,
      });
      expect(manager.describePosture().fallback.action).toBe("ask");
      yolo = true;
      expect(manager.describePosture().fallback.action).toBe("allow");
      yolo = false;
      expect(manager.describePosture().fallback.action).toBe("ask");
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
