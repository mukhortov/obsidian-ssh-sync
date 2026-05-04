import { RsyncResult } from "../types";
import { Transport } from "./transport";
import {
  buildRsyncPushCommand,
  buildRsyncPullCommand,
  buildRsyncDryRunCommand,
  buildMkdirCommand,
  buildLsCommand,
  buildRmCommand,
  buildRmdirCommand,
  buildStatCommand,
  executeCommand,
  runRsync,
} from "../ssh/commands";

/**
 * Real transport adapter — wraps ssh/commands.ts free functions.
 * Accepts a getter for sshHost so settings changes propagate immediately.
 */
export class SshTransport implements Transport {
  constructor(private getSshHost: () => string) {}

  private get sshHost(): string {
    return this.getSshHost();
  }

  async pushFile(
    localPath: string,
    remotePath: string,
    relativePath: string,
    excludePatterns: readonly string[]
  ): Promise<RsyncResult> {
    const cmd = buildRsyncPushCommand({
      localPath,
      sshHost: this.sshHost,
      remotePath,
      relativePath,
      excludePatterns,
    });
    return runRsync(cmd);
  }

  async pushAll(
    localPath: string,
    remotePath: string,
    excludePatterns: readonly string[],
    deleteFlag: boolean
  ): Promise<RsyncResult> {
    const cmd = buildRsyncPushCommand({
      localPath,
      sshHost: this.sshHost,
      remotePath,
      excludePatterns,
      deleteFlag,
    });
    return runRsync(cmd, 120000);
  }

  async pullAll(
    localPath: string,
    remotePath: string,
    excludePatterns: readonly string[],
    deleteFlag: boolean
  ): Promise<RsyncResult> {
    const cmd = buildRsyncPullCommand({
      localPath,
      sshHost: this.sshHost,
      remotePath,
      excludePatterns,
      deleteFlag,
    });
    return runRsync(cmd, 120000);
  }

  async dryRun(
    localPath: string,
    remotePath: string,
    excludePatterns: readonly string[]
  ): Promise<RsyncResult> {
    const cmd = buildRsyncDryRunCommand({
      localPath,
      sshHost: this.sshHost,
      remotePath,
      excludePatterns,
    });
    return runRsync(cmd);
  }

  async mkdir(remotePath: string): Promise<{ exitCode: number; stderr: string }> {
    const cmd = buildMkdirCommand(this.sshHost, remotePath);
    const result = await executeCommand(cmd, 15000);
    return { exitCode: result.exitCode, stderr: result.stderr };
  }

  async ls(remotePath: string): Promise<{ exitCode: number; stderr: string }> {
    const cmd = buildLsCommand(this.sshHost, remotePath);
    const result = await executeCommand(cmd, 15000);
    return { exitCode: result.exitCode, stderr: result.stderr };
  }

  async rm(remotePath: string): Promise<{ exitCode: number; stderr: string }> {
    const cmd = buildRmCommand(this.sshHost, remotePath);
    const result = await executeCommand(cmd, 15000);
    return { exitCode: result.exitCode, stderr: result.stderr };
  }

  async rmdir(remotePath: string): Promise<{ exitCode: number; stderr: string }> {
    const cmd = buildRmdirCommand(this.sshHost, remotePath);
    const result = await executeCommand(cmd, 15000);
    return { exitCode: result.exitCode, stderr: result.stderr };
  }

  async statRemoteFiles(remotePath: string, files: readonly string[]): Promise<Map<string, number>> {
    if (files.length === 0) return new Map();

    const cmd = buildStatCommand(this.sshHost, remotePath, files);
    const result = await executeCommand(cmd, 30000);
    const mtimes = new Map<string, number>();

    if (result.stdout) {
      for (const line of result.stdout.trim().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Format: "<epoch_seconds> <relative_path>"
        const spaceIdx = trimmed.indexOf(" ");
        if (spaceIdx === -1) continue;
        const epochStr = trimmed.slice(0, spaceIdx);
        const filePath = trimmed.slice(spaceIdx + 1);
        const epochSec = parseInt(epochStr, 10);
        if (!isNaN(epochSec) && filePath) {
          mtimes.set(filePath, epochSec * 1000); // convert to ms
        }
      }
    }

    return mtimes;
  }
}
