import { describe, it, expect, afterAll } from "vitest";
import { ConflictResolver } from "../../src/sync/conflict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("ConflictResolver", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-test-"));
  const logPath = path.join(tmpDir, "sync-log.json");
  const resolver = new ConflictResolver(tmpDir, logPath);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("detects conflict when both sides changed", () => {
    const entry = {
      path: "notes/test.md",
      localMtime: 2000,
      remoteMtime: 2000,
      lastSyncedMtime: 1000,
      size: 100,
      hash: "abc",
    };

    const isConflict = resolver.detectConflict(entry, {
      localMtime: 2000,
      remoteMtime: 3000,
    });

    expect(isConflict).toBe(true);
  });

  it("no conflict when only remote changed", () => {
    const entry = {
      path: "notes/test.md",
      localMtime: 1000,
      remoteMtime: 1000,
      lastSyncedMtime: 1000,
      size: 100,
      hash: "abc",
    };

    const isConflict = resolver.detectConflict(entry, {
      localMtime: 1000,
      remoteMtime: 3000,
    });

    expect(isConflict).toBe(false);
  });

  it("no conflict when only local changed", () => {
    const entry = {
      path: "notes/test.md",
      localMtime: 3000,
      remoteMtime: 1000,
      lastSyncedMtime: 1000,
      size: 100,
      hash: "abc",
    };

    const isConflict = resolver.detectConflict(entry, {
      localMtime: 3000,
      remoteMtime: 1000,
    });

    expect(isConflict).toBe(false);
  });

  it("resolves conflict with newer winning", () => {
    const testFile = path.join(tmpDir, "notes", "test.md");
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    fs.writeFileSync(testFile, "local content");

    const conflict = resolver.resolveConflict({
      localPath: testFile,
      localMtime: 1000,
      remoteMtime: 2000,
      winner: "remote",
      backupPath: "",
      timestamp: Date.now(),
    }, "remote content updated");

    expect(conflict.backupPath).toMatch(/notes\/test\.\d{8}T\d{6}\.md$/);
    expect(fs.existsSync(conflict.backupPath)).toBe(true);
    expect(fs.readFileSync(conflict.backupPath, "utf-8")).toBe("local content");
    expect(fs.readFileSync(testFile, "utf-8")).toBe("remote content updated");
  });

  it("logs conflicts", () => {
    const logs = resolver.getLogs();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].type).toBe("conflict");
  });
});
