/**
 * Configuration loading for pi-continue.
 *
 * Config files live at:
 *  - Global:  <agentDir>/extensions/pi-continue/config.json
 *  - Project: <cwd>/.pi/extensions/pi-continue/config.json
 *
 * Project config takes precedence over global. A missing file is silent; a
 * malformed file warns to stderr and falls back to defaults. Every field is
 * optional and anything unrecognized falls back to its default.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EXTENSION_ID = "pi-continue";

/** A model the optional judge should call, instead of the session model. */
export interface JudgeModelConfig {
  provider: string;
  model: string;
}

export interface ContinueConfig {
  /** Master switch. Even when false, `/continue` works by hand. */
  enabled: boolean;
  /** Whether to recover in the session pi-continue is loaded into. */
  continueSelf: boolean;
  /** Whether to recover in subagent child sessions. */
  continueChildren: boolean;
  /** Hard ceiling on back-to-back recoveries before giving up. */
  maxConsecutive: number;
  /** Minimum gap between two recoveries, so a fast crash loop cannot spin. */
  minIntervalMs: number;
  /** Recoveries one run may spend before its budget is gone. */
  maxForks: number;
  /** Message sent for an empty or silent response. */
  emptyText: string;
  /** Message sent for a response cut off at the output-token limit. */
  truncatedText: string;
  /** Message sent for a run that ended on a provider error. */
  errorText: string;
  /**
   * Provider-error substrings Pi already retried internally. Matching errors
   * are not recovered, because Pi has spent its own retry budget on them.
   */
  alreadyRetriedPatterns: string[];
  /**
   * Classify a finished-but-ambiguous run. `off` never asks; `model` asks the
   * judge only for the ambiguous row; `always` asks for every non-`toolUse`
   * row before heuristics narrow it.
   */
  judgeMode: "off" | "model" | "always";
  /** Model for the judge. Unset tries the session model, then any available model. */
  judgeModel?: JudgeModelConfig;
  /** How many trailing messages the judge sees. */
  judgeTailMessages: number;
  /** Abort one judge attempt after this long, then try the next model. */
  judgeTimeoutMs: number;
  /** Whether to stay quiet after an Esc abort until the operator types. */
  suppressAfterAbort: boolean;
  /** Whether to raise a UI notification for each recovery and give-up. */
  notify: boolean;
  /** Whether to write every decision to stderr. */
  debug: boolean;
}

const NUMERIC_KEYS = [
  "maxConsecutive",
  "minIntervalMs",
  "judgeTailMessages",
] as const;

export const DEFAULT_CONFIG: ContinueConfig = {
  enabled: true,
  continueSelf: true,
  continueChildren: true,
  maxConsecutive: 3,
  minIntervalMs: 2000,
  maxForks: 3,
  emptyText: "continue",
  truncatedText:
    "Your response was cut off at the output-token limit. Continue from where you stopped, in shorter steps.",
  errorText: "continue",
  alreadyRetriedPatterns: [
    "429",
    "500",
    "502",
    "503",
    "504",
    "520",
    "524",
    "overloaded",
    "rate limit",
    "connection reset",
    "premature stream",
    "ECONNRESET",
    "ETIMEDOUT",
    "timeout",
    "WebSocket",
  ],
  judgeMode: "off",
  judgeTailMessages: 12,
  judgeTimeoutMs: 8_000,
  suppressAfterAbort: true,
  notify: true,
  debug: false,
};

export function getGlobalConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", EXTENSION_ID, "config.json");
}

export function getProjectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "extensions", EXTENSION_ID, "config.json");
}

/**
 * Drop fields that do not match the expected shape. Garbage becomes absent, so
 * the default survives; a partially bad file keeps every good field.
 */
export function normalizeConfig(raw: unknown): Partial<ContinueConfig> {
  if (!isRecord(raw)) return {};
  const config: Partial<ContinueConfig> = {};
  copyBooleans(raw, config);
  copyNumbers(raw, config);
  copyStrings(raw, config);
  copyJudge(raw, config);
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyBooleans(
  raw: Record<string, unknown>,
  config: Partial<ContinueConfig>,
): void {
  const keys = [
    "enabled",
    "continueSelf",
    "continueChildren",
    "suppressAfterAbort",
    "notify",
    "debug",
  ] as const;
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "boolean") config[key] = value;
  }
}

function copyNumbers(
  raw: Record<string, unknown>,
  config: Partial<ContinueConfig>,
): void {
  for (const key of NUMERIC_KEYS) {
    const value = raw[key];
    // Zero is legal for the interval (no throttle); it is not legal for a count.
    const floor = key === "minIntervalMs" ? 0 : 1;
    if (typeof value === "number" && Number.isFinite(value) && value >= floor) {
      // Narrowed key set above, so the cast is to the numeric members only.
      config[key] = Math.floor(value);
    }
  }
  const timeout = raw.judgeTimeoutMs;
  if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) {
    config.judgeTimeoutMs = Math.floor(timeout);
  }
}

function copyStrings(
  raw: Record<string, unknown>,
  config: Partial<ContinueConfig>,
): void {
  for (const key of ["emptyText", "truncatedText", "errorText"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) {
      config[key] = value;
    }
  }
  const patterns = raw.alreadyRetriedPatterns;
  if (Array.isArray(patterns)) {
    const kept = patterns.filter(
      (pattern): pattern is string =>
        typeof pattern === "string" && pattern.length > 0,
    );
    if (kept.length === patterns.length) {
      config.alreadyRetriedPatterns = kept;
    }
  }
}

function copyJudge(
  raw: Record<string, unknown>,
  config: Partial<ContinueConfig>,
): void {
  const mode = raw.judgeMode;
  if (mode === "off" || mode === "model" || mode === "always") {
    config.judgeMode = mode;
  }
  const model = raw.judgeModel;
  if (!isRecord(model)) return;
  const { provider, model: id } = model;
  if (typeof provider === "string" && typeof id === "string") {
    config.judgeModel = { provider, model: id };
  }
}

function loadSingleConfig(path: string): Partial<ContinueConfig> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return normalizeConfig(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[${EXTENSION_ID}] Ignoring malformed config at ${path}: ${reason}`,
    );
    return {};
  }
}

/** Load merged config: built-in defaults, then global, then project. */
export function loadConfig(options: {
  globalConfigPath: string;
  projectConfigPath: string;
}): ContinueConfig {
  return {
    ...DEFAULT_CONFIG,
    ...loadSingleConfig(options.globalConfigPath),
    ...loadSingleConfig(options.projectConfigPath),
  };
}
