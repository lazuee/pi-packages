import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as Plugin from "../profiles/committer/plugin.mjs";

/**
 * The rules under test are cortex-js/compute-engine's
 * `scripts/check-commit-attribution.mjs`, reached here the way a commit would
 * be: as the message file git reads. Both lists below are upstream's.
 */
const plugin = (await import(
  join(import.meta.dir, "..", "profiles", "committer", "plugin.mjs")
)) as typeof Plugin;

/** Judge a whole message the way a commit with it would be judged. */
function judge(message: string, cwd?: string) {
  const directory = cwd ?? mkdtempSync(join(tmpdir(), "attribution-"));
  writeFileSync(join(directory, "MSG"), message);
  try {
    return plugin.tool_call({
      toolName: "bash",
      input: { command: "git commit -F MSG", cwd: directory },
    });
  } finally {
    if (!cwd) rmSync(directory, { force: true, recursive: true });
  }
}

const refused = [
  "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
  "Co-authored-by: Claude <noreply@anthropic.com>",
  "Co-authored-by : Claude Code",
  "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  "Generated with Claude Code",
  "Co-authored-by: copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>",
  "Co-authored-by: chatgpt-codex-connector[bot] <1+chatgpt-codex-connector[bot]@users.noreply.github.com>",
  "Co-authored-by: Cursor Agent <cursoragent@cursor.com>",
  "Co-authored-by: aider (gpt-4o) <noreply@aider.chat>",
  "Assisted-by: Claude",
  "Generated-by: Codex",
  "Signed-off-by: Claude <noreply@anthropic.com>",
  "Co-authored-by: Gemini 2.5 Pro",
  "Co-authored-by: devin-ai-integration[bot] <2+devin-ai-integration[bot]@users.noreply.github.com>",
  "# Generated with Claude Code",
  "Co-authored-by: Claude 3.5 Sonnet",
  "Co-authored-by: OpenAI Codex",
  "Co-authored-by: Gemini CLI",
  "Generated-by: GPT-4o",
  "Assisted-by: GPT-4o-mini",
  "Co-authored-by: Jane <jane@example.com>, Claude <noreply@anthropic.com>",
  // pi.dev writes its own name and no fixed address, so the name decides here.
  "Co-authored-by: pi.dev <pi@pi.dev>",
  "Co-authored-by: pi agent <n@e>",
];

const accepted = [
  "Co-authored-by: enumeratio <314378874+enumeratio@users.noreply.github.com>",
  "Co-authored-by: Claude Dupont <claude.dupont@example.fr>",
  "Co-authored-by: Claudette Lee <claudette@example.com>",
  "Co-authored-by: codexdev <123+codexdev@users.noreply.github.com>",
  "Signed-off-by: Arno Gourdol <arno@example.com>",
  'The hook refuses a "Generated with Claude Code" line.',
  "Claude Code is a tool; this sentence is not a trailer.",
  "# Please enter the commit message for your changes.",
  "Co-authored-by: devin <123+devin@users.noreply.github.com>",
  "Co-authored-by: Devin <devin@example.com>",
  "Co-authored-by: claude <124+claude@users.noreply.github.com>",
  "Co-authored-by: Cursor <9+cursor@users.noreply.github.com>",
  "Co-authored-by: Jane Doe <jane@anthropic.com>",
];

describe("a message line that credits a tool", () => {
  for (const line of refused)
    test(`refuses: ${line}`, () => {
      const verdict = judge(`fix: x\n\n${line}\n`);
      expect(verdict?.block).toBe(true);
      expect(verdict?.reason).toContain(line);
    });

  for (const line of accepted)
    test(`accepts: ${line}`, () => {
      expect(judge(`fix: x\n\n${line}\n`)).toBeUndefined();
    });
});

describe("message shapes", () => {
  test("a clean message with no trailers passes", () => {
    expect(judge("fix: x\n\nA body naming nobody.\n")).toBeUndefined();
  });

  test("a trailer value continued on an indented line is judged", () => {
    const verdict = judge(
      "fix: x\n\nCo-authored-by:\n Claude <noreply@anthropic.com>\n"
    );
    expect(verdict?.reason).toContain("Co-authored-by:");
  });

  test("CRLF line ends are read", () => {
    expect(
      judge("fix: x\r\n\r\nCo-authored-by: Claude <noreply@anthropic.com>\r\n")
        ?.block
    ).toBe(true);
  });

  test("every offending line is reported, not just the first", () => {
    const verdict = judge(
      "fix: x\n\nCo-authored-by: Claude <noreply@anthropic.com>\n🤖 Generated with Claude Code\n"
    );
    expect(verdict?.reason).toContain("Co-authored-by:");
    expect(verdict?.reason).toContain("Generated with");
  });
});

describe("where the message comes from", () => {
  test("a heredoc body is the message", () => {
    expect(
      plugin.tool_call({
        toolName: "bash",
        input: {
          command:
            "git commit -F - <<'EOF'\nfix: x\n\nCo-authored-by: Claude <noreply@anthropic.com>\nEOF",
        },
      })?.block
    ).toBe(true);
  });

  test("a heredoc with a clean body passes", () => {
    expect(
      plugin.tool_call({
        toolName: "bash",
        input: { command: "git commit -F - <<'EOF'\nfix: x\n\nBody.\nEOF" },
      })
    ).toBeUndefined();
  });

  test("a printf piped into commit is the message", () => {
    // The body is in the command but behind a pipe, not a heredoc.
    for (const command of [
      `printf "fix: x\\n\\nCo-Authored-By: pi.dev <p@pi.dev>\\n" | git commit -F -`,
      `printf 'fix: x\\n\\nAssisted-by: Claude Code\\n' | git commit -F -`,
    ])
      expect(
        plugin.tool_call({ toolName: "bash", input: { command } })?.block
      ).toBe(true);
  });

  test("a clean printf pipe passes", () => {
    expect(
      plugin.tool_call({
        toolName: "bash",
        input: { command: `echo "fix: x" | git commit -F -` },
      })
    ).toBeUndefined();
  });

  test("a bare -F - reading stdin is left alone", () => {
    // Nothing in the command carries the body, so there is nothing to judge.
    expect(
      plugin.tool_call({
        toolName: "bash",
        input: { command: "git commit -F -" },
      })
    ).toBeUndefined();
  });

  test("a written message file is judged", () => {
    expect(
      plugin.tool_call({
        toolName: "write",
        input: {
          content: "fix: x\n\nCo-authored-by: Claude <noreply@anthropic.com>",
        },
      })?.block
    ).toBe(true);
  });

  test("a message file is read relative to the tool call's directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "attribution-cwd-"));
    try {
      writeFileSync(
        join(directory, "msg.txt"),
        "fix: x\n\nAssisted-by: Claude Code\n"
      );
      expect(
        plugin.tool_call({
          toolName: "bash",
          input: { command: "git commit -F msg.txt", cwd: directory },
        })?.reason
      ).toContain("Assisted-by: Claude Code");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("a missing message file is left to the commit to report", () => {
    expect(
      plugin.tool_call({
        toolName: "bash",
        input: { command: "git commit -F gcmsg", cwd: tmpdir() },
      })
    ).toBeUndefined();
  });

  test("only a commit is judged", () => {
    expect(
      plugin.tool_call({
        toolName: "bash",
        input: { command: "git status" },
      })
    ).toBeUndefined();
  });
});
