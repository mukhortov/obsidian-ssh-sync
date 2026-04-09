import { describe, it, expect, vi } from "vitest";
import * as commands from "../../src/ssh/commands";
import {
  createInitialState,
  decidePullAction,
} from "../../src/sync/coordinator";
import { DEFAULT_CONFIG, SyncConfig } from "../../src/types";
import { createTestEnv, createTestFile, findEffect, makeManifestEntry } from "../helpers/test-env";

vi.mock("../../src/ssh/commands", () => ({
  buildRsyncPushCommand: vi.fn(() => "rsync push cmd"),
  buildRsyncPullCommand: vi.fn(() => "rsync pull cmd"),
  buildRsyncDryRunCommand: vi.fn(() => "rsync dry-run cmd"),
  buildMkdirCommand: vi.fn(() => "mkdir cmd"),
  buildLsCommand: vi.fn(() => "ls cmd"),
  buildRmCommand: vi.fn(() => "rm cmd"),
  executeCommand: vi.fn(),
  runRsync: vi.fn(),
}));

const sharedConfig: SyncConfig = {
  ...DEFAULT_CONFIG,
  enabled: true,
  sshHost: "user@shared-host",
  remotePath: "/remote/shared-vault",
};

describe("Multi-Device", () => {
  it("M1: two Macs syncing, no file overlap", async () => {
    const env1 = createTestEnv({ sshHost: sharedConfig.sshHost, remotePath: sharedConfig.remotePath });
    const env2 = createTestEnv({ sshHost: sharedConfig.sshHost, remotePath: sharedConfig.remotePath });

    // Env1 pushes file-a.md
    vi.mocked(commands.runRsync).mockResolvedValueOnce({
      changedFiles: ["file-a.md"],
      deletedFiles: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    createTestFile(env1, "file-a.md", "content from mac 1");
    const push1 = await env1.engine.pushFile("file-a.md");
    expect(push1.success).toBe(true);

    // Env2 pushes file-b.md
    vi.mocked(commands.runRsync).mockResolvedValueOnce({
      changedFiles: ["file-b.md"],
      deletedFiles: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    createTestFile(env2, "file-b.md", "content from mac 2");
    const push2 = await env2.engine.pushFile("file-b.md");
    expect(push2.success).toBe(true);

    // Env1 has file-a.md but NOT file-b.md (independent manifests)
    expect(env1.engine.getManifest().getEntry("file-a.md")).toBeDefined();
    expect(env1.engine.getManifest().getEntry("file-b.md")).toBeUndefined();

    // Env2 has file-b.md but NOT file-a.md
    expect(env2.engine.getManifest().getEntry("file-b.md")).toBeDefined();
    expect(env2.engine.getManifest().getEntry("file-a.md")).toBeUndefined();

    // Env1 polls and detects file-b.md on remote — clean pull (no manifest entry)
    const decision = decidePullAction(
      createInitialState(true),
      { changedFiles: ["file-b.md"], deletedFiles: [] },
      env1.engine.getManifest().getEntries(),
      env1.config,
      new Set(),
      new Map() // file-b.md doesn't exist locally on env1
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    expect(decision.effects.some((e) => e.type === "resolveConflict")).toBe(false);

    env1.cleanup();
    env2.cleanup();
  });

  it("M2: two Macs edit same file — conflict detected", () => {
    const env1 = createTestEnv({ sshHost: sharedConfig.sshHost, remotePath: sharedConfig.remotePath });
    const env2 = createTestEnv({ sshHost: sharedConfig.sshHost, remotePath: sharedConfig.remotePath });

    // Both have manifest entry for shared.md with lastSyncedMtime: 1000
    const sharedEntry = makeManifestEntry("shared.md", { lastSyncedMtime: 1000 });
    env1.engine.getManifest().setEntry("shared.md", sharedEntry);
    env2.engine.getManifest().setEntry("shared.md", sharedEntry);

    // Env1 edited shared.md (localMtime: 2000) — assume push succeeded already
    // Env2 also edited shared.md (localMtime: 3000)
    // When Env2's poller detects remote change from Env1's push:
    const decision = decidePullAction(
      createInitialState(true),
      { changedFiles: ["shared.md"], deletedFiles: [] },
      env2.engine.getManifest().getEntries(), // lastSyncedMtime: 1000
      env2.config,
      new Set(),
      new Map([["shared.md", 3000]]) // Env2's local edit
    );

    // Conflict detected: local changed (3000 > 1000) AND remote changed
    const conflict = findEffect(decision.effects, "resolveConflict");
    expect(conflict).toBeDefined();
    expect(conflict!.file).toBe("shared.md");
    expect(conflict!.localMtime).toBe(3000);

    env1.cleanup();
    env2.cleanup();
  });

  it("M3: one Mac offline, other continues syncing — clean pull on reconnect", () => {
    // Mac A has files a.md and b.md, both synced at mtime 1000
    const manifestA = {
      "a.md": makeManifestEntry("a.md", { lastSyncedMtime: 1000 }),
      "b.md": makeManifestEntry("b.md", { lastSyncedMtime: 1000 }),
    };

    // Mac B pushed changes while Mac A was offline:
    //   - modified a.md (appears in changedFiles)
    //   - created c.md (appears in changedFiles)
    //   - deleted b.md (appears in deletedFiles)

    // Mac A comes online, poll detects changes
    const decision = decidePullAction(
      createInitialState(true),
      { changedFiles: ["a.md", "c.md"], deletedFiles: ["b.md"] },
      manifestA,
      sharedConfig,
      new Set(), // no pending local changes
      new Map([
        ["a.md", 1000], // unchanged locally
        ["b.md", 1000], // unchanged locally
        // c.md: undefined (doesn't exist locally)
      ])
    );

    // a.md: only remote changed (localMtime == lastSyncedMtime) → clean pull
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    expect(decision.effects.filter((e) => e.type === "resolveConflict")).toHaveLength(0);

    // b.md: deleted remotely, unchanged locally → safe to delete
    const deleteEffect = findEffect(decision.effects, "deleteLocalFiles");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toContain("b.md");

    // Notification about pulled files and deleted files
    expect(decision.effects.some((e) => e.type === "notify")).toBe(true);
  });

  it("M3 variant: offline Mac also edited a.md — conflict on reconnect", () => {
    const manifestA = {
      "a.md": makeManifestEntry("a.md", { lastSyncedMtime: 1000 }),
      "b.md": makeManifestEntry("b.md", { lastSyncedMtime: 1000 }),
    };

    // Mac A also edited a.md while offline (localMtime: 2000)
    const decision = decidePullAction(
      createInitialState(true),
      { changedFiles: ["a.md", "c.md"], deletedFiles: ["b.md"] },
      manifestA,
      sharedConfig,
      new Set(),
      new Map([
        ["a.md", 2000], // locally modified while offline
        ["b.md", 1000], // unchanged
        // c.md: undefined
      ])
    );

    // a.md: both local and remote changed → conflict
    const conflicts = decision.effects.filter((e) => e.type === "resolveConflict");
    expect(conflicts).toHaveLength(1);
    const conflict = findEffect(decision.effects, "resolveConflict");
    expect(conflict!.file).toBe("a.md");
    expect(conflict!.localMtime).toBe(2000);

    // c.md: new from remote → clean pull
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);

    // b.md: still safe to delete (unchanged locally)
    const deleteEffect = findEffect(decision.effects, "deleteLocalFiles");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toContain("b.md");
  });
});
