#!/usr/bin/env node
// Rejects stray invisible characters in tracked text files.
//
// A model's output stream can carry a form feed where an em-dash belonged --
// during #863 eight of them reached a commit, and every gate in the repository
// was green on the corrupt tree. Biome's noIrregularWhitespace catches a form
// feed in code position but not inside a comment or a string literal, and its
// rule takes no options, so there is no setting that closes the gap. tsc
// accepts the byte between tokens because ECMAScript classifies U+000C as
// WhiteSpace, and rumdl accepts it in prose.
//
// The characters split by what the correct repair is, not by how bad they are:
// deleting a zero-width space is unambiguous, while deleting a form feed leaves
// the visible half of the corruption behind and deleting a zero-width joiner
// would break an emoji sequence. Only the unambiguous ones are repairable.
//
// Usage: node scripts/lint/invisible-characters.mjs [--fix] [paths...]
//
// With no paths it enumerates `git ls-files -z` itself. `--fix` deletes the
// repairable characters and still fails on the rest.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Every code point from `first` to `last`, inclusive.
 *
 * The sets below are built rather than written as a regular expression
 * character class: Biome's `lint/suspicious/noControlCharactersInRegex` is in
 * the recommended preset and rejects one, and a built set also keeps every
 * literal control character out of this file.
 *
 * @param {number} first
 * @param {number} last
 * @returns {number[]}
 */
function range(first, last) {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/**
 * Code points that are always a failure and are never rewritten.
 *
 * The C0 controls except tab, line feed, and carriage return, plus DEL; then
 * the zero-width characters whose deletion is not universally correct, since
 * a joiner is load-bearing inside an emoji sequence and a non-joiner is
 * semantically required in Persian and several Indic scripts.
 */
const REPORT_ONLY = new Set([
  ...range(0x00, 0x08),
  0x0b,
  0x0c,
  ...range(0x0e, 0x1f),
  0x7f,
  0x200c,
  0x200d,
  0x2060,
]);

/** Code points whose unique correct repair is deletion. */
const REPAIRABLE = new Set([0x200b, 0xfeff]);

/**
 * The visible text a mangled character leaves behind, and what it stood for.
 *
 * Measured across all 1764 session transcripts under `~/.pi/agent/sessions`:
 * 122 form feeds, of which 65 are followed by `erence2` and 4 by `erence6`.
 * The em-dash row is confirmed against the repaired file -- the transcript
 * reads "like `awk` [FF]erence2 but `gawk`" where the commit reads an em dash.
 *
 * 51 of the 122 carry no residue at all, which is why detection keys on the
 * character and only the suggestion keys on this table.
 */
const RESIDUE_SUGGESTIONS = new Map([
  ["erence2", { codePoint: 0x2014, name: "em dash" }],
  ["erence6", { codePoint: 0x2026, name: "ellipsis" }],
]);

/**
 * The character a residue identifies, or null when it identifies none.
 *
 * `residue` is the rest of the line after the invisible character, so a row
 * matches as a prefix -- `coherence2` is ordinary prose, not a signature.
 *
 * @param {string} residue
 * @returns {{codePoint: number, name: string} | null}
 */
export function suggestedCharacter(residue) {
  for (const [signature, character] of RESIDUE_SUGGESTIONS) {
    if (residue.startsWith(signature)) return character;
  }
  return null;
}

/**
 * Every stray invisible character in `text`, in reading order.
 *
 * `column` counts code points rather than UTF-16 units, so an astral
 * character earlier on the line does not skew the position.
 *
 * @param {string} text
 * @returns {{line: number, column: number, codePoint: number, repairable: boolean, suggestion: {codePoint: number, name: string} | null}[]}
 */
export function findInvisibleCharacters(text) {
  const findings = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    let column = 0;
    for (const character of line) {
      column += 1;
      const codePoint = character.codePointAt(0);
      const repairable = REPAIRABLE.has(codePoint);
      if (!repairable && !REPORT_ONLY.has(codePoint)) continue;
      findings.push({
        line: index + 1,
        column,
        codePoint,
        repairable,
        suggestion: suggestedCharacter([...line].slice(column).join("")),
      });
    }
  }
  return findings;
}

/**
 * Whether a file's bytes should be treated as binary and skipped.
 *
 * A NUL is git's own heuristic, and it is what keeps a video or a PNG that
 * happens to contain `0x0c` out of the findings.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isBinary(buffer) {
  return buffer.includes(0);
}

/**
 * One finding rendered as a `path:line:column: U+XXXX` line.
 *
 * When the trailing residue identifies the character that was mangled, the
 * line names it -- but only as a suggestion, since repairing it needs the
 * surrounding sentence and this tool never rewrites it.
 *
 * @param {string} path
 * @param {{line: number, column: number, codePoint: number, suggestion?: {codePoint: number, name: string} | null}} finding
 * @returns {string}
 */
export function formatFinding(path, finding) {
  const position = `${path}:${finding.line}:${finding.column}`;
  const found = `U+${hex(finding.codePoint)}`;
  if (!finding.suggestion) return `${position}: ${found}`;
  const { codePoint, name } = finding.suggestion;
  return `${position}: ${found} (did you mean U+${hex(codePoint)} ${name}?)`;
}

/**
 * A code point as at least four uppercase hexadecimal digits.
 *
 * @param {number} codePoint
 * @returns {string}
 */
function hex(codePoint) {
  return codePoint.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Findings across many files, each tagged with the path it came from.
 *
 * `readFile` is injected so a test can drive the multi-file path without a
 * temporary directory, matching `doc-growth.mjs`'s `measure(sha, run)`.
 *
 * @param {string[]} paths
 * @param {(path: string) => Buffer} readFile
 * @returns {{findings: {path: string, line: number, column: number, codePoint: number, repairable: boolean}[]}}
 */
export function scanFiles(paths, readFile) {
  const findings = [];
  for (const path of paths) {
    const buffer = readFile(path);
    if (isBinary(buffer)) continue;
    for (const finding of findInvisibleCharacters(buffer.toString("utf8"))) {
      findings.push({ path, ...finding });
    }
  }
  return { findings };
}

/**
 * `text` with every repairable character deleted.
 *
 * A report-only character is left exactly where it is. Deleting a form feed
 * would strand its visible residue, which is the trap #863 recorded: the
 * confirming grep then passes on a file that is still wrong.
 *
 * @param {string} text
 * @returns {{text: string, removed: number}}
 */
export function repairInvisibleCharacters(text) {
  const characters = [...text];
  const kept = characters.filter(
    (character) => !REPAIRABLE.has(character.codePointAt(0)),
  );
  return { text: kept.join(""), removed: characters.length - kept.length };
}

/**
 * Repair every file that has something repairable, and name those rewritten.
 *
 * A file with nothing to delete is not rewritten at all, so a repair run
 * leaves no incidental diff.
 *
 * @param {string[]} paths
 * @param {{readFile: (path: string) => Buffer, writeFile: (path: string, text: string) => void}} io
 * @returns {{repaired: string[]}}
 */
export function repairFiles(paths, io) {
  const repaired = [];
  for (const path of paths) {
    const buffer = io.readFile(path);
    if (isBinary(buffer)) continue;
    const { text, removed } = repairInvisibleCharacters(
      buffer.toString("utf8"),
    );
    if (removed === 0) continue;
    io.writeFile(path, text);
    repaired.push(path);
  }
  return { repaired };
}

/**
 * The whole command: repair when asked, then report whatever is left.
 *
 * Repairing never satisfies the gate on its own -- the scan runs afterwards
 * over the rewritten files, so a report-only finding still fails.
 *
 * @param {{paths: string[], fix?: boolean}} request
 * @param {{readFile: (path: string) => Buffer, writeFile: (path: string, text: string) => void}} io
 * @returns {{lines: string[], exitCode: number}}
 */
export function run({ paths, fix = false }, io) {
  const lines = [];
  if (fix) {
    for (const path of repairFiles(paths, io).repaired) {
      lines.push(`repaired ${path}`);
    }
  }
  const { findings } = scanFiles(paths, io.readFile);
  for (const finding of findings) {
    lines.push(formatFinding(finding.path, finding));
  }
  return { lines, exitCode: findings.length === 0 ? 0 : 1 };
}

/**
 * Every tracked file that exists on disk.
 *
 * A path staged for deletion is still tracked, so the existence filter keeps
 * the scan from throwing on it.
 *
 * @returns {string[]}
 */
function trackedFiles() {
  const listing = execFileSync("git", ["ls-files", "-z"], {
    maxBuffer: 64 * 1024 * 1024,
  }).toString("utf8");
  // A submodule is tracked as a gitlink and exists on disk as a directory, so
  // an existence check alone hands `readFileSync` a directory and throws EISDIR.
  return listing
    .split("\0")
    .filter((path) => path !== "" && existsSync(path))
    .filter((path) => !statSync(path).isDirectory());
}

/**
 * @param {string[]} argv
 * @returns {{fix: boolean, paths: string[]}}
 */
function parseArgs(argv) {
  const options = { fix: false, paths: [] };
  for (const argument of argv) {
    if (argument === "--fix") options.fix = true;
    else if (argument.startsWith("--")) {
      throw new Error(`unknown option: ${argument}`);
    } else options.paths.push(argument);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { fix, paths } = parseArgs(process.argv.slice(2));
  const { lines, exitCode } = run(
    { paths: paths.length > 0 ? paths : trackedFiles(), fix },
    {
      readFile: readFileSync,
      writeFile: (path, text) => writeFileSync(path, text, "utf8"),
    },
  );
  for (const line of lines) process.stdout.write(`${line}\n`);
  process.exitCode = exitCode;
}
