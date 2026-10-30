import { expandHomePath } from "#src/path/expand-home";
import type { PathFlavor } from "#src/path/path-flavor";
import type { PermissionState } from "#src/types";
import { evaluate, type Rule, type RuleOrigin, type Ruleset } from "./rule";

/** A config scope that can contribute rules, lowest precedence first. */
export type ConfigScope = "global" | "project" | "agent" | "project-agent";

const CONFIG_SCOPES: readonly ConfigScope[] = [
  "global",
  "project",
  "agent",
  "project-agent",
];

/** Scopes that sit above the human-owned global config. */
const NON_GLOBAL_SCOPES: ReadonlySet<RuleOrigin> = new Set<RuleOrigin>([
  "project",
  "agent",
  "project-agent",
]);

const PERMISSIVENESS: Record<PermissionState, number> = {
  deny: 0,
  ask: 1,
  allow: 2,
};

/**
 * What the composed policy for one agent scope actually enforces, stated in
 * the terms a status line needs.
 *
 * Every action here is the **effective** action — the one `check()` resolves
 * to — so under yolo an `ask` reads as `allow` and a `deny` stays a `deny`.
 */
export interface PolicyPosture {
  /** Whether matched `ask` rules resolve to `allow` (yolo's rewrite); a fail-closed floored `ask` never does. */
  asksAutoAllowed: boolean;
  /** The effective universal fallback (`permission["*"]`) and who set it. */
  fallback: { action: PermissionState; origin: RuleOrigin };
  /** Config-layer rules by effective action, the fallback excluded. */
  ruleCounts: Record<PermissionState, number>;
  /** Config scopes that contributed a rule or the fallback, lowest precedence first. */
  scopes: ConfigScope[];
  /**
   * Non-global scopes that set at least one rule more permissive than the
   * global config alone resolves the same surface and pattern to.
   */
  loosenedBy: ConfigScope[];
  /** Non-global scopes rejected as invalid, floored `allow`→`ask`. */
  failClosedScopes: RuleOrigin[];
}

export interface PolicyPostureInput {
  /** The composed ruleset `check()` evaluates (fail-closed floor applied, yolo not). */
  composed: Ruleset;
  /**
   * {@link composed} before the fail-closed floor, rule for rule: a floored
   * rule's origin reads `"fail-closed"`, and this names the scope that wrote it.
   */
  unfloored: Ruleset;
  /** The ruleset the global scope alone composes to — the ceiling a loosening is measured against. */
  globalOnly: Ruleset;
  failClosedScopes: readonly RuleOrigin[];
  asksAutoAllowed: boolean;
  flavor: PathFlavor;
}

/**
 * Describe the posture of a composed ruleset.
 *
 * Pure: reads the rulesets and decides nothing. The yolo rewrite is applied to
 * the actions here rather than through `rewriteAsksToYolo`, which would replace
 * every rewritten rule's origin with `"yolo"` and lose the scope that wrote it.
 */
export function describePolicyPosture(
  input: PolicyPostureInput,
): PolicyPosture {
  // yolo's rewrite as `rewriteAsksToYolo` applies it: a floored ask stays one.
  const effective = (rule: Rule): PermissionState =>
    input.asksAutoAllowed &&
    rule.action === "ask" &&
    rule.origin !== "fail-closed"
      ? "allow"
      : rule.action;

  const ruleCounts: Record<PermissionState, number> = {
    allow: 0,
    ask: 0,
    deny: 0,
  };
  const contributing = new Set<RuleOrigin>();
  const loosening = new Set<RuleOrigin>();
  let fallback: PolicyPosture["fallback"] = {
    action: input.asksAutoAllowed ? "allow" : "ask",
    origin: "builtin",
  };

  for (const [index, rule] of input.composed.entries()) {
    const origin = input.unfloored[index]?.origin ?? rule.origin;
    if (rule.layer === "default") {
      fallback = { action: effective(rule), origin };
    } else if (rule.layer === "config") {
      ruleCounts[effective(rule)] += 1;
    } else {
      continue;
    }
    contributing.add(origin);
    if (!NON_GLOBAL_SCOPES.has(origin)) continue;

    const ceiling = evaluate(
      rule.surface,
      expandHomePath(rule.pattern),
      input.globalOnly,
      input.flavor,
    );
    if (PERMISSIVENESS[effective(rule)] > PERMISSIVENESS[effective(ceiling)]) {
      loosening.add(origin);
    }
  }

  return {
    asksAutoAllowed: input.asksAutoAllowed,
    fallback,
    ruleCounts,
    scopes: CONFIG_SCOPES.filter((scope) => contributing.has(scope)),
    loosenedBy: CONFIG_SCOPES.filter((scope) => loosening.has(scope)),
    failClosedScopes: [...input.failClosedScopes],
  };
}
