import { expandHomePath } from "#src/path/expand-home";
import type { PathFlavor } from "#src/path/path-flavor";
import type { PermissionState } from "#src/types";
import {
  compileRulesetLookup,
  type Rule,
  type RuleOrigin,
  type Ruleset,
} from "./rule";

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
 * The fallback and the rule counts report the **effective** action — the one
 * `check()` resolves to — so under yolo an `ask` reads as `allow` and a `deny`
 * stays a `deny`. Loosening is judged before the yolo rewrite, see
 * {@link PolicyPosture.loosenedBy}.
 */
export interface PolicyPosture {
  /** Whether matched `ask` rules resolve to `allow` (yolo's rewrite); a fail-closed floored `ask` never does. */
  asksAutoAllowed: boolean;
  /** The effective universal fallback (`permission["*"]`) and who set it. */
  fallback: { action: PermissionState; origin: RuleOrigin };
  /**
   * Effective config-layer rules by effective action, the fallback excluded.
   *
   * A rule counts only where it still decides its own pattern: a `deny` that
   * a later rule matching the same pattern overrides blocks nothing there,
   * so it is not counted. A rule overridden only in part (an `rm *` deny
   * followed by an `rm -i *` allow) still decides its own pattern and counts.
   */
  ruleCounts: Record<PermissionState, number>;
  /** Config scopes that contributed a rule or the fallback, lowest precedence first. */
  scopes: ConfigScope[];
  /**
   * Non-global scopes whose rule now decides a configured surface and pattern
   * more permissively than the global config alone does — a global `deny` or
   * `ask` turned into `allow`, or a `deny` into `ask`.
   *
   * Compared before the yolo rewrite: yolo makes a global `ask` and a project
   * `allow` resolve alike, but the project rule is still a loosening, and it
   * keeps answering `allow` once yolo is off. The probes are every configured
   * pattern, the global-only ones included, so a broad project rule that
   * overrides a narrower global `deny` is caught where the `deny` was.
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

/** A surface and value to resolve: a configured rule's pattern, as a value. */
interface Probe {
  surface: string;
  value: string;
}

const probeOf = (rule: Rule): Probe => ({
  surface: rule.surface,
  value: expandHomePath(rule.pattern),
});

/** Whether a rule is configured policy rather than a synthesized or session one. */
const isConfigured = (rule: Rule): boolean =>
  rule.layer === "default" || rule.layer === "config";

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
  const { composed, flavor } = input;
  // yolo's rewrite as `rewriteAsksToYolo` applies it: a floored ask stays one.
  const effective = (rule: Rule): PermissionState =>
    input.asksAutoAllowed &&
    rule.action === "ask" &&
    rule.origin !== "fail-closed"
      ? "allow"
      : rule.action;
  // The scope that wrote the rule at `index`, through the floor's retagging.
  const scopeAt = (index: number): RuleOrigin =>
    input.unfloored[index]?.origin ?? composed[index].origin;
  // The index of the rule `check()` matches for a probe, or -1 for none.
  const composedLookup = compileRulesetLookup(composed, flavor);
  const decidingIndex = (probe: Probe): number =>
    composedLookup(probe.surface, probe.value);
  // What the global scope alone resolves a probe to; `evaluate`'s `ask` when
  // nothing matches.
  const globalLookup = compileRulesetLookup(input.globalOnly, flavor);
  const ceilingOf = (probe: Probe): PermissionState =>
    input.globalOnly[globalLookup(probe.surface, probe.value)]?.action ?? "ask";

  const ruleCounts: Record<PermissionState, number> = {
    allow: 0,
    ask: 0,
    deny: 0,
  };
  const contributing = new Set<RuleOrigin>();
  let fallback: PolicyPosture["fallback"] = {
    action: input.asksAutoAllowed ? "allow" : "ask",
    origin: "builtin",
  };

  for (const [index, rule] of composed.entries()) {
    if (!isConfigured(rule)) continue;
    contributing.add(scopeAt(index));
    if (rule.layer === "default") {
      fallback = { action: effective(rule), origin: scopeAt(index) };
    } else if (decidingIndex(probeOf(rule)) === index) {
      ruleCounts[effective(rule)] += 1;
    }
  }

  const loosening = new Set<RuleOrigin>();
  const probes = [...composed, ...input.globalOnly]
    .filter(isConfigured)
    .map(probeOf);
  for (const probe of probes) {
    const index = decidingIndex(probe);
    if (index < 0 || !NON_GLOBAL_SCOPES.has(scopeAt(index))) continue;
    if (
      PERMISSIVENESS[composed[index].action] > PERMISSIVENESS[ceilingOf(probe)]
    ) {
      loosening.add(scopeAt(index));
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
