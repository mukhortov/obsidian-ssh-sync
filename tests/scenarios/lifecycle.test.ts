import { describe, it, expect, vi, beforeEach } from "vitest";
import * as commands from "../../src/ssh/commands";
import {
  createInitialState,
  decideToggleAction,
  decideManualSyncAction,
} from "../../src/sync/coordinator";
import { Poller } from "../../src/sync/poller";
import { FileWatcher } from "../../src/sync/watcher";
import { createTestEnv, createTestFile, findEffect, TestEnv } from "../helpers/test-env";
import { ManifestStore } from "../../src/sync/manifest";

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

describe("Lifecycle", () => {
  it("F1: enable sync — starts poller, shows idle", () => {
    const decision = decideToggleAction(
      createInitialState(false),
      false, // currently disabled → enabling
      60000
    );
    expect(decision.state.status).toBe("idle");
    expect(decision.effects.some((e) => e.type === "startPoller")).toBe(true);
    const startEffect = findEffect(decision.effects, "startPoller");
    expect(startEffect!.intervalMs).toBe(60000);
    expect(decision.effects.some((e) => e.type === "notify")).toBe(true);
    const notify = findEffect(decision.effects, "notify");
    expect(notify!.message).toContain("enabled");
  });

  it("F2: disable sync — stops poller, shows disabled", () => {
    const decision = decideToggleAction(
      createInitialState(true),
      true, // currently enabled → disabling
      60000
    );
    expect(decision.state.status).toBe("disabled");
    expect(decision.effects.some((e) => e.type === "stopPoller")).toBe(true);
    const notify = findEffect(decision.effects, "notify");
    expect(notify!.message).toContain("disabled");
  });

  it("F3: change poll interval — poller restarts with new interval", () => {
    vi.useFakeTimers();
    const pollFn = vi.fn();
    const poller = new Poller(pollFn, 60000);
    poller.start();

    // Change interval
    poller.updateInterval(30000);

    // Advance 30s — should fire
    vi.advanceTimersByTime(30000);
    expect(pollFn).toHaveBeenCalledTimes(1);

    // Advance another 30s — should fire again (not at 60s)
    vi.advanceTimersByTime(30000);
    expect(pollFn).toHaveBeenCalledTimes(2);

    poller.stop();
    vi.useRealTimers();
  });

  it("F4: update exclude patterns — new patterns used on next sync", () => {
    const env = createTestEnv({ excludePatterns: [".git/**", "*.tmp"] });
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [], deletedFiles: [], stdout: "", stderr: "", exitCode: 0,
    });

    env.engine.detectRemoteChanges();

    expect(commands.buildRsyncDryRunCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        excludePatterns: expect.arrayContaining(["*.tmp"]),
      })
    );
    env.cleanup();
  });

  it("F5: plugin unload — watcher and poller cleaned up", () => {
    vi.useFakeTimers();
    const watcher = new FileWatcher(500, async () => {});
    const poller = new Poller(async () => {}, 60000);
    poller.start();

    // Simulate onunload
    watcher.dispose();
    poller.stop();

    // Verify no pending operations
    expect(watcher.hasPending()).toBe(false);

    // Advance time — poller should not fire
    const pollFn = vi.fn();
    // poller already stopped, create new one to verify stop works
    const poller2 = new Poller(pollFn, 1000);
    poller2.start();
    poller2.stop();
    vi.advanceTimersByTime(5000);
    expect(pollFn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("F6: first sync with existing remote content", async () => {
    const env = createTestEnv();
    // Full sync: push (nothing local) then pull (remote has files)
    vi.mocked(commands.runRsync)
      .mockResolvedValueOnce({
        changedFiles: [], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      }) // pushAll — nothing to push
      .mockResolvedValueOnce({
        changedFiles: ["remote-note.md", "remote-doc.md"], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      }); // pull — remote files arrive

    const result = await env.engine.fullSync();
    expect(result.success).toBe(true);
    expect(result.changedFiles).toContain("remote-note.md");
    expect(result.changedFiles).toContain("remote-doc.md");
    env.cleanup();
  });

  it("F7: change SSH host while sync enabled", async () => {
    // Create engine with host-b and verify commands use the new host
    const env2 = createTestEnv({ sshHost: "user@host-b" });

    vi.mocked(commands.executeCommand).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await env2.engine.ensureRemoteDir();

    expect(commands.buildMkdirCommand).toHaveBeenCalledWith(
      "user@host-b",
      env2.config.remotePath
    );

    env2.cleanup();
  });

  it("F8: change remote path while sync enabled", async () => {
    const env1 = createTestEnv({ remotePath: "/remote/vault-a" });
    const env2 = createTestEnv({ remotePath: "/remote/vault-b" });

    expect(env1.config.remotePath).toBe("/remote/vault-a");
    expect(env2.config.remotePath).toBe("/remote/vault-b");

    // Mock executeCommand success for ensureRemoteDir
    vi.mocked(commands.executeCommand).mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    await env2.engine.ensureRemoteDir();

    expect(commands.buildMkdirCommand).toHaveBeenCalledWith(
      env2.config.sshHost,
      "/remote/vault-b"
    );

    env1.cleanup();
    env2.cleanup();
  });

  it("F9: re-enable sync after extended offline", () => {
    // Disable sync
    const disableDecision = decideToggleAction(
      createInitialState(true),
      true, // currently enabled → disabling
      60000
    );
    expect(disableDecision.state.status).toBe("disabled");
    expect(disableDecision.effects.some((e) => e.type === "stopPoller")).toBe(true);

    // Re-enable after being offline
    const enableDecision = decideToggleAction(
      disableDecision.state,
      false, // currently disabled → enabling
      60000
    );
    expect(enableDecision.state.status).toBe("idle");
    expect(enableDecision.effects.some((e) => e.type === "startPoller")).toBe(true);
    const startEffect = findEffect(enableDecision.effects, "startPoller");
    expect(startEffect!.intervalMs).toBe(60000);

    // Manual sync after re-enabling (to catch up)
    const syncDecision = decideManualSyncAction(enableDecision.state, true);
    expect(syncDecision.state.status).toBe("syncing");
    expect(syncDecision.effects.some((e) => e.type === "fullSync")).toBe(true);
  });

  it("F10: Obsidian crash during sync — manifest persistence", async () => {
    const env = createTestEnv();

    vi.mocked(commands.runRsync).mockResolvedValueOnce({
      changedFiles: ["crash-test.md"],
      deletedFiles: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    // Create file and push it
    createTestFile(env, "crash-test.md", "important content");
    const result = await env.engine.pushFile("crash-test.md");
    expect(result.success).toBe(true);

    // Verify manifest has the entry
    const entry = env.engine._manifest.getEntry("crash-test.md");
    expect(entry).toBeDefined();
    expect(entry!.path).toBe("crash-test.md");

    // Simulate crash recovery: create a NEW ManifestStore from the same path
    const recoveredManifest = new ManifestStore(env.manifestPath);
    const recoveredEntry = recoveredManifest.getEntry("crash-test.md");
    expect(recoveredEntry).toBeDefined();
    expect(recoveredEntry!.path).toBe("crash-test.md");
    expect(recoveredEntry!.hash).toBe(entry!.hash);

    env.cleanup();
  });
});
