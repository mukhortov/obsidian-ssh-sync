import * as fs from "fs";
import * as path from "path";
import { SyncConfig } from "../types";
import { ManifestStore } from "./manifest";
import { ConflictResolver } from "./conflict";
import { hashFile } from "../utils/file-hash";
import {
  buildRsyncPushCommand,
  buildRsyncPullCommand,
  buildRsyncDryRunCommand,
  buildMkdirCommand,
  buildLsCommand,
  buildRmCommand,
  executeCommand,
  runRsync,
} from "../ssh/commands";

export interface SyncResult {
  success: boolean;
  changedFiles: string[];
  conflicts: number;
  error?: string;
}

export class SyncEngine {
  private manifest: ManifestStore;
  private conflictResolver: ConflictResolver;

  constructor(
    private config: SyncConfig,
    private vaultPath: string,
    manifestPath: string
  ) {
    this.manifest = new ManifestStore(manifestPath);
    this.conflictResolver = new ConflictResolver(vaultPath);
  }

  getConflictResolver(): ConflictResolver {
    return this.conflictResolver;
  }

  getManifest(): ManifestStore {
    return this.manifest;
  }

  async ensureRemoteDir(): Promise<boolean> {
    const cmd = buildMkdirCommand(this.config.sshHost, this.config.remotePath);
    const result = await executeCommand(cmd, 15000);
    return result.exitCode === 0;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    const cmd = buildLsCommand(this.config.sshHost, this.config.remotePath);
    const result = await executeCommand(cmd, 15000);
    if (result.exitCode === 0) {
      return { success: true };
    }
    return { success: false, error: result.stderr };
  }

  async pushFile(relativePath: string): Promise<{ success: boolean; error?: string }> {
    const fullPath = path.join(this.vaultPath, relativePath);
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: "File not found" };
    }

    // Ensure remote parent directory exists before single-file rsync.
    // rsync does not auto-create intermediate directories for single-file transfers.
    const parentDir = path.posix.dirname(relativePath);
    if (parentDir && parentDir !== ".") {
      const mkdirCmd = buildMkdirCommand(
        this.config.sshHost,
        `${this.config.remotePath}/${parentDir}`
      );
      const mkdirResult = await executeCommand(mkdirCmd, 15000);
      if (mkdirResult.exitCode !== 0) {
        return { success: false, error: `Failed to create remote directory: ${mkdirResult.stderr}` };
      }
    }

    const cmd = buildRsyncPushCommand({
      localPath: this.vaultPath,
      sshHost: this.config.sshHost,
      remotePath: this.config.remotePath,
      relativePath,
      excludePatterns: this.config.excludePatterns,
    });

    const result = await runRsync(cmd);
    if (result.exitCode === 0) {
      const stat = fs.statSync(fullPath);
      const hash = await hashFile(fullPath);
      this.manifest.setEntry(relativePath, {
        path: relativePath,
        localMtime: stat.mtimeMs,
        remoteMtime: stat.mtimeMs,
        lastSyncedMtime: stat.mtimeMs,
        size: stat.size,
        hash,
      });
      this.manifest.save();
      if (result.changedFiles.length > 0) {
        this.conflictResolver.addLog({
          type: "push",
          path: relativePath,
          message: "Pushed to remote",
        });
      }
      return { success: true };
    }
    this.conflictResolver.addLog({
      type: "error",
      path: relativePath,
      message: `Push failed: ${result.stderr}`,
    });
    return { success: false, error: result.stderr };
  }

  async deleteRemoteFile(relativePath: string): Promise<{ success: boolean; error?: string }> {
    const remotePath = `${this.config.remotePath}/${relativePath}`;
    const cmd = buildRmCommand(this.config.sshHost, remotePath);
    const result = await executeCommand(cmd, 15000);

    // Remove from manifest regardless — the file is gone locally
    this.manifest.removeEntry(relativePath);
    this.manifest.save();

    if (result.exitCode === 0) {
      this.conflictResolver.addLog({
        type: "delete",
        path: relativePath,
        message: "Deleted from remote",
      });
      return { success: true };
    }

    // Exit code 1 with "No such file" is fine — already gone
    if (result.stderr.includes("No such file")) {
      return { success: true };
    }

    this.conflictResolver.addLog({
      type: "error",
      path: relativePath,
      message: `Remote delete failed: ${result.stderr}`,
    });
    return { success: false, error: result.stderr };
  }

  async pushAll(): Promise<SyncResult> {
    return this.pushAllInternal(true);
  }

  /**
   * Push all local files to remote WITHOUT --delete. Safe for fullSync because
   * it will never remove remote-only files — only add/update files on the remote.
   */
  async pushAllWithoutDelete(): Promise<SyncResult> {
    return this.pushAllInternal(false);
  }

  private async pushAllInternal(deleteFlag: boolean): Promise<SyncResult> {
    const cmd = buildRsyncPushCommand({
      localPath: this.vaultPath,
      sshHost: this.config.sshHost,
      remotePath: this.config.remotePath,
      excludePatterns: this.config.excludePatterns,
      deleteFlag,
    });

    const result = await runRsync(cmd, 120000);
    if (result.exitCode === 0) {
      // Create manifest entries for each pushed file so subsequent polls
      // can detect conflicts (local mtime vs lastSyncedMtime).
      for (const file of result.changedFiles) {
        const fullPath = path.join(this.vaultPath, file);
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath);
          const hash = await hashFile(fullPath);
          this.manifest.setEntry(file, {
            path: file,
            localMtime: stat.mtimeMs,
            remoteMtime: stat.mtimeMs,
            lastSyncedMtime: stat.mtimeMs,
            size: stat.size,
            hash,
          });
        }
      }
      if (deleteFlag) {
        for (const file of result.deletedFiles) {
          this.manifest.removeEntry(file);
        }
      }
      this.manifest.setLastSyncTime(Date.now());
      this.manifest.save();
      const totalChanges = result.changedFiles.length + result.deletedFiles.length;
      if (totalChanges > 0) {
        this.conflictResolver.addLog({
          type: "push",
          path: "*",
          message: `Full push: ${result.changedFiles.length} synced, ${result.deletedFiles.length} deleted`,
        });
      }
      return { success: true, changedFiles: result.changedFiles, conflicts: 0 };
    }
    this.conflictResolver.addLog({
      type: "error",
      path: "*",
      message: `Full push failed: ${result.stderr}`,
    });
    return { success: false, changedFiles: [], conflicts: 0, error: result.stderr };
  }

  async detectRemoteChanges(): Promise<{ changedFiles: string[]; deletedFiles: string[] }> {
    const cmd = buildRsyncDryRunCommand({
      localPath: this.vaultPath,
      sshHost: this.config.sshHost,
      remotePath: this.config.remotePath,
      excludePatterns: this.config.excludePatterns,
    });

    const result = await runRsync(cmd);
    return {
      changedFiles: result.changedFiles,
      deletedFiles: result.deletedFiles,
    };
  }

  async pull(): Promise<SyncResult> {
    return this.pullInternal(true);
  }

  /**
   * Pull remote changes WITHOUT --delete. Safe for polling because it will
   * never remove local files — only add/update files from the remote side.
   */
  async pullWithoutDelete(): Promise<SyncResult> {
    return this.pullInternal(false);
  }

  private async pullInternal(deleteFlag: boolean): Promise<SyncResult> {
    const cmd = buildRsyncPullCommand({
      localPath: this.vaultPath,
      sshHost: this.config.sshHost,
      remotePath: this.config.remotePath,
      excludePatterns: this.config.excludePatterns,
      deleteFlag,
    });

    const result = await runRsync(cmd, 120000);
    if (result.exitCode === 0) {
      for (const file of result.changedFiles) {
        const fullPath = path.join(this.vaultPath, file);
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath);
          const hash = await hashFile(fullPath);
          this.manifest.setEntry(file, {
            path: file,
            localMtime: stat.mtimeMs,
            remoteMtime: stat.mtimeMs,
            lastSyncedMtime: stat.mtimeMs,
            size: stat.size,
            hash,
          });
        }
      }
      if (deleteFlag) {
        for (const file of result.deletedFiles) {
          this.manifest.removeEntry(file);
        }
      }
      this.manifest.setLastSyncTime(Date.now());
      this.manifest.save();
      const totalChanges = result.changedFiles.length + result.deletedFiles.length;
      if (totalChanges > 0) {
        this.conflictResolver.addLog({
          type: "pull",
          path: "*",
          message: `Pulled: ${result.changedFiles.length} synced, ${result.deletedFiles.length} deleted`,
        });
      }
      return { success: true, changedFiles: result.changedFiles, conflicts: 0 };
    }
    this.conflictResolver.addLog({
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
  deleteLocalFiles(files: string[], skipPaths: Set<string>): string[] {
    const deleted: string[] = [];
    for (const file of files) {
      if (skipPaths.has(file)) {
        this.conflictResolver.addLog({
          type: "pull",
          path: file,
          message: "Skipped local delete — file has pending local changes",
        });
        continue;
      }
      const fullPath = path.join(this.vaultPath, file);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        this.manifest.removeEntry(file);
        deleted.push(file);
        this.conflictResolver.addLog({
          type: "delete",
          path: file,
          message: "Deleted locally (removed from remote)",
        });
      } else {
        this.manifest.removeEntry(file);
      }
    }
    if (deleted.length > 0) {
      this.manifest.save();
    }
    return deleted;
  }

  async fullSync(): Promise<SyncResult> {
    // Push without --delete to avoid removing remote-only files before pull
    // can retrieve them. The pull with --delete will then clean up local files
    // that don't exist on remote.
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
