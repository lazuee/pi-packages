#!/usr/bin/env node
// Validation for this repo's project-scope pi-permission-system config.
//
// The extension rejects an invalid non-global scope fail-closed and floors the
// composed policy allow -> ask with origin "fail-closed", so a typo in
// .pi/extensions/pi-permission-system/config.json makes every surface in the
// repo prompt. That is loud rather than silent, but it is worth catching here
// instead of at the next session start.
//
// Three of the checks below are deliberately stricter than the published JSON
// Schema, which marks `reason` optional and bounds nothing else:
//
//  - a deny rule must carry a reason, because the agent-facing refusal never
//    echoes the command it ran, so a reasonless deny tells it nothing;
//  - a reason must not end in a full stop, because the renderer appends one;
//  - a pattern must not span a pipe, because a bash rule matches one command
//    unit and a pipeline enumerates into several, so such a pattern is a
//    silent no-op.
//
// The rest hold the schema's own line rather than exceeding it: a surface
// value is a state or a pattern map, and a deny rule's keys are exactly the
// two the schema's strict object defines.
//
// Usage: node scripts/permission-config/tripwire-rules.mjs [--root DIR]

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The `reason` length the permission schema caps at. */
export const MAX_REASON_LENGTH = 500;

/** The permission states a surface value may name directly. */
const PERMISSION_STATES = ["allow", "deny", "ask"];

/** The keys the schema's strict deny object defines. */
const DENY_RULE_KEYS = ["action", "reason"];

/** Where a project scope's config lives, relative to the repo root. */
const PROJECT_CONFIG_PATH = path.join(
  ".pi",
  "extensions",
  "pi-permission-system",
  "config.json",
);

const RAW_SCHEMA_PREFIX =
  "https://raw.githubusercontent.com/lazuee/pi-packages/main/";

/**
 * Read and parse this repo's project-scope permission config.
 *
 * Throws when the file is missing or is not JSON — a JSONC comment reaches
 * here as a parse error, since the extension does not support JSONC.
 *
 * @param {string} root
 * @returns {Record<string, unknown>}
 */
export function loadProjectPermissionConfig(root) {
  return JSON.parse(readFileSync(path.join(root, PROJECT_CONFIG_PATH), "utf8"));
}

/**
 * The repo-relative path a `$schema` URL names, or null when the URL does not
 * point into this repository at all.
 *
 * @param {unknown} schemaUrl
 * @returns {string | null}
 */
export function schemaRepoPath(schemaUrl) {
  if (typeof schemaUrl !== "string") return null;
  if (!schemaUrl.startsWith(RAW_SCHEMA_PREFIX)) return null;
  return schemaUrl.slice(RAW_SCHEMA_PREFIX.length);
}

/**
 * Human-readable problems with a parsed permission config; an empty array
 * means valid.
 *
 * @param {Record<string, unknown>} config
 * @returns {string[]}
 */
export function findConfigProblems(config) {
  const permission = config?.permission;
  if (typeof permission !== "object" || permission === null) return [];
  if (!Object.hasOwn(permission, "bash")) return [];

  const bash = permission.bash;
  if (typeof bash === "string") {
    return PERMISSION_STATES.includes(bash) ? [] : [malformedSurface()];
  }
  if (typeof bash !== "object" || bash === null || Array.isArray(bash)) {
    return [malformedSurface()];
  }

  const problems = [];
  for (const [pattern, value] of Object.entries(bash)) {
    const label = `bash '${pattern}'`;
    if (pattern.includes("|")) {
      problems.push(
        `${label}: a pattern containing '|' matches nothing, because a pipeline enumerates into separate command units`,
      );
      continue;
    }
    problems.push(...ruleValueProblems(label, value));
  }
  return problems;
}

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {string[]}
 */
function ruleValueProblems(label, value) {
  if (typeof value === "string") {
    return PERMISSION_STATES.includes(value) ? [] : [malformedValue(label)];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [malformedValue(label)];
  }
  if (value.action !== "deny") return [malformedValue(label)];
  const unknown = Object.keys(value).find(
    (key) => !DENY_RULE_KEYS.includes(key),
  );
  if (unknown !== undefined) {
    return [`${label}: unknown key '${unknown}' on a deny rule`];
  }
  return reasonProblems(label, value.reason);
}

/**
 * @param {string} label
 * @param {unknown} reason
 * @returns {string[]}
 */
function reasonProblems(label, reason) {
  if (typeof reason !== "string" || reason === "") {
    return [`${label}: a deny rule must carry a non-empty reason`];
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return [`${label}: reason exceeds ${MAX_REASON_LENGTH} characters`];
  }
  if (reason.endsWith(".")) {
    return [
      `${label}: reason must not end with '.' — the renderer appends one`,
    ];
  }
  return [];
}

/**
 * @param {string} label
 */
function malformedValue(label) {
  return `${label}: value must be "allow", "deny", "ask", or { action: "deny", reason }`;
}

function malformedSurface() {
  return 'bash: surface value must be "allow", "deny", "ask", or a map of patterns';
}

function parseArgs(argv) {
  const options = { root: process.cwd() };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--root") options.root = argv[i + 1];
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { root } = parseArgs(process.argv.slice(2));
  const config = loadProjectPermissionConfig(root);
  const problems = findConfigProblems(config);
  const schemaPath = schemaRepoPath(config.$schema);
  if (schemaPath === null || !existsSync(path.join(root, schemaPath))) {
    problems.push("$schema does not name a file in this repository");
  }
  for (const problem of problems) process.stdout.write(`${problem}\n`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
