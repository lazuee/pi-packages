import { removeKey } from "#src/state/remove-key";
import type { AskQuestion, AskState } from "#src/types";
import { navigateView, submitView } from "./view";

/** Remove one question from active navigation without submitting the questionnaire. */
export function skipCurrentQuestion(state: AskState): AskState {
  // Pasting `completed` does not cover Review, where the index is one past the
  // last question, so the lookup stays unchecked.
  const question = state.questions[state.activeTabIndex] as
    | AskState["questions"][number]
    | undefined;
  if (state.completed || !question) {
    return state;
  }
  const index = getResultQuestions(state).findIndex(
    (candidate) => candidate.id === question.id,
  );
  const questions = state.questions.filter(
    (candidate) => candidate.id !== question.id,
  );
  const answers = { ...state.answers };
  removeKey(answers, question.id);
  const activeTabIndex = Math.min(state.activeTabIndex, questions.length);
  return {
    ...state,
    questions,
    answers,
    skippedQuestions: [...(state.skippedQuestions ?? []), { index, question }],
    activeTabIndex,
    activeOptionIndex: 0,
    activeSubmitActionIndex: 0,
    view: activeTabIndex >= questions.length ? submitView() : navigateView(),
  };
}

/** Restore original order while keeping the live presentation of remaining questions. */
export function getResultQuestions(state: AskState): AskQuestion[] {
  const questions = [...state.questions];
  for (const { index, question } of [...(state.skippedQuestions ?? [])].sort(
    (left, right) => left.index - right.index,
  )) {
    questions.splice(index, 0, question);
  }
  return questions;
}
