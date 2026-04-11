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
  path: string;
  localMtime: number;
  remoteMtime: number;
  lastSyncedMtime: number;
  size: number;
  hash: string;
}

export interface ManifestData {
  files: Record<string, ManifestEntry>;
  lastSyncTime: number;
}

export interface ConflictInfo {
  localPath: string;
  localMtime: number;
  remoteMtime: number;
  winner: "local" | "remote";
  backupPath: string;
  timestamp: number;
}

export interface SyncLogEntry {
  timestamp: number;
  type: "push" | "pull" | "conflict" | "error" | "rename" | "delete";
  path: string;
  message: string;
}

export interface RsyncResult {
  changedFiles: string[];
  deletedFiles: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export const MIN_POLL_INTERVAL_SECONDS = 5;

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
  excludePatterns: [".git/**", "node_modules/**", ".DS_Store", "*.swp", ".obsidian/plugins/obsidian-ssh-sync/sync-manifest.json", ".obsidian/plugins/obsidian-ssh-sync/sync-log.json"],
  conflictPolicy: "remote-wins",
};
