import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskHistoryTools } from "./ask-history-tools";
import { AskModeController } from "./ask-mode";
import { registerAskModeCommand } from "./ask-mode-command";
import { registerAskSettingsCommand } from "./ask-settings-command";
import { registerAskTool } from "./ask-tool";
import { registerBackgroundAnswerRenderer } from "./background-answer";
import { createBackgroundAskRuntime } from "./background-ask";
import { getAskConfigStore, resetAskConfigStore } from "./config/store";
import { registerQuestionStatus } from "./program-status";
import { createRemoteAskRuntime } from "./remote-ask";
import { registerPendingAskResume } from "./resume-pending-ask";
import { registerWaitForAnswersTool } from "./wait-for-answers-tool";

export default function askExtension(pi: ExtensionAPI) {
  resetAskConfigStore();
  registerQuestionStatus(pi);
  const remoteAsk = createRemoteAskRuntime(pi.events);
  pi.on("session_shutdown", () => {
    remoteAsk.disposeAll();
  });
  const backgroundAsk = createBackgroundAskRuntime(pi, remoteAsk);
  registerBackgroundAnswerRenderer(pi);
  const mode = new AskModeController(getAskConfigStore(), (backgroundOnly) => {
    registerQuestionTools();
    if (backgroundOnly) {
      backgroundAsk.interruptWait(
        new Error(
          "wait_for_answers is unavailable in background-only mode. End your turn and receive answers asynchronously.",
        ),
      );
    }
  });
  const registerQuestionTools = () => {
    registerAskTool(pi, remoteAsk, backgroundAsk, () => mode.backgroundOnly);
    registerWaitForAnswersTool(pi, backgroundAsk, () => mode.backgroundOnly);
  };
  registerQuestionTools();
  pi.on("session_start", async (_event, ctx) => {
    await mode.initialize(ctx);
    if ((await getAskConfigStore().getConfig()).behaviour.historyTools) {
      registerAskHistoryTools(pi);
    }
  });
  pi.on("context", () => mode.markModelRequest());
  pi.on("session_shutdown", () => mode.endSession());
  registerAskModeCommand(pi, mode);
  registerAskSettingsCommand(pi);
  registerPendingAskResume(pi, remoteAsk);
}
