import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { REVIEW_COMMAND } from "./constants.js";
import type { ReviewContext } from "./types.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 120;
const MAX_BODY_LINES = 6;

export interface ReviewChecks {
  summaryModel?: string | undefined;
  reviewerModel?: string | undefined;
  detail?: string | undefined;
}

interface Phase {
  headline: string;
  detail?: string | undefined;
  checks?: ReviewChecks | undefined;
}

/**
 * Live progress for one /review run: a spinner, a headline that says what the
 * command is doing right now, the scope it picked, and the checks that ran.
 *
 * The command used to sit on one static "Preparing review context…" line until
 * the reviewer's first output arrived, so an idle-looking panel was really a
 * summary model call. Every stage now owns a headline, and the spinner keeps
 * the widget visibly alive.
 */
export interface ReviewProgress {
  setPhase(headline: string, checks?: ReviewChecks): void;
  setScope(review: ReviewContext): void;
  start(): void;
  stop(): void;
}

export function createReviewProgress(
  ctx: ExtensionCommandContext
): ReviewProgress {
  let phase: Phase = { headline: "Preparing review…" };
  let scope: ReviewContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let stopped = false;
  let startedAt = Date.now();

  const { theme } = ctx.ui;

  const scopeLine = (): string[] => {
    if (!scope || scope.vcs !== "git" || !scope.worktree) return [];
    const parts = [];
    if (scope.worktree.total > 0)
      parts.push(
        `${scope.worktree.staged + (scope.worktree.sinceBase ?? 0)} files`
      );
    if (scope.worktree.unpushed)
      parts.push(`${scope.worktree.unpushed} unpushed commits`);
    if (scope.worktree.untracked)
      parts.push(`${scope.worktree.untracked} untracked`);
    const head = parts.length > 0 ? parts.join(" · ") : "no tracked changes";
    const lines = [
      `${theme.fg("muted", "│")} ${theme.fg("text", `scope: ${head} vs ${scope.baseBranch ?? scope.currentRef}`)}`,
    ];
    for (const item of [
      ...(scope.reviewCommits ?? []).slice(0, 2),
      ...(scope.worktree.stagedSample ?? []).slice(0, 2),
    ]) {
      lines.push(`${theme.fg("muted", "│")} ${theme.fg("dim", `· ${item}`)}`);
    }
    return lines;
  };

  const checkLine = (checks: ReviewChecks | undefined): string[] => {
    const lines: string[] = [];
    if (checks?.summaryModel)
      lines.push(
        `${theme.fg("muted", "│")} ${theme.fg("dim", `summary model: ${checks.summaryModel}`)}`
      );
    if (checks?.reviewerModel)
      lines.push(
        `${theme.fg("muted", "│")} ${theme.fg("dim", `reviewer: ${checks.reviewerModel}`)}`
      );
    return lines;
  };

  const render = () => {
    if (stopped || !ctx.hasUI) return;
    const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "⠋";
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const body = [
      `${theme.fg("muted", "│")} ${theme.fg("dim", `${elapsed}s`)}${phase.detail ? theme.fg("dim", ` · ${phase.detail}`) : ""}`,
      ...scopeLine(),
      ...checkLine(phase.checks),
    ].slice(0, MAX_BODY_LINES);
    ctx.ui.setWidget(
      REVIEW_COMMAND,
      [
        `${theme.fg("accent", "╭─ Review")} ${theme.fg("accent", glyph)} ${theme.fg("text", phase.headline)}`,
        ...body,
        theme.fg("muted", "╰─"),
      ],
      { placement: "aboveEditor" }
    );
  };

  const setPhase = (headline: string, checks?: ReviewChecks) => {
    phase = { headline, checks, detail: checks?.detail };
    if (!timer) startedAt = Date.now();
    render();
  };

  return {
    setPhase,
    setScope: (next) => {
      scope = next;
      render();
    },
    start: () => {
      if (stopped || timer || !ctx.hasUI) return;
      render();
      timer = setInterval(() => {
        frame++;
        render();
      }, SPINNER_INTERVAL_MS);
      timer.unref?.();
    },
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (ctx.hasUI) ctx.ui.setWidget(REVIEW_COMMAND, undefined);
    },
  };
}
