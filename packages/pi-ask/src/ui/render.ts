import type { AskConfig } from "#src/config/schema";
import {
  getCurrentQuestion,
  getRenderableOptions,
  isSubmitTab,
} from "#src/state/selectors";
import { isEditingView } from "#src/state/view";
import type { AskState } from "#src/types";
import { renderFrameFooter, renderFrameHeader } from "./render-frame";
import { renderQuestionScreen } from "./render-question";
import { renderSubmitScreen } from "./render-submit";
import type {
  AskMouseTarget,
  QuestionRenderContext,
  Theme,
} from "./render-types";

export function renderAskScreen(args: {
  config: AskConfig;
  targets?: AskMouseTarget[];
  footerNotice?: string;
  background?: boolean;
  reviewShortcutHint?: string;
  state: AskState;
  theme: Theme;
  width: number;
  editor: QuestionRenderContext["editor"];
}): string[] {
  const {
    config,
    footerNotice,
    reviewShortcutHint,
    state,
    theme,
    width,
    editor,
  } = args;
  const lines: string[] = [];
  const question = getCurrentQuestion(state);
  const options = getRenderableOptions(question);
  const markActiveRow = Boolean(
    args.background && editor.focused && !isEditingView(state),
  );

  renderFrameHeader({ lines, state, theme, width, targets: args.targets });

  if (isSubmitTab(state)) {
    renderSubmitScreen(
      lines,
      state,
      theme,
      width,
      reviewShortcutHint,
      markActiveRow,
      args.targets,
      editor,
    );
  } else if (question) {
    renderQuestionScreen({
      lines,
      state,
      question,
      options,
      markActiveRow,
      targets: args.targets,
      theme,
      width,
      editor,
    });
  }

  renderFrameFooter({
    config,
    footerNotice,
    lines,
    state,
    theme,
    width,
    background: args.background,
  });
  return lines;
}
