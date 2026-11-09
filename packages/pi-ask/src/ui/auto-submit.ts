import type { AskConfig } from "#src/config/schema";
import { hasAnswerNotes } from "#src/state/answers";
import { isQuestionAnswered, isSubmitTab } from "#src/state/selectors";
import type { AskState } from "#src/types";

export function maybeAutoSubmitState(
  state: AskState,
  config: AskConfig,
): AskState {
  if (!shouldAutoSubmit(state, config)) {
    return state;
  }
  return {
    ...state,
    completed: true,
  };
}

export function shouldAutoSubmit(state: AskState, config: AskConfig): boolean {
  if (!config.behaviour.autoSubmitWhenAnsweredWithoutNotes) {
    return false;
  }
  if (
    !state.questions.length ||
    state.completed ||
    state.cancelled ||
    !isSubmitTab(state) ||
    state.view.kind === "submit-note" ||
    state.submitNotes?.submit ||
    state.submitNotes?.cancel
  ) {
    return false;
  }
  for (const question of state.questions) {
    if (!isQuestionAnswered(state, question.id)) {
      return false;
    }
    if (hasAnswerNotes(state.answers[question.id])) {
      return false;
    }
  }
  return true;
}
