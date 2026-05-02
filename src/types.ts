export type SyncStatus = "idle" | "syncing" | "error" | "disabled";

export type ConflictPolicy = "remote-wins" | "local-wins" | "newest-wins";

export interface SyncConfig {
  enabled: boolean;
  sshHost: string;
  remotePath: string;
  pollIntervalSeconds: number;
  syncOnSave: boolean;
  excludePatterns: string[];
  conflictPolicy: ConflictPolicy;
}

export interface ManifestEntry {
  readonly path: string;
  readonly localMtime: number;
  readonly remoteMtime: number;
  readonly lastSyncedMtime: number;
  readonly size: number;
  readonly hash: string;
}

export interface ManifestData {
  readonly files: Record<string, ManifestEntry>;
  readonly lastSyncTime: number;
}

export interface ConflictInfo {
  readonly localPath: string;
  readonly localMtime: number;
  readonly remoteMtime: number;
  readonly winner: "local" | "remote";
  readonly backupPath: string;
  readonly timestamp: number;
}

export interface SyncLogEntry {
  readonly timestamp: number;
  readonly type: "push" | "pull" | "conflict" | "error" | "rename" | "delete";
  readonly path: string;
  readonly message: string;
}

export interface RsyncResult {
  readonly changedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export const MIN_POLL_INTERVAL_SECONDS = 5;

/**
 * Parse and clamp a poll interval string to at least MIN_POLL_INTERVAL_SECONDS.
 * Returns MIN_POLL_INTERVAL_SECONDS for invalid or below-minimum input.
 */
export function clampPollInterval(input: string): number {
  const num = parseInt(input, 10);
  if (isNaN(num) || num < MIN_POLL_INTERVAL_SECONDS) {
    return MIN_POLL_INTERVAL_SECONDS;
  }
  return num;
}

/**
 * Pre-operation suppress: blocks watcher events while a sync operation
 * (pull, fullSync, deleteLocalFiles) is in progress. Set long enough to
 * cover any operation; replaced by SUPPRESS_POST_OP_MS on completion.
 */
export const SUPPRESS_PRE_OP_MS = 60000;

/**
 * Post-operation suppress: grace period after a sync operation completes,
 * giving Obsidian's filesystem watcher time to deliver its events before
 * the watcher resumes accepting them. Typically < 500ms is enough, but
 * 1s provides a safe margin without noticeably blocking user edits.
 */
export const SUPPRESS_POST_OP_MS = 1000;

export const DEFAULT_CONFIG: SyncConfig = {
  enabled: false,
  sshHost: "",
  remotePath: "",
  pollIntervalSeconds: 60,
  syncOnSave: true,
  excludePatterns: [".git/**", "node_modules/**", ".DS_Store", "*.swp", ".obsidian/plugins/ssh-sync/sync-manifest.json", ".obsidian/plugins/ssh-sync/sync-log.json"],
  conflictPolicy: "remote-wins",
};
