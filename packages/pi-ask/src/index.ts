import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskHistoryTools } from "./ask-history-tools";
import { AskModeController } from "./ask-mode";
import { registerAskModeCommand } from "./ask-mode-command";
import { registerAskSettingsCommand } from "./ask-settings-command";
import { executeAskTool, registerAskTool } from "./ask-tool";
import { registerBackgroundAnswerRenderer } from "./background-answer";
import {
  type BackgroundAskRuntime,
  createBackgroundAskRuntime,
  registerBackgroundAskEvents,
} from "./background-ask";
import { getAskConfigStore, resetAskConfigStore } from "./config/store";
import { registerQuestionStatus } from "./program-status";
import { createRemoteAskRuntime } from "./remote-ask";
import { registerPendingAskResume } from "./resume-pending-ask";
import type { AskParams } from "./types";
import { registerWaitForAnswersTool } from "./wait-for-answers-tool";

// The form and the queue are TUI-only, and the run mode exists only on the event
// context, so tools register on session_start instead of eagerly at load.
export default function askExtension(pi: ExtensionAPI) {
  resetAskConfigStore();
  registerQuestionStatus(pi);
  const remoteAsk = createRemoteAskRuntime(pi.events);
  pi.on("session_shutdown", () => {
    remoteAsk.disposeAll();
  });
  let backgroundAsk: BackgroundAskRuntime | undefined;
  // Commands are TUI-gated rather than idempotent, so a later session must not re-register them.
  let commandsRegistered = false;
  registerBackgroundAnswerRenderer(pi);
  const mode = new AskModeController(getAskConfigStore(), (backgroundOnly) => {
    if (backgroundOnly) {
      backgroundAsk?.interruptWait(
        new Error(
          "wait_for_answers is unavailable in background-only mode. End your turn and receive answers asynchronously.",
        ),
      );
    }
  });
  const registerTuiSurface = () => {
    if (!backgroundAsk) {
      backgroundAsk = createBackgroundAskRuntime(pi, remoteAsk);
    } else if (!commandsRegistered) {
      registerBackgroundAskEvents(pi, backgroundAsk);
    }
    if (!commandsRegistered) {
      registerAskModeCommand(pi, mode);
      registerAskSettingsCommand(pi);
      commandsRegistered = true;
    }
    registerAskTool(pi, remoteAsk, backgroundAsk, () => mode.backgroundOnly);
    registerWaitForAnswersTool(pi, backgroundAsk, () => mode.backgroundOnly);
  };
  pi.on("session_start", async (_event, ctx) => {
    await mode.initialize(ctx);
    // Tools register in every mode: print, JSON, and RPC can still answer through an
    // external UI. The native form, the queue, and the commands stay TUI-only.
    if (ctx.mode === "tui") {
      registerTuiSurface();
    } else {
      registerAskTool(pi, remoteAsk, undefined, () => mode.backgroundOnly);
    }
    if ((await getAskConfigStore().getConfig()).behaviour.historyTools) {
      registerAskHistoryTools(pi);
    }
  });
  // The turn's tool snapshot is taken before they register, so a retry of the rejected
  // call finds nothing. This handler executes that retry in-process; the second run's
  // own snapshot differs, so it never runs the same call twice.
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "ask_user") {
      return undefined;
    }
    // Registered by session_start, so this is the retry of a "not found" rejection.
    if (pi.getAllTools().some((tool) => tool.name === "ask_user")) {
      return undefined;
    }
    if (!backgroundAsk) {
      return undefined;
    }
    // The handler owns the call; its result reaches the agent as the next turn.
    void executeAskTool(
      pi,
      event.toolCallId,
      event.input as unknown as AskParams,
      undefined,
      undefined,
      ctx,
      remoteAsk,
      backgroundAsk,
      () => mode.backgroundOnly,
    ).then(
      (result) =>
        pi.sendMessage(
          {
            customType: "ask-tool-result",
            content: result.content,
            display: false,
            details: result.details,
          },
          { triggerTurn: true },
        ),
      (error: unknown) =>
        pi.sendMessage(
          {
            customType: "ask-tool-result",
            content: [
              {
                type: "text" as const,
                text: `ask_user failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            display: false,
          },
          { triggerTurn: true },
        ),
    );
    return { block: true };
  });
  pi.on("context", () => mode.markModelRequest());
  pi.on("session_shutdown", () => mode.endSession());
  registerPendingAskResume(pi, remoteAsk);
  // Commands are mode-independent and Pi offers no lookup during loading, so they
  // register here once; tools need the run mode and wait for session_start.
  registerAskModeCommand(pi, mode);
  registerAskSettingsCommand(pi);
}
