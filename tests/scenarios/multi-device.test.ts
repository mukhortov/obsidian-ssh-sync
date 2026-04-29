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
  buildRmdirCommand: vi.fn(() => "rmdir cmd"),
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
    expect(env1.engine._manifest.getEntry("file-a.md")).toBeDefined();
    expect(env1.engine._manifest.getEntry("file-b.md")).toBeUndefined();

    // Env2 has file-b.md but NOT file-a.md
    expect(env2.engine._manifest.getEntry("file-b.md")).toBeDefined();
    expect(env2.engine._manifest.getEntry("file-a.md")).toBeUndefined();

    // Env1 polls and detects file-b.md on remote — clean pull (no manifest entry)
    const decision = decidePullAction(
      createInitialState(true),
      { changedFiles: ["file-b.md"], deletedFiles: [] },
      env1.engine.getManifestEntries(),
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
    env1.engine._manifest.setEntry("shared.md", sharedEntry);
    env2.engine._manifest.setEntry("shared.md", sharedEntry);

    // Env1 edited shared.md (localMtime: 2000) — assume push succeeded already
    // Env2 also edited shared.md (localMtime: 3000)
    // When Env2's poller detects remote change from Env1's push:
    const decision = decidePullAction(
      createInitialState(true),
      { changedFiles: ["shared.md"], deletedFiles: [] },
      env2.engine.getManifestEntries(), // lastSyncedMtime: 1000
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

  it("M4: both Macs rename same folder to different names — each pulls the other's version", () => {
    // After both flushes, VPS has files at both new paths.
    // Mac A renamed folder/ → folder-alpha/, Mac B renamed folder/ → folder-beta/
    // Mac A polls and sees Mac B's renamed files as new changedFiles.

    // Mac A's manifest: only knows about its own renamed paths
    const manifestA = {
      "folder-alpha/note1.md": makeManifestEntry("folder-alpha/note1.md", { lastSyncedMtime: 1000 }),
      "folder-alpha/note2.md": makeManifestEntry("folder-alpha/note2.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimesA = new Map([
      ["folder-alpha/note1.md", 1000],
      ["folder-alpha/note2.md", 1000],
    ]);

    // Mac A's poll detects Mac B's renamed files
    const decisionA = decidePullAction(
      createInitialState(true),
      { changedFiles: ["folder-beta/note1.md", "folder-beta/note2.md"], deletedFiles: [] },
      manifestA,
      sharedConfig,
      new Set(),
      localMtimesA
    );

    // Mac B's files have no manifest entry on Mac A, don't exist locally → clean pull
    expect(decisionA.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    expect(decisionA.effects.some((e) => e.type === "resolveConflict")).toBe(false);

    // Mac B's perspective: sees Mac A's renamed files
    const manifestB = {
      "folder-beta/note1.md": makeManifestEntry("folder-beta/note1.md", { lastSyncedMtime: 1000 }),
      "folder-beta/note2.md": makeManifestEntry("folder-beta/note2.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimesB = new Map([
      ["folder-beta/note1.md", 1000],
      ["folder-beta/note2.md", 1000],
    ]);

    const decisionB = decidePullAction(
      createInitialState(true),
      { changedFiles: ["folder-alpha/note1.md", "folder-alpha/note2.md"], deletedFiles: [] },
      manifestB,
      sharedConfig,
      new Set(),
      localMtimesB
    );

    expect(decisionB.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    expect(decisionB.effects.some((e) => e.type === "resolveConflict")).toBe(false);
  });

  it("M5: one Mac creates folder structure, other Mac pulls it", () => {
    // Mac A created a new folder structure with 3 files.
    // Mac B polls and sees 3 new changedFiles in new dirs.
    // No manifest entries → clean pull.
    const manifestB = {}; // Mac B has no knowledge of these files
    const localMtimesB = new Map<string, number>(); // none exist locally

    const decision = decidePullAction(
      createInitialState(true),
      {
        changedFiles: [
          "projects/2026/plan.md",
          "projects/2026/tasks/backlog.md",
          "projects/2026/tasks/sprint.md",
        ],
        deletedFiles: [],
      },
      manifestB,
      sharedConfig,
      new Set(),
      localMtimesB
    );

    // All 3 files are new from remote — clean pull
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    expect(decision.effects.some((e) => e.type === "resolveConflict")).toBe(false);

    // Notification mentions pulled files
    const notify = findEffect(decision.effects, "notify");
    expect(notify).toBeDefined();
    expect(notify!.message).toContain("pulled");
  });

  it("M6: one Mac deletes folder, other Mac adds files to it", () => {
    // Mac A deleted folder/old.md. Mac B added folder/new.md.
    // After both sync to VPS:
    //   - Mac A polls: sees folder/new.md as changedFile (new from Mac B)
    //   - Mac B polls: sees folder/old.md as deletedFile (deleted by Mac A)

    // Mac A's perspective: folder/new.md is new from remote
    const manifestA = {
      // Mac A deleted folder/old.md — manifest entry removed after delete
    };
    const localMtimesA = new Map<string, number>(); // folder/new.md doesn't exist locally

    const decisionA = decidePullAction(
      createInitialState(true),
      { changedFiles: ["folder/new.md"], deletedFiles: [] },
      manifestA,
      sharedConfig,
      new Set(),
      localMtimesA
    );

    // Mac A gets a clean pull of the new file
    expect(decisionA.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    expect(decisionA.effects.some((e) => e.type === "resolveConflict")).toBe(false);

    // Mac B's perspective: folder/old.md was deleted by Mac A
    const manifestB = {
      "folder/old.md": makeManifestEntry("folder/old.md", { lastSyncedMtime: 1000 }),
      "folder/new.md": makeManifestEntry("folder/new.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimesB = new Map([
      ["folder/old.md", 1000], // unchanged locally
      ["folder/new.md", 1000],
    ]);

    const decisionB = decidePullAction(
      createInitialState(true),
      { changedFiles: [], deletedFiles: ["folder/old.md"] },
      manifestB,
      sharedConfig,
      new Set(),
      localMtimesB
    );

    // Mac B safely deletes the file (unchanged locally, deleted on remote)
    const deleteEffect = findEffect(decisionB.effects, "deleteLocalFiles");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toContain("folder/old.md");
    expect(decisionB.effects.some((e) => e.type === "resolveConflict")).toBe(false);
  });
});
