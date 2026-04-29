import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncOrchestrator, Platform } from "../../src/sync/orchestrator";
import { SyncEngine } from "../../src/sync/engine";
import { FileWatcher } from "../../src/sync/watcher";
import { Poller } from "../../src/sync/poller";
import { SyncConfig, SyncStatus, DEFAULT_CONFIG } from "../../src/types";

// --- Fakes ---

class FakePlatform implements Platform {
  notifications: string[] = [];
  statusUpdates: SyncStatus[] = [];
  vaultPath = "/fake/vault";

  notify(message: string): void {
    this.notifications.push(message);
  }
  updateStatus(status: SyncStatus): void {
    this.statusUpdates.push(status);
  }
  getVaultPath(): string {
    return this.vaultPath;
  }
}

function createMockEngine(): SyncEngine {
  return {
    pushFile: vi.fn().mockResolvedValue({ success: true }),
    pushAll: vi.fn().mockResolvedValue({ success: true, changedFiles: [], conflicts: 0 }),
    pushAllWithoutDelete: vi.fn().mockResolvedValue({ success: true, changedFiles: [], conflicts: 0 }),
    pull: vi.fn().mockResolvedValue({ success: true, changedFiles: [], conflicts: 0 }),
    pullWithoutDelete: vi.fn().mockResolvedValue({ success: true, changedFiles: [], conflicts: 0 }),
    fullSync: vi.fn().mockResolvedValue({ success: true, changedFiles: ["a.md"], conflicts: 0 }),
    deleteRemoteFile: vi.fn().mockResolvedValue({ success: true }),
    deleteLocalFiles: vi.fn().mockResolvedValue([]),
    detectRemoteChanges: vi.fn().mockResolvedValue({ changedFiles: [], deletedFiles: [] }),
    resolveConflict: vi.fn().mockResolvedValue(undefined),
    appendLog: vi.fn().mockResolvedValue(undefined),
    getManifestEntries: vi.fn().mockReturnValue({}),
    getSyncLogEntries: vi.fn().mockReturnValue([]),
    getLocalMtimes: vi.fn().mockResolvedValue(new Map()),
    statRemoteFiles: vi.fn().mockResolvedValue(new Map()),
    _manifest: { setEntry: vi.fn(), getEntry: vi.fn(), save: vi.fn().mockResolvedValue(undefined) },
    ensureRemoteDir: vi.fn().mockResolvedValue(true),
    testConnection: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as SyncEngine;
}

function createTestOrchestrator(overrides?: {
  config?: Partial<SyncConfig>;
  engine?: SyncEngine;
}) {
  const platform = new FakePlatform();
  const engine = overrides?.engine ?? createMockEngine();
  const watcher = new FileWatcher(500, vi.fn());
  const poller = new Poller(vi.fn(), 60000);
  const config: SyncConfig = { ...DEFAULT_CONFIG, enabled: true, ...overrides?.config };

  const orchestrator = new SyncOrchestrator(
    engine,
    watcher,
    poller,
    platform,
    () => config
  );

  return { orchestrator, engine, platform, watcher, poller, config };
}

// --- Tests ---

describe("SyncOrchestrator", () => {
  describe("manualSync", () => {
    it("calls fullSync and notifies on success", async () => {
      const { orchestrator, engine, platform } = createTestOrchestrator();
      await orchestrator.manualSync();

      expect(engine.fullSync).toHaveBeenCalledOnce();
      expect(platform.notifications).toContain("SSH Sync: Starting full sync...");
      expect(platform.notifications.some((n) => n.includes("Complete"))).toBe(true);
      expect(platform.statusUpdates).toContain("syncing");
      expect(platform.statusUpdates).toContain("idle");
    });

    it("notifies on fullSync failure", async () => {
      const engine = createMockEngine();
      vi.mocked(engine.fullSync).mockResolvedValue({
        success: false,
        changedFiles: [],
        conflicts: 0,
        error: "Connection refused",
      });
      const { orchestrator, platform } = createTestOrchestrator({ engine });
      await orchestrator.manualSync();

      expect(platform.notifications.some((n) => n.includes("Failed"))).toBe(true);
      expect(platform.statusUpdates).toContain("error");
    });

    it("flushes pending watcher changes before fullSync", async () => {
      const engine = createMockEngine();
      const callOrder: string[] = [];

      vi.mocked(engine.deleteRemoteFile).mockImplementation(async () => {
        callOrder.push("deleteRemoteFile");
        return { success: true };
      });
      vi.mocked(engine.fullSync).mockImplementation(async () => {
        callOrder.push("fullSync");
        return { success: true, changedFiles: [], conflicts: 0 };
      });

      const { orchestrator, watcher } = createTestOrchestrator({ engine });

      // Simulate pending delete (folder contents deleted)
      watcher.onFileDeleted("Notes/file.md");

      // manualSync should flush the pending delete BEFORE running fullSync
      await orchestrator.manualSync();

      expect(callOrder.indexOf("deleteRemoteFile")).toBeLessThan(
        callOrder.indexOf("fullSync")
      );
      expect(engine.deleteRemoteFile).toHaveBeenCalledWith("Notes/file.md");
    });
  });

  describe("handleFlush", () => {
    it("pushes changed files and deletes remote files", async () => {
      const { orchestrator, engine, platform } = createTestOrchestrator();
      await orchestrator.handleFlush({
        changedFiles: new Set(["a.md", "b.md"]),
        deletedFiles: new Set(["c.md"]),
      });

      expect(engine.pushFile).toHaveBeenCalledWith("a.md");
      expect(engine.pushFile).toHaveBeenCalledWith("b.md");
      expect(engine.deleteRemoteFile).toHaveBeenCalledWith("c.md");
      expect(platform.statusUpdates).toContain("syncing");
      expect(platform.statusUpdates).toContain("idle");
    });

    it("does nothing when disabled", async () => {
      const { orchestrator, engine } = createTestOrchestrator({
        config: { enabled: false },
      });
      await orchestrator.handleFlush({
        changedFiles: new Set(["a.md"]),
        deletedFiles: new Set(),
      });

      expect(engine.pushFile).not.toHaveBeenCalled();
    });

    it("notifies on push failure", async () => {
      const engine = createMockEngine();
      vi.mocked(engine.pushFile).mockResolvedValue({
        success: false,
        error: "Permission denied",
      });
      const { orchestrator, platform } = createTestOrchestrator({ engine });
      await orchestrator.handleFlush({
        changedFiles: new Set(["a.md"]),
        deletedFiles: new Set(),
      });

      expect(platform.notifications.some((n) => n.includes("Sync failed"))).toBe(true);
    });
  });

  describe("syncFile", () => {
    it("pushes a single file and notifies on success", async () => {
      const { orchestrator, engine, platform } = createTestOrchestrator();
      await orchestrator.syncFile("notes/test.md");

      expect(engine.pushFile).toHaveBeenCalledWith("notes/test.md");
      expect(platform.notifications.some((n) => n.includes("Pushed notes/test.md"))).toBe(true);
      expect(platform.statusUpdates).toContain("idle");
    });

    it("notifies on push failure", async () => {
      const engine = createMockEngine();
      vi.mocked(engine.pushFile).mockResolvedValue({
        success: false,
        error: "File not found",
      });
      const { orchestrator, platform } = createTestOrchestrator({ engine });
      await orchestrator.syncFile("notes/missing.md");

      expect(platform.notifications.some((n) => n.includes("Failed to push"))).toBe(true);
      expect(platform.statusUpdates).toContain("error");
    });
  });

  describe("toggle", () => {
    it("enables sync: starts poller and notifies", async () => {
      const { orchestrator, platform, poller } = createTestOrchestrator({
        config: { enabled: false },
      });
      const startSpy = vi.spyOn(poller, "start");
      await orchestrator.toggle();

      expect(platform.statusUpdates).toContain("idle");
      expect(platform.notifications).toContain("SSH Sync enabled");
      expect(startSpy).toHaveBeenCalled();
    });

    it("disables sync: stops poller and notifies", async () => {
      const { orchestrator, platform, poller } = createTestOrchestrator({
        config: { enabled: true },
      });
      const stopSpy = vi.spyOn(poller, "stop");
      await orchestrator.toggle();

      expect(platform.statusUpdates).toContain("disabled");
      expect(platform.notifications).toContain("SSH Sync disabled");
      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe("pollRemoteChanges", () => {
    it("skips poll when watcher has pending changes", async () => {
      const { orchestrator, engine, watcher } = createTestOrchestrator();
      // Simulate pending changes
      watcher.onFileChange("pending.md");

      await orchestrator.pollRemoteChanges();

      expect(engine.detectRemoteChanges).not.toHaveBeenCalled();
    });

    it("detects remote changes and pulls when no pending", async () => {
      const engine = createMockEngine();
      vi.mocked(engine.detectRemoteChanges).mockResolvedValue({
        changedFiles: ["remote-new.md"],
        deletedFiles: [],
      });
      const { orchestrator, platform } = createTestOrchestrator({ engine });

      await orchestrator.pollRemoteChanges();

      expect(engine.detectRemoteChanges).toHaveBeenCalled();
      expect(engine.pullWithoutDelete).toHaveBeenCalled();
      expect(platform.statusUpdates).toContain("syncing");
    });

    it("returns to idle when no remote changes", async () => {
      const { orchestrator, platform, engine } = createTestOrchestrator();
      await orchestrator.pollRemoteChanges();

      expect(engine.detectRemoteChanges).toHaveBeenCalled();
      expect(platform.statusUpdates).toContain("idle");
    });
  });

  describe("getSyncLogs", () => {
    it("delegates to engine", () => {
      const engine = createMockEngine();
      const entries = [{ timestamp: 1, type: "push" as const, path: "a.md", message: "ok" }];
      vi.mocked(engine.getSyncLogEntries).mockReturnValue(entries);
      const { orchestrator } = createTestOrchestrator({ engine });

      expect(orchestrator.getSyncLogs()).toEqual(entries);
    });
  });

  describe("dispose", () => {
    it("disposes watcher and stops poller", () => {
      const { orchestrator, watcher, poller } = createTestOrchestrator();
      const disposeSpy = vi.spyOn(watcher, "dispose");
      const stopSpy = vi.spyOn(poller, "stop");

      orchestrator.dispose();

      expect(disposeSpy).toHaveBeenCalled();
      expect(stopSpy).toHaveBeenCalled();
    });
  });
});
