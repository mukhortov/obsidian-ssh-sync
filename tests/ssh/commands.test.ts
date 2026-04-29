import { describe, it, expect } from "vitest";
import {
  buildRsyncPushCommand,
  buildRsyncPullCommand,
  buildRsyncDryRunCommand,
  buildMkdirCommand,
  buildLsCommand,
  buildRmCommand,
  buildStatCommand,
  parseRsyncOutput,
  escapeRemotePath,
} from "../../src/ssh/commands";
import { DEFAULT_CONFIG } from "../../src/types";

describe("buildRsyncPushCommand", () => {
  it("builds push command for single file", () => {
    const cmd = buildRsyncPushCommand({
      localPath: "/local/vault",
      sshHost: "user@host",
      remotePath: "/remote/vault",
      relativePath: "notes/foo.md",
    });
    expect(cmd).toBe(
      `rsync -az --update --itemize-changes -e "ssh" '/local/vault/notes/foo.md' "user@host:/remote/vault/notes/foo.md"`
    );
  });

  it("builds push command for directory with excludes and --delete", () => {
    const cmd = buildRsyncPushCommand({
      localPath: "/local/vault",
      sshHost: "user@host",
      remotePath: "/remote/vault",
      excludePatterns: [".obsidian/**", ".git/**"],
    });
    expect(cmd).toContain('rsync -az --update --itemize-changes --delete -e "ssh"');
    expect(cmd).toContain("--exclude='.obsidian/**'");
    expect(cmd).toContain("--exclude='.git/**'");
    expect(cmd).toContain("'/local/vault/'");
    expect(cmd).toContain('"user@host:/remote/vault/"');
  });

  it("builds push command for directory WITHOUT --delete when deleteFlag is false", () => {
    const cmd = buildRsyncPushCommand({
      localPath: "/local/vault",
      sshHost: "user@host",
      remotePath: "/remote/vault",
      deleteFlag: false,
    });
    expect(cmd).not.toContain("--delete");
    expect(cmd).toContain("'/local/vault/'");
    expect(cmd).toContain('"user@host:/remote/vault/"');
  });

  it("escapes spaces in remote path for single file", () => {
    const cmd = buildRsyncPushCommand({
      localPath: "/local/vault",
      sshHost: "user@host",
      remotePath: "/remote/my vault",
      relativePath: "my notes/foo.md",
    });
    expect(cmd).toContain('"user@host:/remote/my\\ vault/my\\ notes/foo.md"');
  });

  it("preserves tilde in remote path for home directory expansion", () => {
    const cmd = buildRsyncPushCommand({
      localPath: "/local/vault",
      sshHost: "user@host",
      remotePath: "~/obsidian-vault",
    });
    expect(cmd).toContain('"user@host:~/obsidian-vault/"');
  });

  it("single-quotes local path to prevent shell expansion of $ and backticks", () => {
    const cmd = buildRsyncPushCommand({
      localPath: "/local/$HOME/vault",
      sshHost: "user@host",
      remotePath: "/remote/vault",
      relativePath: "notes/`test`.md",
    });
    // Local path must be single-quoted so $HOME and `test` are literal
    expect(cmd).toContain("'/local/$HOME/vault/notes/`test`.md'");
  });
});

describe("buildRsyncPullCommand", () => {
  it("builds pull command for single file", () => {
    const cmd = buildRsyncPullCommand({
      localPath: "/local/vault",
      sshHost: "user@host",
      remotePath: "/remote/vault",
      relativePath: "notes/foo.md",
    });
    expect(cmd).toBe(
      `rsync -az --update --itemize-changes -e "ssh" "user@host:/remote/vault/notes/foo.md" '/local/vault/notes/foo.md'`
    );
  });

  it("builds pull command for directory with excludes and --delete", () => {
    const cmd = buildRsyncPullCommand({
      localPath: "/local/vault",
      sshHost: "user@host",
      remotePath: "/remote/vault",
      excludePatterns: [".obsidian/**"],
    });
    expect(cmd).toContain("--delete");
    expect(cmd).toContain("--exclude='.obsidian/**'");
    expect(cmd).toContain('"user@host:/remote/vault/"');
    expect(cmd).toContain("'/local/vault/'");
  });

  it("builds pull command for directory WITHOUT --delete when deleteFlag is false", () => {
    const cmd = buildRsyncPullCommand({
      localPath: "/local/vault",
      sshHost: "user@host",
      remotePath: "/remote/vault",
      deleteFlag: false,
    });
    expect(cmd).not.toContain("--delete");
    expect(cmd).toContain('"user@host:/remote/vault/"');
    expect(cmd).toContain("'/local/vault/'");
  });
});

describe("buildRsyncDryRunCommand", () => {
  it("builds dry-run command to detect remote changes including deletions", () => {
    const cmd = buildRsyncDryRunCommand({
      sshHost: "user@host",
      remotePath: "/remote/vault",
      localPath: "/local/vault",
      excludePatterns: [".obsidian/**"],
    });
    expect(cmd).toContain("--dry-run");
    expect(cmd).toContain("--delete");
    expect(cmd).toContain("--itemize-changes");
    expect(cmd).toContain('"user@host:/remote/vault/"');
    expect(cmd).toContain("'/local/vault/'");
  });
});

describe("buildMkdirCommand", () => {
  it("builds mkdir -p command", () => {
    const cmd = buildMkdirCommand("user@host", "/remote/vault");
    expect(cmd).toBe(`ssh "user@host" "mkdir -p '/remote/vault'"`);
  });
});

describe("buildLsCommand", () => {
  it("builds ls command for connection test", () => {
    const cmd = buildLsCommand("user@host", "/remote/vault");
    expect(cmd).toBe(`ssh "user@host" "ls '/remote/vault'"`);
  });
});

describe("buildRmCommand", () => {
  it("builds rm command for file deletion", () => {
    const cmd = buildRmCommand("user@host", "/remote/vault/old.md");
    expect(cmd).toBe(`ssh "user@host" "rm '/remote/vault/old.md'"`);
  });
});

describe("parseRsyncOutput", () => {
  it("parses itemize-changes output for sent files (>f)", () => {
    const stdout = ">f..t...... notes/foo.md\n>f+++++++++ notes/new.md\n";
    const result = parseRsyncOutput(stdout);
    expect(result.changedFiles).toEqual(["notes/foo.md", "notes/new.md"]);
    expect(result.deletedFiles).toEqual([]);
  });

  it("parses itemize-changes output for received files (<f)", () => {
    const stdout = "<f..t...... docs/readme.md\n<f+++++++++ docs/new.md\n";
    const result = parseRsyncOutput(stdout);
    expect(result.changedFiles).toEqual(["docs/readme.md", "docs/new.md"]);
    expect(result.deletedFiles).toEqual([]);
  });

  it("parses deleted files (*deleting)", () => {
    const stdout = "*deleting   old/removed.md\n*deleting   trash/gone.md\n";
    const result = parseRsyncOutput(stdout);
    expect(result.changedFiles).toEqual([]);
    expect(result.deletedFiles).toEqual(["old/removed.md", "trash/gone.md"]);
  });

  it("ignores directory deletions (*deleting with trailing /)", () => {
    const stdout = "*deleting   old/dir/\n*deleting   old/file.md\n";
    const result = parseRsyncOutput(stdout);
    expect(result.deletedFiles).toEqual(["old/file.md"]);
  });

  it("ignores directory lines and summary noise", () => {
    const stdout = "cd+++++++++ notes/\n>f..t...... notes/real.md\n.d..t...... docs/\n";
    const result = parseRsyncOutput(stdout);
    expect(result.changedFiles).toEqual(["notes/real.md"]);
    expect(result.deletedFiles).toEqual([]);
  });

  it("handles mixed output with changed, deleted, and noise lines", () => {
    const stdout = [
      ">f..t...... notes/modified.md",
      "*deleting   notes/removed.md",
      "cd+++++++++ new-dir/",
      "<f+++++++++ notes/from-remote.md",
      ".d..t...... existing-dir/",
    ].join("\n");
    const result = parseRsyncOutput(stdout);
    expect(result.changedFiles).toEqual(["notes/modified.md", "notes/from-remote.md"]);
    expect(result.deletedFiles).toEqual(["notes/removed.md"]);
  });

  it("returns empty arrays for empty stdout", () => {
    const result = parseRsyncOutput("");
    expect(result.changedFiles).toEqual([]);
    expect(result.deletedFiles).toEqual([]);
  });

  it("handles whitespace-only stdout", () => {
    const result = parseRsyncOutput("   \n  \n");
    expect(result.changedFiles).toEqual([]);
    expect(result.deletedFiles).toEqual([]);
  });
});

describe("DEFAULT_CONFIG excludePatterns", () => {
  it("excludes sync-log.json to prevent infinite deletion loop", () => {
    expect(DEFAULT_CONFIG.excludePatterns).toContain(
      ".obsidian/plugins/obsidian-ssh-sync/sync-log.json"
    );
  });

  it("excludes plugin internal state files that should not be synced", () => {
    const patterns = DEFAULT_CONFIG.excludePatterns;
    expect(patterns).toContain(".obsidian/plugins/obsidian-ssh-sync/sync-manifest.json");
    expect(patterns).toContain(".obsidian/plugins/obsidian-ssh-sync/sync-log.json");
  });

  it("does not exclude plugin manifest.json (should sync across devices)", () => {
    expect(DEFAULT_CONFIG.excludePatterns).not.toContain(
      ".obsidian/plugins/obsidian-ssh-sync/manifest.json"
    );
  });

  it("excludes vim swap files", () => {
    expect(DEFAULT_CONFIG.excludePatterns).toContain("*.swp");
  });
});

describe("escapeRemotePath", () => {
  it("escapes spaces", () => {
    expect(escapeRemotePath("/my vault/notes")).toBe("/my\\ vault/notes");
  });

  it("escapes single and double quotes", () => {
    expect(escapeRemotePath("/it's/a \"test\"")).toBe("/it\\'s/a\\ \\\"test\\\"");
  });

  it("escapes backticks", () => {
    expect(escapeRemotePath("/path/`cmd`")).toBe("/path/\\`cmd\\`");
  });

  it("escapes dollar sign and exclamation", () => {
    expect(escapeRemotePath("/path/$HOME/!done")).toBe("/path/\\$HOME/\\!done");
  });

  it("escapes parentheses, ampersand, semicolon, pipe", () => {
    expect(escapeRemotePath("/a&b;c|d(e)")).toBe("/a\\&b\\;c\\|d\\(e\\)");
  });

  it("escapes special characters in realistic filename", () => {
    const escaped = escapeRemotePath("/remote/vault/notes/café & résumé (2026).md");
    expect(escaped).toContain("café\\ \\&\\ résumé\\ \\(2026\\).md");
  });

  it("escapes glob characters", () => {
    expect(escapeRemotePath("/path/*.md")).toBe("/path/\\*.md");
    expect(escapeRemotePath("/path/[0-9]")).toBe("/path/\\[0-9\\]");
    expect(escapeRemotePath("/path/?")).toBe("/path/\\?");
  });

  it("does not escape tilde (needed for home directory expansion)", () => {
    expect(escapeRemotePath("~/vault")).toBe("~/vault");
    expect(escapeRemotePath("~/my vault")).toBe("~/my\\ vault");
  });

  it("leaves simple paths unchanged", () => {
    expect(escapeRemotePath("/remote/vault/notes/foo.md")).toBe("/remote/vault/notes/foo.md");
  });
});

describe("SSH commands with special characters", () => {
  it("buildMkdirCommand escapes single quotes in path", () => {
    const cmd = buildMkdirCommand("user@host", "/remote/it's a vault");
    expect(cmd).toBe(`ssh "user@host" "mkdir -p '/remote/it'\\''s a vault'"`);
  });

  it("buildLsCommand escapes single quotes in path", () => {
    const cmd = buildLsCommand("user@host", "/remote/it's a vault");
    expect(cmd).toBe(`ssh "user@host" "ls '/remote/it'\\''s a vault'"`);
  });

  it("buildRmCommand escapes single quotes in path", () => {
    const cmd = buildRmCommand("user@host", "/remote/it's a file.md");
    expect(cmd).toBe(`ssh "user@host" "rm '/remote/it'\\''s a file.md'"`);
  });

  it("buildMkdirCommand expands tilde in ~/path", () => {
    const cmd = buildMkdirCommand("user@host", "~/obsidian-vault");
    expect(cmd).toBe(`ssh "user@host" "mkdir -p ~/'obsidian-vault'"`);
  });

  it("buildLsCommand expands tilde in ~/path", () => {
    const cmd = buildLsCommand("user@host", "~/obsidian-vault");
    expect(cmd).toBe(`ssh "user@host" "ls ~/'obsidian-vault'"`);
  });

  it("buildRmCommand expands tilde in ~/path", () => {
    const cmd = buildRmCommand("user@host", "~/obsidian-vault/old.md");
    expect(cmd).toBe(`ssh "user@host" "rm ~/'obsidian-vault/old.md'"`);
  });
});

describe("buildStatCommand", () => {
  it("builds stat command for multiple files", () => {
    const cmd = buildStatCommand("user@host", "/remote/vault", ["a.md", "b.md"]);
    expect(cmd).toContain("ssh");
    expect(cmd).toContain("user@host");
    expect(cmd).toContain("stat");
    expect(cmd).toContain("a.md");
    expect(cmd).toContain("b.md");
  });

  it("handles files with spaces", () => {
    const cmd = buildStatCommand("user@host", "/remote/vault", ["my file.md"]);
    expect(cmd).toContain("my file.md");
  });

  it("handles tilde paths", () => {
    const cmd = buildStatCommand("user@host", "~/vault", ["test.md"]);
    expect(cmd).toContain("~/");
    expect(cmd).toContain("test.md");
  });
});
