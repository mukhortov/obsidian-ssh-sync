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

export const DEFAULT_CONFIG: SyncConfig = {
  enabled: false,
  sshHost: "",
  remotePath: "",
  pollIntervalSeconds: 60,
  syncOnSave: true,
  excludePatterns: [".git/**", "node_modules/**", ".DS_Store", "*.swp", ".obsidian/plugins/obsidian-ssh-sync/sync-manifest.json", ".obsidian/plugins/obsidian-ssh-sync/sync-log.json"],
  conflictPolicy: "remote-wins",
};
