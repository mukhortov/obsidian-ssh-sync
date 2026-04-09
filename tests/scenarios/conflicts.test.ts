import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  decidePullAction,
  resolveConflictWinner,
  createInitialState,
} from "../../src/sync/coordinator";
import { ConflictResolver } from "../../src/sync/conflict";
import { DEFAULT_CONFIG, SyncConfig } from "../../src/types";
import { makeManifestEntry, findEffect, filterEffects } from "../helpers/test-env";

const config: SyncConfig = { ...DEFAULT_CONFIG, enabled: true, sshHost: "user@host", remotePath: "/remote" };

describe("Conflicts", () => {
  describe("C1: Both sides modify same file", () => {
    it("detects conflict with remote-wins policy", () => {
      const remoteWinsConfig = { ...config, conflictPolicy: "remote-wins" as const };
      const manifest = {
        "shared.md": makeManifestEntry("shared.md", { lastSyncedMtime: 1000 }),
      };
      const localMtimes = new Map([["shared.md", 2000]]);

      const decision = decidePullAction(
        createInitialState(true),
        { changedFiles: ["shared.md"], deletedFiles: [] },
        manifest,
        remoteWinsConfig,
        new Set(),
        localMtimes
      );
      const conflict = findEffect(decision.effects, "resolveConflict");
      expect(conflict).toBeDefined();
      expect(conflict!.policy).toBe("remote-wins");
    });

    it("detects conflict with local-wins policy", () => {
      const localWinsConfig = { ...config, conflictPolicy: "local-wins" as const };
      const manifest = {
        "shared.md": makeManifestEntry("shared.md", { lastSyncedMtime: 1000 }),
      };
      const localMtimes = new Map([["shared.md", 2000]]);

      const decision = decidePullAction(
        createInitialState(true),
        { changedFiles: ["shared.md"], deletedFiles: [] },
        manifest,
        localWinsConfig,
        new Set(),
        localMtimes
      );
      const conflict = findEffect(decision.effects, "resolveConflict");
      expect(conflict).toBeDefined();
      expect(conflict!.policy).toBe("local-wins");
    });

    it("detects conflict with newest-wins policy", () => {
      const newestWinsConfig = { ...config, conflictPolicy: "newest-wins" as const };
      const manifest = {
        "shared.md": makeManifestEntry("shared.md", { lastSyncedMtime: 1000 }),
      };
      const localMtimes = new Map([["shared.md", 2000]]);

      const decision = decidePullAction(
        createInitialState(true),
        { changedFiles: ["shared.md"], deletedFiles: [] },
        manifest,
        newestWinsConfig,
        new Set(),
        localMtimes
      );
      const conflict = findEffect(decision.effects, "resolveConflict");
      expect(conflict).toBeDefined();
      expect(conflict!.policy).toBe("newest-wins");
    });

    it("resolveConflictWinner respects each policy", () => {
      expect(resolveConflictWinner("remote-wins", 2000, 1000)).toBe("remote");
      expect(resolveConflictWinner("local-wins", 1000, 2000)).toBe("local");
      expect(resolveConflictWinner("newest-wins", 2000, 1000)).toBe("local");
      expect(resolveConflictWinner("newest-wins", 1000, 2000)).toBe("remote");
    });
  });

  describe("C2: Local edit + remote delete", () => {
    it("preserves locally modified file and pushes back to remote", () => {
      const manifest = {
        "edited.md": makeManifestEntry("edited.md", { lastSyncedMtime: 1000 }),
      };
      const localMtimes = new Map([["edited.md", 2000]]); // locally modified

      const decision = decidePullAction(
        createInitialState(true),
        { changedFiles: [], deletedFiles: ["edited.md"] },
        manifest,
        config,
        new Set(),
        localMtimes
      );

      // File NOT deleted locally
      expect(decision.effects.some((e) => e.type === "deleteLocalFiles")).toBe(false);
      // File preserved and pushed back
      expect(decision.effects.some((e) => e.type === "preserveLocalFile")).toBe(true);
      expect(decision.effects.some((e) => e.type === "pushFile")).toBe(true);
      // Logged as conflict
      const logEffects = filterEffects(decision.effects, "log");
      const logEffect = logEffects.find((e) => e.entry.type === "conflict");
      expect(logEffect).toBeDefined();
      expect(logEffect!.entry.message).toContain("local edit wins");
    });
  });

  describe("C3: Local delete + remote edit", () => {
    it("pulls remote version to restore file", () => {
      // File deleted locally — no manifest entry, no localMtime
      const decision = decidePullAction(
        createInitialState(true),
        { changedFiles: ["restored.md"], deletedFiles: [] },
        {}, // no manifest entry — was cleaned up by deleteRemoteFile
        config,
        new Set(),
        new Map() // file doesn't exist locally
      );

      expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
      const logEffects = filterEffects(decision.effects, "log");
      const logEffect = logEffects.find((e) => e.entry.type === "conflict");
      expect(logEffect).toBeDefined();
      expect(logEffect!.entry.message).toContain("restored");
    });
  });

  describe("C4: Conflict backup file naming", () => {
    it("creates backup with timestamp format", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-test-"));
      const testFile = path.join(tmpDir, "meeting.md");
      fs.writeFileSync(testFile, "local content");

      const resolver = new ConflictResolver(tmpDir, path.join(tmpDir, "log.json"));
      const resolved = resolver.resolveConflict(
        {
          localPath: testFile,
          localMtime: 2000,
          remoteMtime: 3000,
          winner: "remote",
          backupPath: "",
          timestamp: Date.now(),
        },
        "remote content"
      );

      // Backup file exists with timestamp pattern
      expect(resolved.backupPath).toMatch(/meeting\.\d{8}T\d{6}\.md$/);
      expect(fs.existsSync(resolved.backupPath)).toBe(true);
      expect(fs.readFileSync(resolved.backupPath, "utf-8")).toBe("local content");
      // Original file has winner content
      expect(fs.readFileSync(testFile, "utf-8")).toBe("remote content");

      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe("C5: Conflict appears in sync log", () => {
    it("creates log entry with type conflict", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-log-test-"));
      const testFile = path.join(tmpDir, "test.md");
      fs.writeFileSync(testFile, "content");

      const resolver = new ConflictResolver(tmpDir, path.join(tmpDir, "log.json"));
      resolver.resolveConflict(
        {
          localPath: testFile,
          localMtime: 2000,
          remoteMtime: 3000,
          winner: "remote",
          backupPath: "",
          timestamp: Date.now(),
        },
        "remote content"
      );

      const logs = resolver.getLogs();
      expect(logs.length).toBeGreaterThan(0);
      const conflictLog = logs.find((l) => l.type === "conflict");
      expect(conflictLog).toBeDefined();
      expect(conflictLog!.message).toContain("remote won");
      expect(conflictLog!.path).toBe(testFile);

      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe("C6: Conflict with binary file", () => {
    it("backs up original binary and writes new content", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-binary-test-"));
      const testFile = path.join(tmpDir, "image.png");
      const originalBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      fs.writeFileSync(testFile, originalBinary);

      const resolver = new ConflictResolver(tmpDir, path.join(tmpDir, "log.json"));
      const newContent = "remote binary replacement";
      const resolved = resolver.resolveConflict(
        {
          localPath: testFile,
          localMtime: 2000,
          remoteMtime: 3000,
          winner: "remote",
          backupPath: "",
          timestamp: Date.now(),
        },
        newContent
      );

      // Backup exists and contains original binary content
      expect(fs.existsSync(resolved.backupPath)).toBe(true);
      const backupContent = fs.readFileSync(resolved.backupPath);
      expect(Buffer.compare(backupContent, originalBinary)).toBe(0);

      // Original file has new content
      expect(fs.readFileSync(testFile, "utf-8")).toBe(newContent);

      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe("C7: Multiple conflicts in single poll", () => {
    it("produces a resolveConflict effect for each conflicting file", () => {
      const manifest = {
        "a.md": makeManifestEntry("a.md", { lastSyncedMtime: 1000 }),
        "b.md": makeManifestEntry("b.md", { lastSyncedMtime: 1000 }),
        "c.md": makeManifestEntry("c.md", { lastSyncedMtime: 1000 }),
      };
      const localMtimes = new Map([
        ["a.md", 2000],
        ["b.md", 2000],
        ["c.md", 2000],
      ]);

      const decision = decidePullAction(
        createInitialState(true),
        { changedFiles: ["a.md", "b.md", "c.md"], deletedFiles: [] },
        manifest,
        config,
        new Set(),
        localMtimes
      );

      const conflictEffects = filterEffects(decision.effects, "resolveConflict");
      expect(conflictEffects).toHaveLength(3);

      const conflictFiles = conflictEffects.map((e) => e.file);
      expect(conflictFiles).toContain("a.md");
      expect(conflictFiles).toContain("b.md");
      expect(conflictFiles).toContain("c.md");

      // Each has the correct policy from config
      for (const effect of conflictEffects) {
        expect(effect.policy).toBe(config.conflictPolicy);
      }
    });
  });

  describe("C8: Conflict on file renamed locally", () => {
    it("pulls renamed file cleanly when no local edit since push", () => {
      // After local rename: new-name.md exists in manifest, lastSyncedMtime matches localMtime
      const manifest = {
        "new-name.md": makeManifestEntry("new-name.md", { lastSyncedMtime: 1000 }),
      };
      const localMtimes = new Map([["new-name.md", 1000]]); // no local edit since push

      const decision = decidePullAction(
        createInitialState(true),
        { changedFiles: ["new-name.md"], deletedFiles: [] },
        manifest,
        config,
        new Set(),
        localMtimes
      );

      // Clean pull, no conflict
      expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
      expect(decision.effects.some((e) => e.type === "resolveConflict")).toBe(false);
    });

    it("treats old name appearing in changedFiles with no manifest entry as restored file", () => {
      // old-name.md no longer in manifest (removed by deleteRemoteFile),
      // but somehow appears in changedFiles — treated as new file from remote (C3-like)
      const manifest = {};
      const localMtimes = new Map(); // file doesn't exist locally

      const decision = decidePullAction(
        createInitialState(true),
        { changedFiles: ["old-name.md"], deletedFiles: [] },
        manifest,
        config,
        new Set(),
        localMtimes
      );

      // Clean pull — restoration
      expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
      expect(decision.effects.some((e) => e.type === "resolveConflict")).toBe(false);

      // Logged as conflict restoration
      const logEffects = filterEffects(decision.effects, "log");
      const logEffect = logEffects.find((e) => e.entry.type === "conflict");
      expect(logEffect).toBeDefined();
      expect(logEffect!.entry.message).toContain("restored");
    });
  });
});
