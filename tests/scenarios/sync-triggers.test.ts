import { describe, it, expect, vi } from "vitest";
import {
  createInitialState,
  decidePollAction,
  decideFlushAction,
  decideManualSyncAction,
  decideSyncFileAction,
} from "../../src/sync/coordinator";
import { FileWatcher, WatcherFlush } from "../../src/sync/watcher";
import { SyncLock } from "../../src/utils/sync-lock";
import { findEffect } from "../helpers/test-env";

describe("Sync Triggers", () => {
  it("T1: auto-sync on file save produces push effect", () => {
    const decision = decideFlushAction(
      createInitialState(true),
      { changedFiles: new Set(["notes/saved.md"]), deletedFiles: new Set() },
      true
    );
    expect(decision.effects.some((e) => e.type === "updateStatus")).toBe(true);
    expect(decision.effects.some((e) => e.type === "pushFiles")).toBe(true);
    const pushEffect = findEffect(decision.effects, "pushFiles");
    expect(pushEffect!.files).toEqual(["notes/saved.md"]);
  });

  it("T2: periodic poll triggers detection", () => {
    const decision = decidePollAction(createInitialState(true), false);
    expect(decision.state.status).toBe("syncing");
    expect(decision.effects.some((e) => e.type === "detectRemoteChanges")).toBe(true);
  });

  it("T3: Sync vault triggers full sync", () => {
    const decision = decideManualSyncAction(createInitialState(true), true);
    expect(decision.state.status).toBe("syncing");
    expect(decision.effects.some((e) => e.type === "fullSync")).toBe(true);
    expect(decision.effects.some((e) => e.type === "notify")).toBe(true);
  });

  it("T4: Sync current file pushes single file", () => {
    const decision = decideSyncFileAction(createInitialState(true), "notes/active.md", true);
    expect(decision.state.status).toBe("syncing");
    const pushEffect = findEffect(decision.effects, "pushFile");
    expect(pushEffect).toBeDefined();
    expect(pushEffect!.file).toBe("notes/active.md");
  });

  it("T5: Sync Now from settings same as Sync vault", () => {
    const decision = decideManualSyncAction(createInitialState(true), true);
    expect(decision.effects.some((e) => e.type === "fullSync")).toBe(true);
  });

  it("T6: auto-sync on plugin load — decision recommends fullSync when enabled", () => {
    const decision = decideManualSyncAction(createInitialState(true), true);
    expect(decision.effects.some((e) => e.type === "fullSync")).toBe(true);
  });

  it("T7: concurrent triggers serialize via SyncLock", async () => {
    const lock = new SyncLock();
    const executionOrder: string[] = [];

    // Fire two operations concurrently
    const op1 = lock.run(async () => {
      executionOrder.push("start:poll");
      await new Promise((r) => setTimeout(r, 10));
      executionOrder.push("end:poll");
    });
    const op2 = lock.run(async () => {
      executionOrder.push("start:manual");
      await new Promise((r) => setTimeout(r, 10));
      executionOrder.push("end:manual");
    });

    await Promise.all([op1, op2]);

    // Operations must be serialized
    expect(executionOrder).toEqual([
      "start:poll", "end:poll",
      "start:manual", "end:manual",
    ]);
  });
});
