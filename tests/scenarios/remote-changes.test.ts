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

  it("R11: file moved between folders on VPS — delete old, pull new", () => {
    const manifest = {
      "inbox/idea.md": makeManifestEntry("inbox/idea.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimes = new Map([["inbox/idea.md", 1000]]);

    const decision = decidePullAction(
      idleState(),
      { changedFiles: ["notes/idea.md"], deletedFiles: ["inbox/idea.md"] },
      manifest,
      config,
      new Set(),
      localMtimes
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    const deleteEffect = findEffect(decision.effects, "deleteLocalFiles");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toContain("inbox/idea.md");
  });

  it("R12: deeply nested files added on VPS — pull effect produced", () => {
    const decision = decidePullAction(
      idleState(),
      { changedFiles: ["a/b/c/d/deep-note.md"], deletedFiles: [] },
      {},
      config,
      new Set(),
      new Map()
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    expect(decision.effects.some((e) => e.type === "notify")).toBe(true);
  });

  it("R13: file renamed within same subfolder on VPS — delete old, pull new", () => {
    const manifest = {
      "docs/old-name.md": makeManifestEntry("docs/old-name.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimes = new Map([["docs/old-name.md", 1000]]);

    const decision = decidePullAction(
      idleState(),
      { changedFiles: ["docs/new-name.md"], deletedFiles: ["docs/old-name.md"] },
      manifest,
      config,
      new Set(),
      localMtimes
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    const deleteEffect = findEffect(decision.effects, "deleteLocalFiles");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toContain("docs/old-name.md");
  });

  it("R14: multiple subfolders created simultaneously on VPS — single poll", () => {
    const decision = decidePullAction(
      idleState(),
      {
        changedFiles: [
          "projects/alpha/readme.md",
          "projects/beta/readme.md",
          "projects/gamma/readme.md",
        ],
        deletedFiles: [],
      },
      {},
      config,
      new Set(),
      new Map()
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    expect(decision.effects.some((e) => e.type === "notify")).toBe(true);
  });

  it("R15: file moved from deep path to root on VPS — delete deep, pull root", () => {
    const manifest = {
      "a/b/c/deep.md": makeManifestEntry("a/b/c/deep.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimes = new Map([["a/b/c/deep.md", 1000]]);

    const decision = decidePullAction(
      idleState(),
      { changedFiles: ["deep.md"], deletedFiles: ["a/b/c/deep.md"] },
      manifest,
      config,
      new Set(),
      localMtimes
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    const deleteEffect = findEffect(decision.effects, "deleteLocalFiles");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toContain("a/b/c/deep.md");
  });

  it("R16: folder renamed on VPS — all files show as delete+create", () => {
    const manifest = {
      "old-folder/file1.md": makeManifestEntry("old-folder/file1.md", { lastSyncedMtime: 1000 }),
      "old-folder/file2.md": makeManifestEntry("old-folder/file2.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimes = new Map([
      ["old-folder/file1.md", 1000],
      ["old-folder/file2.md", 1000],
    ]);

    const decision = decidePullAction(
      idleState(),
      {
        changedFiles: ["new-folder/file1.md", "new-folder/file2.md"],
        deletedFiles: ["old-folder/file1.md", "old-folder/file2.md"],
      },
      manifest,
      config,
      new Set(),
      localMtimes
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    const deleteEffect = findEffect(decision.effects, "deleteLocalFiles");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toContain("old-folder/file1.md");
    expect(deleteEffect!.files).toContain("old-folder/file2.md");
  });

  it("R17: partial subfolder deletion on VPS — only deleted file removed", () => {
    const manifest = {
      "shared/a.md": makeManifestEntry("shared/a.md", { lastSyncedMtime: 1000 }),
      "shared/b.md": makeManifestEntry("shared/b.md", { lastSyncedMtime: 1000 }),
      "shared/c.md": makeManifestEntry("shared/c.md", { lastSyncedMtime: 1000 }),
    };
    const localMtimes = new Map([
      ["shared/a.md", 1000],
      ["shared/b.md", 1000],
      ["shared/c.md", 1000],
    ]);

    const decision = decidePullAction(
      idleState(),
      { changedFiles: [], deletedFiles: ["shared/b.md"] },
      manifest,
      config,
      new Set(),
      localMtimes
    );
    const deleteEffect = findEffect(decision.effects, "deleteLocalFiles");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toContain("shared/b.md");
    expect(deleteEffect!.files).not.toContain("shared/a.md");
    expect(deleteEffect!.files).not.toContain("shared/c.md");
  });

  it("R18: binary file added in new subfolder on VPS — pull effect produced", () => {
    const decision = decidePullAction(
      idleState(),
      { changedFiles: ["assets/images/photo.png"], deletedFiles: [] },
      {},
      config,
      new Set(),
      new Map()
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    expect(decision.effects.some((e) => e.type === "notify")).toBe(true);
  });

  it("R19: entire nested tree restructured on VPS — deletes from v1, creates in v2", () => {
    const manifest = {
      "v1/docs/guide.md": makeManifestEntry("v1/docs/guide.md", { lastSyncedMtime: 1000 }),
      "v1/docs/api.md": makeManifestEntry("v1/docs/api.md", { lastSyncedMtime: 1000 }),
      "v1/src/main.ts": makeManifestEntry("v1/src/main.ts", { lastSyncedMtime: 1000 }),
    };
    const localMtimes = new Map([
      ["v1/docs/guide.md", 1000],
      ["v1/docs/api.md", 1000],
      ["v1/src/main.ts", 1000],
    ]);

    const decision = decidePullAction(
      idleState(),
      {
        changedFiles: ["v2/docs/guide.md", "v2/docs/api.md", "v2/src/main.ts"],
        deletedFiles: ["v1/docs/guide.md", "v1/docs/api.md", "v1/src/main.ts"],
      },
      manifest,
      config,
      new Set(),
      localMtimes
    );
    expect(decision.effects.some((e) => e.type === "pullWithoutDelete")).toBe(true);
    const deleteEffect = findEffect(decision.effects, "deleteLocalFiles");
    expect(deleteEffect).toBeDefined();
    expect(deleteEffect!.files).toContain("v1/docs/guide.md");
    expect(deleteEffect!.files).toContain("v1/docs/api.md");
    expect(deleteEffect!.files).toContain("v1/src/main.ts");
  });

  it("R20: empty subfolder added on VPS — no file changes, no-op", () => {
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

  it("R21: multiple levels of empty directories on VPS — no file changes, no-op", () => {
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
});
