# @lazuee/pi-session-tools

[![npm version](https://img.shields.io/npm/v/@lazuee/pi-session-tools?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@lazuee/pi-session-tools) [![CI](https://img.shields.io/github/actions/workflow/status/lazuee/pi-packages/ci.yml?style=flat&logo=github&label=CI)](https://github.com/lazuee/pi-packages/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![pnpm](https://img.shields.io/badge/pnpm-%3E%3D11-F69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/) [![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://pi.mariozechner.at/)

Pi extension providing session metadata tools for multi-session workflows.

## Tools

### `set_session_name`

Set the current session's display name (shown in the session selector).

```text
set_session_name({ name: "#42 Planning — Extract ExtensionPaths" })
```

Use a stage-encoded format to identify both the issue and workflow stage:

| Stage         | Format                       |
| ------------- | ---------------------------- |
| Planning      | `#N Planning — <title>`      |
| TDD           | `#N TDD — <title>`           |
| Build         | `#N Build — <title>`         |
| Retrospective | `#N Retrospective — <title>` |

### `get_session_name`

Get the current session's display name, if one has been set.

```text
get_session_name({})
```

### `read_session`

Read the current session's entries as a structured transcript.
Useful for retro lenses and cross-session context.

```text
read_session({ types?: string[], offset?: number, limit?: number, elide_user_text?: boolean, branches?: "live" | "all" })
```

Parameters:

- `types` — filter to specific entry types (e.g. `["message", "compaction"]`).
  Omit for all.
- `offset` — skip the most recent N entries after filtering, before `limit` applies.
  Defaults to 0.
- `limit` — return only the most recent N entries after filtering and `offset`.
  `0` returns none; a negative value is clamped to `0`.
- `elide_user_text` — replace each user turn's body with a `[text elided: N chars]` placeholder.
  Defaults to `false`.
- `branches` — which branches of the session's entry tree to render.
  Defaults to `"live"`; any value other than `"all"` is read as `"live"`.

The output is a human-readable transcript: numbered user/assistant turns, one-line tool call summaries with correlated result status, and metadata events (compaction, model changes, session renames, context edits, system prompt changes).
Tool result bodies, thinking content, and image data are omitted.
A `[model change]` line renders only when the switch actually took effect — a marker followed by an assistant turn before the next switch or the end of entries.
A phantom switch (e.g. cycling the TUI model picker with no turn run after it) is omitted from both the transcript and the `model changes` count, and does not consume a slot against `limit`.
A `[session]` line marks each point where the session was renamed, which is how a multi-stage session's stage boundaries stay visible even when user bodies are elided.
A `[context edit]` line marks where an earlier message was omitted from (or replaced in) the model's context, naming it in transcript terms, as in `[context edit] turn 2 (assistant) omitted from context` or `bash result from turn 2`.
Turns between the target and the edit still saw the original message.
When the target falls outside the rendered entries (because of `types`, `offset`, or `limit`), the line names it by entry id instead.
A `[system]` line marks each system message: the first one in the transcript is the prompt and renders as counts (`[system] prompt: 8 sections, 21 tools`), and later ones name the sections and tools they change.

#### Rewound sessions

A session file is a tree, not a list: every entry records its parent, and rewinding the conversation makes the next entry a second child of an earlier one.
The transcript follows the _live path_ — the walk from the session's newest entry back to the root, which is the same path Pi resumes into — and replaces each stretch it leaves out with a marker:

```text
[abandoned branch] 89 entries omitted (branches: "all" to include)
```

Pass `branches: "all"` to render those entries too, bracketed so they stay distinguishable from the live path:

```text
[abandoned branch begins] 89 entries
…the abandoned turns…
[abandoned branch ends]
```

A marker survives an explicit `types` filter, so a filtered call can never hide the fact that a branch was dropped.
It does occupy a slot against `offset` and `limit`, like any other rendered entry.
The summary counts session entries only, so a live-path render reports the turns that are actually on it.

A session with no rewind renders identically either way, and an entry array with no parent links — a pre-v3 file — is left exactly as it is read.

#### Reading a long session without re-reading its tail

`limit` alone bounds a transcript only from the end, so reaching an early turn means asking for a larger window and re-rendering everything already read.
`offset` and `elide_user_text` address that from opposite directions, and compose:

- `offset` pages backward — `{ limit: 40 }`, then `{ offset: 40, limit: 40 }`, and so on.
  Each call renders only the entries it adds.
- `elide_user_text` shrinks every turn instead of dropping entries.
  On a measured 246-entry session, user bodies were 46.7% of the rendered transcript, and the elided render of the **whole** session cost less than three partial unelided calls did.

Neither is a filter: both leave phantom-switch suppression and the `[provider/model]` label on every assistant turn intact, so an attribution pass can use them freely.
Branch resolution _is_ a filter — it is the one knob that changes which turns an attribution pass sees, which is the point of following the live path by default.

In the TUI the tool row shows a compact summary by default (e.g. `✓ 42 entries — 38 messages, 18 tool calls, 2 compactions`).
Press `Ctrl-O` to expand to the full transcript.
The model always receives the full transcript regardless of the TUI state.

```text
1. user
How do I fix the login bug?

---

2. assistant [anthropic/claude-sonnet-4-20250514]
Let me check the auth flow.
  [tool] Read — path: src/auth/login.ts → completed
  [tool] Bash — command: pnpm vitest login → error
The test is failing because...

---

[compaction] Context compacted (48000 tokens before)

---

[model change] → anthropic/claude-opus-4-20250514

---

[session] → #42 TDD — Fix the login bug

---

3. assistant [anthropic/claude-opus-4-20250514]
Looking at the recent commits...
```

### `read_parent_session`

Read the parent session's entries as a structured transcript when running inside a subagent.
Derives the parent session file from the subagent directory layout.
Returns an error if not running in a subagent context.

```text
read_parent_session({ types?: string[], offset?: number, limit?: number, elide_user_text?: boolean, branches?: "live" | "all" })
```

Parameters and output format are the same as `read_session`.

### `read_session_file`

Read an arbitrary session file as a structured transcript, given its path.
Useful for reading a **sibling** session that neither `read_session` (current session only) nor `read_parent_session` (parent-via-subagent only) can reach — for example, a peer worktree session in the parallel-worktree ship flow.

```text
read_session_file({ path: string, types?: string[], offset?: number, limit?: number, elide_user_text?: boolean, branches?: "live" | "all" })
```

Parameters:

- `path` — absolute path to a session `.jsonl` file.
- `types` / `offset` / `limit` / `elide_user_text` — same as `read_session`.

Output format is the same as `read_session`.
Returns a status message (not an error) when the file does not exist.

### `list_session_files`

List a working directory's session files, newest first.
Encodes the given `cwd` to Pi's session-directory naming convention (`--<cwd with slashes replaced by dashes>--` under the sessions root) and lists the `.jsonl` files found there, so a caller does not have to hand-roll the encoding.
Pass a listed path to `read_session_file` to render it as a transcript.

```text
list_session_files({ cwd: string, limit?: number })
```

Parameters:

- `cwd` — the working directory whose session files to list (e.g. a peer worktree path).
  Required — there is no default, since the sibling-session use case always targets a directory other than the current session's own.
- `limit` — maximum number of paths to list, newest first.
  Defaults to 10.
  Pass a large number (e.g. `1000`) to list every file; there is no sentinel for "all", and `0` lists none.

```text
Session directory: /Users/chris/.pi/agent/sessions/--Users-chris-worktrees-issue-546--
2 session files, newest first:
  /Users/chris/.pi/agent/sessions/--Users-chris-worktrees-issue-546--/2026-07-06T10-00-00Z_.jsonl
  /Users/chris/.pi/agent/sessions/--Users-chris-worktrees-issue-546--/2026-07-05T09-00-00Z_.jsonl
```

The count line always reports the directory's true total, and names how many paths follow when the listing is bounded:

```text
Session directory: /Users/chris/.pi/agent/sessions/--Users-chris-pi-packages--
608 session files, newest first (showing 10):
  …ten paths…
```

### `list_subagent_sessions`

List a session's subagent transcripts, newest first.
Pi stores each subagent session beneath the parent session file's basename (`<session>/tasks/*.jsonl`), so `list_session_files` — which reads one directory and does not recurse — never reports them.
Pass a listed path to `read_session_file` to render it.

```text
list_subagent_sessions({ path: string, limit?: number })
```

Parameters:

- `path` — absolute path to the session `.jsonl` file whose subagent transcripts to list.
  Required — there is no default, so a mistyped path can never silently answer about the current session.
- `limit` — maximum number of paths to list, newest first.
  Defaults to 10, with the same large-number escape hatch as `list_session_files`.

```text
Session directory: /Users/chris/.pi/agent/sessions/--project--/2026-09-06T04-26-34-471Z_01a074f7/tasks
2 session files, newest first:
  /Users/chris/.pi/agent/sessions/--project--/2026-09-06T04-26-34-471Z_01a074f7/tasks/2026-09-06T17-26-06-793Z_01a077c1.jsonl
  /Users/chris/.pi/agent/sessions/--project--/2026-09-06T04-26-34-471Z_01a074f7/tasks/2026-09-06T10-02-11-004Z_01a07612.jsonl
```

The listing reports one generation, mirroring `read_parent_session`'s single step up — call the tool again on a returned path to reach a subagent's own subagents.
A session that spawned none renders `No session files found.` under the directory that would hold them; a `path` with no session file behind it returns a `Session file not found:` status instead, so the two cases stay distinguishable.

## Install

```bash
pi install npm:@lazuee/pi-session-tools
```

Or add it to your Pi settings (`.pi/settings.json`):

```json
{
  "packages": ["npm:@lazuee/pi-session-tools"]
}
```

## Scope and non-goals

**Purpose.**
A multi-session workflow needs two things Pi does not otherwise expose to an extension: a way to label the current session, and a way to read a session's transcript — including a parent's or a sibling's.

**In scope.**
Rendering a transcript more usefully for whoever reads it, and reaching a session the existing tools cannot reach.
A new capability arrives as a new tool rather than as another parameter on an existing one.

**Non-goals.**

- _Mutating transcript content._
  Session metadata is writable; transcript entries are read-only — no editing, redacting, replaying, or pruning.
- _A raw or JSON passthrough mode._
  Anything needing unrendered entries can read the session `.jsonl` directly.
- _Owning Pi's session storage format._
  The directory encoding and entry schema belong to Pi; this package matches them rather than improving them.
- _Path allowlisting for `read_session_file`._
  The agent already has `Read` and `Bash` on any file, so restricting one tool adds friction without a security boundary.
- _Analytics and roll-ups._
  Per-turn attribution and flat counts are emitted; interpreting them is the calling prompt's job.

## License

MIT
