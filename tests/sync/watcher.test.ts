import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileWatcher } from "../../src/sync/watcher";

describe("FileWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("debounces rapid file changes", () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);

    watcher.onFileChange("test.md");
    watcher.onFileChange("test.md");
    watcher.onFileChange("test.md");

    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(600);

    expect(callback).toHaveBeenCalledTimes(1);
    const flush = callback.mock.calls[0][0];
    expect(flush.changedFiles).toEqual(new Set(["test.md"]));
    expect(flush.deletedFiles).toEqual(new Set());
  });

  it("accumulates different files in debounce window", () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);

    watcher.onFileChange("a.md");
    watcher.onFileChange("b.md");
    watcher.onFileChange("c.md");

    vi.advanceTimersByTime(600);

    expect(callback).toHaveBeenCalledTimes(1);
    const flush = callback.mock.calls[0][0];
    expect(flush.changedFiles).toEqual(new Set(["a.md", "b.md", "c.md"]));
  });

  it("fires again after debounce window resets", () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);

    watcher.onFileChange("first.md");
    vi.advanceTimersByTime(600);
    expect(callback).toHaveBeenCalledTimes(1);

    watcher.onFileChange("second.md");
    vi.advanceTimersByTime(600);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("tracks deletes separately from changes", () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);

    watcher.onFileDeleted("old.md");
    vi.advanceTimersByTime(600);

    expect(callback).toHaveBeenCalledTimes(1);
    const flush = callback.mock.calls[0][0];
    expect(flush.changedFiles).toEqual(new Set());
    expect(flush.deletedFiles).toEqual(new Set(["old.md"]));
  });

  it("rename: delete then create moves file from deleted to changed", () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);

    // Obsidian rename fires delete(oldPath) then create(newPath)
    watcher.onFileDeleted("Untitled.md");
    watcher.onFileChange("Notes.md");

    vi.advanceTimersByTime(600);

    const flush = callback.mock.calls[0][0];
    expect(flush.changedFiles).toEqual(new Set(["Notes.md"]));
    expect(flush.deletedFiles).toEqual(new Set(["Untitled.md"]));
  });

  it("create then delete within debounce cancels the change", () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);

    watcher.onFileChange("temp.md");
    watcher.onFileDeleted("temp.md");

    vi.advanceTimersByTime(600);

    const flush = callback.mock.calls[0][0];
    expect(flush.changedFiles).toEqual(new Set());
    expect(flush.deletedFiles).toEqual(new Set(["temp.md"]));
  });

  it("re-create after delete moves file back to changed", () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);

    // File deleted then re-created with same name
    watcher.onFileDeleted("test.md");
    watcher.onFileChange("test.md");

    vi.advanceTimersByTime(600);

    const flush = callback.mock.calls[0][0];
    expect(flush.changedFiles).toEqual(new Set(["test.md"]));
    expect(flush.deletedFiles).toEqual(new Set());
  });

  it("hasPending returns false when no pending changes", () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);
    expect(watcher.hasPending()).toBe(false);
  });

  it("hasPending returns true when changes are pending", async () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);

    watcher.onFileChange("test.md");
    expect(watcher.hasPending()).toBe(true);

    await vi.advanceTimersByTimeAsync(600);
    expect(watcher.hasPending()).toBe(false);
  });

  it("hasPending returns true when deletes are pending", async () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);

    watcher.onFileDeleted("test.md");
    expect(watcher.hasPending()).toBe(true);

    await vi.advanceTimersByTimeAsync(600);
    expect(watcher.hasPending()).toBe(false);
  });

  it("getPendingPaths returns union of changes and deletes", () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);

    watcher.onFileChange("new.md");
    watcher.onFileDeleted("old.md");

    const pending = watcher.getPendingPaths();
    expect(pending).toEqual(new Set(["new.md", "old.md"]));
  });

  it("getPendingPaths returns empty set when nothing pending", () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);

    expect(watcher.getPendingPaths()).toEqual(new Set());
  });

  it("hasPending includes in-flight flush paths while callback is running", async () => {
    let resolveCallback!: () => void;
    const callbackPromise = new Promise<void>((r) => { resolveCallback = r; });
    const callback = vi.fn(() => callbackPromise);
    const watcher = new FileWatcher(500, callback);

    watcher.onFileChange("test.md");
    expect(watcher.hasPending()).toBe(true);

    // Fire debounce — pendingChanges cleared, but callback is still running
    vi.advanceTimersByTime(600);
    expect(callback).toHaveBeenCalledTimes(1);
    // activeFlush should keep hasPending true while callback hasn't resolved
    expect(watcher.hasPending()).toBe(true);
    expect(watcher.getPendingPaths()).toEqual(new Set(["test.md"]));

    // Resolve the callback — activeFlush cleared after the async finally runs
    resolveCallback();
    // Drain all pending microtasks and timers
    await vi.runAllTimersAsync();
    expect(watcher.hasPending()).toBe(false);
    expect(watcher.getPendingPaths()).toEqual(new Set());
  });

  it("activeFlush is cleared even if callback throws", async () => {
    let rejectCallback!: (err: Error) => void;
    const callbackPromise = new Promise<void>((_, reject) => { rejectCallback = reject; });
    // Wrap to prevent unhandled rejection — the watcher's try/finally still runs
    const callback = vi.fn(() => callbackPromise.catch(() => {}));
    const watcher = new FileWatcher(500, callback);

    watcher.onFileChange("test.md");
    vi.advanceTimersByTime(600);
    expect(watcher.hasPending()).toBe(true);

    // Reject the underlying promise
    rejectCallback(new Error("sync failed"));
    await vi.runAllTimersAsync();

    expect(watcher.hasPending()).toBe(false);
    expect(watcher.getPendingPaths()).toEqual(new Set());
  });

  it("onFileRenamed: single rename produces origin delete and new push", () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);

    watcher.onFileRenamed("Notes.md", "Untitled.md");
    vi.advanceTimersByTime(600);

    const flush = callback.mock.calls[0][0];
    expect(flush.changedFiles).toEqual(new Set(["Notes.md"]));
    expect(flush.deletedFiles).toEqual(new Set(["Untitled.md"]));
  });

  it("onFileRenamed: chained renames collapse to origin → final", () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);

    // Simulates typing "Hi from mac!" keystroke by keystroke
    watcher.onFileRenamed("H.md", "Untitled.md");
    watcher.onFileRenamed("Hi.md", "H.md");
    watcher.onFileRenamed("Hi .md", "Hi.md");
    watcher.onFileRenamed("Hi f.md", "Hi .md");
    watcher.onFileRenamed("Hi from mac!.md", "Hi f.md");

    vi.advanceTimersByTime(600);

    const flush = callback.mock.calls[0][0];
    // Only the final name should be pushed
    expect(flush.changedFiles).toEqual(new Set(["Hi from mac!.md"]));
    // Only the original name should be deleted from remote
    expect(flush.deletedFiles).toEqual(new Set(["Untitled.md"]));
  });

  it("onFileRenamed: chained renames don't include intermediates", () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);

    watcher.onFileRenamed("B.md", "A.md");
    watcher.onFileRenamed("C.md", "B.md");
    watcher.onFileRenamed("D.md", "C.md");

    vi.advanceTimersByTime(600);

    const flush = callback.mock.calls[0][0];
    expect(flush.changedFiles).toEqual(new Set(["D.md"]));
    expect(flush.deletedFiles).toEqual(new Set(["A.md"]));
    // No intermediate paths
    expect(flush.changedFiles.has("B.md")).toBe(false);
    expect(flush.changedFiles.has("C.md")).toBe(false);
    expect(flush.deletedFiles.has("B.md")).toBe(false);
    expect(flush.deletedFiles.has("C.md")).toBe(false);
  });

  it("onFileRenamed: rename chain resets after flush", () => {
    const callback = vi.fn();
    const watcher = new FileWatcher(500, callback);

    watcher.onFileRenamed("B.md", "A.md");
    vi.advanceTimersByTime(600);

    // New rename after flush — should not carry over old chain
    watcher.onFileRenamed("C.md", "B.md");
    vi.advanceTimersByTime(600);

    expect(callback).toHaveBeenCalledTimes(2);
    const flush2 = callback.mock.calls[1][0];
    expect(flush2.changedFiles).toEqual(new Set(["C.md"]));
    expect(flush2.deletedFiles).toEqual(new Set(["B.md"]));
  });
});
