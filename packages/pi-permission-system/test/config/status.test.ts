import { describe, expect, it } from "vitest";
import {
  getPermissionSystemStatus,
  PERMISSION_SYSTEM_STATUS_KEY,
  syncPermissionSystemStatus,
} from "#src/config/status";
import type { PolicyPosture } from "#src/policy/policy-posture";
import { makeCtx } from "#test/helpers/handler-fixtures";
import { makePolicyPosture } from "#test/helpers/session-fixtures";

function statusOf(
  posture: Partial<PolicyPosture>,
  yoloEnabledByProject = false,
): string | undefined {
  return getPermissionSystemStatus({
    posture: makePolicyPosture(posture),
    yoloEnabledByProject,
  });
}

const YOLO: Partial<PolicyPosture> = {
  asksAutoAllowed: true,
  fallback: { action: "allow", origin: "global" },
  scopes: ["global"],
};

describe("getPermissionSystemStatus", () => {
  describe("the default posture", () => {
    it("shows nothing when asks prompt and nothing loosened or failed closed", () => {
      expect(
        statusOf({ ruleCounts: { allow: 0, ask: 2, deny: 3 } }),
      ).toBeUndefined();
    });
  });

  describe("yolo", () => {
    it("says deny rules remain instead of reading as unrestricted", () => {
      expect(
        statusOf({ ...YOLO, ruleCounts: { allow: 4, ask: 0, deny: 3 } }),
      ).toBe("perm: no prompts (yolo) · 3 deny rules · global");
    });

    it("says nothing is denied only when no deny rule and no deny fallback remain", () => {
      expect(statusOf(YOLO)).toBe(
        "perm: no prompts (yolo) · nothing denied · global",
      );
    });

    it("names a deny fallback", () => {
      expect(
        statusOf({
          ...YOLO,
          fallback: { action: "deny", origin: "global" },
          ruleCounts: { allow: 2, ask: 0, deny: 1 },
        }),
      ).toBe("perm: no prompts (yolo) · default deny · 1 deny rule · global");
    });

    it("lists every contributing scope", () => {
      expect(
        statusOf({
          ...YOLO,
          scopes: ["global", "project", "agent"],
          ruleCounts: { allow: 0, ask: 0, deny: 2 },
        }),
      ).toBe("perm: no prompts (yolo) · 2 deny rules · global+project+agent");
    });

    it("says built-in defaults when no config file contributed", () => {
      expect(statusOf({ ...YOLO, scopes: [] })).toBe(
        "perm: no prompts (yolo) · nothing denied · built-in defaults",
      );
    });
  });

  describe("loosening", () => {
    it("flags project loosening even when asks still prompt", () => {
      expect(
        statusOf({
          scopes: ["global", "project"],
          ruleCounts: { allow: 1, ask: 0, deny: 1 },
          loosenedBy: ["project"],
        }),
      ).toBe(
        "perm: prompts on · 1 deny rule · global+project · project loosens global",
      );
    });

    it("flags a project that turned yolo on", () => {
      expect(statusOf({ ...YOLO, scopes: ["global", "project"] }, true)).toBe(
        "perm: no prompts (yolo) · nothing denied · global+project · project loosens global",
      );
    });

    it("names several loosening scopes", () => {
      expect(
        statusOf({
          ...YOLO,
          scopes: ["global", "project", "agent"],
          loosenedBy: ["project", "agent"],
        }),
      ).toBe(
        "perm: no prompts (yolo) · nothing denied · global+project+agent · project+agent loosen global",
      );
    });
  });

  describe("fail-closed", () => {
    it("flags an invalid scope", () => {
      expect(
        statusOf({ scopes: ["global"], failClosedScopes: ["project"] }),
      ).toBe("perm: prompts on · global · project invalid: fail-closed");
    });
  });
});

describe("syncPermissionSystemStatus", () => {
  it("sets the status under the extension's key", () => {
    const ctx = makeCtx();
    syncPermissionSystemStatus(ctx, {
      posture: makePolicyPosture(YOLO),
      yoloEnabledByProject: false,
    });
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      PERMISSION_SYSTEM_STATUS_KEY,
      "perm: no prompts (yolo) · nothing denied · global",
    );
  });

  it("clears the status for the default posture", () => {
    const ctx = makeCtx();
    syncPermissionSystemStatus(ctx, {
      posture: makePolicyPosture(),
      yoloEnabledByProject: false,
    });
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      PERMISSION_SYSTEM_STATUS_KEY,
      undefined,
    );
  });
});
