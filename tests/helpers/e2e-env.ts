import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { SyncConfig, DEFAULT_CONFIG } from "../../src/types";
import { SyncEngine } from "../../src/sync/engine";

/**
 * E2E configuration from environment variables.
 *
 * - E2E_SSH_HOST: SSH host to connect to (default: "localhost")
 * - E2E_REMOTE_PATH: Remote vault path to use (default: auto-created temp dir)
 *
 * When E2E_REMOTE_PATH is set, it is used as-is and NOT cleaned up on teardown.
 * The test runner must ensure the directory exists and is writable.
 *
 * Note: Remote file verification (remoteFileExists, readRemoteFile, createRemoteFile)
 * still uses local filesystem calls, so the remote path must be locally accessible.
 */
const E2E_SSH_HOST = process.env.E2E_SSH_HOST ?? "localhost";
const E2E_REMOTE_PATH = process.env.E2E_REMOTE_PATH ?? "/tmp";

export interface E2EEnv {
  localVaultPath: string;
  remoteVaultPath: string;
  sshHost: string;
  config: SyncConfig;
  engine: SyncEngine;
  cleanup: () => void;
}

/**
 * Check if SSH to the configured host is available.
 * Uses E2E_SSH_HOST env var, defaulting to "localhost".
 * Returns true if `ssh <host> true` succeeds.
 */
export function canRunE2E(): boolean {
  try {
    execSync(`ssh -o BatchMode=yes -o ConnectTimeout=2 ${E2E_SSH_HOST} true`, {
      stdio: "pipe",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the configured SSH host for e2e tests.
 */
export function getE2EHost(): string {
  return E2E_SSH_HOST;
}

/**
 * Create an e2e test environment with real local and "remote" directories.
 *
 * If E2E_REMOTE_PATH is set, uses that path (creates a unique subdirectory under it
 * to avoid test interference). Otherwise creates a temp directory.
 */
export function createE2EEnv(): E2EEnv {
  const localVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-sync-e2e-local-"));

  let remoteVaultPath: string;
  let ownsRemoteDir: boolean;

  if (E2E_REMOTE_PATH) {
    // Use configured path with a unique subdirectory per test
    remoteVaultPath = path.join(E2E_REMOTE_PATH, `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(remoteVaultPath, { recursive: true });
    ownsRemoteDir = true; // We created a subdirectory, safe to clean up
  } else {
    remoteVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-sync-e2e-remote-"));
    ownsRemoteDir = true;
  }

  const manifestPath = path.join(localVaultPath, "sync-manifest.json");

  const config: SyncConfig = {
    ...DEFAULT_CONFIG,
    enabled: true,
    sshHost: E2E_SSH_HOST,
    remotePath: remoteVaultPath,
    conflictPolicy: "remote-wins",
  };

  const engine = new SyncEngine(config, localVaultPath, manifestPath);

  return {
    localVaultPath,
    remoteVaultPath,
    sshHost: E2E_SSH_HOST,
    config,
    engine,
    cleanup: () => {
      fs.rmSync(localVaultPath, { recursive: true, force: true });
      if (ownsRemoteDir) {
        fs.rmSync(remoteVaultPath, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Create a file in the e2e local vault.
 */
export function createLocalFile(env: E2EEnv, relativePath: string, content: string): string {
  const fullPath = path.join(env.localVaultPath, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

/**
 * Create a file directly in the e2e "remote" directory (simulating a VPS change).
 */
export function createRemoteFile(env: E2EEnv, relativePath: string, content: string): string {
  const fullPath = path.join(env.remoteVaultPath, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

/**
 * Check if a file exists on the "remote" side.
 */
export function remoteFileExists(env: E2EEnv, relativePath: string): boolean {
  return fs.existsSync(path.join(env.remoteVaultPath, relativePath));
}

/**
 * Read file content from the "remote" side.
 */
export function readRemoteFile(env: E2EEnv, relativePath: string): string {
  return fs.readFileSync(path.join(env.remoteVaultPath, relativePath), "utf-8");
}
