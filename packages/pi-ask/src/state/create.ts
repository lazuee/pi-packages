import type { AskParams } from "#src/types";
import { normalizeQuestions } from "./normalize";
import { createInitialState as createBaseState } from "./transitions";

interface CreateInitialStateOptions {
  presentSingleAsMulti?: boolean;
}

export function createInitialState(
  params: AskParams,
  options: CreateInitialStateOptions = {},
) {
  return createBaseState({
    title: params.title?.trim() || undefined,
    questions: normalizeQuestions(params, options),
  });
}
