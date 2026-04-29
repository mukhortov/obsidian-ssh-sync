import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { ManifestStore } from "../../src/sync/manifest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("ManifestStore", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-test-"));
  const manifestPath = path.join(tmpDir, "manifest.json");
  let store: ManifestStore;

  beforeEach(() => {
    if (fs.existsSync(manifestPath)) {
      fs.rmSync(manifestPath);
    }
    store = new ManifestStore(manifestPath);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("starts with empty manifest", () => {
    expect(store.getEntries()).toEqual({});
    expect(store.getLastSyncTime()).toBe(0);
  });

  it("loads existing manifest from file", () => {
    const data = {
      files: { "foo.md": { path: "foo.md", localMtime: 100, remoteMtime: 100, lastSyncedMtime: 100, size: 50, hash: "abc123" } },
      lastSyncTime: 500,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(data));
    store = new ManifestStore(manifestPath);
    expect(store.getEntries()).toHaveProperty("foo.md");
    expect(store.getLastSyncTime()).toBe(500);
  });

  it("sets and gets entry", () => {
    const entry = {
      path: "notes/test.md",
      localMtime: 1000,
      remoteMtime: 1000,
      lastSyncedMtime: 1000,
      size: 200,
      hash: "def456",
    };
    store.setEntry("notes/test.md", entry);
    expect(store.getEntry("notes/test.md")).toEqual(entry);
  });

  it("removes entry", () => {
    const entry = {
      path: "notes/old.md",
      localMtime: 1000,
      remoteMtime: 1000,
      lastSyncedMtime: 1000,
      size: 100,
      hash: "ghi789",
    };
    store.setEntry("notes/old.md", entry);
    store.removeEntry("notes/old.md");
    expect(store.getEntry("notes/old.md")).toBeUndefined();
  });

  it("updates last sync time", () => {
    store.setLastSyncTime(9999);
    expect(store.getLastSyncTime()).toBe(9999);
  });

  it("saves and reloads", async () => {
    const entry = {
      path: "persist.md",
      localMtime: 500,
      remoteMtime: 500,
      lastSyncedMtime: 500,
      size: 50,
      hash: "persist123",
    };
    store.setEntry("persist.md", entry);
    store.setLastSyncTime(7777);
    await store.save();

    const reloaded = new ManifestStore(manifestPath);
    expect(reloaded.getEntry("persist.md")).toEqual(entry);
    expect(reloaded.getLastSyncTime()).toBe(7777);
  });
});
