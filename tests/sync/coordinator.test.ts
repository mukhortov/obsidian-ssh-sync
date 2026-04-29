import { describe, it, expect } from "vitest";
import {
  createInitialState,
  decidePollAction,
  decidePullAction,
  decideFlushAction,
  decideManualSyncAction,
  decideSyncFileAction,
  decideToggleAction,
  resolveConflictWinner,
  SyncState,
  SyncEffect,
} from "../../src/sync/coordinator";
import { DEFAULT_CONFIG, SyncConfig, ManifestEntry } from "../../src/types";
import { makeManifestEntry, findEffect, filterEffects } from "../helpers/test-env";

const config: SyncConfig = { ...DEFAULT_CONFIG, enabled: true, sshHost: "user@host", remotePath: "/remote" };

function idleState(): SyncState {
  return createInitialState(true);
}

describe("createInitialState", () => {
  it("returns idle when enabled", () => {
    const state = createInitialState(true);
    expect(state.status).toBe("idle");
    expect(state.isSyncing).toBe(false);
    expect(state.hasPendingWatcherChanges).toBe(false);
  });

  it("returns disabled when not enabled", () => {
    const state = createInitialState(false);
    expect(state.status).toBe("disabled");
  });
});

describe("decidePollAction", () => {
  it("skips poll when watcher has pending changes", () => {
    const decision = decidePollAction(idleState(), true);
    expect(decision.effects).toEqual([]);
    expect(decision.state.status).toBe("idle");
  });

  it("proceeds with detection when no pending changes", () => {
    const decision = decidePollAction(idleState(), false);
    expect(decision.state.status).toBe("syncing");
    const types = decision.effects.map((e) => e.type);
    expect(types).toContain("updateStatus");
    expect(types).toContain("detectRemoteChanges");
  });
});

describe("decidePullAction", () => {
  it("returns to idle when no changes detected (R6)", () => {
    const decision = decidePullAction(
      idleState(),
      { changedFiles: [], deletedFiles: [] },
      {},
      config,
      new Set(),
      new Map()
    );
    expect(decision.state.status).toBe("idle");
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(false);
  });

  it("pulls new file from remote (R1)", () => {
    const decision = decidePullAction(
      idleState(),
      { changedFiles: ["notes/new.md"], deletedFiles: [] },
      {},
      config,
      new Set(),
      new Map()
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    expect(decision.effects.some((e) => e.type === "notify")).toBe(true);
  });

  it("pulls updated file from remote when local unchanged (R2)", () => {
    const manifest: Record<string, ManifestEntry> = {
      "notes/existing.md": makeManifestEntry("notes/existing.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimes = new Map([["notes/existing.md", 1000]]); // same as lastSynced — not changed

    const decision = decidePullAction(
      idleState(),
      { changedFiles: ["notes/existing.md"], deletedFiles: [] },
      manifest,
      config,
      new Set(),
      localMtimes
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    expect(decision.effects.some((e) => e.type === "resolveConflict")).toBe(false);
  });

  it("detects conflict when both sides changed (C1)", () => {
    const manifest: Record<string, ManifestEntry> = {
      "notes/shared.md": makeManifestEntry("notes/shared.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimes = new Map([["notes/shared.md", 2000]]); // newer than lastSynced

    const decision = decidePullAction(
      idleState(),
      { changedFiles: ["notes/shared.md"], deletedFiles: [] },
      manifest,
      config,
      new Set(),
      localMtimes
    );
    const conflictEffect = findEffect(decision.effects, "resolveConflict");
    expect(conflictEffect).toBeDefined();
    expect(conflictEffect!.file).toBe("notes/shared.md");
    expect(conflictEffect!.policy).toBe("remote-wins");
  });

  it("deletes local file when deleted on remote and not locally modified (R3)", () => {
    const manifest: Record<string, ManifestEntry> = {
      "notes/gone.md": makeManifestEntry("notes/gone.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimes = new Map([["notes/gone.md", 1000]]); // not modified

    const decision = decidePullAction(
      idleState(),
      { changedFiles: [], deletedFiles: ["notes/gone.md"] },
      manifest,
      config,
      new Set(),
      localMtimes
    );
    const deleteEffect = findEffect(decision.effects, "deleteLocalFiles");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toContain("notes/gone.md");
  });

  it("preserves locally modified file when deleted on remote (C2)", () => {
    const manifest: Record<string, ManifestEntry> = {
      "notes/edited.md": makeManifestEntry("notes/edited.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimes = new Map([["notes/edited.md", 2000]]); // modified locally

    const decision = decidePullAction(
      idleState(),
      { changedFiles: [], deletedFiles: ["notes/edited.md"] },
      manifest,
      config,
      new Set(),
      localMtimes
    );
    expect(decision.effects.some((e) => e.type === "deleteLocalFiles")).toBe(false);
    expect(decision.effects.some((e) => e.type === "preserveLocalFile")).toBe(true);
    expect(decision.effects.some((e) => e.type === "pushFile")).toBe(true);
  });

  it("skips deletion of files in pendingPaths (R8)", () => {
    const decision = decidePullAction(
      idleState(),
      { changedFiles: [], deletedFiles: ["notes/active.md"] },
      {},
      config,
      new Set(["notes/active.md"]),
      new Map([["notes/active.md", 1000]])
    );
    expect(decision.effects.some((e) => e.type === "deleteLocalFiles")).toBe(false);
  });

  it("handles remote rename as delete + new file (R4)", () => {
    const manifest: Record<string, ManifestEntry> = {
      "old.md": makeManifestEntry("old.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimes = new Map([["old.md", 1000]]);

    const decision = decidePullAction(
      idleState(),
      { changedFiles: ["new.md"], deletedFiles: ["old.md"] },
      manifest,
      config,
      new Set(),
      localMtimes
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    const deleteEffect = findEffect(decision.effects, "deleteLocalFiles");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toContain("old.md");
  });

  it("logs restored file for local-delete + remote-edit (C3)", () => {
    // File was deleted locally (no manifest entry, no localMtime, but remote has it)
    const decision = decidePullAction(
      idleState(),
      { changedFiles: ["notes/restored.md"], deletedFiles: [] },
      {},
      config,
      new Set(),
      new Map() // file doesn't exist locally
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    const logEffects = filterEffects(decision.effects, "log");
    const logEffect = logEffects.find((e) => e.entry.type === "conflict");
    expect(logEffect).toBeDefined();
    expect(logEffect!.entry.message).toContain("restored");
  });

  it("uses real remote mtime for conflict resolution when remoteFileMtimes provided", () => {
    const manifest: Record<string, ManifestEntry> = {
      "notes/shared.md": makeManifestEntry("notes/shared.md", {
        lastSyncedMtime: 1000,
        remoteMtime: 1000, // stale manifest value
      }),
    };
    const localMtimes = new Map([["notes/shared.md", 2000]]);
    const remoteFileMtimes = new Map([["notes/shared.md", 3000]]);

    const newestConfig = { ...config, conflictPolicy: "newest-wins" as const };
    const decision = decidePullAction(
      idleState(),
      { changedFiles: ["notes/shared.md"], deletedFiles: [] },
      manifest,
      newestConfig,
      new Set(),
      localMtimes,
      remoteFileMtimes
    );
    const conflictEffect = findEffect(decision.effects, "resolveConflict");
    expect(conflictEffect).toBeDefined();
    // Should use real remote mtime (3000), not manifest value (1000)
    expect(conflictEffect!.remoteMtime).toBe(3000);
  });

  it("falls back to manifest remoteMtime when remoteFileMtimes not provided", () => {
    const manifest: Record<string, ManifestEntry> = {
      "notes/shared.md": makeManifestEntry("notes/shared.md", {
        lastSyncedMtime: 1000,
        remoteMtime: 1500,
      }),
    };
    const localMtimes = new Map([["notes/shared.md", 2000]]);

    const decision = decidePullAction(
      idleState(),
      { changedFiles: ["notes/shared.md"], deletedFiles: [] },
      manifest,
      config,
      new Set(),
      localMtimes
    );
    const conflictEffect = findEffect(decision.effects, "resolveConflict");
    expect(conflictEffect).toBeDefined();
    expect(conflictEffect!.remoteMtime).toBe(1500);
  });
});

describe("decideFlushAction", () => {
  it("pushes changed files and deletes remote files (T1, L1-L3)", () => {
    const flush = {
      changedFiles: new Set(["a.md", "b.md"]),
      deletedFiles: new Set(["c.md"]),
    };
    const decision = decideFlushAction(idleState(), flush, true);
    const pushEffect = findEffect(decision.effects, "pushFiles");
    expect(pushEffect).toBeDefined();
    expect(pushEffect!.files).toEqual(["a.md", "b.md"]);
    const deleteEffect = findEffect(decision.effects, "deleteRemoteFiles");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toEqual(["c.md"]);
  });

  it("does nothing when disabled (F2)", () => {
    const flush = {
      changedFiles: new Set(["a.md"]),
      deletedFiles: new Set<string>(),
    };
    const decision = decideFlushAction(idleState(), flush, false);
    expect(decision.effects).toEqual([]);
  });

  it("handles empty flush", () => {
    const flush = {
      changedFiles: new Set<string>(),
      deletedFiles: new Set<string>(),
    };
    const decision = decideFlushAction(idleState(), flush, true);
    // Only updateStatus effect, no push/delete
    expect(decision.effects.some((e) => e.type === "pushFiles")).toBe(false);
    expect(decision.effects.some((e) => e.type === "deleteRemoteFiles")).toBe(false);
  });
});

describe("decideManualSyncAction", () => {
  it("starts full sync when engine available (T3, T5)", () => {
    const decision = decideManualSyncAction(idleState(), true);
    expect(decision.state.status).toBe("syncing");
    expect(decision.effects.some((e) => e.type === "fullSync")).toBe(true);
    expect(decision.effects.some((e) => e.type === "notify")).toBe(true);
  });

  it("returns error when engine not available (E8)", () => {
    const decision = decideManualSyncAction(idleState(), false);
    expect(decision.effects.some((e) => e.type === "notifyError")).toBe(true);
  });
});

describe("decideSyncFileAction", () => {
  it("pushes active file (T4)", () => {
    const decision = decideSyncFileAction(idleState(), "notes/current.md", true);
    expect(decision.state.status).toBe("syncing");
    const pushEffect = findEffect(decision.effects, "pushFile");
    expect(pushEffect).toBeDefined();
    expect(pushEffect!.file).toBe("notes/current.md");
  });

  it("notifies when no active file (E7)", () => {
    const decision = decideSyncFileAction(idleState(), null, true);
    const notifyEffect = findEffect(decision.effects, "notify");
    expect(notifyEffect).toBeDefined();
    expect(notifyEffect!.message).toContain("No active file");
  });

  it("notifies when engine not available (E8)", () => {
    const decision = decideSyncFileAction(idleState(), "test.md", false);
    const notifyEffect = findEffect(decision.effects, "notify");
    expect(notifyEffect).toBeDefined();
    expect(notifyEffect!.message).toContain("not initialized");
  });
});

describe("decideToggleAction", () => {
  it("enables sync: starts poller, updates status (F1)", () => {
    const decision = decideToggleAction(
      createInitialState(false),
      false, // currently disabled
      60000
    );
    expect(decision.state.status).toBe("idle");
    expect(decision.effects.some((e) => e.type === "startPoller")).toBe(true);
    expect(decision.effects.some((e) => e.type === "notify")).toBe(true);
  });

  it("disables sync: stops poller, updates status (F2)", () => {
    const decision = decideToggleAction(
      idleState(),
      true, // currently enabled
      60000
    );
    expect(decision.state.status).toBe("disabled");
    expect(decision.effects.some((e) => e.type === "stopPoller")).toBe(true);
    expect(decision.effects.some((e) => e.type === "notify")).toBe(true);
  });
});

describe("resolveConflictWinner", () => {
  it("remote-wins always returns remote", () => {
    expect(resolveConflictWinner("remote-wins", 2000, 1000)).toBe("remote");
    expect(resolveConflictWinner("remote-wins", 1000, 2000)).toBe("remote");
  });

  it("local-wins always returns local", () => {
    expect(resolveConflictWinner("local-wins", 1000, 2000)).toBe("local");
    expect(resolveConflictWinner("local-wins", 2000, 1000)).toBe("local");
  });

  it("newest-wins returns the newer side", () => {
    expect(resolveConflictWinner("newest-wins", 2000, 1000)).toBe("local");
    expect(resolveConflictWinner("newest-wins", 1000, 2000)).toBe("remote");
  });

  it("newest-wins returns local on tie", () => {
    expect(resolveConflictWinner("newest-wins", 1000, 1000)).toBe("local");
  });
});
