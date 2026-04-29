import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SyncConfig, DEFAULT_CONFIG, ManifestEntry } from "../../src/types";
import { SyncEngine } from "../../src/sync/engine";
import { SyncEffect } from "../../src/sync/coordinator";

export interface TestEnv {
  vaultPath: string;
  manifestPath: string;
  config: SyncConfig;
  engine: SyncEngine;
  cleanup: () => void;
}

export function createTestEnv(overrides?: Partial<SyncConfig>): TestEnv {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-sync-test-"));
  const manifestPath = path.join(vaultPath, "sync-manifest.json");

  const config: SyncConfig = {
    ...DEFAULT_CONFIG,
    enabled: true,
    sshHost: "user@host",
    remotePath: "/remote/vault",
    ...overrides,
  };

  const engine = new SyncEngine(config, vaultPath, manifestPath);

  return {
    vaultPath,
    manifestPath,
    config,
    engine,
    cleanup: () => fs.rmSync(vaultPath, { recursive: true, force: true }),
  };
}

/**
 * Create a file in the test vault and optionally seed its manifest entry.
 */
export async function createTestFile(
  env: TestEnv,
  relativePath: string,
  content: string,
  seedManifest = false
): string {
  const fullPath = path.join(env.vaultPath, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);

  if (seedManifest) {
    const stat = fs.statSync(fullPath);
    const crypto = require("crypto");
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    env.engine._manifest.setEntry(relativePath, {
      path: relativePath,
      localMtime: stat.mtimeMs,
      remoteMtime: stat.mtimeMs,
      lastSyncedMtime: stat.mtimeMs,
      size: stat.size,
      hash,
    });
    await env.engine._manifest.save();
  }

  return fullPath;
}

/**
 * Build a manifest entry for testing.
 */
export function makeManifestEntry(
  relativePath: string,
  overrides?: Partial<ManifestEntry>
): ManifestEntry {
  return {
    path: relativePath,
    localMtime: 1000,
    remoteMtime: 1000,
    lastSyncedMtime: 1000,
    size: 100,
    hash: "abc123",
    ...overrides,
  };
}

/**
 * Find a specific effect by type from a list of SyncEffects,
 * with proper type narrowing to avoid `as any` casts.
 */
export function findEffect<T extends SyncEffect["type"]>(
  effects: readonly SyncEffect[],
  type: T
): Extract<SyncEffect, { type: T }> | undefined {
  return effects.find((e): e is Extract<SyncEffect, { type: T }> => e.type === type);
}

/**
 * Filter effects by type from a list of SyncEffects,
 * with proper type narrowing to avoid `as any` casts.
 */
export function filterEffects<T extends SyncEffect["type"]>(
  effects: readonly SyncEffect[],
  type: T
): Extract<SyncEffect, { type: T }>[] {
  return effects.filter((e): e is Extract<SyncEffect, { type: T }> => e.type === type);
}
