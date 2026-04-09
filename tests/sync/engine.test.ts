import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { SyncEngine } from "../../src/sync/engine";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as commands from "../../src/ssh/commands";

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

describe("SyncEngine", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
  const manifestPath = path.join(tmpDir, "manifest.json");

  const config = {
    enabled: true,
    sshHost: "user@host",
    remotePath: "/remote/vault",
    pollIntervalSeconds: 60,
    syncOnSave: true,
    excludePatterns: [".obsidian/**"],
    conflictPolicy: "remote-wins" as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(manifestPath, { force: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("pushes a single file", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["notes/test.md"],
      deletedFiles: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const testFile = path.join(tmpDir, "notes", "test.md");
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    fs.writeFileSync(testFile, "content");

    const engine = new SyncEngine(config, tmpDir, manifestPath);
    const result = await engine.pushFile("notes/test.md");

    expect(result.success).toBe(true);
    expect(commands.runRsync).toHaveBeenCalled();
  });

  it("fails push when file does not exist", async () => {
    const engine = new SyncEngine(config, tmpDir, manifestPath);
    const result = await engine.pushFile("nonexistent.md");
    expect(result.success).toBe(false);
  });

  it("pulls changes from remote", async () => {
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["notes/remote.md"],
      deletedFiles: [],
      stdout: "notes/remote.md",
      stderr: "",
      exitCode: 0,
    });

    const engine = new SyncEngine(config, tmpDir, manifestPath);
    const result = await engine.pull();

    expect(result.success).toBe(true);
    expect(result.changedFiles).toContain("notes/remote.md");
  });

  it("detects remote changes with dry run", async () => {
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["notes/new.md", "notes/updated.md"],
      deletedFiles: [],
      stdout: "notes/new.md\nnotes/updated.md",
      stderr: "",
      exitCode: 0,
    });

    const engine = new SyncEngine(config, tmpDir, manifestPath);
    const result = await engine.detectRemoteChanges();

    expect(result.changedFiles).toHaveLength(2);
  });

  it("ensures remote directory exists on first sync", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [],
      deletedFiles: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const engine = new SyncEngine(config, tmpDir, manifestPath);
    await engine.ensureRemoteDir();

    expect(commands.executeCommand).toHaveBeenCalledWith("mkdir cmd", expect.any(Number));
  });

  it("tests connection", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "file1.md\nfile2.md",
      stderr: "",
      exitCode: 0,
    });

    const engine = new SyncEngine(config, tmpDir, manifestPath);
    const result = await engine.testConnection();

    expect(result.success).toBe(true);
  });

  it("deletes a remote file and removes manifest entry", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const engine = new SyncEngine(config, tmpDir, manifestPath);

    // Seed manifest with an entry
    engine.getManifest().setEntry("old.md", {
      path: "old.md",
      localMtime: 1000,
      remoteMtime: 1000,
      lastSyncedMtime: 1000,
      size: 100,
      hash: "abc",
    });

    const result = await engine.deleteRemoteFile("old.md");

    expect(result.success).toBe(true);
    expect(commands.executeCommand).toHaveBeenCalledWith("rm cmd", 15000);
    expect(engine.getManifest().getEntry("old.md")).toBeUndefined();
  });

  it("treats 'No such file' as successful delete", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "",
      stderr: "rm: /remote/vault/gone.md: No such file or directory",
      exitCode: 1,
    });

    const engine = new SyncEngine(config, tmpDir, manifestPath);
    const result = await engine.deleteRemoteFile("gone.md");

    expect(result.success).toBe(true);
  });

  it("reports failure when remote delete fails", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "",
      stderr: "Permission denied",
      exitCode: 1,
    });

    const engine = new SyncEngine(config, tmpDir, manifestPath);
    const result = await engine.deleteRemoteFile("protected.md");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Permission denied");
  });

  it("pullWithoutDelete pulls without --delete flag", async () => {
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["notes/remote.md"],
      deletedFiles: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const engine = new SyncEngine(config, tmpDir, manifestPath);
    const result = await engine.pullWithoutDelete();

    expect(result.success).toBe(true);
    expect(result.changedFiles).toContain("notes/remote.md");
    expect(commands.buildRsyncPullCommand).toHaveBeenCalledWith(
      expect.objectContaining({ deleteFlag: false })
    );
  });

  it("deleteLocalFiles removes files and skips pending paths", () => {
    const fileToDelete = path.join(tmpDir, "delete-me.md");
    const fileToSkip = path.join(tmpDir, "keep-me.md");
    fs.writeFileSync(fileToDelete, "content");
    fs.writeFileSync(fileToSkip, "content");

    const engine = new SyncEngine(config, tmpDir, manifestPath);
    engine.getManifest().setEntry("delete-me.md", {
      path: "delete-me.md",
      localMtime: 1000,
      remoteMtime: 1000,
      lastSyncedMtime: 1000,
      size: 7,
      hash: "abc",
    });

    const skipPaths = new Set(["keep-me.md"]);
    const deleted = engine.deleteLocalFiles(["delete-me.md", "keep-me.md"], skipPaths);

    expect(deleted).toEqual(["delete-me.md"]);
    expect(fs.existsSync(fileToDelete)).toBe(false);
    expect(fs.existsSync(fileToSkip)).toBe(true);
    expect(engine.getManifest().getEntry("delete-me.md")).toBeUndefined();
  });

  it("pushFile calls mkdir for subdirectory before rsync", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["notes/sub/test.md"],
      deletedFiles: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const testFile = path.join(tmpDir, "notes", "sub", "test.md");
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    fs.writeFileSync(testFile, "content");

    const engine = new SyncEngine(config, tmpDir, manifestPath);
    const result = await engine.pushFile("notes/sub/test.md");

    expect(result.success).toBe(true);
    expect(commands.buildMkdirCommand).toHaveBeenCalledWith(
      "user@host",
      "/remote/vault/notes/sub"
    );
    expect(commands.executeCommand).toHaveBeenCalledWith("mkdir cmd", 15000);
  });

  it("pushFile does not call mkdir for root-level files", async () => {
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["root.md"],
      deletedFiles: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const testFile = path.join(tmpDir, "root.md");
    fs.writeFileSync(testFile, "content");

    const engine = new SyncEngine(config, tmpDir, manifestPath);
    const result = await engine.pushFile("root.md");

    expect(result.success).toBe(true);
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it("pushFile returns error when mkdir fails", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "",
      stderr: "Permission denied",
      exitCode: 1,
    });

    const testFile = path.join(tmpDir, "notes", "fail.md");
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    fs.writeFileSync(testFile, "content");

    const engine = new SyncEngine(config, tmpDir, manifestPath);
    const result = await engine.pushFile("notes/fail.md");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to create remote directory");
    expect(commands.runRsync).not.toHaveBeenCalled();
  });

  it("pushAllWithoutDelete uses deleteFlag false", async () => {
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["notes/test.md"],
      deletedFiles: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    // Create the file so manifest entry can be populated
    const testFile = path.join(tmpDir, "notes", "test.md");
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    fs.writeFileSync(testFile, "content");

    const engine = new SyncEngine(config, tmpDir, manifestPath);
    const result = await engine.pushAllWithoutDelete();

    expect(result.success).toBe(true);
    expect(commands.buildRsyncPushCommand).toHaveBeenCalledWith(
      expect.objectContaining({ deleteFlag: false })
    );
  });

  it("pushAll creates manifest entries for pushed files", async () => {
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["notes/a.md", "notes/b.md"],
      deletedFiles: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    // Create the files so manifest entries can be populated
    fs.mkdirSync(path.join(tmpDir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "notes/a.md"), "content a");
    fs.writeFileSync(path.join(tmpDir, "notes/b.md"), "content b");

    const engine = new SyncEngine(config, tmpDir, manifestPath);
    const result = await engine.pushAll();

    expect(result.success).toBe(true);
    // Both files should have manifest entries with hashes
    const entryA = engine.getManifest().getEntry("notes/a.md");
    const entryB = engine.getManifest().getEntry("notes/b.md");
    expect(entryA).toBeDefined();
    expect(entryA!.hash).toBeTruthy();
    expect(entryA!.size).toBeGreaterThan(0);
    expect(entryB).toBeDefined();
    expect(entryB!.hash).toBeTruthy();
  });

  it("fullSync uses pushAllWithoutDelete then pull", async () => {
    vi.mocked(commands.runRsync)
      .mockResolvedValueOnce({
        changedFiles: ["local.md"],
        deletedFiles: [],
        stdout: "",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        changedFiles: ["remote.md"],
        deletedFiles: [],
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

    const engine = new SyncEngine(config, tmpDir, manifestPath);
    const result = await engine.fullSync();

    expect(result.success).toBe(true);
    expect(result.changedFiles).toEqual(["local.md", "remote.md"]);
    // First call should be push without delete
    expect(commands.buildRsyncPushCommand).toHaveBeenCalledWith(
      expect.objectContaining({ deleteFlag: false })
    );
    // Second call should be pull with delete (deleteFlag defaults to true / not passed as false)
    expect(commands.buildRsyncPullCommand).toHaveBeenCalledWith(
      expect.objectContaining({ deleteFlag: true })
    );
  });
});
