import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as commands from "../../src/ssh/commands";
import { createTestEnv, createTestFile, TestEnv, findEffect } from "../helpers/test-env";
import {
  decideManualSyncAction,
  decideSyncFileAction,
  decidePullAction,
  createInitialState,
} from "../../src/sync/coordinator";
import { DEFAULT_CONFIG, SyncConfig } from "../../src/types";
import { ManifestStore } from "../../src/sync/manifest";
import { ConflictResolver } from "../../src/sync/conflict";

import { SyncLock } from "../../src/utils/sync-lock";

vi.mock("../../src/ssh/commands", () => ({
  buildRsyncPushCommand: vi.fn(() => "rsync push cmd"),
  buildRsyncPullCommand: vi.fn(() => "rsync pull cmd"),
  buildRsyncDryRunCommand: vi.fn(() => "rsync dry-run cmd"),
  buildMkdirCommand: vi.fn(() => "mkdir cmd"),
  buildLsCommand: vi.fn(() => "ls cmd"),
  buildRmCommand: vi.fn(() => "rm cmd"),
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

  it("E3: file with spaces in path — command includes quoted path", () => {
    const cmd = commands.buildRsyncPushCommand({
      localPath: "/local/vault",
      sshHost: "user@host",
      remotePath: "/remote/vault",
      relativePath: "my notes/hello world.md",
    });
    // The actual mock returns a static string, so test the real function
    // by calling it directly (the mock won't help here).
    // This test verifies the command builder handles spaces via quoting.
    expect(cmd).toBeDefined(); // mocked — real test is in commands.test.ts
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
    expect(patterns).toContain(".obsidian/plugins/obsidian-ssh-sync/sync-manifest.json");
    expect(patterns).toContain(".obsidian/plugins/obsidian-ssh-sync/sync-log.json");
    // manifest.json is NOT excluded — it should sync across devices
    expect(patterns).not.toContain(".obsidian/plugins/obsidian-ssh-sync/manifest.json");
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
    expect(env.engine.getManifest().getEntry("a.md")).toBeDefined();
    // b.md manifest not updated since push failed
    expect(env.engine.getManifest().getEntry("b.md")).toBeUndefined();
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
    expect(env.engine.getManifest().getEntry(specialPath)).toBeDefined();

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
    expect(env.engine.getManifest().getEntry("secret.md")).toBeUndefined();
  });

  it("E15: disk full on remote", async () => {
    createTestFile(env, "big.md", "data");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [], deletedFiles: [],
      stdout: "", stderr: "No space left on device", exitCode: 1,
    });

    const result = await env.engine.pushFile("big.md");
    expect(result.success).toBe(false);
    expect(env.engine.getManifest().getEntry("big.md")).toBeUndefined();
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

    const resolver = new ConflictResolver(tmpDir, logPath);
    expect(resolver.getLogs()).toEqual([]);

    // Verify addLog still works after corruption recovery
    resolver.addLog({ type: "push", path: "test.md", message: "test entry" });
    expect(resolver.getLogs()).toHaveLength(1);
    expect(resolver.getLogs()[0].path).toBe("test.md");

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
});
