import { RsyncResult } from "../types";

/**
 * Transport seam — abstracts the shell commands that SyncEngine uses to
 * communicate with the remote server. The real adapter wraps ssh/commands.ts.
 * Tests can supply a fake to verify bookkeeping without SSH.
 */
export interface Transport {
  /** Push a single file to the remote. */
  pushFile(localPath: string, remotePath: string, relativePath: string, excludePatterns: readonly string[]): Promise<RsyncResult>;

  /** Push all files (full directory rsync). */
  pushAll(localPath: string, remotePath: string, excludePatterns: readonly string[], deleteFlag: boolean): Promise<RsyncResult>;

  /** Pull all files from the remote. */
  pullAll(localPath: string, remotePath: string, excludePatterns: readonly string[], deleteFlag: boolean): Promise<RsyncResult>;

  /** Dry-run pull to detect remote changes without transferring. */
  dryRun(localPath: string, remotePath: string, excludePatterns: readonly string[]): Promise<RsyncResult>;

  /** Create a directory on the remote. */
  mkdir(remotePath: string): Promise<{ exitCode: number; stderr: string }>;

  /** List a directory on the remote (used for connection test). */
  ls(remotePath: string): Promise<{ exitCode: number; stderr: string }>;

  /** Delete a file on the remote. */
  rm(remotePath: string): Promise<{ exitCode: number; stderr: string }>;

  /** Remove an empty directory on the remote. */
  rmdir(remotePath: string): Promise<{ exitCode: number; stderr: string }>;

  /**
   * Get modification times (epoch ms) for files on the remote.
   * Files that don't exist are omitted from the result.
   */
  statRemoteFiles(remotePath: string, files: readonly string[]): Promise<Map<string, number>>;
}
