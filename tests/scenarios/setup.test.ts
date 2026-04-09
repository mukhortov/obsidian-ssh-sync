import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as commands from "../../src/ssh/commands";
import { createTestEnv, createTestFile, findEffect, TestEnv } from "../helpers/test-env";
import {
  createInitialState,
  decideManualSyncAction,
} from "../../src/sync/coordinator";
import { DEFAULT_CONFIG } from "../../src/types";

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

describe("Setup & Initial Connection", () => {
  let env: TestEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    env = createTestEnv();
    vi.mocked(commands.runRsync).mockResolvedValue({
      changedFiles: [], deletedFiles: [], stdout: "", stderr: "", exitCode: 0,
    });
    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "", stderr: "", exitCode: 0,
    });
  });

  afterEach(() => {
    env?.cleanup();
  });

  it("S1: new Mac vault connecting to existing VPS vault", async () => {
    // Empty local vault, remote has files
    vi.mocked(commands.runRsync)
      .mockResolvedValueOnce({
        changedFiles: [], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      }) // pushAll — nothing local to push
      .mockResolvedValueOnce({
        changedFiles: ["notes/from-vps.md", "journal/day1.md"], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      }); // pull — remote files arrive

    const result = await env.engine.fullSync();

    expect(result.success).toBe(true);
    expect(result.changedFiles).toContain("notes/from-vps.md");
    expect(result.changedFiles).toContain("journal/day1.md");
  });

  it("S2: existing Mac vault connecting to empty VPS", async () => {
    createTestFile(env, "notes/local-note.md", "local content");
    createTestFile(env, "projects/readme.md", "project readme");

    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "", stderr: "", exitCode: 0,
    });
    vi.mocked(commands.runRsync)
      .mockResolvedValueOnce({
        changedFiles: ["notes/local-note.md", "projects/readme.md"], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      }) // pushAll — sends local files
      .mockResolvedValueOnce({
        changedFiles: [], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      }); // pull — nothing on remote

    const ensureResult = await env.engine.ensureRemoteDir();
    expect(ensureResult).toBe(true);
    expect(commands.executeCommand).toHaveBeenCalledWith("mkdir cmd", 15000);

    const result = await env.engine.fullSync();

    expect(result.success).toBe(true);
    expect(result.changedFiles).toContain("notes/local-note.md");
    expect(result.changedFiles).toContain("projects/readme.md");
  });

  it("S3: existing Mac vault connecting to existing VPS vault (different content)", async () => {
    createTestFile(env, "notes/local-only.md", "local content");

    vi.mocked(commands.runRsync)
      .mockResolvedValueOnce({
        changedFiles: ["notes/local-only.md"], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      }) // pushAll — sends local files
      .mockResolvedValueOnce({
        changedFiles: ["notes/remote-only.md", "docs/guide.md"], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      }); // pull — remote files arrive

    const result = await env.engine.fullSync();

    expect(result.success).toBe(true);
    expect(result.changedFiles).toContain("notes/local-only.md");
    expect(result.changedFiles).toContain("notes/remote-only.md");
    expect(result.changedFiles).toContain("docs/guide.md");
  });

  it("S4: second Mac connecting to same VPS vault", async () => {
    // First Mac: push files to VPS
    const env1 = createTestEnv({ sshHost: "user@shared-host", remotePath: "/shared/vault" });
    createTestFile(env1, "notes/shared.md", "shared content");

    vi.mocked(commands.runRsync)
      .mockResolvedValueOnce({
        changedFiles: ["notes/shared.md"], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      }) // env1 pushAll
      .mockResolvedValueOnce({
        changedFiles: [], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      }); // env1 pull

    const result1 = await env1.engine.fullSync();
    expect(result1.success).toBe(true);
    expect(result1.changedFiles).toContain("notes/shared.md");

    // Second Mac: empty vault, pulls from same VPS
    const env2 = createTestEnv({ sshHost: "user@shared-host", remotePath: "/shared/vault" });

    vi.mocked(commands.runRsync)
      .mockResolvedValueOnce({
        changedFiles: [], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      }) // env2 pushAll — nothing local
      .mockResolvedValueOnce({
        changedFiles: ["notes/shared.md"], deletedFiles: [],
        stdout: "", stderr: "", exitCode: 0,
      }); // env2 pull — gets shared file

    const result2 = await env2.engine.fullSync();
    expect(result2.success).toBe(true);
    expect(result2.changedFiles).toContain("notes/shared.md");

    // Manifests are independent
    expect(env1.manifestPath).not.toBe(env2.manifestPath);

    env1.cleanup();
    env2.cleanup();
  });

  it("S5: test connection succeeds", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "file1.md\nfile2.md", stderr: "", exitCode: 0,
    });

    const result = await env.engine.testConnection();

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("S6: test connection fails (bad host)", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "", stderr: "ssh: connect to host bad-host port 22: Connection refused", exitCode: 255,
    });

    const result = await env.engine.testConnection();

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Connection refused");
  });

  it("S7: test connection fails (bad remote path)", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue({
      stdout: "", stderr: "ls: /nonexistent/path: No such file or directory", exitCode: 1,
    });

    const result = await env.engine.testConnection();

    expect(result.success).toBe(false);
  });

  it("S8: configuring settings for the first time", () => {
    // DEFAULT_CONFIG starts unconfigured
    expect(DEFAULT_CONFIG.enabled).toBe(false);
    expect(DEFAULT_CONFIG.sshHost).toBe("");
    expect(DEFAULT_CONFIG.remotePath).toBe("");

    // Initial state is disabled
    const state = createInitialState(false);
    expect(state.status).toBe("disabled");

    // Manual sync without engine returns notifyError
    const decision = decideManualSyncAction(state, false);
    expect(decision.effects.some((e) => e.type === "notifyError")).toBe(true);
    const errorEffect = findEffect(decision.effects, "notifyError");
    expect(errorEffect!.message).toContain("not initialized");
  });
});
