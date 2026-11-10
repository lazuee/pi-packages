import { validateToolCall } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  appendAskHistoryCompletion,
  appendAskHistoryRequest,
} from "./ask-history";
import { appendAskPayload } from "./ask-payload-store";
import {
  ASK_BACKGROUND_ONLY_TOOL_DESCRIPTION,
  ASK_TOOL_DESCRIPTION,
  invalidPayloadResponse,
  nonInteractiveResponse,
  renderAskToolCall,
  renderAskToolResult,
  successfulResponse,
  validateParams,
} from "./ask-tool-helpers";
import type { BackgroundAskRuntime } from "./background-ask";
import { AskQueuedSchema } from "./background-ask-state";
import { getAskConfigStore } from "./config/store";
import { resolveContextFiles } from "./context-files";
import { connectExternalAskUi, runExternalAskFlow } from "./external-ui";
import type { RemoteAskRuntime } from "./remote-ask";
import { AskOutputSchema, toAskOutput } from "./result-schema";
import { AskBackgroundOnlyParamsSchema, AskParamsSchema } from "./schema";
import { prepareAskParams } from "./state/normalize";
import type { AskParams, AskState } from "./types";
import { runAskFlow } from "./ui/controller";

export function registerAskTool(
  pi: ExtensionAPI,
  remoteAsk?: RemoteAskRuntime,
  backgroundAsk?: BackgroundAskRuntime,
  isBackgroundOnly: () => boolean = () => false,
) {
  if (!isToolRegistered(pi, "ask_user"))
    registerAskUserTool(pi, remoteAsk, backgroundAsk, isBackgroundOnly);
}

const reachesEverything = () => "all" as const;

/** Safe to call on every session start: Pi keeps registrations for the whole process. */
export function isToolRegistered(pi: ExtensionAPI, name: string): boolean {
  return pi.getAllTools().some((tool) => tool.name === name);
}

function registerAskUserTool(
  pi: ExtensionAPI,
  remoteAsk?: RemoteAskRuntime,
  backgroundAsk?: BackgroundAskRuntime,
  isBackgroundOnly: () => boolean = () => false,
) {
  const lateRegistration = !isToolRegistered(pi, "ask_user");
  pi.registerTool({
    ...definition(isBackgroundOnly()),
    prepareArguments: prepareAskParams as never,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      executeAskTool(
        pi,
        toolCallId,
        params as AskParams,
        signal,
        onUpdate,
        ctx,
        remoteAsk,
        backgroundAsk,
        isBackgroundOnly,
      ),
    // Registering after session_start leaves the tool out of the turn's tool snapshot,
    // where the SDK validates arguments. A "reaches" tool is executed even when its
    // call names no tool, so execute() validates the arguments itself.
    ...(lateRegistration ? { reachesTools: reachesEverything } : {}),
    renderCall: renderAskToolCall,
    renderResult: renderAskToolResult,
  });
}

const definition = (backgroundOnly: boolean) => ({
  name: "ask_user",
  label: "Ask User",
  description: backgroundOnly
    ? ASK_BACKGROUND_ONLY_TOOL_DESCRIPTION
    : ASK_TOOL_DESCRIPTION,
  promptSnippet:
    "Ask the user for what you cannot find yourself: missing facts, preferences, decisions",
  parameters: backgroundOnly ? AskBackgroundOnlyParamsSchema : AskParamsSchema,
  outputSchema: Type.Union([AskOutputSchema, AskQueuedSchema]),
});

async function executeNonTuiAsk(
  pi: Pick<ExtensionAPI, "events">,
  ctx: ExtensionContext,
  params: AskParams,
  state: AskState,
  toolCallId: string,
  signal: AbortSignal | undefined,
  runtime?: RemoteAskRuntime,
) {
  const provider =
    !params.background && runtime
      ? connectExternalAskUi(pi.events, ctx.mode, toolCallId)
      : undefined;
  if (!(provider && runtime)) {
    return nonInteractiveResponse(state);
  }
  const result = await runExternalAskFlow({
    provider,
    runtime,
    state,
    toolCallId,
    signal,
  });
  if (result.cancelled) {
    ctx.abort();
  }
  return successfulResponse(result);
}
export async function executeAskTool(
  pi: Pick<ExtensionAPI, "appendEntry" | "events" | "getAllTools">,
  toolCallId: string,
  input: AskParams,
  signal: AbortSignal | undefined,
  _onUpdate: unknown,
  ctx: ExtensionContext,
  remoteAsk?: RemoteAskRuntime,
  backgroundAsk?: BackgroundAskRuntime,
  isBackgroundOnly: () => boolean = () => false,
) {
  const config = await getAskConfigStore().getConfig();
  const backgroundOnly = isBackgroundOnly();
  // Re-run the SDK's two steps here: a late-registered tool skips both of them.
  const call = definition(backgroundOnly);
  const input_ = validateToolCall([call], {
    type: "toolCall",
    id: toolCallId,
    name: "ask_user",
    arguments: prepareAskParams(input) as never,
  }) as AskParams;
  const resolved = await resolveContextFiles(input_);
  if (!resolved.ok) {
    return invalidPayloadResponse(input_, resolved.issues);
  }
  const params = backgroundOnly
    ? { ...resolved.params, background: true }
    : resolved.params;
  const validation = validateParams(params, {
    presentSingleAsMulti: config.behaviour.presentSingleAsMulti,
  });
  if (!validation.ok) {
    return invalidPayloadResponse(params, validation.issues);
  }
  appendAskPayload(pi, {
    params,
    source: "tool",
    sourceEntryId: toolCallId,
  });
  const requestId = appendAskHistoryRequest(
    pi,
    toolCallId,
    validation.state,
    Boolean(params.background),
  );
  try {
    return await executeRecordedAsk(
      pi,
      requestId,
      toolCallId,
      params,
      validation.state,
      signal,
      ctx,
      remoteAsk,
      backgroundAsk,
      backgroundOnly,
      isBackgroundOnly,
    );
  } catch (error) {
    appendAskHistoryCompletion(pi, {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function executeRecordedAsk(
  pi: Pick<ExtensionAPI, "appendEntry" | "events">,
  requestId: string,
  toolCallId: string,
  params: AskParams,
  state: AskState,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  remoteAsk?: RemoteAskRuntime,
  backgroundAsk?: BackgroundAskRuntime,
  backgroundOnly = false,
  backgroundOnlyCheck: () => boolean = () => backgroundOnly,
) {
  if (ctx.mode !== "tui") {
    const response = await executeNonTuiAsk(
      pi,
      ctx,
      params,
      state,
      toolCallId,
      signal,
      remoteAsk,
    );
    return recordResponse(pi, requestId, response);
  }
  if (params.background || backgroundOnlyCheck()) {
    if (!backgroundAsk) {
      throw new Error("Background question queue is unavailable.");
    }
    const receipt = backgroundAsk.enqueue(
      requestId,
      params,
      ctx,
      state.questions.some((question) => question.presentedType === "multi"),
      toolCallId,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: `Queued ask_user [${receipt.requestId}]. ${receipt.pendingRequests} form(s) pending. This is not an answer. The answer arrives later as a background-answer message${backgroundOnly ? "" : " or from wait_for_answers"}.`,
        },
      ],
      details: receipt,
      structuredContent: receipt,
    };
  }
  ctx.ui.setWorkingVisible(false);
  try {
    const result = await runAskFlow(ctx, params, {
      signal,
      remote: remoteAsk
        ? { runtime: remoteAsk, source: "tool", toolCallId }
        : undefined,
      herdrEvents: pi.events,
    });
    return recordResponse(pi, requestId, successfulResponse(result));
  } finally {
    ctx.ui.setWorkingVisible(true);
  }
}

function recordResponse(
  pi: Pick<ExtensionAPI, "appendEntry">,
  requestId: string,
  response:
    | ReturnType<typeof successfulResponse>
    | ReturnType<typeof invalidPayloadResponse>
    | ReturnType<typeof nonInteractiveResponse>,
) {
  const result = { ...response.details, requestId };
  appendAskHistoryCompletion(pi, { requestId, result });
  return {
    ...response,
    content: response.content.map((item, index) =>
      item.type === "text" && index === 0
        ? {
            ...item,
            text: `ask_user [${requestId}]\n${item.text}`,
          }
        : item,
    ),
    details: result,
    structuredContent: toAskOutput(result),
  };
}
