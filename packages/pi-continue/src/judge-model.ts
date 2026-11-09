/**
 * Which model the judge calls.
 *
 * The judge only needs a cheap, available chat model, so the order is:
 *
 * 1. the model named in `judgeModel` — an explicit choice is honoured even if it
 *    is the session model;
 * 2. the session model, when no judge model is set;
 * 3. any model whose provider has credentials, so a configured judge that has
 *    since lost its key still gets an answer;
 * 4. nothing, which leaves the deterministic rows to decide.
 *
 * Step 3 is what makes the judge usable without pinning a model: it degrades to
 * whatever is actually reachable instead of going silent.
 */

/** The minimum a candidate model must carry. */
export interface ModelChoice {
  provider: string;
  id: string;
}

/** What the resolver may look at, so it stays host-free and testable. */
export interface ResolveJudgeInput {
  /** The `judgeModel` config, if set. */
  configured: ModelChoice | undefined;
  /** The session's current model, if any. */
  session: ModelChoice | undefined;
  /** Credentialed chat models, most-preferred first. */
  available: readonly ModelChoice[];
}

/**
 * The ordered candidates to try, most preferred first.
 *
 * A configured model leads, and is included even when it is not in `available`:
 * the list only covers credentialed providers. Duplicates are collapsed so a
 * configured model equal to the session model is not tried twice.
 */
export function resolveJudgeModel(input: ResolveJudgeInput): ModelChoice[] {
  const ordered: ModelChoice[] = [];
  for (const candidate of [
    input.configured,
    input.session,
    ...input.available,
  ]) {
    if (!candidate) continue;
    const seen = ordered.some(
      (m) => m.provider === candidate.provider && m.id === candidate.id,
    );
    if (!seen) ordered.push(candidate);
  }
  return ordered;
}
