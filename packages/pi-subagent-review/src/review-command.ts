import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolveReviewConfig } from "./config.js";
import { REVIEW_COMMAND } from "./constants.js";
import { buildReviewConversationSummary } from "./conversation-summary.js";
import {
  announceReviewFindingsReady,
  announceReviewSummaryStarted,
  sendReviewFindings,
  sendReviewPreface,
} from "./messages.js";
import type { ReviewDeveloperMessages } from "./messages.js";
import { detectReviewContext } from "./review-context.js";
import {
  appendReviewLoopBoundary,
  applyReviewLoopMarker,
  getSemanticLeafId,
  parseReviewArgs,
  readReviewLoopState,
  summarizeReviewLoopIncrement,
} from "./review-loop.js";
import { createReviewProgress } from "./review-progress.js";
import { buildReviewTask } from "./review-task.js";
import {
  createChildRunDetails,
  getFinalOutput,
  isSubagentFailure,
} from "./run-details.js";
import { runReviewSubagent, normalizeReviewMarkup } from "./subagent.js";
import type { NavigateWithSummaryModel } from "./tree-summary.js";

// Shepherdr's own reporter; the event name is a shared contract, not an import,
// so /review still works when that package is not loaded.
const STATUS_CHANNEL = "herdr:status";

export function registerReviewCommand(
  pi: ExtensionAPI,
  navigateWithSummaryModel: NavigateWithSummaryModel,
  developerMessages?: ReviewDeveloperMessages
) {
  pi.registerCommand(REVIEW_COMMAND, {
    description:
      "Run an isolated code-review subagent; in a JJ workspace, pass stack=<ancestor revset> to review a cumulative stack",
    handler: async (args, ctx) => {
      const parsedArgs = parseReviewArgs(args);
      const progress = createReviewProgress(ctx);
      const setReviewWidget = progress.setPhase;
      // The reviewer runs outside any turn, so the session would report `idle`
      // to shepherdr, waits and the sidebar for the whole run.
      const hold = (active: boolean, label?: string) =>
        pi.events.emit(STATUS_CHANNEL, { active, ...(label ? { label } : {}) });

      if (!ctx.isIdle()) {
        ctx.ui.notify(
          `Waiting for the current turn to finish before running /${REVIEW_COMMAND}...`,
          "info"
        );
        await ctx.waitForIdle();
      }
      let review;
      try {
        review = await detectReviewContext(pi, ctx.cwd, {
          ...(parsedArgs.stackBase ? { stackBase: parsedArgs.stackBase } : {}),
          onStage: (stage) => setReviewWidget(stage),
        });
        if (review.vcs === "jj" && parsedArgs.invalidStackArgument) {
          throw new Error(parsedArgs.invalidStackArgument);
        }
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error"
        );
        progress.stop();
        return;
      }

      let reviewConfig;
      let summaryFallbackNotified = false;

      if (!parsedArgs.startLoop) {
        const markerId = readReviewLoopState(ctx)?.markerId;
        if (markerId) {
          setReviewWidget("Summarizing the review loop increment…");
          reviewConfig = await resolveReviewConfig(pi, ctx);
          if (reviewConfig.summary.source === "current") {
            ctx.ui.notify(
              `Configured summary model unavailable; falling back to current session model ${reviewConfig.summary.model}.`,
              "warning"
            );
            summaryFallbackNotified = true;
          }
          const loopResult = await summarizeReviewLoopIncrement(
            pi,
            ctx,
            markerId,
            reviewConfig.summary,
            navigateWithSummaryModel
          );
          if (loopResult === "cancelled") {
            ctx.ui.notify("/review cancelled", "warning");
            progress.stop();
            return;
          }
        }
      }

      if (!review.hasAnyChanges) {
        ctx.ui.notify(
          review.vcs === "jj"
            ? "No changes found in the active JJ revision or its immediate parent."
            : review.scope === "latest-commit"
              ? `No changes against \`${review.baseBranch}\`; the latest commit is already reviewed. Commit or stage something first.`
              : "No changes found relative to the selected base branch.",
          "info"
        );
        progress.stop();
        return;
      }
      sendReviewPreface(
        pi,
        ctx,
        { freshLoop: parsedArgs.startLoop },
        developerMessages
      );

      if (parsedArgs.startLoop) {
        const targetId =
          appendReviewLoopBoundary(pi, ctx) ?? getSemanticLeafId(ctx);
        if (targetId) {
          applyReviewLoopMarker(
            pi,
            ctx,
            targetId,
            readReviewLoopState(ctx)?.markerId
          );
          ctx.ui.notify("Review loop marker set", "info");
        }
      }

      reviewConfig ??= await resolveReviewConfig(pi, ctx);
      progress.setScope(review);
      progress.start();
      hold(true, `/${REVIEW_COMMAND}`);
      let conversationSummary: string | undefined;
      let details = createChildRunDetails("", review.repoRoot, reviewConfig);
      try {
        try {
          if (reviewConfig.summary.enabled) {
            if (
              reviewConfig.summary.source === "current" &&
              !summaryFallbackNotified
            )
              ctx.ui.notify(
                `Configured summary model unavailable; falling back to current session model ${reviewConfig.summary.model}.`,
                "warning"
              );
            setReviewWidget("Summarizing the conversation for the reviewer…", {
              summaryModel: reviewConfig.summary.model,
            });
            announceReviewSummaryStarted(pi);
            conversationSummary = await buildReviewConversationSummary(
              ctx,
              reviewConfig
            );
          }
        } catch (error) {
          if (ctx.signal?.aborted) return;
          ctx.ui.notify(
            `Conversation summary unavailable: ${error instanceof Error ? error.message : String(error)}; continuing with diff-only review.`,
            "warning"
          );
        }

        const task = buildReviewTask(
          review,
          review.vcs === "jj" ? parsedArgs.focus : parsedArgs.rawFocus,
          conversationSummary
        );
        const spawnedAt = Date.now();
        details = createChildRunDetails(task, review.repoRoot, reviewConfig);
        if (reviewConfig.source === "current") {
          ctx.ui.notify(
            `Configured review model unavailable; falling back to current session model ${reviewConfig.model}.`,
            "warning"
          );
        }

        // The reviewer spawns its own process; say so while the child starts up
        // so the gap before its first turn does not read as a stalled run.
        setReviewWidget(
          review.vcs === "jj"
            ? `Launching the reviewer on revision ${review.changeId}…`
            : `Launching the reviewer on ${review.scope === "latest-commit" ? `commit ${review.latestCommit ?? "HEAD"}` : `the diff against ${review.baseBranch ?? "the base"}`}…`,
          {
            reviewerModel: reviewConfig.model,
            ...(reviewConfig.source === "current"
              ? { detail: "configured model unavailable, using current" }
              : {}),
          }
        );
        const seconds = Math.max(
          1,
          Math.round((Date.now() - spawnedAt) / 1000)
        );
        setReviewWidget(
          review.vcs === "jj"
            ? `Reviewing revision ${review.changeId}…`
            : `Reviewing ${review.scope === "latest-commit" ? `commit ${review.latestCommit ?? "HEAD"}` : `the diff against ${review.baseBranch ?? "the base"}`}…`,
          {
            reviewerModel: reviewConfig.model,
            detail: `subagent running for ${seconds}s`,
          }
        );
        details = await runReviewSubagent(
          task,
          review.repoRoot,
          reviewConfig,
          ctx.signal
        );
        if (ctx.signal?.aborted) return;
        const finalOutput = getFinalOutput(details.messages).trim();
        // The reviewer's own diagnostics: a provider error or an empty run used
        // to surface as "No actionable issues found", which reads like a pass.
        if (isSubagentFailure(details) && finalOutput)
          throw new Error(
            details.errorMessage || details.stderr || "Review subagent failed."
          );

        const findings = normalizeReviewMarkup(
          finalOutput || "No actionable issues found."
        );

        setReviewWidget("Delivering findings to the main agent…");
        sendReviewFindings(pi, ctx, review, findings);
        announceReviewFindingsReady(pi);
        // An idle session queues findings without a turn, so the follow-up
        // triage prompt is what actually starts one; claiming it was "sent back
        // to the main agent" was wrong and left the findings unread.
        ctx.ui.notify(
          ctx.isIdle()
            ? `Review findings from /${REVIEW_COMMAND} are ready.`
            : `Review findings sent back to the main agent from /${REVIEW_COMMAND}.`,
          "info"
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        details.exitCode ||= 1;
        details.errorMessage = message;
        pi.appendEntry("subagent-review-failure", {
          version: 1,
          message,
          model: details.model,
          cwd: details.cwd,
        });
        ctx.ui.notify(`/${REVIEW_COMMAND} failed: ${message}`, "error");
      } finally {
        hold(false);
        progress.stop();
      }
    },
  });
}
