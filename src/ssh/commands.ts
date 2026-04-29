import { exec } from "child_process";
import { promisify } from "util";
import { RsyncResult } from "../types";

const execAsync = promisify(exec);

interface RsyncOptions {
  localPath: string;
  sshHost: string;
  remotePath: string;
  relativePath?: string;
  excludePatterns?: readonly string[];
  deleteFlag?: boolean;
}

function buildExcludeFlags(patterns: readonly string[] = []): string {
  return patterns.map((p) => `--exclude='${p}'`).join(" ");
}

/**
 * Quote a local filesystem path for the local shell. Uses single quotes to
 * prevent expansion of $, `, !, etc. Embedded single quotes are escaped
 * with the close-escape-reopen idiom: 'foo'\''bar'
 */
function quoteLocalPath(localPath: string): string {
  return `'${localPath.replace(/'/g, "'\\''")}'`;
}

/**
 * Escape a remote path for rsync. Rsync passes the remote path through the
 * remote shell, so spaces and shell metacharacters must be escaped with
 * backslashes. The local path only needs local shell quoting (double quotes).
 *
 * Note: ~ is intentionally NOT escaped. A leading ~/ must be expanded by the
 * remote shell to resolve to the user's home directory. In other positions,
 * ~ is already literal and harmless.
 */
export function escapeRemotePath(remotePath: string): string {
  return remotePath.replace(/([ '"\\`#&;|()$!?*\[\]{}])/g, "\\$1");
}

/**
 * Escape a path for use inside a single-quoted SSH command argument.
 * Single quotes cannot be escaped inside single quotes, so we close the
 * single quote, add an escaped single quote, and reopen: 'foo'\''bar'
 *
 * A leading ~/ is kept outside the single quotes so the remote shell
 * expands it to the user's home directory.
 */
function quoteSshPath(remotePath: string): string {
  if (remotePath.startsWith("~/")) {
    const rest = remotePath.slice(2).replace(/'/g, "'\\''");
    return `~/'${rest}'`;
  }
  return `'${remotePath.replace(/'/g, "'\\''")}'`;
}

export function buildRsyncPushCommand(opts: RsyncOptions): string {
  const excludes = buildExcludeFlags(opts.excludePatterns);
  if (opts.relativePath) {
    const src = quoteLocalPath(`${opts.localPath}/${opts.relativePath}`);
    const remoteDst = escapeRemotePath(`${opts.remotePath}/${opts.relativePath}`);
    const dst = `${opts.sshHost}:${remoteDst}`;
    return `rsync -az --update --itemize-changes -e "ssh" ${excludes} ${src} "${dst}"`.replace(/\s+/g, " ").trim();
  }
  // Full-directory push: --delete removes files on remote that don't exist locally
  const deleteOpt = opts.deleteFlag === false ? "" : "--delete";
  const src = quoteLocalPath(`${opts.localPath}/`);
  const remoteDst = escapeRemotePath(`${opts.remotePath}/`);
  const dst = `${opts.sshHost}:${remoteDst}`;
  return `rsync -az --update --itemize-changes ${deleteOpt} -e "ssh" ${excludes} ${src} "${dst}"`.replace(/\s+/g, " ").trim();
}

export function buildRsyncPullCommand(opts: RsyncOptions): string {
  const excludes = buildExcludeFlags(opts.excludePatterns);
  if (opts.relativePath) {
    const remoteSrc = escapeRemotePath(`${opts.remotePath}/${opts.relativePath}`);
    const src = `${opts.sshHost}:${remoteSrc}`;
    const dst = quoteLocalPath(`${opts.localPath}/${opts.relativePath}`);
    return `rsync -az --update --itemize-changes -e "ssh" ${excludes} "${src}" ${dst}`.replace(/\s+/g, " ").trim();
  }
  const deleteOpt = opts.deleteFlag === false ? "" : "--delete";
  const remoteSrc = escapeRemotePath(`${opts.remotePath}/`);
  const src = `${opts.sshHost}:${remoteSrc}`;
  const dst = quoteLocalPath(`${opts.localPath}/`);
  return `rsync -az --update --itemize-changes ${deleteOpt} -e "ssh" ${excludes} "${src}" ${dst}`.replace(/\s+/g, " ").trim();
}

export function buildRsyncDryRunCommand(opts: RsyncOptions): string {
  const excludes = buildExcludeFlags(opts.excludePatterns);
  const remoteSrc = escapeRemotePath(`${opts.remotePath}/`);
  const src = `${opts.sshHost}:${remoteSrc}`;
  const dst = quoteLocalPath(`${opts.localPath}/`);
  return `rsync -az --update --itemize-changes --delete --dry-run -e "ssh" ${excludes} "${src}" ${dst}`.replace(/\s+/g, " ").trim();
}

export function buildMkdirCommand(sshHost: string, remotePath: string): string {
  return `ssh "${sshHost}" "mkdir -p ${quoteSshPath(remotePath)}"`;
}

export function buildLsCommand(sshHost: string, remotePath: string): string {
  return `ssh "${sshHost}" "ls ${quoteSshPath(remotePath)}"`;
}

export function buildRmCommand(sshHost: string, remotePath: string): string {
  return `ssh "${sshHost}" "rm ${quoteSshPath(remotePath)}"`;
}

export function buildRmdirCommand(sshHost: string, remotePath: string): string {
  return `ssh "${sshHost}" "rmdir ${quoteSshPath(remotePath)}"`;
}

/**
 * Build an SSH command to stat multiple remote files and return their
 * modification times as epoch seconds. Uses `stat -c %Y` (GNU/Linux).
 * For each file, outputs: <epoch_seconds> <relative_path>
 * Non-existent files produce a stderr line but no stdout line.
 */
export function buildStatCommand(sshHost: string, remotePath: string, files: readonly string[]): string {
  // Build a stat command that outputs "<mtime> <file>" for each file.
  // Using a for loop to handle files individually so missing files don't
  // abort the entire command.
  const statCmds = files
    .map((f) => {
      const fullRemote = `${remotePath}/${f}`;
      // Use stat -c for GNU coreutils; fall back to stat -f for BSD/macOS
      return `stat -c '%Y ${f}' ${quoteSshPath(fullRemote)} 2>/dev/null || stat -f '%m ${f}' ${quoteSshPath(fullRemote)} 2>/dev/null`;
    })
    .join("; ");
  return `ssh "${sshHost}" "${statCmds}"`;
}

export async function executeCommand(
  command: string,
  timeoutMs = 30000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      // GNU rsync 3.2.4+ auto-escapes spaces and shell metacharacters in
      // remote paths. Since we already escape via escapeRemotePath(), this
      // causes double-escaping on Linux. RSYNC_OLD_ARGS=1 disables the
      // auto-escaping so our manual escaping works on both GNU rsync and
      // macOS openrsync (which ignores this env var).
      env: { ...process.env, RSYNC_OLD_ARGS: "1" },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err) {
      const execErr = err as unknown as { code: string | number; stdout: string; stderr: string };
      return {
        stdout: execErr.stdout || "",
        stderr: execErr.stderr || err.message,
        exitCode: typeof execErr.code === "number" ? execErr.code : 1,
      };
    }
    return { stdout: "", stderr: (err as Error).message, exitCode: 1 };
  }
}

export function parseRsyncOutput(stdout: string): { changedFiles: string[]; deletedFiles: string[] } {
  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];

  if (stdout) {
    const lines = stdout.trim().split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("*deleting")) {
        // Format: "*deleting   path/to/file"
        const filePath = trimmed.replace(/^\*deleting\s+/, "");
        if (filePath.length > 0 && !filePath.endsWith("/")) {
          deletedFiles.push(filePath);
        }
      } else if (/^[<>]f/.test(trimmed)) {
        // Format: ">f..t...... path/to/file" or "<f..t...... path/to/file"
        // Extract file path after the itemize flags (11 chars + space)
        const filePath = trimmed.replace(/^[<>]f[^\s]*\s+/, "");
        if (filePath.length > 0) {
          changedFiles.push(filePath);
        }
      }
    }
  }

  return { changedFiles, deletedFiles };
}

export async function runRsync(
  command: string,
  timeoutMs = 60000
): Promise<RsyncResult> {
  const result = await executeCommand(command, timeoutMs);
  const { changedFiles, deletedFiles } = parseRsyncOutput(result.stdout);

  return {
    changedFiles,
    deletedFiles,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}
