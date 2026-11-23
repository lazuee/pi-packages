/**
 * Committer plugin: refuse a commit whose message credits an AI tool.
 *
 * The project's history credits people only, so no trailer names a tool and no
 * "Generated with" footer survives. A trailer for a person still passes.
 *
 * The rules and their reasoning are taken from cortex-js/compute-engine's
 * `scripts/check-commit-attribution.mjs`: a trailer is a line whose key ends in
 * `-by`, a value is judged by its `<email>` alone when it has one, and a value
 * without an email is judged by the tool or vendor name it starts with. Identity
 * is never read from the sender's domain — people commit from @anthropic.com.
 *
 * It diverges in one way: that script runs as a git `commit-msg` hook, while
 * this one is a `tool_call` guard, so it reads the message the commit is about
 * to use and refuses before the commit runs. A refused commit never lands, and
 * the agent gets back the exact lines to delete.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const hook = "tool_call";

/** A trailer: a key ending in `-by`, at the start of a line. Git allows spaces
 * before the colon, and only the key matters here, so case is ignored. */
const TRAILER = /^([A-Za-z][\w-]*-by)\s*:\s*(.*)$/i;

/** The email of a trailer value: the text between `<` and `>`. */
const EMAIL = /<([^<>]*)>/g;

/** The exact addresses AI tools write. `pi.dev` is not in the upstream list and
 * is the tool this session runs in, which is what it emits. */
const TOOL_ADDRESSES = new Set([
  "noreply@anthropic.com",
  "noreply@openai.com",
  "cursoragent@cursor.com",
  "noreply@aider.chat",
  "pi@pi.dev",
  "noreply@pi.dev",
  "piagent@pi.dev",
]);

/** The GitHub noreply address of the Copilot agent. */
const COPILOT_NOREPLY = /^\d+\+copilot@users\.noreply\.github\.com$/i;

/** A bot login that names a tool, such as `copilot-swe-agent[bot]`. */
const TOOL_BOT =
  /(claude|anthropic|copilot|codex|chatgpt|openai|gemini|devin|cursor|aider)[\w-]*\[bot\]/i;

/** The name of a tool or its vendor, where a value carries no email. */
const TOOL_NAME =
  /^(claude|anthropic|pi\.dev|pi agent|openai|codex|chatgpt|gpt-?\d[\w.-]*|(github\s+)?copilot|gemini|google\s+gemini|cursor|aider|devin)\b/i;

/** The footer Claude Code writes. Only a `#` or an emoji may precede it, so a
 * sentence quoting the phrase, or a `+` line of a diff, is accepted. */
const GENERATED_WITH =
  /^(#\s*)?(\p{Extended_Pictographic}\uFE0F?\s*)?generated with \[?claude code/iu;

/** pi.dev, which writes its own name and no fixed address. */
const PI_AGENT = /^\s*pi(\.dev|\s+agent)\b/i;

/**
 * Every email in a value, since one value can name several people.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isToolValue(value) {
  const addresses = [...value.matchAll(EMAIL)].map((m) =>
    (m[1] ?? "").trim().toLowerCase()
  );
  if (addresses.length === 0) return TOOL_NAME.test(value.trim());
  return (
    TOOL_BOT.test(value) ||
    addresses.some(
      (address) => TOOL_ADDRESSES.has(address) || COPILOT_NOREPLY.test(address)
    ) ||
    // This one tool names itself and its address is arbitrary, so it is the
    // only case where a name decides over the email.
    PI_AGENT.test(value)
  );
}

/**
 * The lines that credit an AI tool. A trailer continues on indented lines, and
 * the whole of that value is judged while only its first line is reported.
 *
 * @param {string} message
 * @returns {string[]}
 */
export function attributionLines(message) {
  const lines = message.split(/\r?\n/);
  const bad = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (GENERATED_WITH.test(line)) {
      bad.push(line);
      continue;
    }
    const trailer = TRAILER.exec(line);
    if (!trailer) continue;
    let value = trailer[2] ?? "";
    while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1] ?? "")) {
      index += 1;
      value += ` ${String(lines[index] ?? "").trim()}`;
    }
    if (isToolValue(value)) bad.push(line);
  }
  return bad;
}

/**
 * One `tool_call`. Judged only where the message is visible: a written message
 * file, or a heredoc whose body is the message.
 *
 * @param {{ toolName: string, input: Record<string, unknown> }} event
 * @returns {{ block: true, reason: string } | undefined}
 */
export function tool_call(event) {
  const message = messageOf(event);
  if (message === undefined) return;
  const bad = attributionLines(message);
  if (bad.length === 0) return;
  return {
    block: true,
    reason: [
      "The commit message credits an AI tool. Remove these lines:",
      ...bad.map((line) => `  ${line}`),
      "Credit a person if one worked on it, and otherwise leave the trailer out.",
    ]
      .join("\n")
      .trim(),
  };
}

/**
 * The message this call would commit, when it can be read.
 *
 * @param {{ toolName: string, input: Record<string, unknown> }} event
 * @returns {string | undefined}
 */
function messageOf(event) {
  const input = event.input ?? {};
  if (event.toolName === "write") {
    const content = [input.content, input.message, input.text].find(
      (value) => typeof value === "string"
    );
    return content;
  }
  if (event.toolName !== "bash" && event.toolName !== "powershell") return;
  const command = typeof input.command === "string" ? input.command : "";
  if (!isCommit(command)) return;
  // A message file is read whole; a heredoc's body is the message already.
  const file = messageFile(command);
  if (file) return read(file, input.cwd);
  const body = heredoc(command);
  if (body !== undefined) return body;
  // `printf … | git commit -F -` carries the message in the pipeline. Only
  // the last is attempted: earlier output would be another command's.
  return piped(command);
}

/**
 * The message a printf-into-stdin commit feeds, on the left of its pipe.
 *
 * @param {string} command
 * @returns {string | undefined}
 */
function piped(command) {
  const parts = command.split("|");
  if (parts.length < 2) return;
  const producer = parts.at(-2) ?? "";
  if (!/\bprintf\b|\becho\b/.test(producer)) return;
  const output = stdout(producer);
  if (output === undefined) return;
  return unquote(output);
}

/**
 * Undo the shell's own quoting and escapes, since what git sees is the text
 * between them. `\n`, `\'` and the `$'…'` form are the ones it arrives in.
 *
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  return value
    .replaceAll("\\'", "'")
    .replaceAll("\\n", "\n")
    .replaceAll(/\$'([^']*)'/g, "$1")
    .replaceAll(/"([^"]*)"/g, "$1")
    .replaceAll(/(?:^|\s)'(.*?)'/g, " $1")
    .trim();
}

/**
 * What a printf or echo would print, as written, before interpretation.
 *
 * @param {string} producer
 * @returns {string | undefined}
 */
function stdout(producer) {
  const args = producer.trim().replace(/^(?:printf|echo)\b\s*/, "");
  if (!args) return;
  // -n/-e are call flags; any leading flags are skipped.
  return args.replace(/^(?:-(?:n|e|ne|en)\s+)+/, "");
}

/**
 * `git commit`, `git -C x commit`, and the bare `commit` a pipeline leaves.
 *
 * @param {string} command
 * @returns {boolean}
 */
function isCommit(command) {
  return /\bgit\s+(?:-{1,2}\S+\s+\S*\s+)*commit\b|^commit(?:\s|$)/m.test(
    command
  );
}

/**
 * The heredoc body the shell would feed to git, when there is one. Only `-F -`
 * or a bare `commit` takes it, so `git commit -m x <<EOF` is not read here.
 *
 * @param {string} command
 * @returns {string | undefined}
 */
function heredoc(command) {
  const opener = /<<-?\s*["']?([A-Za-z_][\w]*)["']?/.exec(command);
  if (!opener) return;
  const rest = command.slice(opener.index + opener[0].length);
  const end = new RegExp(`\\n${opener[1]}\\s*(?:\\n|$)`).exec(rest);
  const body = end ? rest.slice(1, end.index) : rest.slice(1);
  return body.replace(/^\n/, "");
}

/**
 * The message file named by `-F`, `--file` or `--file=`. A bare path argument is
 * not one: git only reads paths from a commit being amended.
 *
 * @param {string} command
 * @returns {string | undefined}
 */
function messageFile(command) {
  const flag = /(?:^|\s)(?:-F|--file)(?:=|\s+)([^\s"']+)/.exec(command)?.[1];
  return flag && flag !== "-" ? flag : undefined;
}

/**
 * Read a message file, relative to the tool call's working directory.
 *
 * @param {string} file
 * @param {unknown} cwd
 * @returns {string | undefined}
 */
function read(file, cwd) {
  try {
    return readFileSync(
      typeof cwd === "string" ? join(cwd, file) : file,
      "utf-8"
    );
  } catch {
    // A missing file is not this hook's finding; the commit reports it.
    return;
  }
}
