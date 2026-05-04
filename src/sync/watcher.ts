export interface WatcherFlush {
  readonly changedFiles: ReadonlySet<string>;
  readonly deletedFiles: ReadonlySet<string>;
}

/** Opaque timer handle — works in both Obsidian (number) and Node (Timeout). */
type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Detect paths with 3+ consecutive identical leading segments, indicating
 * a runaway recursive sync loop (e.g., "X/X/X/..." or "X/X/X/file.md").
 * Two identical segments (e.g., "notes/notes/file.md") are allowed since
 * users can legitimately create such structures.
 */
function hasRecursiveNesting(filePath: string): boolean {
  const segments = filePath.split("/");
  if (segments.length < 3) return false;
  // Check for 3 consecutive identical segments starting from the beginning
  for (let i = 0; i <= segments.length - 3; i++) {
    if (segments[i] === segments[i + 1] && segments[i + 1] === segments[i + 2]) {
      return true;
    }
  }
  return false;
}

function scheduleTimer(callback: () => void, delayMs: number): TimerHandle {
  if (typeof window !== "undefined") {
    return window.activeWindow.setTimeout(callback, delayMs) as unknown as TimerHandle;
  }
  // eslint-disable-next-line obsidianmd/prefer-active-window-timers -- Node test env fallback
  return setTimeout(callback, delayMs);
}

function cancelTimer(handle: TimerHandle): void {
  if (typeof window !== "undefined") {
    window.activeWindow.clearTimeout(handle as unknown as number);
  } else {
    // eslint-disable-next-line obsidianmd/prefer-active-window-timers -- Node test env fallback
    clearTimeout(handle);
  }
}

export class FileWatcher {
  private pendingChanges = new Set<string>();
  private pendingDeletes = new Set<string>();
  private activeFlush = new Set<string>();
  private timer: TimerHandle | null = null;

  /**
   * When > 0, all incoming events are suppressed. This prevents feedback
   * loops where a pull writes files to the vault, Obsidian detects the
   * changes, and the watcher pushes them right back.
   */
  private suppressUntil = 0;

  /**
   * Tracks rename chains: maps current path → original path.
   * e.g. if A→B→C, stores { C: A } so only A is deleted and C is pushed.
   */
  private renameOrigins = new Map<string, string>();

  constructor(
    private debounceMs: number,
    private onSync: (flush: WatcherFlush) => Promise<void>
  ) {}

  /**
   * Suppress all incoming events for the given duration. Use this before
   * any operation that writes files to the vault (pull, fullSync) to
   * prevent the watcher from pushing those files right back.
   */
  suppress(durationMs: number): void {
    this.suppressUntil = Date.now() + durationMs;
  }

  private isSuppressed(): boolean {
    return Date.now() < this.suppressUntil;
  }

  onFileChange(relativePath: string): void {
    if (this.isSuppressed()) return;
    if (hasRecursiveNesting(relativePath)) return;
    this.pendingChanges.add(relativePath);
    // If a file was deleted then re-created (rename target), remove from deletes
    this.pendingDeletes.delete(relativePath);
    this.scheduleSync();
  }

  onFileRenamed(newPath: string, oldPath: string): void {
    // Reject recursively-nested paths that indicate a sync feedback loop
    if (this.isSuppressed()) return;
    if (hasRecursiveNesting(newPath)) return;

    // Track the rename chain: if oldPath was itself renamed from an
    // earlier origin, carry that origin forward to newPath.
    const origin = this.renameOrigins.get(oldPath) ?? oldPath;
    this.renameOrigins.delete(oldPath);
    this.renameOrigins.set(newPath, origin);

    // Remove intermediate path from both pending sets — it's neither
    // the original (to be deleted) nor the final (to be pushed).
    this.pendingChanges.delete(oldPath);
    this.pendingDeletes.delete(oldPath);

    // Only the current (latest) name needs to be pushed
    this.pendingChanges.add(newPath);

    // Only the origin (first name before any renames) needs to be deleted
    // from remote. Don't add intermediates.
    if (origin !== newPath) {
      this.pendingDeletes.add(origin);
      // Remove origin from changes if it somehow ended up there
      this.pendingChanges.delete(origin);
    }

    this.scheduleSync();
  }

  onFileDeleted(relativePath: string): void {
    if (this.isSuppressed()) return;
    if (hasRecursiveNesting(relativePath)) return;
    this.pendingDeletes.add(relativePath);
    // If a file was changed then deleted (rename source), remove from changes
    this.pendingChanges.delete(relativePath);
    // Clean up any rename chain that targeted this path
    this.renameOrigins.delete(relativePath);
    this.scheduleSync();
  }

  private scheduleSync(): void {
    if (this.timer) {
      cancelTimer(this.timer);
    }
    this.timer = scheduleTimer(() => {
      void (async () => {
        const flush: WatcherFlush = {
          changedFiles: new Set(this.pendingChanges),
          deletedFiles: new Set(this.pendingDeletes),
        };
        // Track all flushed paths as "in-flight" until the callback completes.
        // This prevents the poller from deleting files that are being pushed.
        for (const f of flush.changedFiles) this.activeFlush.add(f);
        for (const f of flush.deletedFiles) this.activeFlush.add(f);
        this.pendingChanges.clear();
        this.pendingDeletes.clear();
        this.renameOrigins.clear();
        try {
          await this.onSync(flush);
        } finally {
          for (const f of flush.changedFiles) this.activeFlush.delete(f);
          for (const f of flush.deletedFiles) this.activeFlush.delete(f);
        }
      })();
    }, this.debounceMs);
  }

  hasPending(): boolean {
    return this.pendingChanges.size > 0 || this.pendingDeletes.size > 0 || this.activeFlush.size > 0;
  }

  /**
   * Immediately flush any pending changes, canceling the debounce timer.
   * Used by manualSync to ensure local deletions propagate to remote
   * before fullSync pulls remote state back to local.
   * Returns the flush result, or null if nothing was pending.
   */
  async flushNow(): Promise<WatcherFlush | null> {
    if (this.pendingChanges.size === 0 && this.pendingDeletes.size === 0) {
      return null;
    }
    // Cancel the debounce timer
    if (this.timer) {
      cancelTimer(this.timer);
      this.timer = null;
    }
    const flush: WatcherFlush = {
      changedFiles: new Set(this.pendingChanges),
      deletedFiles: new Set(this.pendingDeletes),
    };
    for (const f of flush.changedFiles) this.activeFlush.add(f);
    for (const f of flush.deletedFiles) this.activeFlush.add(f);
    this.pendingChanges.clear();
    this.pendingDeletes.clear();
    this.renameOrigins.clear();
    try {
      await this.onSync(flush);
    } finally {
      for (const f of flush.changedFiles) this.activeFlush.delete(f);
      for (const f of flush.deletedFiles) this.activeFlush.delete(f);
    }
    return flush;
  }

  /**
   * Returns a snapshot of all paths currently pending (queued, debouncing,
   * or in an active flush that hasn't completed yet).
   */
  getPendingPaths(): ReadonlySet<string> {
    return new Set([...this.pendingChanges, ...this.pendingDeletes, ...this.activeFlush]);
  }

  dispose(): void {
    if (this.timer) {
      cancelTimer(this.timer);
      this.timer = null;
    }
  }
}
