import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  canRunE2E,
  createE2EEnv,
  createLocalFile,
  createRemoteFile,
  remoteFileExists,
  readRemoteFile,
  E2EEnv,
} from "../helpers/e2e-env";

const skipE2E = !canRunE2E();

describe.skipIf(skipE2E)("E2E: Real SSH sync", () => {
  let env: E2EEnv;

  beforeEach(() => {
    env = createE2EEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("pushes a local file to remote via rsync", async () => {
    createLocalFile(env, "notes/hello.md", "Hello from local");

    const result = await env.engine.pushFile("notes/hello.md");

    expect(result.success).toBe(true);
    expect(remoteFileExists(env, "notes/hello.md")).toBe(true);
    expect(readRemoteFile(env, "notes/hello.md")).toBe("Hello from local");
  });

  it("detects new remote file via dry-run", async () => {
    createRemoteFile(env, "notes/from-remote.md", "Hello from VPS");

    const changes = await env.engine.detectRemoteChanges();

    expect(changes.changedFiles).toContain("notes/from-remote.md");
  });

  it("pulls remote file to local", async () => {
    createRemoteFile(env, "notes/remote-doc.md", "Remote content");

    const result = await env.engine.pullWithoutDelete();

    expect(result.success).toBe(true);
    const localPath = path.join(env.localVaultPath, "notes/remote-doc.md");
    expect(fs.existsSync(localPath)).toBe(true);
    expect(fs.readFileSync(localPath, "utf-8")).toBe("Remote content");
  });

  it("detects remote deletion", async () => {
    // First push a file so it exists on both sides
    createLocalFile(env, "notes/will-delete.md", "content");
    await env.engine.pushFile("notes/will-delete.md");

    // Delete from remote
    fs.unlinkSync(path.join(env.remoteVaultPath, "notes/will-delete.md"));

    // Detect changes
    const changes = await env.engine.detectRemoteChanges();
    expect(changes.deletedFiles).toContain("notes/will-delete.md");
  });

  it("full sync pushes local and pulls remote", async () => {
    createLocalFile(env, "local-only.md", "local content");
    createRemoteFile(env, "remote-only.md", "remote content");

    const result = await env.engine.fullSync();

    expect(result.success).toBe(true);
    // Local file should be on remote
    expect(remoteFileExists(env, "local-only.md")).toBe(true);
    // Remote file should be local
    expect(fs.existsSync(path.join(env.localVaultPath, "remote-only.md"))).toBe(true);
  });

  it("handles file with spaces in path", async () => {
    createLocalFile(env, "my notes/hello world.md", "spaces work");

    const result = await env.engine.pushFile("my notes/hello world.md");

    expect(result.success).toBe(true);
    expect(remoteFileExists(env, "my notes/hello world.md")).toBe(true);
  });

  it("deleteLocalFiles removes file from vault", () => {
    createLocalFile(env, "to-delete.md", "content");

    const deleted = env.engine.deleteLocalFiles(["to-delete.md"], new Set());

    expect(deleted).toEqual(["to-delete.md"]);
    expect(fs.existsSync(path.join(env.localVaultPath, "to-delete.md"))).toBe(false);
  });

  it("ensureRemoteDir creates directory", async () => {
    // The remote dir already exists from createE2EEnv, but this verifies the command works
    const result = await env.engine.ensureRemoteDir();
    expect(result).toBe(true);
  });
});
