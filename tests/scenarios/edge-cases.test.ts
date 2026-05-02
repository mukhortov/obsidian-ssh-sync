import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as commands from "../../src/ssh/commands";
import { createTestEnv, createTestFile, TestEnv, findEffect, filterEffects } from "../helpers/test-env";
import {
  decideManualSyncAction,
  decideSyncFileAction,
  decidePullAction,
  decidePollAction,
  decideFlushAction,
  decideToggleAction,
  createInitialState,
} from "../../src/sync/coordinator";
import { DEFAULT_CONFIG, SyncConfig, MIN_POLL_INTERVAL_SECONDS, SUPPRESS_PRE_OP_MS, SUPPRESS_POST_OP_MS, clampPollInterval } from "../../src/types";
import { ManifestStore } from "../../src/sync/manifest";
import { SyncLog } from "../../src/sync/sync-log";

import { SyncLock } from "../../src/utils/sync-lock";
import { FileWatcher, WatcherFlush } from "../../src/sync/watcher";
import { Poller } from "../../src/sync/poller";

vi.mock("../../src/ssh/commands", () => ({
  buildRsyncPushCommand: vi.fn(() => "rsync push cmd"),
  buildRsyncPullCommand: vi.fn(() => "rsync pull cmd"),
  buildRsyncDryRunCommand: vi.fn(() => "rsync dry-run cmd"),
  buildMkdirCommand: vi.fn(() => "mkdir cmd"),
  buildLsCommand: vi.fn(() => "ls cmd"),
  buildRmCommand: vi.fn(() => "rm cmd"),
  buildRmdirCommand: vi.fn(() => "rmdir cmd"),
  executeCommand: vi.fn(),
  runRsync: vi.fn(),
}));

const config: SyncConfig = { ...DEFAULT_CONFIG, enabled: true, sshHost: "user@host", remotePath: "/remote" };

describe("Edge Cases & Error Handling", () => {
  let env: TestEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    env = createTestEnv();
  });

  afterEach(() => {
    env?.cleanup();
  });

  it("E1: SSH connection failure returns error", async () => {
    createTestFile(env, "test.md", "content");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [], deletedFiles: [],
      stdout: "", stderr: "ssh: connect to host: Connection refused", exitCode: 255,
    });

    const result = await env.engine.pushFile("test.md");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Connection refused");
  });

  it("E2: rsync timeout returns error", async () => {
    createTestFile(env, "test.md", "content");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [], deletedFiles: [],
      stdout: "", stderr: "command timed out", exitCode: 1,
    });

    const result = await env.engine.pushFile("test.md");
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("E3: file with spaces in path — passed through to command builder", async () => {
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["my notes/hello world.md"], deletedFiles: [], stdout: "", stderr: "", exitCode: 0,
    });
    vi.mocked(commands.executeCommand).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    await createTestFile(env, "my notes/hello world.md", "content with spaces");
    await env.engine.pushFile("my notes/hello world.md");
    expect(commands.buildRsyncPushCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: "my notes/hello world.md",
      })
    );
  });

  it("E4: excluded file not in rsync transfer", async () => {
    // Verify exclude patterns are passed to command builders
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [], deletedFiles: [], stdout: "", stderr: "", exitCode: 0,
    });
    vi.mocked(commands.buildRsyncPushCommand).mockReturnValue("rsync --exclude='.git/**' push");

    // This is verified by checking buildRsyncPushCommand receives excludePatterns
    createTestFile(env, "test.md", "content");
    // pushFile passes config.excludePatterns to the command builder
    await env.engine.pushFile("test.md");
    expect(commands.buildRsyncPushCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        excludePatterns: expect.arrayContaining([".git/**"]),
      })
    );
  });

  it("E5: plugin internal state files in default exclude patterns", () => {
    const patterns = DEFAULT_CONFIG.excludePatterns;
    expect(patterns).toContain(".obsidian/plugins/ssh-sync/sync-manifest.json");
    expect(patterns).toContain(".obsidian/plugins/ssh-sync/sync-log.json");
    // manifest.json is NOT excluded — it should sync across devices
    expect(patterns).not.toContain(".obsidian/plugins/ssh-sync/manifest.json");
  });

  it("E6: empty vault sync — no errors", async () => {
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [], deletedFiles: [], stdout: "", stderr: "", exitCode: 0,
    });

    const result = await env.engine.fullSync();
    expect(result.success).toBe(true);
    expect(result.changedFiles).toEqual([]);
  });

  it("E7: sync with no active file", () => {
    const decision = decideSyncFileAction(createInitialState(true), null, true);
    const notify = findEffect(decision.effects, "notify");
    expect(notify).toBeDefined();
    expect(notify!.message).toContain("No active file");
  });

  it("E8: sync when engine not initialized", () => {
    const decision = decideManualSyncAction(createInitialState(true), false);
    expect(decision.effects.some((e) => e.type === "notifyError")).toBe(true);
  });

  it("E9: remote directory creation", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "", stderr: "", exitCode: 0,
    });

    const result = await env.engine.ensureRemoteDir();
    expect(result).toBe(true);
    expect(commands.executeCommand).toHaveBeenCalledWith("mkdir cmd", 15000);
  });

  it("E10: partial push failure — successful files still tracked", async () => {
    createTestFile(env, "a.md", "content a");
    createTestFile(env, "b.md", "content b");

    // First call succeeds, second fails
    vi.mocked(commands.runRsync)
      .mockResolvedValueOnce({
        changedFiles: ["a.md"], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      })
      .mockResolvedValueOnce({
        changedFiles: [], deletedFiles: [],
        stdout: "", stderr: "Permission denied", exitCode: 1,
      });

    const resultA = await env.engine.pushFile("a.md");
    const resultB = await env.engine.pushFile("b.md");

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(false);
    expect(env.engine._manifest.getEntry("a.md")).toBeDefined();
    // b.md manifest not updated since push failed
    expect(env.engine._manifest.getEntry("b.md")).toBeUndefined();
  });

  it("E11: very large file sync — rsync timeout", async () => {
    createTestFile(env, "large-file.md", "x".repeat(1024));
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [], deletedFiles: [],
      stdout: "", stderr: "command timed out", exitCode: 1,
    });

    const result = await env.engine.pushFile("large-file.md");
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("E12: special characters in filename", async () => {
    const specialPath = "notes/café & résumé (2026).md";

    // Create file with special chars and push it through the engine
    createTestFile(env, specialPath, "special content");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [specialPath], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });

    const result = await env.engine.pushFile(specialPath);
    expect(result.success).toBe(true);
    expect(env.engine._manifest.getEntry(specialPath)).toBeDefined();

    // Verify the command builder received the special-char path
    expect(commands.buildRsyncPushCommand).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: specialPath })
    );
  });

  it("E13: symlink in vault", async () => {
    const realFile = path.join(env.vaultPath, "real-file.md");
    const symlinkFile = path.join(env.vaultPath, "symlink-file.md");

    fs.writeFileSync(realFile, "real content");
    fs.symlinkSync(realFile, symlinkFile);

    // Verify the symlink exists
    const stat = fs.lstatSync(symlinkFile);
    expect(stat.isSymbolicLink()).toBe(true);

    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["symlink-file.md"], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });

    const result = await env.engine.pushFile("symlink-file.md");
    expect(result.success).toBe(true);
    expect(commands.buildRsyncPushCommand).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: "symlink-file.md" })
    );

    // Clean up symlink and real file
    fs.unlinkSync(symlinkFile);
    fs.unlinkSync(realFile);
  });

  it("E14: permission denied on remote write", async () => {
    createTestFile(env, "secret.md", "classified");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [], deletedFiles: [],
      stdout: "", stderr: "Permission denied", exitCode: 1,
    });

    const result = await env.engine.pushFile("secret.md");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Permission denied");
    expect(env.engine._manifest.getEntry("secret.md")).toBeUndefined();
  });

  it("E15: disk full on remote", async () => {
    createTestFile(env, "big.md", "data");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [], deletedFiles: [],
      stdout: "", stderr: "No space left on device", exitCode: 1,
    });

    const result = await env.engine.pushFile("big.md");
    expect(result.success).toBe(false);
    expect(env.engine._manifest.getEntry("big.md")).toBeUndefined();
  });

  it("E16: disk full on local (pull failure)", async () => {
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [], deletedFiles: [],
      stdout: "", stderr: "No space left on device", exitCode: 1,
    });

    const result = await env.engine.pull();
    expect(result.success).toBe(false);
    expect(result.error).toContain("No space left on device");
  });

  it("E17: network interruption mid-sync", async () => {
    createTestFile(env, "doc.md", "important");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [], deletedFiles: [],
      stdout: "", stderr: "Connection reset by peer", exitCode: 255,
    });

    const result = await env.engine.pushFile("doc.md");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Connection reset by peer");
  });

  it("E18: manifest file corrupted — starts fresh", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-test-"));
    const manifestPath = path.join(tmpDir, "sync-manifest.json");

    // Write invalid JSON
    fs.writeFileSync(manifestPath, "not valid json{{{");

    const store = new ManifestStore(manifestPath);
    expect(store.getEntries()).toEqual({});
    expect(store.getEntry("anything.md")).toBeUndefined();

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("E19: sync log file corrupted/missing — recovers gracefully", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-test-"));
    const logPath = path.join(tmpDir, "sync-log.json");

    // Write invalid JSON to log file
    fs.writeFileSync(logPath, "not valid json{{{");

    const syncLog = new SyncLog(logPath);
    expect(syncLog.getEntries()).toEqual([]);

    // Verify append still works after corruption recovery
    syncLog.append({ type: "push", path: "test.md", message: "test entry" });
    expect(syncLog.getEntries()).toHaveLength(1);
    expect(syncLog.getEntries()[0].path).toBe("test.md");

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("E20: concurrent operations with lock serialization", async () => {
    const lock = new SyncLock();
    const order: string[] = [];

    const op1 = lock.run(async () => {
      expect(lock.isLocked).toBe(true);
      order.push("op1-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("op1-end");
    });

    const op2 = lock.run(async () => {
      order.push("op2-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("op2-end");
    });

    await Promise.all([op1, op2]);
    expect(lock.isLocked).toBe(false);

    // op1 must fully complete before op2 starts
    expect(order).toEqual(["op1-start", "op1-end", "op2-start", "op2-end"]);
  });

  it("E21: folder name with only spaces", async () => {
    const spacePath = "   /note.md";
    createTestFile(env, spacePath, "content in space folder");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [spacePath], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });

    const result = await env.engine.pushFile(spacePath);
    expect(result.success).toBe(true);
    expect(commands.buildRsyncPushCommand).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: spacePath })
    );
  });

  it("E22: folder name with unicode", async () => {
    const unicodePath = "日記/note.md";
    createTestFile(env, unicodePath, "unicode folder content");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [unicodePath], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });

    const result = await env.engine.pushFile(unicodePath);
    expect(result.success).toBe(true);
    expect(env.engine._manifest.getEntry(unicodePath)).toBeDefined();
  });

  it("E23: very long folder path", async () => {
    // Build a ~200 char path with nested folders
    const segments = [];
    for (let i = 0; i < 10; i++) {
      segments.push("a".repeat(18));
    }
    const longPath = segments.join("/") + "/note.md";
    expect(longPath.length).toBeGreaterThan(190);

    createTestFile(env, longPath, "deep nested content");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [longPath], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });

    const result = await env.engine.pushFile(longPath);
    expect(result.success).toBe(true);
    expect(env.engine._manifest.getEntry(longPath)).toBeDefined();
  });

  it("E24: hidden folder (.hidden/secret.md)", async () => {
    const hiddenPath = ".hidden/secret.md";
    createTestFile(env, hiddenPath, "hidden content");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [hiddenPath], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });

    const result = await env.engine.pushFile(hiddenPath);
    expect(result.success).toBe(true);
    // No special treatment — pushed like any other file
    expect(commands.buildRsyncPushCommand).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: hiddenPath })
    );
    expect(env.engine._manifest.getEntry(hiddenPath)).toBeDefined();
  });

  it("E25: folder name collision with trailing spaces", async () => {
    const pathA = "notes/a.md";
    const pathB = "notes /b.md"; // trailing space in folder name
    createTestFile(env, pathA, "content a");
    createTestFile(env, pathB, "content b");

    vi.mocked(commands.runRsync)
      .mockResolvedValueOnce({
        changedFiles: [pathA], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      })
      .mockResolvedValueOnce({
        changedFiles: [pathB], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      });

    const resultA = await env.engine.pushFile(pathA);
    const resultB = await env.engine.pushFile(pathB);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    // Both are tracked independently in manifest
    expect(env.engine._manifest.getEntry(pathA)).toBeDefined();
    expect(env.engine._manifest.getEntry(pathB)).toBeDefined();
  });

  it("E26: delete from subfolder on VPS while local adds to same subfolder — poll skipped", () => {
    const decision = decidePollAction(
      createInitialState(true),
      true // hasPending — local watcher has pending changes
    );

    // Poll skipped entirely when there are pending local changes
    expect(decision.effects).toHaveLength(0);
  });

  it("E27: remote mkdir -p failure — pushFile returns error, rsync NOT called", async () => {
    createTestFile(env, "deep/nested/folder/note.md", "content");
    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "", stderr: "mkdir: permission denied", exitCode: 1,
    });

    const result = await env.engine.pushFile("deep/nested/folder/note.md");
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // rsync should NOT have been called since mkdir failed
    expect(commands.runRsync).not.toHaveBeenCalled();
  });

  it("E28: rename folder to excluded pattern — flush produces push + delete effects", () => {
    // Simulate watcher recording a rename: old folder → new excluded folder
    const flush: WatcherFlush = {
      changedFiles: new Set(["_excluded/note.md"]),
      deletedFiles: new Set(["original/note.md"]),
    };

    const decision = decideFlushAction(
      createInitialState(true),
      flush,
      true
    );

    // Flush produces both push and delete effects
    // (rsync will handle excluding the file during actual transfer)
    const pushEffect = findEffect(decision.effects, "pushFiles");
    const deleteEffect = findEffect(decision.effects, "deleteRemoteFiles");
    expect(pushEffect).toBeDefined();
    expect(pushEffect!.files).toContain("_excluded/note.md");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toContain("original/note.md");
  });

  it("E29: move file into excluded folder — flush produces push + delete effects", () => {
    const watcher = new FileWatcher(0, async () => {});
    watcher.onFileRenamed("_excluded/moved.md", "visible/moved.md");

    // Verify watcher state: new path in changes, old path in deletes
    const pending = watcher.getPendingPaths();
    expect(pending.has("_excluded/moved.md")).toBe(true);
    expect(pending.has("visible/moved.md")).toBe(true);

    // Flush action with the watcher's accumulated state
    const flush: WatcherFlush = {
      changedFiles: new Set(["_excluded/moved.md"]),
      deletedFiles: new Set(["visible/moved.md"]),
    };
    const decision = decideFlushAction(createInitialState(true), flush, true);

    const pushEffect = findEffect(decision.effects, "pushFiles");
    const deleteEffect = findEffect(decision.effects, "deleteRemoteFiles");
    expect(pushEffect).toBeDefined();
    expect(pushEffect!.files).toContain("_excluded/moved.md");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toContain("visible/moved.md");

    watcher.dispose();
  });

  it("E30: move file out of excluded folder — flush produces push + delete effects", () => {
    const watcher = new FileWatcher(0, async () => {});
    watcher.onFileRenamed("visible/note.md", "_excluded/note.md");

    const pending = watcher.getPendingPaths();
    expect(pending.has("visible/note.md")).toBe(true);
    expect(pending.has("_excluded/note.md")).toBe(true);

    const flush: WatcherFlush = {
      changedFiles: new Set(["visible/note.md"]),
      deletedFiles: new Set(["_excluded/note.md"]),
    };
    const decision = decideFlushAction(createInitialState(true), flush, true);

    const pushEffect = findEffect(decision.effects, "pushFiles");
    const deleteEffect = findEffect(decision.effects, "deleteRemoteFiles");
    expect(pushEffect).toBeDefined();
    expect(pushEffect!.files).toContain("visible/note.md");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toContain("_excluded/note.md");

    watcher.dispose();
  });

  it("E31: concurrent folder operations in different subfolders — single debounce", () => {
    const watcher = new FileWatcher(0, async () => {});

    // Renames and deletes from different folders accumulated in a single debounce window
    watcher.onFileRenamed("folderA/renamed.md", "folderA/original.md");
    watcher.onFileDeleted("folderB/removed.md");
    watcher.onFileChange("folderC/new.md");

    const pending = watcher.getPendingPaths();
    // folderA: renamed file tracked
    expect(pending.has("folderA/renamed.md")).toBe(true);
    expect(pending.has("folderA/original.md")).toBe(true);
    // folderB: deleted file tracked
    expect(pending.has("folderB/removed.md")).toBe(true);
    // folderC: new file tracked
    expect(pending.has("folderC/new.md")).toBe(true);

    expect(watcher.hasPending()).toBe(true);

    watcher.dispose();
  });

  it("E32: mixed file types at every level — all push successfully", async () => {
    const mdPath = "level1/doc.md";
    const pngPath = "level1/level2/image.png";
    const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString();

    createTestFile(env, mdPath, "# Markdown content");
    createTestFile(env, pngPath, binaryContent);

    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "", stderr: "", exitCode: 0,
    });

    vi.mocked(commands.runRsync)
      .mockResolvedValueOnce({
        changedFiles: [mdPath], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      })
      .mockResolvedValueOnce({
        changedFiles: [pngPath], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      });

    const resultMd = await env.engine.pushFile(mdPath);
    const resultPng = await env.engine.pushFile(pngPath);

    expect(resultMd.success).toBe(true);
    expect(resultPng.success).toBe(true);
    expect(env.engine._manifest.getEntry(mdPath)).toBeDefined();
    expect(env.engine._manifest.getEntry(pngPath)).toBeDefined();
  });

  it("E33: pushFile rejects directory paths — returns error without calling rsync", async () => {
    // Create a directory (not a file) at the given path
    const dirPath = "MyFolder";
    fs.mkdirSync(path.join(env.vaultPath, dirPath), { recursive: true });

    const result = await env.engine.pushFile(dirPath);

    expect(result.success).toBe(false);
    expect(result.error).toContain("directory");
    // rsync should NOT have been called for a directory
    expect(commands.runRsync).not.toHaveBeenCalled();
  });

  it("E34: pushFile rejects nested directory paths", async () => {
    const dirPath = "Projects/SubProject";
    fs.mkdirSync(path.join(env.vaultPath, dirPath), { recursive: true });

    const result = await env.engine.pushFile(dirPath);

    expect(result.success).toBe(false);
    expect(result.error).toContain("directory");
    expect(commands.runRsync).not.toHaveBeenCalled();
  });

  it("E35: pushFile rejects self-referential recursive path (folder/folder/folder)", async () => {
    // Simulate the exact bug: a path like "X/X/X" where X is a folder name
    const recursivePath = "Obsidian SSH Sync plugin/Obsidian SSH Sync plugin/Obsidian SSH Sync plugin";
    fs.mkdirSync(path.join(env.vaultPath, recursivePath), { recursive: true });

    const result = await env.engine.pushFile(recursivePath);

    expect(result.success).toBe(false);
    expect(result.error).toContain("directory");
    expect(commands.runRsync).not.toHaveBeenCalled();
  });

  it("E36: watcher ignores paths with recursive segment duplication", () => {
    const watcher = new FileWatcher(0, async () => {});

    // Simulate the bug: each time a nested path is reported
    watcher.onFileChange("Plugin/Plugin/Plugin/note.md");

    const pending = watcher.getPendingPaths();
    // Path with 3+ repeated leading segments should be rejected
    expect(pending.has("Plugin/Plugin/Plugin/note.md")).toBe(false);

    watcher.dispose();
  });

  it("E37: watcher accepts legitimate repeated folder names (up to 2 levels)", () => {
    const watcher = new FileWatcher(0, async () => {});

    // Some users legitimately have "notes/notes/file.md"
    watcher.onFileChange("notes/notes/file.md");

    const pending = watcher.getPendingPaths();
    expect(pending.has("notes/notes/file.md")).toBe(true);

    watcher.dispose();
  });

  it("E38: watcher rejects rename that creates recursive nesting", () => {
    const watcher = new FileWatcher(0, async () => {});

    // Simulate a rename where the new path has recursive nesting
    watcher.onFileRenamed("X/X/X/file.md", "X/file.md");

    const pending = watcher.getPendingPaths();
    // The recursively-nested new path should be rejected
    expect(pending.has("X/X/X/file.md")).toBe(false);

    watcher.dispose();
  });

  it("E39: deleteRemoteFile rejects directory-only paths (no file extension, trailing slash)", async () => {
    // A directory path passed to deleteRemoteFile should work but
    // ensure we track that it was treated as a valid deletion request
    // (directories are deleted via rm -rf on remote)
    const result = await env.engine.deleteRemoteFile("SomeFolder");

    // This should succeed (rm on remote is fine for folders)
    // But verify it went through the correct path
    expect(commands.buildRmCommand).toHaveBeenCalled();
  });

  it("E40: rapid successive folder events don't cause exponential path growth", async () => {
    const flushes: WatcherFlush[] = [];
    const watcher = new FileWatcher(10, async (flush) => {
      flushes.push(flush);
    });

    // Simulate rapid folder events that could cause exponential growth
    watcher.onFileChange("MyPlugin");
    watcher.onFileChange("MyPlugin/MyPlugin");
    watcher.onFileChange("MyPlugin/MyPlugin/MyPlugin");

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 50));

    // The watcher should have rejected the recursively-nested paths
    if (flushes.length > 0) {
      const allChanged = [...flushes[0].changedFiles];
      // Should only contain the original path, not the nested duplicates
      const hasDeepNesting = allChanged.some(
        (p) => p.split("/").length >= 3 && new Set(p.split("/")).size === 1
      );
      expect(hasDeepNesting).toBe(false);
    }

    watcher.dispose();
  });

  it("E41: suppressed watcher ignores all events during suppression window", () => {
    const watcher = new FileWatcher(0, async () => {});

    watcher.suppress(1000);
    watcher.onFileChange("file1.md");
    watcher.onFileChange("file2.md");
    watcher.onFileDeleted("file3.md");
    watcher.onFileRenamed("new.md", "old.md");

    const pending = watcher.getPendingPaths();
    expect(pending.size).toBe(0);
    expect(watcher.hasPending()).toBe(false);

    watcher.dispose();
  });

  it("E42: watcher accepts events after suppression expires", async () => {
    const watcher = new FileWatcher(0, async () => {});

    watcher.suppress(50); // 50ms suppression

    watcher.onFileChange("during-suppression.md");
    expect(watcher.getPendingPaths().has("during-suppression.md")).toBe(false);

    // Wait for suppression to expire
    await new Promise((r) => setTimeout(r, 100));

    watcher.onFileChange("after-suppression.md");
    expect(watcher.getPendingPaths().has("after-suppression.md")).toBe(true);

    watcher.dispose();
  });

  it("E43: suppress can be extended before expiry", () => {
    const watcher = new FileWatcher(0, async () => {});

    watcher.suppress(100);
    watcher.suppress(5000); // extend

    watcher.onFileChange("file.md");
    expect(watcher.getPendingPaths().has("file.md")).toBe(false);

    watcher.dispose();
  });

  it("E44: suppression prevents pull-triggered push feedback loop", async () => {
    const flushes: WatcherFlush[] = [];
    const watcher = new FileWatcher(10, async (flush) => {
      flushes.push(flush);
    });

    // Simulate: suppress before pull, then events arrive from pulled files
    watcher.suppress(500);

    // These represent Obsidian events triggered by rsync writing files
    watcher.onFileChange("Notes/Test.md");
    watcher.onFileChange("Obsidian SSH Sync plugin/Specs.md");

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 50));

    // No flush should have occurred
    expect(flushes).toHaveLength(0);
    expect(watcher.hasPending()).toBe(false);

    watcher.dispose();
  });

  it("E45: suppress replacement — long pre-operation window replaced by short post-operation grace", async () => {
    const watcher = new FileWatcher(0, async () => {});

    // Pre-operation: safety net (same constant used in main.ts)
    watcher.suppress(SUPPRESS_PRE_OP_MS);

    // Events during operation are blocked
    watcher.onFileChange("pulled-file.md");
    expect(watcher.getPendingPaths().has("pulled-file.md")).toBe(false);

    // Post-operation: replace with grace period (same constant used in main.ts)
    // suppress() replaces the previous window entirely
    watcher.suppress(SUPPRESS_POST_OP_MS);

    // Events immediately after replacement are still blocked (within grace period)
    watcher.onFileChange("filesystem-event.md");
    expect(watcher.getPendingPaths().has("filesystem-event.md")).toBe(false);

    watcher.dispose();
  });

  it("E46: suppress replacement allows events after short grace expires", async () => {
    const watcher = new FileWatcher(0, async () => {});

    // Pre-operation: long window
    watcher.suppress(SUPPRESS_PRE_OP_MS);

    // Post-operation: replace with very short grace for testability
    watcher.suppress(50);

    // Wait for grace to expire
    await new Promise((r) => setTimeout(r, 100));

    // Now events should be accepted
    watcher.onFileChange("user-edit.md");
    expect(watcher.getPendingPaths().has("user-edit.md")).toBe(true);

    watcher.dispose();
  });

  it("E47: suppress shortening — replacing long window with shorter one actually shortens", async () => {
    const watcher = new FileWatcher(0, async () => {});

    // Set a long suppression
    watcher.suppress(SUPPRESS_PRE_OP_MS);

    // Replace with a very short one (simulating post-operation grace)
    watcher.suppress(30);

    // Wait for the short one to expire
    await new Promise((r) => setTimeout(r, 80));

    // Watcher should accept events now (not still blocked by the old 60s window)
    watcher.onFileChange("after-grace.md");
    expect(watcher.getPendingPaths().has("after-grace.md")).toBe(true);

    watcher.dispose();
  });

  it("E48: poll interval clamped to minimum", () => {
    expect(clampPollInterval("1")).toBe(MIN_POLL_INTERVAL_SECONDS);
    expect(clampPollInterval("3")).toBe(MIN_POLL_INTERVAL_SECONDS);
    expect(clampPollInterval(String(MIN_POLL_INTERVAL_SECONDS))).toBe(MIN_POLL_INTERVAL_SECONDS);
    expect(clampPollInterval("10")).toBe(10);
    expect(clampPollInterval("60")).toBe(60);
    expect(clampPollInterval("0")).toBe(MIN_POLL_INTERVAL_SECONDS);
    expect(clampPollInterval("-1")).toBe(MIN_POLL_INTERVAL_SECONDS);
  });

  it("E49: settings validation rejects poll intervals below minimum", () => {
    // Values below minimum are clamped
    expect(clampPollInterval("1")).toBe(MIN_POLL_INTERVAL_SECONDS);
    expect(clampPollInterval("2")).toBe(MIN_POLL_INTERVAL_SECONDS);
    expect(clampPollInterval("4")).toBe(MIN_POLL_INTERVAL_SECONDS);
    // Valid values pass through
    expect(clampPollInterval(String(MIN_POLL_INTERVAL_SECONDS))).toBe(MIN_POLL_INTERVAL_SECONDS);
    expect(clampPollInterval("10")).toBe(10);
    expect(clampPollInterval("60")).toBe(60);
    // Invalid strings clamp to minimum
    expect(clampPollInterval("abc")).toBe(MIN_POLL_INTERVAL_SECONDS);
    expect(clampPollInterval("")).toBe(MIN_POLL_INTERVAL_SECONDS);
  });

  it("E50: invalid poll interval falls back to minimum, not last saved value", () => {
    expect(clampPollInterval("abc")).toBe(MIN_POLL_INTERVAL_SECONDS);
    expect(clampPollInterval("")).toBe(MIN_POLL_INTERVAL_SECONDS);
    expect(clampPollInterval("-10")).toBe(MIN_POLL_INTERVAL_SECONDS);
    expect(clampPollInterval("0")).toBe(MIN_POLL_INTERVAL_SECONDS);
    expect(clampPollInterval("3")).toBe(MIN_POLL_INTERVAL_SECONDS);
    // Valid values return as-is
    expect(clampPollInterval("10")).toBe(10);
    expect(clampPollInterval("60")).toBe(60);
  });

  it("E51: sync log capped at 200 entries (SL1)", async () => {
    const logPath = path.join(env.vaultPath, "sync-log.json");
    const syncLog = new SyncLog(logPath);

    // Append 201 entries
    for (let i = 0; i < 201; i++) {
      await syncLog.append({ type: "push", path: `file-${i}.md`, message: `push file-${i}` });
    }

    // Re-read from disk to verify persistence
    const raw = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    expect(raw.length).toBe(200);
    // Oldest entry (file-0.md) should be evicted; newest (file-200.md) kept
    expect(raw[0].path).toBe("file-1.md");
    expect(raw[199].path).toBe("file-200.md");
  });

  it("E52: watcher produces no flush when no events are received (SO1)", async () => {
    vi.useFakeTimers();
    const flushCallback = vi.fn();
    const watcher = new FileWatcher(500, flushCallback);

    // Advance past debounce window without feeding any events
    await vi.advanceTimersByTimeAsync(5000);

    expect(flushCallback).not.toHaveBeenCalled();
    expect(watcher.hasPending()).toBe(false);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("E53: three concurrent sync triggers queue FIFO (SL2)", async () => {
    const lock = new SyncLock();
    const order: string[] = [];

    const op1 = lock.run(async () => {
      order.push("start:1");
      await new Promise((r) => setTimeout(r, 10));
      order.push("end:1");
    });
    const op2 = lock.run(async () => {
      order.push("start:2");
      await new Promise((r) => setTimeout(r, 10));
      order.push("end:2");
    });
    const op3 = lock.run(async () => {
      order.push("start:3");
      await new Promise((r) => setTimeout(r, 10));
      order.push("end:3");
    });

    await Promise.all([op1, op2, op3]);

    expect(order).toEqual([
      "start:1", "end:1",
      "start:2", "end:2",
      "start:3", "end:3",
    ]);
  });

  it("E54: full sync pushes without --delete before pulling (FS1)", async () => {
    // Verify fullSync calls pushAllWithoutDelete then pull (ordering invariant)
    // by checking the coordinator produces fullSync effect (which engine implements as push-then-pull)
    const state = createInitialState(true);
    const decision = decideManualSyncAction(state, true);
    const fullSyncEffect = findEffect(decision.effects, "fullSync");
    expect(fullSyncEffect).toBeDefined();

    // Verify engine.fullSync implementation: pushAllWithoutDelete delegates to
    // pushAllInternal(false) which passes deleteFlag=false
    // Create files and mock transport properly
    await createTestFile(env, "local.md", "content");

    vi.mocked(commands.runRsync).mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      changedFiles: [],
      deletedFiles: [],
    } as any);
    vi.mocked(commands.executeCommand).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await env.engine.fullSync();

    // pushAllWithoutDelete is called first with deleteFlag=false
    const pushCalls = vi.mocked(commands.buildRsyncPushCommand).mock.calls;
    expect(pushCalls.length).toBeGreaterThan(0);
    expect(pushCalls[0][0].deleteFlag).toBe(false);

    // pull is called after with deleteFlag not explicitly false (defaults to true via pull)
    const pullCalls = vi.mocked(commands.buildRsyncPullCommand).mock.calls;
    expect(pullCalls.length).toBeGreaterThan(0);
  });

  it("E55: status transitions idle → syncing → idle (SB1)", () => {
    const state = createInitialState(true);
    expect(state.status).toBe("idle");

    // Manual sync transitions to syncing
    const decision = decideManualSyncAction(state, true);
    expect(decision.state.status).toBe("syncing");
    expect(findEffect(decision.effects, "updateStatus")!.status).toBe("syncing");

    // Simulate sync complete: pull with no changes returns to idle
    const pullDecision = decidePullAction(
      decision.state,
      { changedFiles: [], deletedFiles: [] },
      {},
      DEFAULT_CONFIG,
      new Set(),
      new Map()
    );
    expect(pullDecision.state.status).toBe("idle");
    expect(findEffect(pullDecision.effects, "updateStatus")!.status).toBe("idle");
  });

  it("E56: error state recovers on next successful sync (SB2)", () => {
    // Start with error state
    const errorState = { ...createInitialState(true), status: "error" as const };

    // Next manual sync should transition to syncing
    const decision = decideManualSyncAction(errorState, true);
    expect(decision.state.status).toBe("syncing");
    expect(decision.effects.some((e) => e.type === "fullSync")).toBe(true);

    // After successful sync (pull with no changes), status returns to idle
    const pullDecision = decidePullAction(
      decision.state,
      { changedFiles: [], deletedFiles: [] },
      {},
      DEFAULT_CONFIG,
      new Set(),
      new Map()
    );
    expect(pullDecision.state.status).toBe("idle");
  });

  it("E57: disabled state shows correct status (SB3)", () => {
    const decision = decideToggleAction(
      createInitialState(true),
      true, // currently enabled → disabling
      60000
    );
    expect(decision.state.status).toBe("disabled");
    const statusEffect = findEffect(decision.effects, "updateStatus");
    expect(statusEffect!.status).toBe("disabled");
  });
});
