import { describe, it, expect } from "vitest";
import {
  decidePollAction,
  decidePullAction,
  createInitialState,
  SyncState,
} from "../../src/sync/coordinator";
import { DEFAULT_CONFIG, SyncConfig, ManifestEntry } from "../../src/types";
import { findEffect, makeManifestEntry } from "../helpers/test-env";

const config: SyncConfig = { ...DEFAULT_CONFIG, enabled: true, sshHost: "user@host", remotePath: "/remote" };

function idleState(): SyncState {
  return createInitialState(true);
}

describe("Remote Changes → Local", () => {
  it("R1: new file appears on VPS — pulled to local", () => {
    const decision = decidePullAction(
      idleState(),
      { changedFiles: ["notes/from-vps.md"], deletedFiles: [] },
      {}, // no manifest entry — new file
      config,
      new Set(),
      new Map() // file doesn't exist locally
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    expect(decision.effects.some((e) => e.type === "notify")).toBe(true);
  });

  it("R2: existing file modified on VPS — pulled when local unchanged", () => {
    const manifest = {
      "notes/existing.md": makeManifestEntry("notes/existing.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimes = new Map([["notes/existing.md", 1000]]);

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

  it("R3: file deleted on VPS — deleted locally", () => {
    const manifest = {
      "notes/gone.md": makeManifestEntry("notes/gone.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimes = new Map([["notes/gone.md", 1000]]);

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
    expect(decision.effects.some((e) => e.type === "notify")).toBe(true);
  });

  it("R4: file renamed on VPS — old deleted, new pulled", () => {
    const manifest = {
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

  it("R5: multiple changes on VPS handled in single poll", () => {
    const decision = decidePullAction(
      idleState(),
      { changedFiles: ["a.md", "b.md"], deletedFiles: ["c.md"] },
      { "c.md": makeManifestEntry("c.md") },
      config,
      new Set(),
      new Map([["c.md", 1000]])
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    expect(decision.effects.some((e) => e.type === "deleteLocalFiles")).toBe(true);
  });

  it("R6: no changes on VPS — no-op", () => {
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
    expect(decision.effects.some((e) => e.type === "deleteLocalFiles")).toBe(false);
  });

  it("R7: remote change during active local edit — poll skipped", () => {
    const decision = decidePollAction(idleState(), true);
    expect(decision.effects).toEqual([]);
  });

  it("R8: remote deletion of file in pending paths — skipped", () => {
    const decision = decidePullAction(
      idleState(),
      { changedFiles: [], deletedFiles: ["notes/editing.md"] },
      {},
      config,
      new Set(["notes/editing.md"]),
      new Map([["notes/editing.md", 1000]])
    );
    expect(decision.effects.some((e) => e.type === "deleteLocalFiles")).toBe(false);
  });

  it("R9: new subfolder with files appears on VPS", () => {
    const decision = decidePullAction(
      idleState(),
      { changedFiles: ["shared/team-notes/a.md", "shared/team-notes/b.md"], deletedFiles: [] },
      {}, // no manifest entries — new files
      config,
      new Set(),
      new Map() // files don't exist locally
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    expect(decision.effects.some((e) => e.type === "notify")).toBe(true);
  });

  it("R10: entire subfolder deleted on VPS", () => {
    const manifest = {
      "old-project/readme.md": makeManifestEntry("old-project/readme.md", { lastSyncedMtime: 1000 }),
      "old-project/notes.md": makeManifestEntry("old-project/notes.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimes = new Map([
      ["old-project/readme.md", 1000],
      ["old-project/notes.md", 1000],
    ]);

    const decision = decidePullAction(
      idleState(),
      { changedFiles: [], deletedFiles: ["old-project/readme.md", "old-project/notes.md"] },
      manifest,
      config,
      new Set(),
      localMtimes
    );
    const deleteEffect = findEffect(decision.effects, "deleteLocalFiles");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toContain("old-project/readme.md");
    expect(deleteEffect!.files).toContain("old-project/notes.md");
  });
});
