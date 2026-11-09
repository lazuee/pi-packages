import { CANCELLED_SUMMARY, SUBMITTED_SUMMARY } from "#src/constants/text";
import { formatResultLines } from "#src/result-format";
import type { AskResult, AskState, AskStateAnswer } from "#src/types";
import {
  getExtraOptionNotes,
  isAnswerEmpty,
  isResultAnswerCommitted,
  isResultAnswerEmpty,
  serializeAnswer,
} from "./answers";
import { getResultQuestions } from "./skip";

export type ReviewAnswer = AskResult["answers"][string] & {
  extraOptionNotes?: Array<{
    label: string;
    note: string;
  }>;
};

export function toAskResult(state: AskState): AskResult {
  const questions = getResultQuestions(state);
  const skipped = new Set(
    state.skippedQuestions?.map(({ question }) => question.id),
  );
  const skippedQuestionIds = questions
    .filter((question) => skipped.has(question.id))
    .map((question) => question.id);
  const answers = Object.fromEntries(
    Object.entries(state.answers)
      .filter(([questionId]) => !skipped.has(questionId))
      .map(([questionId, answer]) => {
        const serialized = serializeAnswer(answer);
        if (state.cancelled) {
          serialized.customImages = undefined;
          serialized.noteImages = undefined;
          serialized.optionNoteImages = undefined;
        }
        return [questionId, serialized] as const;
      })
      .filter(([, answer]) => !isResultAnswerEmpty(answer)),
  );

  return {
    title: state.title,
    cancelled: state.cancelled,
    ...(state.submitNotes?.[state.cancelled ? "cancel" : "submit"]
      ? { comment: state.submitNotes[state.cancelled ? "cancel" : "submit"] }
      : {}),
    questions: questions.map((question) => ({
      id: question.id,
      label: question.label,
      prompt: question.prompt,
      type: question.requestedType ?? question.type,
      ...(question.presentedType &&
      question.presentedType !== question.requestedType
        ? { presentedType: question.presentedType }
        : {}),
    })),
    answers,
    ...(skippedQuestionIds.length ? { skippedQuestionIds } : {}),
  };
}

export function summarizeResult(result: AskResult): string {
  if (result.cancelled) {
    return result.comment
      ? `${CANCELLED_SUMMARY}\nComment: ${result.comment}`
      : CANCELLED_SUMMARY;
  }
  const lines = formatResultLines(result, { mode: "summary" });
  if (result.comment) {
    lines.push(`Comment: ${result.comment}`);
  }
  return lines.join("\n") || SUBMITTED_SUMMARY;
}

export function hasAnswerContent(state: AskState, questionId: string): boolean {
  const answer = state.answers[questionId];
  return Boolean(answer) && !isAnswerEmpty(answer);
}

export function toReviewAnswer(
  question: AskState["questions"][number],
  answer: AskStateAnswer | undefined,
): ReviewAnswer | undefined {
  if (!answer) {
    return;
  }

  const serialized = serializeAnswer(answer);
  const hasCommittedAnswer = isResultAnswerCommitted(serialized);

  const extraOptionNotes = getExtraOptionNotes({
    answer,
    questionOptions: question.options,
    selectedValues: serialized.values,
  });
  if (
    !(hasCommittedAnswer || serialized.note || serialized.noteImages?.length) &&
    extraOptionNotes.length === 0
  ) {
    return;
  }

  return {
    ...serialized,
    extraOptionNotes:
      extraOptionNotes.length > 0 ? extraOptionNotes : undefined,
  };
}

export function shouldRenderAnswersIndividually(answer: ReviewAnswer): boolean {
  if (!answer.labels.length) {
    return false;
  }

  return (
    answer.labels.length > 1 ||
    Boolean(answer.optionNotes && Object.keys(answer.optionNotes).length > 0) ||
    Boolean(
      answer.optionNoteImages &&
        Object.keys(answer.optionNoteImages).length > 0,
    )
  );
}
