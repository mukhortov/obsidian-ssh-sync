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

  it("pushes file in deeply nested subfolder (mkdir -p on remote)", async () => {
    createLocalFile(env, "a/b/c/d/file.md", "deep content");

    const result = await env.engine.pushFile("a/b/c/d/file.md");

    expect(result.success).toBe(true);
    expect(remoteFileExists(env, "a/b/c/d/file.md")).toBe(true);
    expect(readRemoteFile(env, "a/b/c/d/file.md")).toBe("deep content");
  });

  it("pushes multiple files to same new subfolder", async () => {
    createLocalFile(env, "new-folder/first.md", "first file");
    createLocalFile(env, "new-folder/second.md", "second file");

    const result1 = await env.engine.pushFile("new-folder/first.md");
    const result2 = await env.engine.pushFile("new-folder/second.md");

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(remoteFileExists(env, "new-folder/first.md")).toBe(true);
    expect(remoteFileExists(env, "new-folder/second.md")).toBe(true);
  });

  it("deletes remote file and verifies it is gone", async () => {
    createLocalFile(env, "notes/to-remove.md", "temporary content");
    await env.engine.pushFile("notes/to-remove.md");
    expect(remoteFileExists(env, "notes/to-remove.md")).toBe(true);

    const result = await env.engine.deleteRemoteFile("notes/to-remove.md");

    expect(result.success).toBe(true);
    expect(remoteFileExists(env, "notes/to-remove.md")).toBe(false);
  });

  it("full sync with nested folder structure", async () => {
    // 3 local files at different depths
    createLocalFile(env, "top.md", "top level");
    createLocalFile(env, "docs/guide.md", "one level deep");
    createLocalFile(env, "docs/api/ref.md", "two levels deep");

    // 2 remote files at different depths
    createRemoteFile(env, "remote-note.md", "remote top");
    createRemoteFile(env, "journal/2024/entry.md", "remote nested");

    const result = await env.engine.fullSync();

    expect(result.success).toBe(true);

    // All 3 local files should exist on remote
    expect(remoteFileExists(env, "top.md")).toBe(true);
    expect(remoteFileExists(env, "docs/guide.md")).toBe(true);
    expect(remoteFileExists(env, "docs/api/ref.md")).toBe(true);

    // All 2 remote files should exist locally
    expect(fs.existsSync(path.join(env.localVaultPath, "remote-note.md"))).toBe(true);
    expect(fs.existsSync(path.join(env.localVaultPath, "journal/2024/entry.md"))).toBe(true);
  });

  it("detects remote folder rename as delete + create in dry-run", async () => {
    createLocalFile(env, "old-folder/file.md", "moved content");
    await env.engine.pushFile("old-folder/file.md");

    // Rename folder on remote side
    fs.mkdirSync(path.join(env.remoteVaultPath, "new-folder"), { recursive: true });
    fs.renameSync(
      path.join(env.remoteVaultPath, "old-folder/file.md"),
      path.join(env.remoteVaultPath, "new-folder/file.md")
    );
    fs.rmSync(path.join(env.remoteVaultPath, "old-folder"), { recursive: true, force: true });

    const changes = await env.engine.detectRemoteChanges();

    expect(changes.deletedFiles).toContain("old-folder/file.md");
    expect(changes.changedFiles).toContain("new-folder/file.md");
  });

  it("handles file with special characters in folder name", async () => {
    createLocalFile(env, "café notes/résumé.md", "special chars work");

    const result = await env.engine.pushFile("café notes/résumé.md");

    expect(result.success).toBe(true);
    expect(remoteFileExists(env, "café notes/résumé.md")).toBe(true);
    expect(readRemoteFile(env, "café notes/résumé.md")).toBe("special chars work");
  });

  it("pushes file then pulls modified version from remote", async () => {
    createLocalFile(env, "notes/evolving.md", "version 1");
    await env.engine.pushFile("notes/evolving.md");

    // Modify the file directly on the remote
    fs.writeFileSync(
      path.join(env.remoteVaultPath, "notes/evolving.md"),
      "version 2 from remote"
    );

    const result = await env.engine.pullWithoutDelete();

    expect(result.success).toBe(true);
    const localContent = fs.readFileSync(
      path.join(env.localVaultPath, "notes/evolving.md"),
      "utf-8"
    );
    expect(localContent).toBe("version 2 from remote");
  });

  it("fullSync does NOT duplicate folder contents into nested subfolders", async () => {
    // Reproduce the bug: Notes/Test.md getting duplicated to
    // Notes/Notes/Notes/.../Test.md after repeated syncs
    createLocalFile(env, "Notes/Test.md", "test content");
    createLocalFile(env, "Other/File.md", "other content");

    // First sync
    const result1 = await env.engine.fullSync();
    expect(result1.success).toBe(true);

    // Verify remote has exactly the right structure
    expect(remoteFileExists(env, "Notes/Test.md")).toBe(true);
    expect(remoteFileExists(env, "Other/File.md")).toBe(true);
    // Must NOT have nested duplicates
    expect(remoteFileExists(env, "Notes/Notes/Test.md")).toBe(false);

    // Second sync should be idempotent
    const result2 = await env.engine.fullSync();
    expect(result2.success).toBe(true);

    // Still no nesting
    expect(remoteFileExists(env, "Notes/Notes/Test.md")).toBe(false);
    // Local should not have nesting either
    expect(fs.existsSync(path.join(env.localVaultPath, "Notes/Notes/Test.md"))).toBe(false);

    // Third sync — the bug often manifests after multiple cycles
    const result3 = await env.engine.fullSync();
    expect(result3.success).toBe(true);
    expect(remoteFileExists(env, "Notes/Notes/Test.md")).toBe(false);
    expect(remoteFileExists(env, "Notes/Notes/Notes/Test.md")).toBe(false);
    expect(fs.existsSync(path.join(env.localVaultPath, "Notes/Notes/Test.md"))).toBe(false);
  });

  it("fullSync does NOT duplicate folder with spaces in name", async () => {
    createLocalFile(env, "Obsidian SSH Sync plugin/Specs.md", "spec content");

    const result1 = await env.engine.fullSync();
    expect(result1.success).toBe(true);
    expect(remoteFileExists(env, "Obsidian SSH Sync plugin/Specs.md")).toBe(true);

    // Must NOT create nested duplicate
    expect(remoteFileExists(env, "Obsidian SSH Sync plugin/Obsidian SSH Sync plugin/Specs.md")).toBe(false);

    // Second sync
    const result2 = await env.engine.fullSync();
    expect(result2.success).toBe(true);
    expect(remoteFileExists(env, "Obsidian SSH Sync plugin/Obsidian SSH Sync plugin/Specs.md")).toBe(false);
    expect(fs.existsSync(path.join(env.localVaultPath, "Obsidian SSH Sync plugin/Obsidian SSH Sync plugin/Specs.md"))).toBe(false);
  });
});
