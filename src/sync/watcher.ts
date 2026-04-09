export interface WatcherFlush {
  changedFiles: Set<string>;
  deletedFiles: Set<string>;
}

export class FileWatcher {
  private pendingChanges = new Set<string>();
  private pendingDeletes = new Set<string>();
  private activeFlush = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Tracks rename chains: maps current path → original path.
   * e.g. if A→B→C, stores { C: A } so only A is deleted and C is pushed.
   */
  private renameOrigins = new Map<string, string>();

  constructor(
    private debounceMs: number,
    private onSync: (flush: WatcherFlush) => Promise<void>
  ) {}

  onFileChange(relativePath: string): void {
    this.pendingChanges.add(relativePath);
    // If a file was deleted then re-created (rename target), remove from deletes
    this.pendingDeletes.delete(relativePath);
    this.scheduleSync();
  }

  onFileRenamed(newPath: string, oldPath: string): void {
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
    this.pendingDeletes.add(relativePath);
    // If a file was changed then deleted (rename source), remove from changes
    this.pendingChanges.delete(relativePath);
    // Clean up any rename chain that targeted this path
    this.renameOrigins.delete(relativePath);
    this.scheduleSync();
  }

  private scheduleSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(async () => {
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
    }, this.debounceMs);
  }

  hasPending(): boolean {
    return this.pendingChanges.size > 0 || this.pendingDeletes.size > 0 || this.activeFlush.size > 0;
  }

  /**
   * Returns a snapshot of all paths currently pending (queued, debouncing,
   * or in an active flush that hasn't completed yet).
   */
  getPendingPaths(): Set<string> {
    return new Set([...this.pendingChanges, ...this.pendingDeletes, ...this.activeFlush]);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
