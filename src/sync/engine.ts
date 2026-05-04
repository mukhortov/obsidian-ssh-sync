import * as fsp from "fs/promises";
import * as path from "path";
import { SyncConfig } from "../types";
import { ManifestStore } from "./manifest";
import { ConflictResolver } from "./conflict";
import { SyncLog } from "./sync-log";
import { Transport } from "./transport";
import { SshTransport } from "./ssh-transport";
import { hashFile } from "../utils/file-hash";

export interface SyncResult {
  readonly success: boolean;
  readonly changedFiles: readonly string[];
  readonly conflicts: number;
  readonly error?: string;
}

export class SyncEngine {
  private manifest: ManifestStore;
  private conflictResolver: ConflictResolver;
  private syncLog: SyncLog;
  private transport: Transport;

  constructor(
    private config: SyncConfig,
    private vaultPath: string,
    manifestPath: string,
    syncLog?: SyncLog,
    transport?: Transport
  ) {
    this.manifest = new ManifestStore(manifestPath);
    const logPath = path.join(
      path.dirname(manifestPath),
      "sync-log.json"
    );
    this.syncLog = syncLog ?? new SyncLog(logPath);
    this.conflictResolver = new ConflictResolver(vaultPath, this.syncLog);
    this.transport = transport ?? new SshTransport(() => config.sshHost);
  }

  /** Return a shallow copy of all manifest entries. */
  getManifestEntries(): Record<string, import("../types").ManifestEntry> {
    return this.manifest.getEntries();
  }

  /** Return a copy of the sync log entries. */
  getSyncLogEntries(): import("../types").SyncLogEntry[] {
    return this.syncLog.getEntries();
  }

  /** Append an entry to the sync log. */
  async appendLog(entry: Omit<import("../types").SyncLogEntry, "timestamp">): Promise<void> {
    await this.syncLog.append(entry);
  }

  /**
   * Resolve a conflict for a single file.
   * When the winner is "remote", backs up the local version and logs the conflict.
   * When the winner is "local", just logs that local wins.
   */
  async resolveConflict(
    file: string,
    winner: "local" | "remote",
    localMtime: number,
    remoteMtime: number
  ): Promise<void> {
    if (winner === "remote") {
      const fullPath = path.join(this.vaultPath, file);
      let localContent = "";
      try {
        localContent = await fsp.readFile(fullPath, "utf-8");
      } catch {
        // File may not exist
      }
      await this.conflictResolver.resolveConflict(
        {
          localPath: fullPath,
          localMtime,
          remoteMtime,
          winner: "remote",
          backupPath: "",
          timestamp: Date.now(),
        },
        localContent
      );
    } else {
      await this.syncLog.append({
        type: "conflict",
        path: file,
        message: "Conflict resolved: local wins. Remote version discarded.",
      });
    }
  }

  /**
   * Access the underlying ManifestStore.
   * Intended for test helpers that need to seed/inspect manifest state.
   * Production code should not call this — use engine methods instead.
   */
  get _manifest(): ManifestStore {
    return this.manifest;
  }

  /**
   * Get local file modification times for the given relative paths.
   * Files that don't exist are omitted from the result.
   */
  async getLocalMtimes(files: readonly string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const file of files) {
      const fullPath = path.join(this.vaultPath, file);
      try {
        const stat = await fsp.stat(fullPath);
        result.set(file, stat.mtimeMs);
      } catch {
        // File doesn't exist — omit
      }
    }
    return result;
  }

  /**
   * Get remote file modification times for the given relative paths.
   * Delegates to the transport's statRemoteFiles.
   */
  async statRemoteFiles(files: readonly string[]): Promise<Map<string, number>> {
    return this.transport.statRemoteFiles(this.config.remotePath, files);
  }

  async ensureRemoteDir(): Promise<boolean> {
    const result = await this.transport.mkdir(this.config.remotePath);
    return result.exitCode === 0;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    const result = await this.transport.ls(this.config.remotePath);
    if (result.exitCode === 0) {
      return { success: true };
    }
    return { success: false, error: result.stderr };
  }

  async pushFile(relativePath: string): Promise<{ success: boolean; error?: string }> {
    const fullPath = path.join(this.vaultPath, relativePath);

    let stat: import("fs").Stats;
    try {
      stat = await fsp.stat(fullPath);
    } catch {
      return { success: false, error: "File not found" };
    }

    // Guard: reject directories — folders are synced implicitly via their contents.
    if (stat.isDirectory()) {
      return { success: false, error: "Path is a directory — folders are synced via their contents" };
    }

    // Ensure remote parent directory exists before single-file rsync.
    const parentDir = path.posix.dirname(relativePath);
    if (parentDir && parentDir !== ".") {
      const mkdirResult = await this.transport.mkdir(
        `${this.config.remotePath}/${parentDir}`
      );
      if (mkdirResult.exitCode !== 0) {
        return { success: false, error: `Failed to create remote directory: ${mkdirResult.stderr}` };
      }
    }

    const result = await this.transport.pushFile(
      this.vaultPath,
      this.config.remotePath,
      relativePath,
      this.config.excludePatterns
    );

    if (result.exitCode === 0) {
      const postStat = await fsp.stat(fullPath);
      const hash = await hashFile(fullPath);
      this.manifest.setEntry(relativePath, {
        path: relativePath,
        localMtime: postStat.mtimeMs,
        remoteMtime: postStat.mtimeMs,
        lastSyncedMtime: postStat.mtimeMs,
        size: postStat.size,
        hash,
      });
      await this.manifest.save();
      if (result.changedFiles.length > 0) {
        await this.syncLog.append({
          type: "push",
          path: relativePath,
          message: "Pushed to remote",
        });
      }
      return { success: true };
    }
    await this.syncLog.append({
      type: "error",
      path: relativePath,
      message: `Push failed: ${result.stderr}`,
    });
    return { success: false, error: result.stderr };
  }

  async deleteRemoteFile(relativePath: string): Promise<{ success: boolean; error?: string }> {
    const remotePath = `${this.config.remotePath}/${relativePath}`;
    const result = await this.transport.rm(remotePath);

    // Remove from manifest regardless — the file is gone locally
    this.manifest.removeEntry(relativePath);
    await this.manifest.save();

    if (result.exitCode === 0) {
      await this.syncLog.append({
        type: "delete",
        path: relativePath,
        message: "Deleted from remote",
      });
      // Clean up empty parent directories on remote (bottom-up)
      await this.cleanupEmptyRemoteDirs(relativePath);
      return { success: true };
    }

    // Exit code 1 with "No such file" is fine — already gone
    if (result.stderr.includes("No such file")) {
      return { success: true };
    }

    // "Is a directory" — folder path reached deleteRemoteFile.
    // Try rmdir to remove it if empty; if non-empty, succeed silently
    // (contents are managed by file-level deletes and fullSync --delete).
    if (result.stderr.includes("Is a directory")) {
      await this.transport.rmdir(remotePath);
      // rmdir succeeds (empty dir removed) or fails (non-empty) — both are OK
      return { success: true };
    }

    await this.syncLog.append({
      type: "error",
      path: relativePath,
      message: `Remote delete failed: ${result.stderr}`,
    });
    return { success: false, error: result.stderr };
  }

  /**
   * After deleting a file from remote, walk up the directory tree and
   * rmdir each parent. Stops at the first non-empty directory or at
   * the remote root. rmdir only removes empty directories, so this is
   * safe — it won't delete dirs that still have files.
   */
  private async cleanupEmptyRemoteDirs(relativePath: string): Promise<void> {
    let dir = path.posix.dirname(relativePath);
    while (dir && dir !== ".") {
      const remoteDirPath = `${this.config.remotePath}/${dir}`;
      const rmdirResult = await this.transport.rmdir(remoteDirPath);
      if (rmdirResult.exitCode !== 0) {
        // Directory not empty or doesn't exist — stop climbing
        break;
      }
      dir = path.posix.dirname(dir);
    }
  }

  async pushAll(): Promise<SyncResult> {
    return this.pushAllInternal(true);
  }

  async pushAllWithoutDelete(): Promise<SyncResult> {
    return this.pushAllInternal(false);
  }

  private async pushAllInternal(deleteFlag: boolean): Promise<SyncResult> {
    const result = await this.transport.pushAll(
      this.vaultPath,
      this.config.remotePath,
      this.config.excludePatterns,
      deleteFlag
    );

    if (result.exitCode === 0) {
      for (const file of result.changedFiles) {
        const fullPath = path.join(this.vaultPath, file);
        try {
          const stat = await fsp.stat(fullPath);
          const hash = await hashFile(fullPath);
          this.manifest.setEntry(file, {
            path: file,
            localMtime: stat.mtimeMs,
            remoteMtime: stat.mtimeMs,
            lastSyncedMtime: stat.mtimeMs,
            size: stat.size,
            hash,
          });
        } catch {
          // File may have been deleted between rsync and stat
        }
      }
      if (deleteFlag) {
        for (const file of result.deletedFiles) {
          this.manifest.removeEntry(file);
        }
      }
      this.manifest.setLastSyncTime(Date.now());
      await this.manifest.save();
      const totalChanges = result.changedFiles.length + result.deletedFiles.length;
      if (totalChanges > 0) {
        await this.syncLog.append({
          type: "push",
          path: "*",
          message: `Full push: ${result.changedFiles.length} synced, ${result.deletedFiles.length} deleted`,
        });
      }
      return { success: true, changedFiles: result.changedFiles, conflicts: 0 };
    }
    await this.syncLog.append({
      type: "error",
      path: "*",
      message: `Full push failed: ${result.stderr}`,
    });
    return { success: false, changedFiles: [], conflicts: 0, error: result.stderr };
  }

  async detectRemoteChanges(): Promise<{ changedFiles: readonly string[]; deletedFiles: readonly string[] }> {
    const result = await this.transport.dryRun(
      this.vaultPath,
      this.config.remotePath,
      this.config.excludePatterns
    );
    return {
      changedFiles: result.changedFiles,
      deletedFiles: result.deletedFiles,
    };
  }

  async pull(): Promise<SyncResult> {
    return this.pullInternal(true);
  }

  async pullWithoutDelete(): Promise<SyncResult> {
    return this.pullInternal(false);
  }

  private async pullInternal(deleteFlag: boolean): Promise<SyncResult> {
    const result = await this.transport.pullAll(
      this.vaultPath,
      this.config.remotePath,
      this.config.excludePatterns,
      deleteFlag
    );

    if (result.exitCode === 0) {
      // Fetch real remote mtimes for pulled files
      let remoteMtimes = new Map<string, number>();
      if (result.changedFiles.length > 0) {
        try {
          remoteMtimes = await this.transport.statRemoteFiles(
            this.config.remotePath,
            result.changedFiles
          );
        } catch {
          // If stat fails, fall back to local mtime (previous behaviour)
        }
      }

      for (const file of result.changedFiles) {
        const fullPath = path.join(this.vaultPath, file);
        try {
          const stat = await fsp.stat(fullPath);
          const hash = await hashFile(fullPath);
          this.manifest.setEntry(file, {
            path: file,
            localMtime: stat.mtimeMs,
            remoteMtime: remoteMtimes.get(file) ?? stat.mtimeMs,
            lastSyncedMtime: stat.mtimeMs,
            size: stat.size,
            hash,
          });
        } catch {
          // File may have been deleted between rsync and stat
        }
      }
      if (deleteFlag) {
        for (const file of result.deletedFiles) {
          this.manifest.removeEntry(file);
        }
      }
      this.manifest.setLastSyncTime(Date.now());
      await this.manifest.save();
      const totalChanges = result.changedFiles.length + result.deletedFiles.length;
      if (totalChanges > 0) {
        await this.syncLog.append({
          type: "pull",
          path: "*",
          message: `Pulled: ${result.changedFiles.length} synced, ${result.deletedFiles.length} deleted`,
        });
      }
      return { success: true, changedFiles: result.changedFiles, conflicts: 0 };
    }
    await this.syncLog.append({
      type: "error",
      path: "*",
      message: `Pull failed: ${result.stderr}`,
    });
    return { success: false, changedFiles: [], conflicts: 0, error: result.stderr };
  }

  /**
   * Delete specific local files that were detected as deleted on the remote.
   * Only deletes files that are safe to remove (not in the provided skip set).
   */
  async deleteLocalFiles(files: readonly string[], skipPaths: ReadonlySet<string>): Promise<string[]> {
    const deleted: string[] = [];
    for (const file of files) {
      if (skipPaths.has(file)) {
        await this.syncLog.append({
          type: "pull",
          path: file,
          message: "Skipped local delete — file has pending local changes",
        });
        continue;
      }
      const fullPath = path.join(this.vaultPath, file);
      try {
        await fsp.unlink(fullPath);
        this.manifest.removeEntry(file);
        deleted.push(file);
        await this.syncLog.append({
          type: "delete",
          path: file,
          message: "Deleted locally (removed from remote)",
        });
      } catch {
        // File doesn't exist — just clean up manifest
        this.manifest.removeEntry(file);
      }
    }
    if (deleted.length > 0) {
      await this.manifest.save();
    }
    return deleted;
  }

  async fullSync(): Promise<SyncResult> {
    const pushResult = await this.pushAllWithoutDelete();
    if (!pushResult.success) {
      return pushResult;
    }

    const pullResult = await this.pull();
    if (!pullResult.success) {
      return pullResult;
    }

    return {
      success: true,
      changedFiles: [...pushResult.changedFiles, ...pullResult.changedFiles],
      conflicts: 0,
    };
  }
}
