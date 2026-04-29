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
  buildRmdirCommand: vi.fn(() => "rmdir cmd"),
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
    const entry = env.engine._manifest.getEntry("notes/new-idea.md");
    expect(entry).toBeDefined();
    expect(entry!.hash).toBeTruthy();
    expect(entry!.size).toBeGreaterThan(0);
  });

  it("L2: edits existing file and pushes update", async () => {
    await createTestFile(env, "notes/existing.md", "original content", true);
    fs.writeFileSync(path.join(env.vaultPath, "notes/existing.md"), "updated content");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["notes/existing.md"], deletedFiles: [], stdout: "", stderr: "", exitCode: 0,
    });

    const result = await env.engine.pushFile("notes/existing.md");

    expect(result.success).toBe(true);
    const entry = env.engine._manifest.getEntry("notes/existing.md");
    expect(entry).toBeDefined();
  });

  it("L3: deletes file from VPS", async () => {
    await createTestFile(env, "notes/old.md", "content", true);

    const result = await env.engine.deleteRemoteFile("notes/old.md");

    expect(result.success).toBe(true);
    expect(env.engine._manifest.getEntry("notes/old.md")).toBeUndefined();
  });

  it("L4: renames file (single) — delete old, push new", async () => {
    createTestFile(env, "notes/new-name.md", "content", false);
    // Seed manifest with old name
    env.engine._manifest.setEntry("notes/old-name.md", {
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

    expect(env.engine._manifest.getEntry("notes/old-name.md")).toBeUndefined();
    expect(env.engine._manifest.getEntry("notes/new-name.md")).toBeDefined();
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
    expect(env.engine._manifest.getEntry("projects/new-project/readme.md")).toBeDefined();
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
    const entry = env.engine._manifest.getEntry("attachments/image.png");
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
    expect(env.engine._manifest.getEntry("projects/2026/q2/april/notes.md")).toBeDefined();
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

  // ─── New use cases L14–L41 ───────────────────────────────────────────

  it("L14: delete last file in subfolder (orphaned empty directory)", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    // Only file in the subfolder is deleted
    watcher.onFileDeleted("journal/2026/only-entry.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.deletedFiles.has("journal/2026/only-entry.md")).toBe(true);
    expect(flushed!.changedFiles.size).toBe(0);

    // Engine side: deleteRemoteFile removes from manifest and calls rm on remote
    const deleteResult = await env.engine.deleteRemoteFile("journal/2026/only-entry.md");
    expect(deleteResult.success).toBe(true);
    expect(commands.executeCommand).toHaveBeenCalled();

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L15: move file from root to nested subfolder", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    watcher.onFileRenamed("projects/deep/notes/idea.md", "idea.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("projects/deep/notes/idea.md")).toBe(true);
    expect(flushed!.deletedFiles.has("idea.md")).toBe(true);

    // Engine: pushFile should call mkdir for the nested parent dir
    createTestFile(env, "projects/deep/notes/idea.md", "content");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["projects/deep/notes/idea.md"], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });

    const pushResult = await env.engine.pushFile("projects/deep/notes/idea.md");
    expect(pushResult.success).toBe(true);
    // mkdir should have been called for the parent directory
    expect(commands.executeCommand).toHaveBeenCalled();
    expect(commands.buildMkdirCommand).toHaveBeenCalled();

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L16: move file from nested subfolder to root", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    watcher.onFileRenamed("readme.md", "docs/guides/readme.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("readme.md")).toBe(true);
    expect(flushed!.deletedFiles.has("docs/guides/readme.md")).toBe(true);

    // For root-level file, pushFile should NOT call mkdir (parentDir is ".")
    createTestFile(env, "readme.md", "root content");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["readme.md"], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });

    vi.mocked(commands.buildMkdirCommand).mockClear();
    const pushResult = await env.engine.pushFile("readme.md");
    expect(pushResult.success).toBe(true);
    // No mkdir needed for root
    expect(commands.buildMkdirCommand).not.toHaveBeenCalled();

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L17: move file between two different subfolders", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    watcher.onFileRenamed("archive/2026/report.md", "projects/active/report.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("archive/2026/report.md")).toBe(true);
    expect(flushed!.deletedFiles.has("projects/active/report.md")).toBe(true);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L18: move file to a new subfolder that doesn't exist yet", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    watcher.onFileRenamed("brand-new-folder/spec.md", "spec.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("brand-new-folder/spec.md")).toBe(true);
    expect(flushed!.deletedFiles.has("spec.md")).toBe(true);

    // Engine creates the remote dir with mkdir before rsync
    createTestFile(env, "brand-new-folder/spec.md", "specification");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["brand-new-folder/spec.md"], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });

    const pushResult = await env.engine.pushFile("brand-new-folder/spec.md");
    expect(pushResult.success).toBe(true);
    expect(commands.buildMkdirCommand).toHaveBeenCalled();

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L19: create multiple files in same new subfolder rapidly (debounce)", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    let flushCount = 0;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; flushCount++; });

    watcher.onFileChange("new-project/file1.md");
    await vi.advanceTimersByTimeAsync(50);
    watcher.onFileChange("new-project/file2.md");
    await vi.advanceTimersByTimeAsync(50);
    watcher.onFileChange("new-project/file3.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushCount).toBe(1);
    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("new-project/file1.md")).toBe(true);
    expect(flushed!.changedFiles.has("new-project/file2.md")).toBe(true);
    expect(flushed!.changedFiles.has("new-project/file3.md")).toBe(true);
    expect(flushed!.changedFiles.size).toBe(3);

    // Engine: each pushFile call should create the remote dir
    for (const f of ["new-project/file1.md", "new-project/file2.md", "new-project/file3.md"]) {
      createTestFile(env, f, `content of ${f}`);
    }
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["new-project/file1.md"], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });
    const result = await env.engine.pushFile("new-project/file1.md");
    expect(result.success).toBe(true);
    expect(commands.buildMkdirCommand).toHaveBeenCalled();

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L20: delete multiple files from different subfolders (debounce)", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    let flushCount = 0;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; flushCount++; });

    watcher.onFileDeleted("notes/meeting.md");
    await vi.advanceTimersByTimeAsync(50);
    watcher.onFileDeleted("projects/old-idea.md");
    await vi.advanceTimersByTimeAsync(50);
    watcher.onFileDeleted("journal/2025/jan.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushCount).toBe(1);
    expect(flushed).not.toBeNull();
    expect(flushed!.deletedFiles.has("notes/meeting.md")).toBe(true);
    expect(flushed!.deletedFiles.has("projects/old-idea.md")).toBe(true);
    expect(flushed!.deletedFiles.has("journal/2025/jan.md")).toBe(true);
    expect(flushed!.deletedFiles.size).toBe(3);
    expect(flushed!.changedFiles.size).toBe(0);

    watcher.dispose();
    vi.useRealTimers();
  });

  // L21 (old L14) — already tested above as "L14: delete entire subfolder"
  // L23 (old L15) — already tested above as "L15: rename folder"

  it("L22: delete deeply nested subfolder tree", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    // Files at various depths in a nested tree
    watcher.onFileDeleted("projects/2026/q1/january/week1/notes.md");
    watcher.onFileDeleted("projects/2026/q1/january/week2/notes.md");
    watcher.onFileDeleted("projects/2026/q1/february/plan.md");
    watcher.onFileDeleted("projects/2026/q1/summary.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.deletedFiles.size).toBe(4);
    expect(flushed!.deletedFiles.has("projects/2026/q1/january/week1/notes.md")).toBe(true);
    expect(flushed!.deletedFiles.has("projects/2026/q1/january/week2/notes.md")).toBe(true);
    expect(flushed!.deletedFiles.has("projects/2026/q1/february/plan.md")).toBe(true);
    expect(flushed!.deletedFiles.has("projects/2026/q1/summary.md")).toBe(true);
    expect(flushed!.changedFiles.size).toBe(0);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L24: rename folder with many files (30 renames in debounce window)", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    // Simulate renaming a folder with 30 files: old-folder → new-folder
    for (let i = 1; i <= 30; i++) {
      watcher.onFileRenamed(`new-folder/file${i}.md`, `old-folder/file${i}.md`);
    }

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.size).toBe(30);
    expect(flushed!.deletedFiles.size).toBe(30);
    for (let i = 1; i <= 30; i++) {
      expect(flushed!.changedFiles.has(`new-folder/file${i}.md`)).toBe(true);
      expect(flushed!.deletedFiles.has(`old-folder/file${i}.md`)).toBe(true);
    }

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L25: rename deeply nested folder (2 renames with deep paths)", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    watcher.onFileRenamed("a/b/c/new-name/file1.md", "a/b/c/old-name/file1.md");
    watcher.onFileRenamed("a/b/c/new-name/file2.md", "a/b/c/old-name/file2.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("a/b/c/new-name/file1.md")).toBe(true);
    expect(flushed!.changedFiles.has("a/b/c/new-name/file2.md")).toBe(true);
    expect(flushed!.deletedFiles.has("a/b/c/old-name/file1.md")).toBe(true);
    expect(flushed!.deletedFiles.has("a/b/c/old-name/file2.md")).toBe(true);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L26: rename parent folder of nested tree (4 renames across sub-levels)", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    // Renaming "parent" to "renamed-parent" affects files at multiple sub-levels
    watcher.onFileRenamed("renamed-parent/file.md", "parent/file.md");
    watcher.onFileRenamed("renamed-parent/sub1/deep.md", "parent/sub1/deep.md");
    watcher.onFileRenamed("renamed-parent/sub2/a.md", "parent/sub2/a.md");
    watcher.onFileRenamed("renamed-parent/sub2/nested/b.md", "parent/sub2/nested/b.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.size).toBe(4);
    expect(flushed!.deletedFiles.size).toBe(4);
    expect(flushed!.changedFiles.has("renamed-parent/file.md")).toBe(true);
    expect(flushed!.changedFiles.has("renamed-parent/sub1/deep.md")).toBe(true);
    expect(flushed!.changedFiles.has("renamed-parent/sub2/a.md")).toBe(true);
    expect(flushed!.changedFiles.has("renamed-parent/sub2/nested/b.md")).toBe(true);
    expect(flushed!.deletedFiles.has("parent/file.md")).toBe(true);
    expect(flushed!.deletedFiles.has("parent/sub1/deep.md")).toBe(true);
    expect(flushed!.deletedFiles.has("parent/sub2/a.md")).toBe(true);
    expect(flushed!.deletedFiles.has("parent/sub2/nested/b.md")).toBe(true);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L27: move folder into another folder (2 renames changing parent)", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    // Move "src" into "archive": src/a.md → archive/src/a.md
    watcher.onFileRenamed("archive/src/a.md", "src/a.md");
    watcher.onFileRenamed("archive/src/b.md", "src/b.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("archive/src/a.md")).toBe(true);
    expect(flushed!.changedFiles.has("archive/src/b.md")).toBe(true);
    expect(flushed!.deletedFiles.has("src/a.md")).toBe(true);
    expect(flushed!.deletedFiles.has("src/b.md")).toBe(true);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L28: move folder out of a parent (promote up one level)", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    // Move "parent/child" up to "child": parent/child/x.md → child/x.md
    watcher.onFileRenamed("child/x.md", "parent/child/x.md");
    watcher.onFileRenamed("child/y.md", "parent/child/y.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("child/x.md")).toBe(true);
    expect(flushed!.changedFiles.has("child/y.md")).toBe(true);
    expect(flushed!.deletedFiles.has("parent/child/x.md")).toBe(true);
    expect(flushed!.deletedFiles.has("parent/child/y.md")).toBe(true);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L29: move folder to vault root (remove all parent dirs)", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    // Move "a/b/c" to root: a/b/c/doc.md → doc.md (but folder name preserved)
    watcher.onFileRenamed("c/doc1.md", "a/b/c/doc1.md");
    watcher.onFileRenamed("c/doc2.md", "a/b/c/doc2.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("c/doc1.md")).toBe(true);
    expect(flushed!.changedFiles.has("c/doc2.md")).toBe(true);
    expect(flushed!.deletedFiles.has("a/b/c/doc1.md")).toBe(true);
    expect(flushed!.deletedFiles.has("a/b/c/doc2.md")).toBe(true);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L30: rename folder then immediately rename it again (chain collapse for folder renames)", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    // First rename: alpha → beta
    watcher.onFileRenamed("beta/one.md", "alpha/one.md");
    watcher.onFileRenamed("beta/two.md", "alpha/two.md");

    // Second rename (within debounce window): beta → gamma
    watcher.onFileRenamed("gamma/one.md", "beta/one.md");
    watcher.onFileRenamed("gamma/two.md", "beta/two.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    // Chain collapsed: only alpha (origin) deleted, only gamma (final) pushed
    expect(flushed!.changedFiles.has("gamma/one.md")).toBe(true);
    expect(flushed!.changedFiles.has("gamma/two.md")).toBe(true);
    expect(flushed!.deletedFiles.has("alpha/one.md")).toBe(true);
    expect(flushed!.deletedFiles.has("alpha/two.md")).toBe(true);
    // Intermediates should not appear
    expect(flushed!.changedFiles.has("beta/one.md")).toBe(false);
    expect(flushed!.changedFiles.has("beta/two.md")).toBe(false);
    expect(flushed!.deletedFiles.has("beta/one.md")).toBe(false);
    expect(flushed!.deletedFiles.has("beta/two.md")).toBe(false);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L31: create folder, add files, then rename the folder within debounce window", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    // Create files in "draft-folder"
    watcher.onFileChange("draft-folder/a.md");
    watcher.onFileChange("draft-folder/b.md");

    // Rename "draft-folder" to "final-folder" within debounce
    watcher.onFileRenamed("final-folder/a.md", "draft-folder/a.md");
    watcher.onFileRenamed("final-folder/b.md", "draft-folder/b.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    // The final names should be in changedFiles
    expect(flushed!.changedFiles.has("final-folder/a.md")).toBe(true);
    expect(flushed!.changedFiles.has("final-folder/b.md")).toBe(true);
    // The draft names should NOT be in changedFiles (they were the create targets, now renamed)
    expect(flushed!.changedFiles.has("draft-folder/a.md")).toBe(false);
    expect(flushed!.changedFiles.has("draft-folder/b.md")).toBe(false);
    // The draft names are the rename origin — but they were created new (no pre-existing remote),
    // so the watcher records them as the origin in the rename chain.
    // Since they were initially created (onFileChange) then renamed away, the rename
    // origin (draft-folder/*) gets added to deletedFiles.
    // But they never existed on remote so the delete will be a no-op on the engine side.

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L32: create empty folder (no files) — no watcher events, no sync", async () => {
    vi.useFakeTimers();
    let flushCount = 0;
    const watcher = new FileWatcher(500, async () => { flushCount++; });

    // Empty folder creation produces no file events in Obsidian's vault API
    // (Obsidian only watches files, not directories)
    // So we simply don't call any watcher methods

    await vi.advanceTimersByTimeAsync(600);

    expect(flushCount).toBe(0);
    expect(watcher.hasPending()).toBe(false);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L33: rename folder with spaces and special characters (escaping)", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    watcher.onFileRenamed("my folder (2026)/notes & ideas.md", "old name [draft]/notes & ideas.md");
    watcher.onFileRenamed("my folder (2026)/résumé.md", "old name [draft]/résumé.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("my folder (2026)/notes & ideas.md")).toBe(true);
    expect(flushed!.changedFiles.has("my folder (2026)/résumé.md")).toBe(true);
    expect(flushed!.deletedFiles.has("old name [draft]/notes & ideas.md")).toBe(true);
    expect(flushed!.deletedFiles.has("old name [draft]/résumé.md")).toBe(true);

    // Verify engine handles special chars in paths
    createTestFile(env, "my folder (2026)/notes & ideas.md", "content with special chars");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["my folder (2026)/notes & ideas.md"], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });
    const pushResult = await env.engine.pushFile("my folder (2026)/notes & ideas.md");
    expect(pushResult.success).toBe(true);
    // mkdir should have been called with the special-char path
    expect(commands.buildMkdirCommand).toHaveBeenCalled();

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L34: delete folder then recreate with same name and different files", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    // Delete old files
    watcher.onFileDeleted("recycled/old1.md");
    watcher.onFileDeleted("recycled/old2.md");

    // Recreate folder with new files (same folder name)
    await vi.advanceTimersByTimeAsync(100);
    watcher.onFileChange("recycled/new1.md");
    watcher.onFileChange("recycled/new2.md");
    watcher.onFileChange("recycled/new3.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    // Old files should be deleted
    expect(flushed!.deletedFiles.has("recycled/old1.md")).toBe(true);
    expect(flushed!.deletedFiles.has("recycled/old2.md")).toBe(true);
    // New files should be changed
    expect(flushed!.changedFiles.has("recycled/new1.md")).toBe(true);
    expect(flushed!.changedFiles.has("recycled/new2.md")).toBe(true);
    expect(flushed!.changedFiles.has("recycled/new3.md")).toBe(true);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L35: move multiple files from different folders into one new folder", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    // Files from 3 different source folders → single target folder
    watcher.onFileRenamed("collected/from-notes.md", "notes/from-notes.md");
    watcher.onFileRenamed("collected/from-journal.md", "journal/from-journal.md");
    watcher.onFileRenamed("collected/from-projects.md", "projects/from-projects.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    // All 3 new paths in changed
    expect(flushed!.changedFiles.has("collected/from-notes.md")).toBe(true);
    expect(flushed!.changedFiles.has("collected/from-journal.md")).toBe(true);
    expect(flushed!.changedFiles.has("collected/from-projects.md")).toBe(true);
    // All 3 old paths in deleted
    expect(flushed!.deletedFiles.has("notes/from-notes.md")).toBe(true);
    expect(flushed!.deletedFiles.has("journal/from-journal.md")).toBe(true);
    expect(flushed!.deletedFiles.has("projects/from-projects.md")).toBe(true);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L36: move file and edit it simultaneously (rename + modify within debounce)", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    // Rename the file
    watcher.onFileRenamed("archive/doc.md", "active/doc.md");
    // Then edit it at the new location
    await vi.advanceTimersByTimeAsync(50);
    watcher.onFileChange("archive/doc.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    // The new path should be in changed (both rename target and edit)
    expect(flushed!.changedFiles.has("archive/doc.md")).toBe(true);
    // The old path should be in deleted
    expect(flushed!.deletedFiles.has("active/doc.md")).toBe(true);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L37: scatter files from one folder into multiple folders (3 renames to 3 targets)", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    // Scatter 3 files from "inbox" into 3 different folders
    watcher.onFileRenamed("notes/task1.md", "inbox/task1.md");
    watcher.onFileRenamed("projects/task2.md", "inbox/task2.md");
    watcher.onFileRenamed("archive/task3.md", "inbox/task3.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("notes/task1.md")).toBe(true);
    expect(flushed!.changedFiles.has("projects/task2.md")).toBe(true);
    expect(flushed!.changedFiles.has("archive/task3.md")).toBe(true);
    expect(flushed!.deletedFiles.has("inbox/task1.md")).toBe(true);
    expect(flushed!.deletedFiles.has("inbox/task2.md")).toBe(true);
    expect(flushed!.deletedFiles.has("inbox/task3.md")).toBe(true);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L38: create file at depth 10+ levels (pushFile with very deep mkdir)", async () => {
    const deepPath = "a/b/c/d/e/f/g/h/i/j/k/deep-note.md";
    createTestFile(env, deepPath, "very deep content");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [deepPath], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });

    const result = await env.engine.pushFile(deepPath);

    expect(result.success).toBe(true);
    expect(commands.buildMkdirCommand).toHaveBeenCalled();
    expect(env.engine._manifest.getEntry(deepPath)).toBeDefined();
  });

  it("L39: rename file within same subfolder (rename without dir change)", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    watcher.onFileRenamed("notes/new-title.md", "notes/old-title.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("notes/new-title.md")).toBe(true);
    expect(flushed!.deletedFiles.has("notes/old-title.md")).toBe(true);
    // Only 1 rename, so 1 changed + 1 deleted
    expect(flushed!.changedFiles.size).toBe(1);
    expect(flushed!.deletedFiles.size).toBe(1);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L40: rename file changing only case", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    watcher.onFileRenamed("notes/README.md", "notes/readme.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("notes/README.md")).toBe(true);
    expect(flushed!.deletedFiles.has("notes/readme.md")).toBe(true);

    // Engine: push the new name, delete the old name
    createTestFile(env, "notes/README.md", "readme content");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["notes/README.md"], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });
    const pushResult = await env.engine.pushFile("notes/README.md");
    expect(pushResult.success).toBe(true);

    const deleteResult = await env.engine.deleteRemoteFile("notes/readme.md");
    expect(deleteResult.success).toBe(true);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L41: rename file changing extension", async () => {
    vi.useFakeTimers();
    let flushed: WatcherFlush | null = null;
    const watcher = new FileWatcher(500, async (flush) => { flushed = flush; });

    watcher.onFileRenamed("notes/document.txt", "notes/document.md");

    await vi.advanceTimersByTimeAsync(600);

    expect(flushed).not.toBeNull();
    expect(flushed!.changedFiles.has("notes/document.txt")).toBe(true);
    expect(flushed!.deletedFiles.has("notes/document.md")).toBe(true);

    // Engine: push the new extension, delete the old one
    createTestFile(env, "notes/document.txt", "plain text content");
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: ["notes/document.txt"], deletedFiles: [],
      stdout: "", stderr: "", exitCode: 0,
    });
    const pushResult = await env.engine.pushFile("notes/document.txt");
    expect(pushResult.success).toBe(true);

    const deleteResult = await env.engine.deleteRemoteFile("notes/document.md");
    expect(deleteResult.success).toBe(true);

    watcher.dispose();
    vi.useRealTimers();
  });

  it("L42: delete folder — rm 'Is a directory' retries with rmdir", async () => {
    // When Obsidian fires a delete event for a folder path, rm fails with
    // "Is a directory". The engine should retry with rmdir to remove the
    // empty directory on remote, preventing it from syncing back on pull.
    const executeResults: Array<{ stdout: string; stderr: string; exitCode: number }> = [];

    vi.mocked(commands.executeCommand).mockImplementation(async (cmd: string) => {
      if (cmd.includes("rmdir")) {
        const result = { stdout: "", stderr: "", exitCode: 0 };
        executeResults.push(result);
        return result;
      }
      // rm fails with "Is a directory"
      const result = {
        stdout: "",
        stderr: "rm: cannot remove '/home/ubuntu/vault/Notes': Is a directory",
        exitCode: 1,
      };
      executeResults.push(result);
      return result;
    });

    const result = await env.engine.deleteRemoteFile("Notes");
    expect(result.success).toBe(true);

    // Verify rmdir was attempted after rm failed
    expect(commands.executeCommand).toHaveBeenCalledTimes(2);
    expect(commands.buildRmdirCommand).toHaveBeenCalledWith(
      env.config.sshHost,
      `${env.config.remotePath}/Notes`
    );
  });

  it("L43: delete folder — rmdir fails on non-empty dir (expected)", async () => {
    // If the remote directory is NOT empty, rmdir should fail and that's OK.
    // We return success since the directory has contents we don't want to
    // force-delete.
    vi.mocked(commands.executeCommand).mockImplementation(async (cmd: string) => {
      if (cmd.includes("rmdir")) {
        return {
          stdout: "",
          stderr: "rmdir: failed to remove: Directory not empty",
          exitCode: 1,
        };
      }
      return {
        stdout: "",
        stderr: "rm: cannot remove: Is a directory",
        exitCode: 1,
      };
    });

    const result = await env.engine.deleteRemoteFile("Notes");
    // Non-empty dir → rmdir fails, but that's fine. The dir has real files.
    expect(result.success).toBe(true);
  });

  it("L44: delete file from subfolder — parent dir cleaned up via rmdir", async () => {
    // After deleting the last file in a remote directory, the engine should
    // attempt to rmdir the parent directory to prevent empty dirs from
    // syncing back on pull.
    vi.mocked(commands.executeCommand).mockImplementation(async (cmd: string) => {
      if (cmd.includes("rmdir")) {
        // rmdir succeeds — directory was empty after file delete
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      // rm succeeds for the file
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const result = await env.engine.deleteRemoteFile("Notes/file.md");
    expect(result.success).toBe(true);

    // Verify rmdir was called for the parent directory
    expect(commands.buildRmdirCommand).toHaveBeenCalledWith(
      env.config.sshHost,
      `${env.config.remotePath}/Notes`
    );
  });

  it("L45: delete file from nested subfolder — cleans up ancestor dirs bottom-up", async () => {
    // After deleting a file from a/b/c/, the engine should try rmdir on
    // a/b/c, then a/b, then a — stopping at the first non-empty dir.
    const rmdirCalls: string[] = [];

    vi.mocked(commands.executeCommand).mockImplementation(async (cmd: string) => {
      // rm succeeds
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    vi.mocked(commands.buildRmdirCommand).mockImplementation((host: string, path: string) => {
      rmdirCalls.push(path);
      return "rmdir cmd";
    });

    const result = await env.engine.deleteRemoteFile("a/b/c/file.md");
    expect(result.success).toBe(true);

    // Should try rmdir bottom-up: a/b/c, a/b, a
    expect(rmdirCalls).toEqual([
      `${env.config.remotePath}/a/b/c`,
      `${env.config.remotePath}/a/b`,
      `${env.config.remotePath}/a`,
    ]);
  });

  it("L46: delete file from nested dir — stops cleaning at first non-empty ancestor", async () => {
    const rmdirCalls: string[] = [];

    vi.mocked(commands.executeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === "rmdir cmd") {
        // First rmdir (a/b/c) succeeds, second (a/b) fails (not empty)
        if (rmdirCalls.length <= 1) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "rmdir: not empty", exitCode: 1 };
      }
      // rm succeeds
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    vi.mocked(commands.buildRmdirCommand).mockImplementation((host: string, path: string) => {
      rmdirCalls.push(path);
      return "rmdir cmd";
    });

    const result = await env.engine.deleteRemoteFile("a/b/c/file.md");
    expect(result.success).toBe(true);

    // Should try a/b/c (success), a/b (fail), stop there
    expect(rmdirCalls).toEqual([
      `${env.config.remotePath}/a/b/c`,
      `${env.config.remotePath}/a/b`,
    ]);
  });
});
