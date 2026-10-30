import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ConfigScope, PolicyPosture } from "#src/policy/policy-posture";

import { EXTENSION_ID } from "./extension-config";

export const PERMISSION_SYSTEM_STATUS_KEY = EXTENSION_ID;

type PermissionStatusContext =
  | Pick<ExtensionContext, "hasUI" | "ui">
  | Pick<ExtensionCommandContext, "ui">;

/** What the status line is derived from. */
export interface PermissionStatusFacts {
  /** The effective posture of the composed policy for the session's agent. */
  posture: PolicyPosture;
  /** `yoloMode` is on only because the project config turned it on. */
  yoloEnabledByProject: boolean;
}

/**
 * The footer text for the policy the session actually enforces.
 *
 * It reports what the gates do, not the `yoloMode` boolean: yolo turns asks
 * into allows but keeps every deny, so "yolo" alone read as unrestricted. The
 * line says whether asks still prompt, how many deny rules remain, which
 * config scopes contributed, and whether a project or agent scope loosened
 * the global policy or failed closed.
 *
 * It describes this extension's permission gates only; it makes no claim about
 * any OS sandbox, which this extension neither configures nor observes.
 *
 * Returns `undefined` (no footer entry) when asks prompt and nothing was
 * loosened or failed closed — the default posture, as before.
 */
export function getPermissionSystemStatus(
  facts: PermissionStatusFacts,
): string | undefined {
  const { posture } = facts;
  const loosened = loosenedScopes(facts);
  const failClosed = posture.failClosedScopes;
  if (
    !posture.asksAutoAllowed &&
    loosened.length === 0 &&
    failClosed.length === 0
  ) {
    return undefined;
  }

  const segments = [
    promptSegment(posture),
    ...denySegments(posture),
    posture.scopes.length > 0 ? posture.scopes.join("+") : "built-in defaults",
  ];
  if (loosened.length > 0) {
    segments.push(
      `${loosened.join("+")} ${loosened.length === 1 ? "loosens" : "loosen"} global`,
    );
  }
  if (failClosed.length > 0) {
    segments.push(`${failClosed.join("+")} invalid: fail-closed`);
  }
  return segments.join(" · ");
}

/**
 * Whether asks prompt. Under yolo a fail-closed scope's floored asks still
 * do, so "no prompts" would be false there.
 */
function promptSegment(posture: PolicyPosture): string {
  if (!posture.asksAutoAllowed) return "perm: prompts on";
  return posture.failClosedScopes.length > 0
    ? "perm: yolo, fail-closed asks prompt"
    : "perm: no prompts (yolo)";
}

function denySegments(posture: PolicyPosture): string[] {
  const denies = posture.ruleCounts.deny;
  const segments: string[] = [];
  if (posture.fallback.action === "deny") segments.push("default deny");
  if (denies > 0) {
    segments.push(`${denies} deny ${denies === 1 ? "rule" : "rules"}`);
  } else if (segments.length === 0 && posture.asksAutoAllowed) {
    segments.push("nothing denied");
  }
  return segments;
}

function loosenedScopes(facts: PermissionStatusFacts): ConfigScope[] {
  const scopes = new Set<ConfigScope>(facts.posture.loosenedBy);
  if (facts.yoloEnabledByProject) scopes.add("project");
  const order: readonly ConfigScope[] = ["project", "agent", "project-agent"];
  return order.filter((scope) => scopes.has(scope));
}

export function syncPermissionSystemStatus(
  ctx: PermissionStatusContext,
  facts: PermissionStatusFacts,
): void {
  ctx.ui.setStatus(
    PERMISSION_SYSTEM_STATUS_KEY,
    getPermissionSystemStatus(facts),
  );
}
