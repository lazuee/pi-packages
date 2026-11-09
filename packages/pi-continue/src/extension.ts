/* eslint-disable @typescript-eslint/require-await -- Pi's event handlers and command handlers must return a promise; the work here is synchronous. */
/**
 * pi-continue — detect a stalled agent run and nudge it back into motion.
 *
 * Wiring only: every rule lives in a module that runs without Pi. The handlers
 * below translate Pi's lifecycle into engine calls; the gateway, the permission
 * observer and the judge are built here because they are the pieces that need
 * the host.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import type { ArmState } from "./arm-tool";
import { ARM_TOOL_NAME, createArmTool } from "./arm-tool";
import {
  type ContinueConfig,
  getGlobalConfigPath,
  getProjectConfigPath,
  loadConfig,
} from "./config";
import { ContinueEngine, STATUS_KEY } from "./engine";
import type { MessageLike } from "./evidence";
import { readEnv, SessionGateway } from "./gateway";
import { createJudge, JUDGE_MAX_TAIL_CHARS } from "./judge";
import { resolveJudgeModel } from "./judge-model";
import { PermissionAwait } from "./permission-await";

const ARM_ENTRY = "pi-continue:arm";
const CHILD_STARTED = "subagents:started";
/** Ceiling on a whole judge chain, so a long candidate list cannot stall settle. */
const JUDGE_TOTAL_BUDGET_MS = 20_000;
const CHILD_ENDED = ["subagents:completed", "subagents:failed"] as const;

export default function piContinueExtension(pi: ExtensionAPI): void {
  const gateway = new SessionGateway();
  const awaits = new PermissionAwait({
    on: (channel, handler) => pi.events.on(channel, handler),
  });
  let config: ContinueConfig = loadConfig({
    globalConfigPath: getGlobalConfigPath(getAgentDir()),
    projectConfigPath: getProjectConfigPath(process.cwd()),
  });
  let armState: ArmState = { armed: false };
  // In-session override of `enabled`; undefined defers to config. Cleared on a
  // session switch so a mute does not silently follow you into a new session.
  let enabledOverride: boolean | undefined;
  let operatorMessage: string | undefined;
  let statusCtx: ExtensionContext | undefined;

  const refreshConfig = (cwd: string): void => {
    config = loadConfig({
      globalConfigPath: getGlobalConfigPath(getAgentDir()),
      projectConfigPath: getProjectConfigPath(cwd),
    });
    // An explicit in-session toggle wins; otherwise arming is the explicit ask.
    if (enabledOverride !== undefined) config = { ...config, enabled: enabledOverride };
    else if (armState.armed) config = { ...config, enabled: true };
  };

  const engine = new ContinueEngine({
    host: {
      on: (event, handler) => {
        pi.on(event as Parameters<typeof pi.on>[0], handler as never);
      },
      sendUserMessage: (text, options) => pi.sendUserMessage(text, options),
    },
    gateway,
    config: () => config,
    permissionPending: () => {
      const v = awaits.pending;
      if (process.env.PI_CONTINUE_TRACE) appendFileSync("/tmp/trace.log", `pending=${v} n=${awaits.pendingCount}\n`);
      return v;
    },
    childPending: () => gateway.hasActiveChildren,
    messages: () => branchMessages(statusCtx),
    operatorMessage: () => armState.goal ?? operatorMessage,
    judge: createJudge({
      completer: {
        complete: (prompt) =>
          completeWithJudge(statusCtx, config.judgeModel, prompt, config.judgeTimeoutMs),
      },
      messages: () => branchMessages(statusCtx),
      tailMessages: config.judgeTailMessages,
      timeoutMs: config.judgeTimeoutMs,
      maxTailChars: JUDGE_MAX_TAIL_CHARS,
    }),
    log: (message) => process.stderr.write(`[pi-continue] ${message}\n`),
    notify: (text, level) => {
      if (statusCtx?.hasUI) statusCtx.ui.notify(text, level);
    },
    setStatus: (text) => {
      if (!statusCtx?.hasUI) return;
      const fallback = armState.armed ? "↻ armed" : undefined;
      statusCtx.ui.setStatus(STATUS_KEY, text ?? fallback);
    },
  });

  pi.registerTool(
    createArmTool({
      state: () => armState,
      arm: (goal) => {
        armState = { armed: true, goal, armedAt: Date.now() };
        engine.noteOperatorSpoke();
      },
      disarm: () => {
        armState = { armed: false };
      },
      persist: () => pi.appendEntry(ARM_ENTRY, armState),
    }),
  );

  pi.on("session_start", async (_event, ctx) => {
    statusCtx = ctx;
    enabledOverride = undefined;
    refreshConfig(ctx.cwd);
    engine.noteSessionStart();
    gateway.touch();
    if (readEnv("PI_CONTINUE_FOR_CHILD", process.env) === "1") {
      gateway.markChild();
    }
  });

  pi.on("input", (event) => {
    // Only interaction counts as the operator speaking: a message this
    // extension delivered must not clear the streak it advanced.
    if (event.source !== "interactive") return;
    operatorMessage = event.text;
    engine.noteOperatorSpoke();
    return { action: "continue" as const };
  });

  pi.events.on(CHILD_STARTED, (payload) => {
    const id = agentIdOf(payload);
    if (id) gateway.childSpawned(id);
  });
  for (const channel of CHILD_ENDED) {
    pi.events.on(channel, (payload) => {
      const id = agentIdOf(payload);
      if (id) gateway.childFinished(id);
    });
  }

  pi.on("agent_start", () => {
    engine.noteRunStart();
    gateway.touch();
  });

  pi.on("turn_end", () => {
    gateway.turnEnded();
  });

  pi.on("agent_end", (_event, ctx) => {
    engine.captureRun();
    if (ctx.signal?.aborted) engine.noteAbort();
  });

  pi.on("agent_before_settle", () => {
    engine.captureRun();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await engine.onSettled(ctx);
  });

  pi.on("session_shutdown", () => {
    awaits.dispose();
    statusCtx = undefined;
  });

  pi.registerCommand("continue", {
    description: "pi-continue status, arm/disarm recovery, or on/off for this session",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "arm") {
        armState = { armed: true, armedAt: Date.now() };
        ctx.ui.notify(`${ARM_TOOL_NAME}: armed`, "info");
        return;
      }
      if (sub === "disarm") {
        armState = { armed: false };
        ctx.ui.notify(`${ARM_TOOL_NAME}: disarmed`, "info");
        return;
      }
      if (sub === "on" || sub === "off") {
        enabledOverride = sub === "on";
        refreshConfig(ctx.cwd);
        if (!enabledOverride) armState = { armed: false };
        ctx.ui.notify(
          `pi-continue ${sub === "on" ? "enabled" : "disabled"} for this session`,
          "info",
        );
        return;
      }
      ctx.ui.notify(
        statusReport(engine, gateway, awaits, config, armState, enabledOverride),
        "info",
      );
    },
  });
}

function statusReport(
  engine: ContinueEngine,
  gateway: SessionGateway,
  awaits: PermissionAwait,
  config: ContinueConfig,
  armState: ArmState,
  enabledOverride: boolean | undefined,
): string {
  const last = engine.lastDecision;
  return [
    `pi-continue ${config.enabled ? "enabled" : "disabled"}` +
      (enabledOverride === undefined ? "" : " (session override)") +
      (armState.armed ? " (armed)" : ""),
    `gated in: ${gateway.isGatedIn(config) ? "yes" : "no"}`,
    `streak: ${engine.streak}/${config.maxConsecutive}`,
    `permission prompts open: ${awaits.pendingCount}`,
    `children running: ${gateway.hasActiveChildren ? "yes" : "no"}`,
    `judge: ${config.judgeMode}`,
    `last: ${last ? `${last.verdict} — ${last.reason}` : "none"}`,
  ].join("\n");
}

function agentIdOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const id = (payload as { agentId?: unknown }).agentId;
  return typeof id === "string" ? id : undefined;
}

/** The branch's message rows, as the evidence readers see them. */
function branchMessages(ctx: ExtensionContext | undefined): MessageLike[] {
  if (!ctx) return [];
  return ctx.sessionManager.getBranch().flatMap((entry: unknown) => {
    const message = (entry as { message?: MessageLike }).message;
    return message ? [message] : [];
  });
}

/**
 * One judge call.
 *
 * The judge is a convenience, so every dead end returns an empty answer and the
 * deterministic rows decide instead. Candidates are tried in order — an explicit
 * `judgeModel`, then the session model, then any credentialed chat model — so a
 * provider that dies mid-session is stepped over rather than silencing the judge.
 */
async function completeWithJudge(
  ctx: ExtensionContext | undefined,
  configured: ContinueConfig["judgeModel"],
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const registry = ctx?.modelRegistry;
  if (!ctx || !registry) return "";

  let available: ReadonlyArray<{ provider: string; id: string }> = [];
  try {
    available = await registry.getAvailableOfType("chat");
  } catch {
    // The session and configured candidates below do not need the listing.
  }
  const session = ctx.model;
  const candidates = resolveJudgeModel({
    configured: configured
      ? { provider: configured.provider, id: configured.model }
      : undefined,
    session: session ? { provider: session.provider, id: session.id } : undefined,
    available: available.map((model) => ({ provider: model.provider, id: model.id })),
  });

  const context = {
    messages: [
      {
        role: "user" as const,
        timestamp: Date.now(),
        content: [{ type: "text" as const, text: prompt }],
      },
    ],
  };
  // A total budget across the chain: ten candidates at a full per-attempt
  // timeout would otherwise hold the settle boundary open for minutes.
  const deadline = Date.now() + Math.max(timeoutMs, JUDGE_TOTAL_BUDGET_MS);
  for (const candidate of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const model = registry.getModelOfType("chat", candidate.provider, candidate.id);
    if (!model) continue;
    // A fresh controller per attempt: a signal already aborted by the previous
    // candidate's timeout would fail every retry immediately.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, Math.min(timeoutMs, remaining));
    try {
      const message = await registry.complete(model, context, {
        signal: controller.signal,
      });
      // A timed-out call resolves with an aborted message instead of throwing.
      const failed = message.stopReason === "aborted" || message.stopReason === "error";
      const text = message.content
        .filter(
          (block): block is { type: "text"; text: string } =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join("\n");
      if (failed || text.trim().length === 0) {
        continue;
      }
      return text;
    } catch {
      // Next candidate.
    } finally {
      clearTimeout(timer);
    }
  }
  return "";
}
