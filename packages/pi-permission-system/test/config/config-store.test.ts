import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks (hoisted) ─────────────────────────────────────────────────

const {
  mockLoadAndMergeConfigs,
  mockLoadUnifiedConfig,
  mockBuildResolvedConfigLogEntry,
  mockExistsSync,
  mockMkdirSync,
  mockWriteFileSync,
  mockRenameSync,
  mockUnlinkSync,
} = vi.hoisted(() => ({
  mockLoadAndMergeConfigs: vi.fn(),
  mockLoadUnifiedConfig: vi.fn(),
  mockBuildResolvedConfigLogEntry: vi.fn(),
  mockExistsSync: vi.fn<(path: string) => boolean>(),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockRenameSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
}));

vi.mock("#src/config/config-loader", () => ({
  loadAndMergeConfigs: mockLoadAndMergeConfigs,
  loadUnifiedConfig: mockLoadUnifiedConfig,
}));

vi.mock("#src/config/config-reporter", () => ({
  buildResolvedConfigLogEntry: mockBuildResolvedConfigLogEntry,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  renameSync: mockRenameSync,
  unlinkSync: mockUnlinkSync,
  default: {
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync,
    renameSync: mockRenameSync,
    unlinkSync: mockUnlinkSync,
  },
}));

// ── Imports ────────────────────────────────────────────────────────────────

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  foldDeclaredCommandEffects,
  NO_DECLARED_COMMAND_EFFECTS,
} from "#src/config/command-effects-config";
import {
  ConfigStore,
  type ConfigStoreDeps,
  type ResolvedPolicyPathProvider,
} from "#src/config/config-store";
import { DEFAULT_EXTENSION_CONFIG } from "#src/config/extension-config";
import type { ResolvedPolicyPaths } from "#src/config/policy-loader";

// ── Helpers ────────────────────────────────────────────────────────────────

function makePolicyPathProvider(
  paths?: Partial<ResolvedPolicyPaths>,
): ResolvedPolicyPathProvider {
  return {
    getResolvedPolicyPaths: vi.fn(
      (): ResolvedPolicyPaths => ({
        globalConfigPath: "/agent/config.json",
        globalConfigExists: false,
        projectConfigPath: null,
        projectConfigExists: false,
        agentsDir: "/agent/agents",
        agentsDirExists: false,
        projectAgentsDir: null,
        projectAgentsDirExists: false,
        ...paths,
      }),
    ),
  };
}

function makeLogger() {
  return {
    debug: vi.fn<(event: string, details?: Record<string, unknown>) => void>(),
    review: vi.fn<(event: string, details?: Record<string, unknown>) => void>(),
  };
}

function makeCommandCtx(
  overrides: Partial<ExtensionCommandContext> = {},
): ExtensionCommandContext {
  return {
    cwd: "/test/project",
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    ...overrides,
  } as unknown as ExtensionCommandContext;
}

function makeStore(overrides: Partial<ConfigStoreDeps> = {}) {
  const logger = makeLogger();
  const syncStatus = vi.fn<(ctx: ExtensionCommandContext) => void>();
  const deps: ConfigStoreDeps = {
    agentDir: "/test/agent",
    policyPaths: makePolicyPathProvider(),
    coreCommandWords: new Set(["sed"]),
    wrapperCommandWords: new Set(["xargs"]),
    logger,
    syncStatus,
    ...overrides,
  };
  return { store: new ConfigStore(deps), logger, syncStatus };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ConfigStore", () => {
  beforeEach(() => {
    mockLoadAndMergeConfigs.mockReset().mockReturnValue({
      declaredCommandEffects: NO_DECLARED_COMMAND_EFFECTS,
      merged: { ...DEFAULT_EXTENSION_CONFIG },
      issues: [],
    });
    mockLoadUnifiedConfig.mockReset().mockReturnValue({ config: {} });
    mockBuildResolvedConfigLogEntry
      .mockReset()
      .mockReturnValue({ resolved: true });
    mockExistsSync.mockReset().mockReturnValue(false);
    mockMkdirSync.mockReset();
    mockWriteFileSync.mockReset();
    mockRenameSync.mockReset();
    mockUnlinkSync.mockReset();
  });

  // ── current() ─────────────────────────────────────────────────────────

  describe("current()", () => {
    it("returns DEFAULT_EXTENSION_CONFIG before any refresh", () => {
      const { store } = makeStore();
      expect(store.current()).toEqual(DEFAULT_EXTENSION_CONFIG);
    });
  });

  // ── getConfigIssues() ─────────────────────────────────────────────────

  describe("getConfigIssues()", () => {
    it("answers empty before any refresh", () => {
      const { store } = makeStore();
      expect(store.getConfigIssues()).toEqual([]);
    });

    it("answers the issues the last load produced", () => {
      const { store } = makeStore();
      mockLoadAndMergeConfigs.mockReturnValue({
        declaredCommandEffects: NO_DECLARED_COMMAND_EFFECTS,
        merged: { ...DEFAULT_EXTENSION_CONFIG },
        issues: ["first issue", "second issue"],
      });
      store.refresh("/test/project", true);
      expect(store.getConfigIssues()).toEqual(["first issue", "second issue"]);
    });

    it("answers empty again once a reload finds the config clean", () => {
      const { store } = makeStore();
      mockLoadAndMergeConfigs.mockReturnValue({
        declaredCommandEffects: NO_DECLARED_COMMAND_EFFECTS,
        merged: { ...DEFAULT_EXTENSION_CONFIG },
        issues: ["transient issue"],
      });
      store.refresh("/test/project", true);
      mockLoadAndMergeConfigs.mockReturnValue({
        declaredCommandEffects: NO_DECLARED_COMMAND_EFFECTS,
        merged: { ...DEFAULT_EXTENSION_CONFIG },
        issues: [],
      });
      store.refresh("/test/project", true);
      expect(store.getConfigIssues()).toEqual([]);
    });

    it("appends a declaration the pure-reader core shadows", () => {
      const { store } = makeStore();
      mockLoadAndMergeConfigs.mockReturnValue({
        declaredCommandEffects: foldDeclaredCommandEffects(
          NO_DECLARED_COMMAND_EFFECTS,
          {
            sed: { effects: "read" },
            xargs: { effects: "read" },
            git: { effects: "read" },
          },
          "global",
        ),
        merged: { ...DEFAULT_EXTENSION_CONFIG },
        issues: ["first issue"],
      });
      store.refresh("/test/project", true);
      expect(store.getConfigIssues()).toEqual([
        "first issue",
        "commandEffects declares 'sed', a pure-reader core command. The core decides its effects, so the declaration is ignored; remove it.",
        "commandEffects declares 'xargs', a wrapper. A declaration describes a command's own arguments, never the command a wrapper runs, so it is ignored; remove it.",
      ]);
    });
  });

  // ── refresh() ─────────────────────────────────────────────────────────

  describe("refresh()", () => {
    it("uses the passed cwd for loadAndMergeConfigs and includes the project scope when trusted", () => {
      const { store } = makeStore();
      store.refresh("/my/project", true);
      expect(mockLoadAndMergeConfigs).toHaveBeenCalledWith(
        "/test/agent",
        "/my/project",
        expect.any(String),
        { includeProjectScope: true },
      );
    });

    it("withholds the project scope when the project is untrusted", () => {
      const { store } = makeStore();
      store.refresh("/my/project", false);
      expect(mockLoadAndMergeConfigs).toHaveBeenCalledWith(
        "/test/agent",
        "/my/project",
        expect.any(String),
        { includeProjectScope: false },
      );
    });

    it("uses empty string cwd when no cwd is provided", () => {
      const { store } = makeStore();
      store.refresh(undefined, true);
      expect(mockLoadAndMergeConfigs).toHaveBeenCalledWith(
        "/test/agent",
        "",
        expect.any(String),
        { includeProjectScope: true },
      );
    });

    it("updates current() with normalized merged result", () => {
      const { store } = makeStore();
      mockLoadAndMergeConfigs.mockReturnValue({
        declaredCommandEffects: NO_DECLARED_COMMAND_EFFECTS,
        merged: { debugLog: true, permissionReviewLog: false, yoloMode: false },
        issues: [],
      });
      store.refresh(undefined, true);
      expect(store.current().debugLog).toBe(true);
      expect(store.current().permissionReviewLog).toBe(false);
    });

    it("writes config.loaded debug log", () => {
      const { store, logger } = makeStore();
      store.refresh(undefined, true);
      expect(logger.debug).toHaveBeenCalledWith(
        "config.loaded",
        expect.objectContaining({ debugLog: false }),
      );
    });

    // `config.loaded` is the durable record of what the load found, for
    // whoever is diagnosing after the fact. The operator-facing notification
    // is `ConfigIssueReporter`'s job; this field is not.
    it("records the issues on config.loaded as one joined string", () => {
      const { store, logger } = makeStore();
      mockLoadAndMergeConfigs.mockReturnValue({
        declaredCommandEffects: NO_DECLARED_COMMAND_EFFECTS,
        merged: { ...DEFAULT_EXTENSION_CONFIG },
        issues: ["first issue", "second issue"],
      });
      store.refresh(undefined, true);
      expect(logger.debug).toHaveBeenCalledWith(
        "config.loaded",
        expect.objectContaining({ warning: "first issue\nsecond issue" }),
      );
    });

    it("records a null warning on config.loaded when the config is clean", () => {
      const { store, logger } = makeStore();
      store.refresh(undefined, true);
      expect(logger.debug).toHaveBeenCalledWith(
        "config.loaded",
        expect.objectContaining({ warning: null }),
      );
    });

    // The load takes no context now, so it cannot notify or sync the status
    // bar even by accident, which is the point: `PermissionSession` owns the
    // status sync and `ConfigIssueReporter` owns the warning (#933).
    it("does not sync the status bar", () => {
      const { store, syncStatus } = makeStore();
      store.refresh("/my/project", true);
      expect(syncStatus).not.toHaveBeenCalled();
    });

    describe("yolo provenance", () => {
      function loadYolo(global: boolean | undefined, merged: boolean): void {
        mockLoadAndMergeConfigs.mockReturnValue({
          declaredCommandEffects: NO_DECLARED_COMMAND_EFFECTS,
          merged: { ...DEFAULT_EXTENSION_CONFIG, yoloMode: merged },
          belowProject: global === undefined ? {} : { yoloMode: global },
          issues: [],
        });
      }

      it("reports yolo enabled by the project when only the project turns it on", () => {
        const { store } = makeStore();
        loadYolo(undefined, true);
        store.refresh("/my/project", true);
        expect(store.yoloEnabledByProject()).toBe(true);
      });

      it("does not blame the project when the global config already enables yolo", () => {
        const { store } = makeStore();
        loadYolo(true, true);
        store.refresh("/my/project", true);
        expect(store.yoloEnabledByProject()).toBe(false);
      });

      it("does not blame the project when yolo is off", () => {
        const { store } = makeStore();
        loadYolo(true, false);
        store.refresh("/my/project", true);
        expect(store.yoloEnabledByProject()).toBe(false);
      });

      it("clears the project attribution once a save writes yolo to the global file", () => {
        const { store } = makeStore();
        loadYolo(false, true);
        store.refresh("/my/project", true);
        store.save(
          { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true },
          makeCommandCtx(),
        );
        expect(store.yoloEnabledByProject()).toBe(false);
      });
    });

    it("carries piInfrastructureReadPaths from merged config into current()", () => {
      const { store } = makeStore();
      mockLoadAndMergeConfigs.mockReturnValue({
        declaredCommandEffects: NO_DECLARED_COMMAND_EFFECTS,
        merged: { piInfrastructureReadPaths: ["/extra/path"] },
        issues: [],
      });
      store.refresh(undefined, true);
      expect(store.current().piInfrastructureReadPaths).toEqual([
        "/extra/path",
      ]);
    });
  });

  // ── save() ─────────────────────────────────────────────────────────────

  describe("declaredCommandEffects()", () => {
    const declared = foldDeclaredCommandEffects(
      NO_DECLARED_COMMAND_EFFECTS,
      { git: { subcommands: { log: "read" } } },
      "project",
    );

    it("answers none before any refresh", () => {
      const { store } = makeStore();
      expect(store.declaredCommandEffects()).toBe(NO_DECLARED_COMMAND_EFFECTS);
    });

    it("answers what the last refresh loaded", () => {
      const { store } = makeStore();
      mockLoadAndMergeConfigs.mockReturnValue({
        declaredCommandEffects: declared,
        merged: { ...DEFAULT_EXTENSION_CONFIG },
        issues: [],
      });
      store.refresh("/test/project", true);
      expect(store.declaredCommandEffects()).toBe(declared);
    });

    it("survives a save, which rebuilds the runtime config", () => {
      const { store } = makeStore();
      mockLoadAndMergeConfigs.mockReturnValue({
        declaredCommandEffects: declared,
        merged: { ...DEFAULT_EXTENSION_CONFIG },
        issues: [],
      });
      store.refresh("/test/project", true);
      store.save(
        { ...DEFAULT_EXTENSION_CONFIG, debugLog: true },
        makeCommandCtx(),
      );
      expect(store.declaredCommandEffects()).toBe(declared);
    });
  });

  describe("save()", () => {
    it("writes merged config to the global path", () => {
      const { store } = makeStore();
      mockLoadUnifiedConfig.mockReturnValue({
        config: { permission: { "*": "ask" } },
      });
      const next = { ...DEFAULT_EXTENSION_CONFIG, debugLog: true };
      const ctx = makeCommandCtx();
      store.save(next, ctx);
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining(".tmp"),
        expect.stringContaining('"debugLog": true'),
        "utf-8",
      );
      expect(mockRenameSync).toHaveBeenCalled();
    });

    it("updates current() after a successful save", () => {
      const { store } = makeStore();
      const next = { ...DEFAULT_EXTENSION_CONFIG, debugLog: true };
      store.save(next, makeCommandCtx());
      expect(store.current().debugLog).toBe(true);
    });

    it("asks the session to resync the status after a successful save", () => {
      const { store, syncStatus } = makeStore();
      const ctx = makeCommandCtx();
      store.save({ ...DEFAULT_EXTENSION_CONFIG }, ctx);
      expect(syncStatus).toHaveBeenCalledWith(ctx);
    });

    it("writes config.saved debug log after a successful save", () => {
      const { store, logger } = makeStore();
      store.save({ ...DEFAULT_EXTENSION_CONFIG }, makeCommandCtx());
      expect(logger.debug).toHaveBeenCalledWith(
        "config.saved",
        expect.objectContaining({ debugLog: false }),
      );
    });

    it("notifies with error and returns early when write fails", () => {
      const mockNotify = vi.fn();
      const ctx = makeCommandCtx({ ui: { notify: mockNotify } as never });
      const { store, logger, syncStatus } = makeStore();
      mockMkdirSync.mockImplementation(() => {
        throw new Error("disk full");
      });
      store.save({ ...DEFAULT_EXTENSION_CONFIG }, ctx);
      expect(mockNotify).toHaveBeenCalledWith(
        expect.stringContaining("Failed to save"),
        "error",
      );
      // current() is not updated on failure
      expect(store.current()).toEqual(DEFAULT_EXTENSION_CONFIG);
      // nothing changed, so the status line is left as it was
      expect(syncStatus).not.toHaveBeenCalled();
      // no debug log on failure
      expect(logger.debug).not.toHaveBeenCalledWith(
        "config.saved",
        expect.anything(),
      );
    });

    it("attempts cleanup of tmp file when write fails and tmp exists", () => {
      const ctx = makeCommandCtx();
      const { store } = makeStore();
      mockMkdirSync.mockImplementation(() => {
        throw new Error("disk full");
      });
      mockExistsSync.mockReturnValue(true);
      store.save({ ...DEFAULT_EXTENSION_CONFIG }, ctx);
      expect(mockUnlinkSync).toHaveBeenCalled();
    });

    it("preserves an existing global toolInputPreviewMaxLength on save", () => {
      const { store } = makeStore();
      // Simulate a global config.json that already has the preview-length field.
      mockLoadUnifiedConfig.mockReturnValue({
        config: { toolInputPreviewMaxLength: 800 },
      });
      store.save({ ...DEFAULT_EXTENSION_CONFIG }, makeCommandCtx());
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining(".tmp"),
        expect.stringContaining('"toolInputPreviewMaxLength": 800'),
        "utf-8",
      );
    });

    it("preserves an existing global piInfrastructureReadPaths on save", () => {
      const { store } = makeStore();
      // Simulate a global config.json that already has the infra-paths field.
      mockLoadUnifiedConfig.mockReturnValue({
        config: { piInfrastructureReadPaths: ["/extra/path"] },
      });
      store.save({ ...DEFAULT_EXTENSION_CONFIG }, makeCommandCtx());
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining(".tmp"),
        expect.stringContaining('"piInfrastructureReadPaths"'),
        "utf-8",
      );
    });
  });

  // ── logResolvedPaths() ─────────────────────────────────────────────────

  describe("logResolvedPaths()", () => {
    it("writes config.resolved to both review and debug logs", () => {
      const { store, logger } = makeStore();
      store.logResolvedPaths();
      expect(logger.review).toHaveBeenCalledWith(
        "config.resolved",
        expect.any(Object),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        "config.resolved",
        expect.any(Object),
      );
    });

    it("calls getResolvedPolicyPaths from the provider", () => {
      const mockProvider = makePolicyPathProvider();
      const { store } = makeStore({ policyPaths: mockProvider });
      store.logResolvedPaths();
      expect(mockProvider.getResolvedPolicyPaths).toHaveBeenCalled();
    });

    it("passes legacy detection results to buildResolvedConfigLogEntry", () => {
      const { store } = makeStore();
      // Make one legacy path exist
      mockExistsSync.mockImplementation((p: string) =>
        p.includes("policies.json"),
      );
      store.logResolvedPaths("/some/project");
      expect(mockBuildResolvedConfigLogEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          legacyGlobalPolicyDetected: expect.any(Boolean),
          legacyProjectPolicyDetected: expect.any(Boolean),
          legacyExtensionConfigDetected: expect.any(Boolean),
        }),
      );
    });

    it("does not check project legacy path when no cwd is provided", () => {
      const { store } = makeStore();
      store.logResolvedPaths(); // no cwd
      // existsSync called for global and ext-config legacy paths only (not project)
      const calls = mockExistsSync.mock.calls.map(([p]: [string]) => p);
      const projectCalls = calls.filter(
        (p) => p.includes("/null/") || p.includes("null"),
      );
      expect(projectCalls).toHaveLength(0);
    });
  });
});
