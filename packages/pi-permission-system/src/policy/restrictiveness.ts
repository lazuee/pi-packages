import type { PermissionCheckResult, PermissionState } from "#src/types";

/**
 * Select the most restrictive permission result from a possibly-empty list
 * (deny > fail-closed ask > ask > allow).
 *
 * The first occurrence wins on ties, so a caller passing results in candidate
 * order receives the earliest worst case. Returns `undefined` for an empty list.
 *
 * Shared by the bash gates (path, external-directory) to combine the per-candidate
 * `checkPermission` results their tree-sitter token extraction produces.
 */
export function pickMostRestrictive(
  results: readonly PermissionCheckResult[],
): PermissionCheckResult | undefined {
  const first = results.at(0);
  return first === undefined
    ? undefined
    : mostRestrictiveOf([first, ...results.slice(1)]);
}

/**
 * Select the most restrictive of a statically non-empty list of results
 * (deny > fail-closed ask > ask > allow), first-wins on ties.
 *
 * Total by construction: the non-empty tuple parameter means the caller never
 * handles an `undefined` branch. The winner is the losing member's **own**
 * result, so `toolName`, `matchedPattern`, `origin`, and `source` all name the
 * input that forced the verdict rather than a synthesized composite.
 */
export function mostRestrictiveOf(
  results: readonly [PermissionCheckResult, ...PermissionCheckResult[]],
): PermissionCheckResult {
  let worst = results[0];
  for (const result of results) {
    if (restrictiveness(result) > restrictiveness(worst)) {
      worst = result;
    }
  }
  return worst;
}

/**
 * Rank a result: deny is the most restrictive, allow the least, and a
 * fail-closed `ask` outranks any other `ask`.
 *
 * The two asks prompt alike with yolo off, but yolo approves an ordinary ask
 * and never a fail-closed one, so letting an ordinary ask win the tie would
 * let yolo approve a chain or path set that holds a fail-closed member.
 */
function restrictiveness(result: PermissionCheckResult): number {
  if (result.state === "ask" && result.origin === "fail-closed") {
    return FAIL_CLOSED_ASK;
  }
  return RESTRICTIVENESS[result.state];
}

/** Restrictiveness ordering: deny is the most restrictive, allow the least. */
const RESTRICTIVENESS: Record<PermissionState, number> = {
  allow: 0,
  ask: 1,
  deny: 3,
};
const FAIL_CLOSED_ASK = 2;
