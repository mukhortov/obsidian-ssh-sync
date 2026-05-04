import { describe, it, expect } from "vitest";
import { parseStoredSettings, withPluginExcludes, DEFAULT_CONFIG } from "../../src/types";

describe("parseStoredSettings", () => {
  it("returns empty object for null", () => {
    expect(parseStoredSettings(null)).toEqual({});
  });

  it("returns empty object for undefined", () => {
    expect(parseStoredSettings(undefined)).toEqual({});
  });

  it("returns empty object for non-object", () => {
    expect(parseStoredSettings("string")).toEqual({});
    expect(parseStoredSettings(42)).toEqual({});
  });

  it("parses valid boolean fields", () => {
    const result = parseStoredSettings({ enabled: true, syncOnSave: false });
    expect(result.enabled).toBe(true);
    expect(result.syncOnSave).toBe(false);
  });

  it("parses valid string fields", () => {
    const result = parseStoredSettings({ sshHost: "user@host", remotePath: "/tmp" });
    expect(result.sshHost).toBe("user@host");
    expect(result.remotePath).toBe("/tmp");
  });

  it("parses valid pollIntervalSeconds", () => {
    const result = parseStoredSettings({ pollIntervalSeconds: 30 });
    expect(result.pollIntervalSeconds).toBe(30);
  });

  it("drops NaN pollIntervalSeconds", () => {
    const result = parseStoredSettings({ pollIntervalSeconds: NaN });
    expect(result.pollIntervalSeconds).toBeUndefined();
  });

  it("drops Infinity pollIntervalSeconds", () => {
    const result = parseStoredSettings({ pollIntervalSeconds: Infinity });
    expect(result.pollIntervalSeconds).toBeUndefined();
  });

  it("drops non-number pollIntervalSeconds", () => {
    const result = parseStoredSettings({ pollIntervalSeconds: "60" });
    expect(result.pollIntervalSeconds).toBeUndefined();
  });

  it("parses valid excludePatterns", () => {
    const result = parseStoredSettings({ excludePatterns: [".git/**", "*.swp"] });
    expect(result.excludePatterns).toEqual([".git/**", "*.swp"]);
  });

  it("drops excludePatterns with non-string items", () => {
    const result = parseStoredSettings({ excludePatterns: [".git/**", 42] });
    expect(result.excludePatterns).toBeUndefined();
  });

  it("drops non-array excludePatterns", () => {
    const result = parseStoredSettings({ excludePatterns: ".git/**" });
    expect(result.excludePatterns).toBeUndefined();
  });

  it("parses valid conflictPolicy", () => {
    expect(parseStoredSettings({ conflictPolicy: "remote-wins" }).conflictPolicy).toBe("remote-wins");
    expect(parseStoredSettings({ conflictPolicy: "local-wins" }).conflictPolicy).toBe("local-wins");
    expect(parseStoredSettings({ conflictPolicy: "newest-wins" }).conflictPolicy).toBe("newest-wins");
  });

  it("drops invalid conflictPolicy", () => {
    const result = parseStoredSettings({ conflictPolicy: "invalid" });
    expect(result.conflictPolicy).toBeUndefined();
  });

  it("ignores unknown fields", () => {
    const result = parseStoredSettings({ unknownField: "value", enabled: true });
    expect(result).toEqual({ enabled: true });
  });

  it("drops fields with wrong types", () => {
    const result = parseStoredSettings({
      enabled: "yes",
      sshHost: 123,
      syncOnSave: 1,
    });
    expect(result).toEqual({});
  });
});

describe("withPluginExcludes", () => {
  it("adds plugin state file excludes using configDir", () => {
    const result = withPluginExcludes([".git/**"], ".obsidian");
    expect(result).toContain(".obsidian/plugins/ssh-sync/sync-manifest.json");
    expect(result).toContain(".obsidian/plugins/ssh-sync/sync-log.json");
    expect(result).toContain(".git/**");
  });

  it("uses custom configDir", () => {
    const result = withPluginExcludes([], ".my-config");
    expect(result).toContain(".my-config/plugins/ssh-sync/sync-manifest.json");
    expect(result).toContain(".my-config/plugins/ssh-sync/sync-log.json");
  });

  it("does not duplicate excludes already present", () => {
    const existing = [".obsidian/plugins/ssh-sync/sync-manifest.json"];
    const result = withPluginExcludes(existing, ".obsidian");
    const manifestCount = result.filter((p) => p === ".obsidian/plugins/ssh-sync/sync-manifest.json").length;
    expect(manifestCount).toBe(1);
    expect(result).toContain(".obsidian/plugins/ssh-sync/sync-log.json");
  });

  it("does not mutate the input array", () => {
    const input = [".git/**"];
    withPluginExcludes(input, ".obsidian");
    expect(input).toEqual([".git/**"]);
  });

  it("does not exclude plugin manifest.json", () => {
    const result = withPluginExcludes(DEFAULT_CONFIG.excludePatterns, ".obsidian");
    expect(result).not.toContain(".obsidian/plugins/ssh-sync/manifest.json");
  });
});
