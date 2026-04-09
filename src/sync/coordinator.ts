import { SyncStatus, SyncConfig, SyncLogEntry, ManifestEntry, ConflictPolicy } from "../types";

// --- Types ---

export interface SyncState {
  readonly status: SyncStatus;
  readonly isSyncing: boolean;
  readonly hasPendingWatcherChanges: boolean;
}

export type SyncEffect =
  | { type: "pushFiles"; files: string[] }
  | { type: "pushAll" }
  | { type: "pullWithoutDelete" }
  | { type: "pullWithDelete" }
  | { type: "deleteRemoteFiles"; files: string[] }
  | { type: "deleteLocalFiles"; files: string[]; skipPaths: ReadonlySet<string> }
  | { type: "detectRemoteChanges" }
  | { type: "resolveConflict"; file: string; policy: ConflictPolicy; localMtime: number; remoteMtime: number }
  | { type: "pushFile"; file: string }
  | { type: "preserveLocalFile"; file: string }
  | { type: "notify"; message: string }
  | { type: "notifyError"; message: string }
  | { type: "updateStatus"; status: SyncStatus }
  | { type: "startPoller"; intervalMs: number }
  | { type: "stopPoller" }
  | { type: "fullSync" }
  | { type: "log"; entry: Omit<SyncLogEntry, "timestamp"> };

export interface SyncDecision {
  readonly state: SyncState;
  readonly effects: readonly SyncEffect[];
}

export interface FlushInput {
  readonly changedFiles: ReadonlySet<string>;
  readonly deletedFiles: ReadonlySet<string>;
}

export interface RemoteChanges {
  readonly changedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
}

// --- Pure functions ---

export function createInitialState(enabled: boolean): SyncState {
  return {
    status: enabled ? "idle" : "disabled",
    isSyncing: false,
    hasPendingWatcherChanges: false,
  };
}

/**
 * Decide what to do when the poller fires.
 * If there are pending watcher changes, skip the poll entirely.
 */
export function decidePollAction(
  state: SyncState,
  hasPending: boolean
): SyncDecision {
  if (hasPending) {
    return { state, effects: [] };
  }
  return {
    state: { ...state, status: "syncing" },
    effects: [
      { type: "updateStatus", status: "syncing" },
      { type: "detectRemoteChanges" },
    ],
  };
}

/**
 * Decide what to do after remote changes have been detected.
 * Handles: clean pulls, conflict detection, local-edit-vs-remote-delete,
 * and local-delete-vs-remote-edit cases.
 */
export function decidePullAction(
  state: SyncState,
  changes: RemoteChanges,
  manifestFiles: Readonly<Record<string, ManifestEntry>>,
  config: SyncConfig,
  pendingPaths: ReadonlySet<string>,
  localFileMtimes: ReadonlyMap<string, number>
): SyncDecision {
  const effects: SyncEffect[] = [];

  // No changes — return to idle
  if (changes.changedFiles.length === 0 && changes.deletedFiles.length === 0) {
    return {
      state: { ...state, status: "idle" },
      effects: [{ type: "updateStatus", status: "idle" }],
    };
  }

  // Handle changed files (remote has new/updated files)
  if (changes.changedFiles.length > 0) {
    const conflictFiles: string[] = [];
    const cleanPullFiles: string[] = [];
    const restoredFiles: string[] = [];

    for (const file of changes.changedFiles) {
      const entry = manifestFiles[file];
      const localMtime = localFileMtimes.get(file);

      if (!entry) {
        // New file from remote (no manifest entry) — clean pull
        // Also covers C3: local delete + remote edit. The file was deleted
        // locally (so no localMtime), manifest entry was removed by
        // deleteRemoteFile. Remote still has it → pull restores it.
        if (localMtime === undefined) {
          // File doesn't exist locally — check if it was recently in manifest
          // (would indicate a local delete + remote edit conflict)
          restoredFiles.push(file);
        }
        cleanPullFiles.push(file);
        continue;
      }

      if (localMtime === undefined) {
        // Entry exists but file gone locally — was deleted locally but
        // manifest not yet cleaned. Pull the remote version (C3).
        cleanPullFiles.push(file);
        restoredFiles.push(file);
        continue;
      }

      // Entry exists and file exists locally — check for conflict
      const localChanged = localMtime > entry.lastSyncedMtime;
      if (localChanged) {
        // Both sides changed — conflict (C1)
        conflictFiles.push(file);
        effects.push({
          type: "resolveConflict",
          file,
          policy: config.conflictPolicy,
          localMtime,
          remoteMtime: entry.remoteMtime,
        });
      } else {
        // Only remote changed — safe to pull
        cleanPullFiles.push(file);
      }
    }

    if (cleanPullFiles.length > 0) {
      effects.push({ type: "pullWithoutDelete" });
    }

    if (cleanPullFiles.length > 0 || conflictFiles.length > 0) {
      const parts: string[] = [];
      if (cleanPullFiles.length > 0) parts.push(`${cleanPullFiles.length} pulled`);
      if (conflictFiles.length > 0) parts.push(`${conflictFiles.length} conflict(s)`);
      if (restoredFiles.length > 0) parts.push(`${restoredFiles.length} restored`);
      effects.push({ type: "notify", message: `SSH Sync: ${parts.join(", ")}` });
    }

    for (const file of restoredFiles) {
      effects.push({
        type: "log",
        entry: {
          type: "conflict",
          path: file,
          message: "Conflict: remote edit restored file after local delete",
        },
      });
    }
  }

  // Handle deleted files (exist locally but not on remote)
  if (changes.deletedFiles.length > 0) {
    const safeToDelete: string[] = [];
    const locallyModified: string[] = [];

    for (const file of changes.deletedFiles) {
      if (pendingPaths.has(file)) {
        // Skip — file has pending local changes
        continue;
      }

      const entry = manifestFiles[file];
      const localMtime = localFileMtimes.get(file);

      if (entry && localMtime !== undefined && localMtime > entry.lastSyncedMtime) {
        // C2: Local edit + remote delete — local modification wins
        locallyModified.push(file);
      } else {
        safeToDelete.push(file);
      }
    }

    if (safeToDelete.length > 0) {
      effects.push({
        type: "deleteLocalFiles",
        files: safeToDelete,
        skipPaths: pendingPaths,
      });
      effects.push({
        type: "notify",
        message: `SSH Sync: ${safeToDelete.length} file(s) deleted (removed from remote)`,
      });
    }

    for (const file of locallyModified) {
      effects.push({ type: "preserveLocalFile", file });
      effects.push({ type: "pushFile", file });
      effects.push({
        type: "log",
        entry: {
          type: "conflict",
          path: file,
          message: "Conflict: local edit wins over remote delete — file restored to remote",
        },
      });
      effects.push({
        type: "notify",
        message: `SSH Sync: ${file} preserved (local edit wins over remote delete)`,
      });
    }
  }

  effects.push({ type: "updateStatus", status: "idle" });

  return {
    state: { ...state, status: "idle" },
    effects,
  };
}

/**
 * Decide what to do when the watcher flushes.
 */
export function decideFlushAction(
  state: SyncState,
  flush: FlushInput,
  enabled: boolean
): SyncDecision {
  if (!enabled) {
    return { state, effects: [] };
  }

  const effects: SyncEffect[] = [];
  effects.push({ type: "updateStatus", status: "syncing" });

  if (flush.changedFiles.size > 0) {
    effects.push({ type: "pushFiles", files: [...flush.changedFiles] });
  }

  if (flush.deletedFiles.size > 0) {
    effects.push({ type: "deleteRemoteFiles", files: [...flush.deletedFiles] });
  }

  return {
    state: { ...state, status: "syncing" },
    effects,
  };
}

/**
 * Decide what to do for a manual full sync.
 */
export function decideManualSyncAction(
  state: SyncState,
  engineAvailable: boolean
): SyncDecision {
  if (!engineAvailable) {
    return {
      state,
      effects: [
        { type: "notifyError", message: "Sync engine not initialized" },
      ],
    };
  }

  return {
    state: { ...state, status: "syncing" },
    effects: [
      { type: "updateStatus", status: "syncing" },
      { type: "notify", message: "SSH Sync: Starting full sync..." },
      { type: "fullSync" },
    ],
  };
}

/**
 * Decide what to do for syncing a single file.
 */
export function decideSyncFileAction(
  state: SyncState,
  activeFile: string | null,
  engineAvailable: boolean
): SyncDecision {
  if (!activeFile) {
    return {
      state,
      effects: [{ type: "notify", message: "SSH Sync: No active file" }],
    };
  }
  if (!engineAvailable) {
    return {
      state,
      effects: [{ type: "notify", message: "SSH Sync: Sync engine not initialized" }],
    };
  }

  return {
    state: { ...state, status: "syncing" },
    effects: [
      { type: "updateStatus", status: "syncing" },
      { type: "pushFile", file: activeFile },
    ],
  };
}

/**
 * Decide what to do when toggling sync on/off.
 */
export function decideToggleAction(
  state: SyncState,
  currentlyEnabled: boolean,
  pollIntervalMs: number
): SyncDecision {
  const nowEnabled = !currentlyEnabled;
  const effects: SyncEffect[] = [];

  if (nowEnabled) {
    effects.push({ type: "updateStatus", status: "idle" });
    effects.push({ type: "startPoller", intervalMs: pollIntervalMs });
    effects.push({ type: "notify", message: "SSH Sync enabled" });
  } else {
    effects.push({ type: "updateStatus", status: "disabled" });
    effects.push({ type: "stopPoller" });
    effects.push({ type: "notify", message: "SSH Sync disabled" });
  }

  return {
    state: {
      ...state,
      status: nowEnabled ? "idle" : "disabled",
    },
    effects,
  };
}

/**
 * Determine the conflict winner for a single file.
 * Returns "local" or "remote".
 */
export function resolveConflictWinner(
  policy: ConflictPolicy,
  localMtime: number,
  remoteMtime: number
): "local" | "remote" {
  switch (policy) {
    case "local-wins":
      return "local";
    case "remote-wins":
      return "remote";
    case "newest-wins":
      return localMtime >= remoteMtime ? "local" : "remote";
  }
}
