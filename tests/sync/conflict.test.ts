import { describe, it, expect, afterAll } from "vitest";
import { ConflictResolver } from "../../src/sync/conflict";
import { SyncLog } from "../../src/sync/sync-log";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("ConflictResolver", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-test-"));
  const logPath = path.join(tmpDir, "sync-log.json");
  const syncLog = new SyncLog(logPath);
  const resolver = new ConflictResolver(tmpDir, syncLog);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("resolves conflict with newer winning", async () => {
    const testFile = path.join(tmpDir, "notes", "test.md");
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    fs.writeFileSync(testFile, "local content");

    const conflict = await resolver.resolveConflict({
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

  it("logs conflicts to sync log", () => {
    const logs = syncLog.getEntries();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].type).toBe("conflict");
  });
});
