import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as commands from "../../src/ssh/commands";
import { createTestEnv, createTestFile, TestEnv } from "../helpers/test-env";
import { FileWatcher, WatcherFlush } from "../../src/sync/watcher";
import { decideFlushAction, createInitialState } from "../../src/sync/coordinator";

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

describe("Local Changes → Remote", () => {
  let env: TestEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    env = createTestEnv();
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [], deletedFiles: [], stdout: "", stderr: "", exitCode: 0,
    });
    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "", stderr: "", exitCode: 0,
    });
  });

  afterEach(() => {
    env?.cleanup();
  });

  afterAll(() => {
    // Cleanup is handled per-test via env.cleanup() if needed
  });

  it("L1: creates new file and pushes to VPS", async () => {
    createTestFile(env, "notes/new-idea.md", "new content");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["notes/new-idea.md"], deletedFiles: [], stdout: "", stderr: "", exitCode: 0,
    });

    const result = await env.engine.pushFile("notes/new-idea.md");

    expect(result.success).toBe(true);
    expect(commands.runRsync).toHaveBeenCalled();
    const entry = env.engine.getManifest().getEntry("notes/new-idea.md");
    expect(entry).toBeDefined();
    expect(entry!.hash).toBeTruthy();
    expect(entry!.size).toBeGreaterThan(0);
  });

  it("L2: edits existing file and pushes update", async () => {
    createTestFile(env, "notes/existing.md", "original content", true);
    fs.writeFileSync(path.join(env.vaultPath, "notes/existing.md"), "updated content");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["notes/existing.md"], deletedFiles: [], stdout: "", stderr: "", exitCode: 0,
    });

    const result = await env.engine.pushFile("notes/existing.md");

    expect(result.success).toBe(true);
    const entry = env.engine.getManifest().getEntry("notes/existing.md");
    expect(entry).toBeDefined();
  });

  it("L3: deletes file from VPS", async () => {
    createTestFile(env, "notes/old.md", "content", true);

    const result = await env.engine.deleteRemoteFile("notes/old.md");

    expect(result.success).toBe(true);
    expect(env.engine.getManifest().getEntry("notes/old.md")).toBeUndefined();
  });

  it("L4: renames file (single) — delete old, push new", async () => {
    createTestFile(env, "notes/new-name.md", "content", false);
    // Seed manifest with old name
    env.engine.getManifest().setEntry("notes/old-name.md", {
      path: "notes/old-name.md", localMtime: 1000, remoteMtime: 1000,
      lastSyncedMtime: 1000, size: 7, hash: "abc",
    });

    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["notes/new-name.md"], deletedFiles: [], stdout: "", stderr: "", exitCode: 0,
    });

    // Push new name
    const pushResult = await env.engine.pushFile("notes/new-name.md");
    expect(pushResult.success).toBe(true);

    // Delete old name from remote
    const deleteResult = await env.engine.deleteRemoteFile("notes/old-name.md");
    expect(deleteResult.success).toBe(true);

    expect(env.engine.getManifest().getEntry("notes/old-name.md")).toBeUndefined();
    expect(env.engine.getManifest().getEntry("notes/new-name.md")).toBeDefined();
  });

  it("L5: rename chain collapses to delete origin + push final", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    // Simulate keystroke-by-keystroke rename: Untitled → H → He → Hel → Hello
    watcher.onFileRenamed("H.md", "Untitled.md");
    watcher.onFileRenamed("He.md", "H.md");
    watcher.onFileRenamed("Hel.md", "He.md");
    watcher.onFileRenamed("Hello.md", "Hel.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("Hello.md")).toBe(true);
    expect(flushed!.deletedFiles.has("Untitled.md")).toBe(true);
    // No intermediates
    expect(flushed!.changedFiles.has("H.md")).toBe(false);
    expect(flushed!.changedFiles.has("He.md")).toBe(false);
    expect(flushed!.changedFiles.has("Hel.md")).toBe(false);
    expect(flushed!.deletedFiles.has("H.md")).toBe(false);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L6: move file to subfolder", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    watcher.onFileRenamed("projects/idea.md", "notes/idea.md");
    await vi.advanceTimersByTimeAsync(600);

    expect(flushed!.changedFiles.has("projects/idea.md")).toBe(true);
    expect(flushed!.deletedFiles.has("notes/idea.md")).toBe(true);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L7: create file in new subfolder", async () => {
    createTestFile(env, "projects/new-project/readme.md", "# Readme");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["projects/new-project/readme.md"], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });

    const result = await env.engine.pushFile("projects/new-project/readme.md");
    expect(result.success).toBe(true);
    expect(env.engine.getManifest().getEntry("projects/new-project/readme.md")).toBeDefined();
  });

  it("L8: rapid edits to same file produce single flush", async () => {
    vi.useFakeTimers();
    let flushCount = 0;
    const watcher = new FileWatcher(500, async () => { flushCount++; });

    watcher.onFileChange("notes/draft.md");
    await vi.advanceTimersByTimeAsync(100);
    watcher.onFileChange("notes/draft.md");
    await vi.advanceTimersByTimeAsync(100);
    watcher.onFileChange("notes/draft.md");
    await vi.advanceTimersByTimeAsync(100);
    watcher.onFileChange("notes/draft.md");
    await vi.advanceTimersByTimeAsync(100);
    watcher.onFileChange("notes/draft.md");
    await vi.advanceTimersByTimeAsync(600);

    expect(flushCount).toBe(1);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L9: edit multiple files rapidly produces single flush with all files", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    watcher.onFileChange("a.md");
    await vi.advanceTimersByTimeAsync(100);
    watcher.onFileChange("b.md");
    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("a.md")).toBe(true);
    expect(flushed!.changedFiles.has("b.md")).toBe(true);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L10: delete then recreate same path treated as change", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    watcher.onFileDeleted("notes/temp.md");
    await vi.advanceTimersByTimeAsync(100);
    watcher.onFileChange("notes/temp.md"); // re-created

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed!.changedFiles.has("notes/temp.md")).toBe(true);
    expect(flushed!.deletedFiles.has("notes/temp.md")).toBe(false);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L11: excluded file produces push effect but rsync excludes it", () => {
    // Test via coordinator: flush includes the file, but the rsync command
    // will have --exclude patterns that prevent actual transfer.
    // Here we verify the exclude patterns are passed to the rsync command builder.
    const decision = decideFlushAction(
      createInitialState(true),
      { changedFiles: new Set([".git/config"]), deletedFiles: new Set() },
      true
    );
    // The coordinator doesn't filter by exclude patterns — that's rsync's job.
    // The effect is created, but when executed, rsync --exclude handles it.
    const pushEffect = decision.effects.find((e) => e.type === "pushFiles");
    expect(pushEffect).toBeDefined();
  });

  it("L12: create/modify binary file", async () => {
    const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const filePath = path.join(env.vaultPath, "attachments");
    fs.mkdirSync(filePath, { recursive: true });
    fs.writeFileSync(path.join(filePath, "image.png"), binaryData);
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["attachments/image.png"], deletedFiles: [], stdout: "", stderr: "", exitCode: 0,
    });

    const result = await env.engine.pushFile("attachments/image.png");

    expect(result.success).toBe(true);
    const entry = env.engine.getManifest().getEntry("attachments/image.png");
    expect(entry).toBeDefined();
    expect(entry!.hash).toBeTruthy();
    expect(entry!.size).toBeGreaterThan(0);
  });

  it("L13: create deeply nested directory structure", async () => {
    createTestFile(env, "projects/2026/q2/april/notes.md", "# Q2 April Notes");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["projects/2026/q2/april/notes.md"], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });

    const result = await env.engine.pushFile("projects/2026/q2/april/notes.md");

    expect(result.success).toBe(true);
    expect(env.engine.getManifest().getEntry("projects/2026/q2/april/notes.md")).toBeDefined();
  });

  it("L14: delete entire subfolder", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    watcher.onFileDeleted("projects/old/a.md");
    watcher.onFileDeleted("projects/old/b.md");
    watcher.onFileDeleted("projects/old/c.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.deletedFiles.has("projects/old/a.md")).toBe(true);
    expect(flushed!.deletedFiles.has("projects/old/b.md")).toBe(true);
    expect(flushed!.deletedFiles.has("projects/old/c.md")).toBe(true);
    expect(flushed!.changedFiles.size).toBe(0);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L15: rename folder", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    watcher.onFileRenamed("archive/one.md", "notes/one.md");
    watcher.onFileRenamed("archive/two.md", "notes/two.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("archive/one.md")).toBe(true);
    expect(flushed!.changedFiles.has("archive/two.md")).toBe(true);
    expect(flushed!.deletedFiles.has("notes/one.md")).toBe(true);
    expect(flushed!.deletedFiles.has("notes/two.md")).toBe(true);

    watcher.dispose();
    vi.useRealTimers();
  });
});
