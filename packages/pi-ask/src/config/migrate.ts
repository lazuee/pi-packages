import { normalizeConfiguredKeymaps } from "#src/constants/keymaps";
import { normalizeAskConfig } from "./defaults";
import {
  AskConfigVersionMigrationError,
  type AskConfigVersionMigrationResult,
  migrateAskConfigFileToCurrent,
} from "./migrations/index";
import { type AskConfig, validateAskConfigFileV5 } from "./schema";

export class AskConfigMigrationError extends Error {
  readonly reason: "invalid_or_unsupported" | "migration_failed";

  constructor(
    message: string,
    reason: "invalid_or_unsupported" | "migration_failed",
  ) {
    super(message);
    this.reason = reason;
  }
}

export interface AskConfigMigrationResult {
  config: AskConfig;
  migrated: boolean;
  notice?: string;
}

export function migrateAskConfig(raw: unknown): AskConfigMigrationResult {
  let migratedFile: AskConfigVersionMigrationResult;
  try {
    migratedFile = migrateAskConfigFileToCurrent(raw);
  } catch (error) {
    throw new AskConfigMigrationError(
      "Config was invalid or unsupported.",
      error instanceof AskConfigVersionMigrationError
        ? error.reason
        : "migration_failed",
    );
  }

  if (!validateAskConfigFileV5.Check(migratedFile.config)) {
    throw new AskConfigMigrationError(
      "Config was invalid or unsupported.",
      "invalid_or_unsupported",
    );
  }

  const currentFile = migratedFile.config;
  const config = normalizeAskConfig(currentFile);
  const keymapsResult = normalizeConfiguredKeymaps(currentFile.keymaps);
  if (!keymapsResult.ok) {
    return {
      config: {
        ...config,
        keymaps: normalizeAskConfig().keymaps,
      },
      migrated: migratedFile.migrated,
      notice: `${keymapsResult.error} Using default ask keymaps for this session. Edit the config and restart pi or run /reload.`,
    };
  }

  return {
    config: {
      ...config,
      keymaps: keymapsResult.keymaps,
    },
    migrated: migratedFile.migrated,
  };
}
