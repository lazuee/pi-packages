/**
 * pi-session-tools — Session metadata tools for multi-session workflows.
 *
 * Tools:
 *   set_session_name — Set the session display name (shown in session selector)
 *   get_session_name — Get the current session name
 *   read_session — Read the current session's raw entries (survives compaction)
 *   read_parent_session — Read the parent session's entries from a subagent context
 *   read_session_file — Read an arbitrary session file's entries by path
 *   list_session_files — List a cwd's session files, newest first, bounded by `limit`
 *   list_subagent_sessions — List a session's subagent transcripts, newest first
 */

import { join } from "node:path";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  keyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { selectEntries } from "./entry-selection.js";
import {
  formatSummaryText,
  type SessionSummary,
  summarizeEntries,
} from "./entry-summary.js";
import { formatTranscript, type TranscriptEntry } from "./format-transcript.js";
import {
  deriveParentSessionFile,
  deriveSubagentSessionsDir,
} from "./parent-session.js";
import {
  deriveSessionsRoot,
  encodeCwdToSessionDirName,
  listSessionFiles,
  readSessionFileEntries,
  sessionFileExists,
} from "./session-file.js";
import {
  boundListingPaths,
  DEFAULT_LIST_LIMIT,
  formatListingSummary,
  formatListingText,
} from "./session-listing.js";
import type { BranchMode } from "./session-tree.js";

/** Shared description for the `branches` parameter on every transcript tool. */
const BRANCHES_DESCRIPTION =
  'Which branches to render. "live" (the default) follows the path from the session\'s newest entry back to the root and replaces each rewound stretch with a marker naming how many entries it omitted. "all" additionally renders those entries, bracketed by begin/end markers.';

/** Discriminated union stored in tool `details` for the session-read and discovery tools. */
type SessionToolDetails =
  | { kind: "transcript"; summary: SessionSummary }
  | { kind: "status"; message: string }
  | { kind: "listing"; directory: string; count: number; shown: number };

// ---- rendering helpers ----

/**
 * Compact call label: `read session (types: [...], limit: N)` or `read parent session`.
 * Extra params omitted when not supplied.
 */
function formatCallText(
  label: string,
  args: {
    types?: string[];
    offset?: number;
    limit?: number;
    elide_user_text?: boolean;
    branches?: string;
    path?: string;
    cwd?: string;
  },
  theme: Theme,
): string {
  const hints: string[] = [];
  if (args.path) hints.push(`path: ${args.path}`);
  if (args.cwd) hints.push(`cwd: ${args.cwd}`);
  if (args.types && args.types.length > 0)
    hints.push(`types: [${args.types.join(", ")}]`);
  if (args.offset != null) hints.push(`offset: ${args.offset}`);
  if (args.limit != null) hints.push(`limit: ${args.limit}`);
  if (args.elide_user_text) hints.push("elide user text");
  if (args.branches) hints.push(`branches: ${args.branches}`);
  const suffix = hints.length > 0 ? ` (${hints.join(", ")})` : "";
  return `${theme.fg("toolTitle", theme.bold(label))}${theme.fg("muted", suffix)}`;
}

/**
 * Collapsed or expanded result text for a session-read tool.
 *
 * Collapsed: one-line summary (or status message) + expand hint.
 * Expanded: full transcript content lines coloured as tool output.
 */
function formatResultText(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  },
  options: { expanded: boolean },
  theme: Theme,
): string {
  const details = result.details as SessionToolDetails | undefined;
  const outputText =
    result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";

  if (options.expanded) {
    return outputText
      .split("\n")
      .map((l) => theme.fg("toolOutput", l))
      .join("\n");
  }

  // Collapsed view.
  const hint = keyHint("app.tools.expand", "to expand");
  if (!details) {
    return `${theme.fg("muted", outputText.split("\n")[0] ?? "")} ${hint}`;
  }
  if (details.kind === "status") {
    return `${theme.fg("warning", "\u26a0")} ${theme.fg("muted", details.message)} ${hint}`;
  }
  if (details.kind === "listing") {
    const summary = formatListingSummary(
      details.directory,
      details.shown,
      details.count,
    );
    return `${theme.fg("success", "\u2713")} ${theme.fg("muted", summary)} ${hint}`;
  }
  // kind === "transcript"
  return `${theme.fg("success", "\u2713")} ${theme.fg("muted", formatSummaryText(details.summary))} ${hint}`;
}

/** The parameter surface every transcript-rendering tool shares. */
interface TranscriptReadParams {
  types?: string[];
  offset?: number;
  limit?: number;
  elide_user_text?: boolean;
  branches?: string;
}

/**
 * Select the entries the caller asked for, then summarize and format them.
 * Shared by every tool that renders a transcript from an entry array
 * (`read_session`, `read_parent_session`, `read_session_file`).
 *
 * `leafId` is the session's live leaf when the caller knows it; the file
 * readers omit it, and the walk falls back to the last entry — the leaf Pi
 * itself resumes into.
 */
function buildTranscriptResult(
  allEntries: TranscriptEntry[],
  params: TranscriptReadParams,
  leafId?: string | null,
): {
  content: [{ type: "text"; text: string }];
  details: SessionToolDetails;
} {
  // Anything but the literal "all" resolves to the safe default, so a mistyped
  // parameter renders the live path rather than the branch it discarded.
  const branches: BranchMode = params.branches === "all" ? "all" : "live";
  const entries = selectEntries(allEntries, {
    types: params.types,
    offset: params.offset,
    limit: params.limit,
    branches,
    leafId,
  });
  const summary = summarizeEntries(entries);
  const text = formatTranscript(entries, {
    elideUserText: params.elide_user_text,
  });
  return {
    content: [{ type: "text", text }],
    details: { kind: "transcript", summary },
  };
}

/**
 * Render a directory's session files as the tool's text body plus its
 * `listing` details. Shared shape with `buildTranscriptResult`.
 */
function buildListingResult(
  directory: string,
  files: string[],
  params: { limit?: number },
): {
  content: [{ type: "text"; text: string }];
  details: SessionToolDetails;
} {
  const paths = boundListingPaths(files, params.limit ?? DEFAULT_LIST_LIMIT);
  return {
    content: [
      { type: "text", text: formatListingText(directory, paths, files.length) },
    ],
    details: {
      kind: "listing",
      directory,
      count: files.length,
      shown: paths.length,
    },
  };
}

export default function sessionTools(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "set_session_name",
      label: "Set Session Name",
      description:
        "Set the current session's display name. " +
        "The name appears in the session selector for identification when resuming work. " +
        "Use a stage-encoded format like '#42 Planning — Extract ExtensionPaths' " +
        "to identify both the issue and the workflow stage.",
      parameters: Type.Object({
        name: Type.String({
          description:
            "The session display name (e.g., '#42 Planning — My feature title')",
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/require-await -- satisfies async tool interface; no actual async work
      async execute(_toolCallId, params) {
        pi.setSessionName(params.name);
        return {
          content: [
            { type: "text", text: `Session name set to: ${params.name}` },
          ],
          details: undefined,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "get_session_name",
      label: "Get Session Name",
      description:
        "Get the current session's display name, if one has been set.",
      parameters: Type.Object({}),
      // eslint-disable-next-line @typescript-eslint/require-await -- satisfies async tool interface; no actual async work
      async execute() {
        const name = pi.getSessionName();
        return {
          content: [
            {
              type: "text",
              text: name
                ? `Current session name: ${name}`
                : "No session name set.",
            },
          ],
          details: undefined,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "read_session",
      label: "Read Session",
      description:
        "Read the current session's raw entries from the session file. " +
        "Returns a structured transcript that survives context compaction — use this to inspect " +
        "the full session history including messages, model changes, compaction events, and custom entries. " +
        "The transcript format shows numbered user/assistant turns, one-line tool call summaries with " +
        "correlated results, and metadata events (compaction, model changes). " +
        "Tool result bodies, thinking content, and image data are omitted. " +
        "A session that was rewound renders only the live path, with a marker naming what it omitted.",
      parameters: Type.Object({
        types: Type.Optional(
          Type.Array(
            Type.String({
              description:
                'Entry type to include (e.g., "message", "compaction", "model_change", "custom")',
            }),
            {
              description:
                "Filter entries by type. When omitted, all entry types are returned.",
            },
          ),
        ),
        offset: Type.Optional(
          Type.Number({
            minimum: 0,
            description:
              "Skip the most recent N entries (after type filtering) before applying `limit`. Page backward through a long session instead of re-reading its tail.",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            minimum: 0,
            description:
              "Return only the most recent N entries (after type filtering, and after `offset` when given). When omitted, all matching entries are returned.",
          }),
        ),
        elide_user_text: Type.Optional(
          Type.Boolean({
            description:
              "Replace each user turn's body with a length placeholder, keeping turn numbering, [provider/model] labels, and tool-call lines. Use it when you need the shape of a session rather than its prompts.",
          }),
        ),
        branches: Type.Optional(
          Type.String({ description: BRANCHES_DESCRIPTION }),
        ),
      }),
      renderCall(args, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatCallText("read session", args, theme));
        return text;
      },
      renderResult(result, options, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatResultText(result, options, theme));
        return text;
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- satisfies async tool interface; no actual async work
      async execute(
        _toolCallId: string,
        params: TranscriptReadParams,
        _signal: unknown,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        return buildTranscriptResult(
          ctx.sessionManager.getEntries(),
          params,
          ctx.sessionManager.getLeafId(),
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "read_parent_session",
      label: "Read Parent Session",
      description:
        "Read the parent session's entries when running inside a subagent. " +
        "Derives the parent session file from the subagent directory layout. " +
        "Returns a structured transcript with numbered user/assistant turns, one-line tool call summaries, " +
        "and metadata events. Tool result bodies, thinking content, and image data are omitted. " +
        "A session that was rewound renders only the live path, with a marker naming what it omitted. " +
        "Returns an error if not running in a subagent context.",
      parameters: Type.Object({
        types: Type.Optional(
          Type.Array(
            Type.String({
              description:
                'Entry type to include (e.g., "message", "compaction", "model_change")',
            }),
            {
              description:
                "Filter entries by type. When omitted, all entry types are returned.",
            },
          ),
        ),
        offset: Type.Optional(
          Type.Number({
            minimum: 0,
            description:
              "Skip the most recent N entries (after type filtering) before applying `limit`.",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            minimum: 0,
            description:
              "Return only the most recent N entries (after type filtering, and after `offset` when given).",
          }),
        ),
        elide_user_text: Type.Optional(
          Type.Boolean({
            description:
              "Replace each user turn's body with a length placeholder, keeping turn numbering, [provider/model] labels, and tool-call lines.",
          }),
        ),
        branches: Type.Optional(
          Type.String({ description: BRANCHES_DESCRIPTION }),
        ),
      }),
      renderCall(args, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatCallText("read parent session", args, theme));
        return text;
      },
      renderResult(result, options, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatResultText(result, options, theme));
        return text;
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- satisfies async tool interface; no actual async work
      async execute(
        _toolCallId: string,
        params: TranscriptReadParams,
        _signal: unknown,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        const sessionFile = ctx.sessionManager.getSessionFile();
        const parentFile = deriveParentSessionFile(sessionFile);
        if (!parentFile) {
          return {
            content: [
              {
                type: "text",
                text: "This session is not running inside a subagent — no parent session available.",
              },
            ],
            details: {
              kind: "status",
              message: "Not running inside a subagent",
            } as SessionToolDetails,
          };
        }

        const allEntries = readSessionFileEntries(parentFile);
        if (!allEntries) {
          return {
            content: [
              {
                type: "text",
                text: `Parent session file not found: ${parentFile}`,
              },
            ],
            details: {
              kind: "status",
              message: `Parent session file not found: ${parentFile}`,
            } as SessionToolDetails,
          };
        }

        return buildTranscriptResult(allEntries, params);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "read_session_file",
      label: "Read Session File",
      description:
        "Read an arbitrary session file by path and render it as a structured transcript. " +
        "Useful for reading a sibling session (e.g. a peer worktree session) that neither " +
        "read_session nor read_parent_session can reach. " +
        "Returns a structured transcript with numbered user/assistant turns, one-line tool call summaries, " +
        "and metadata events. Tool result bodies, thinking content, and image data are omitted. " +
        "A session that was rewound renders only the live path, with a marker naming what it omitted. " +
        "Returns an error if the file does not exist.",
      parameters: Type.Object({
        path: Type.String({
          description: "Absolute path to a session JSONL file.",
        }),
        types: Type.Optional(
          Type.Array(
            Type.String({
              description:
                'Entry type to include (e.g., "message", "compaction", "model_change")',
            }),
            {
              description:
                "Filter entries by type. When omitted, all entry types are returned.",
            },
          ),
        ),
        offset: Type.Optional(
          Type.Number({
            minimum: 0,
            description:
              "Skip the most recent N entries (after type filtering) before applying `limit`.",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            minimum: 0,
            description:
              "Return only the most recent N entries (after type filtering, and after `offset` when given).",
          }),
        ),
        elide_user_text: Type.Optional(
          Type.Boolean({
            description:
              "Replace each user turn's body with a length placeholder, keeping turn numbering, [provider/model] labels, and tool-call lines.",
          }),
        ),
        branches: Type.Optional(
          Type.String({ description: BRANCHES_DESCRIPTION }),
        ),
      }),
      renderCall(args, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatCallText("read session file", args, theme));
        return text;
      },
      renderResult(result, options, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatResultText(result, options, theme));
        return text;
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- satisfies async tool interface; no actual async work
      async execute(
        _toolCallId: string,
        params: TranscriptReadParams & { path: string },
      ) {
        const allEntries = readSessionFileEntries(params.path);
        if (!allEntries) {
          return {
            content: [
              {
                type: "text",
                text: `Session file not found: ${params.path}`,
              },
            ],
            details: {
              kind: "status",
              message: `Session file not found: ${params.path}`,
            } as SessionToolDetails,
          };
        }

        return buildTranscriptResult(allEntries, params);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "list_session_files",
      label: "List Session Files",
      description:
        "List a cwd's session files, newest first. " +
        "Encodes the given cwd to Pi's session-directory naming convention and lists the " +
        ".jsonl files found there, so a caller does not have to hand-roll the encoding. " +
        "Pass the returned path to read_session_file to render one as a transcript. " +
        "Useful for locating a sibling session (e.g. a peer worktree session). " +
        `Lists at most ${DEFAULT_LIST_LIMIT} paths unless limit says otherwise; ` +
        "the count line always reports the directory's true total.",
      parameters: Type.Object({
        cwd: Type.String({
          description:
            "The working directory whose session files to list (e.g. a peer worktree path).",
        }),
        limit: Type.Optional(
          Type.Number({
            description: `Maximum number of paths to list, newest first. Defaults to ${DEFAULT_LIST_LIMIT}; pass a large number (e.g. 1000) to list every file.`,
          }),
        ),
      }),
      renderCall(args, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatCallText("list session files", args, theme));
        return text;
      },
      renderResult(result, options, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatResultText(result, options, theme));
        return text;
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- satisfies async tool interface; no actual async work
      async execute(
        _toolCallId: string,
        params: { cwd: string; limit?: number },
        _signal: unknown,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        const root = deriveSessionsRoot(
          ctx.sessionManager.getSessionFile(),
          process.cwd(),
        );
        const directory = join(root, encodeCwdToSessionDirName(params.cwd));
        return buildListingResult(
          directory,
          listSessionFiles(directory),
          params,
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "list_subagent_sessions",
      label: "List Subagent Sessions",
      description:
        "List a session's subagent transcripts, newest first. " +
        "Pi stores each subagent session beneath the parent session file's basename " +
        "(<session>/tasks/*.jsonl), so list_session_files — which reads one directory " +
        "and does not recurse — never reports them. " +
        "Pass the parent session's .jsonl path; render a returned path with read_session_file. " +
        `Lists at most ${DEFAULT_LIST_LIMIT} paths unless limit says otherwise; ` +
        "the count line always reports the directory's true total.",
      parameters: Type.Object({
        path: Type.String({
          description:
            "Absolute path to the session JSONL file whose subagent transcripts to list.",
        }),
        limit: Type.Optional(
          Type.Number({
            description: `Maximum number of paths to list, newest first. Defaults to ${DEFAULT_LIST_LIMIT}; pass a large number (e.g. 1000) to list every file.`,
          }),
        ),
      }),
      renderCall(args, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatCallText("list subagent sessions", args, theme));
        return text;
      },
      renderResult(result, options, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatResultText(result, options, theme));
        return text;
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- satisfies async tool interface; no actual async work
      async execute(
        _toolCallId: string,
        params: { path: string; limit?: number },
      ) {
        if (!sessionFileExists(params.path)) {
          return {
            content: [
              {
                type: "text",
                text: `Session file not found: ${params.path}`,
              },
            ],
            details: {
              kind: "status",
              message: `Session file not found: ${params.path}`,
            } as SessionToolDetails,
          };
        }

        const directory = deriveSubagentSessionsDir(params.path);
        return buildListingResult(
          directory,
          listSessionFiles(directory),
          params,
        );
      },
    }),
  );
}
