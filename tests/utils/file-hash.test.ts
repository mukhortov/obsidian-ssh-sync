import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hashFile } from "../../src/utils/file-hash";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("hashFile", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hash-test-"));
  const testFile = path.join(tmpDir, "test.md");

  beforeAll(() => {
    fs.writeFileSync(testFile, "hello world");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns SHA-256 hash for a file", async () => {
    const hash = await hashFile(testFile);
    expect(hash).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    );
  });

  it("returns different hash for different content", async () => {
    const differentFile = path.join(tmpDir, "different.md");
    fs.writeFileSync(differentFile, "goodbye world");
    const hash = await hashFile(differentFile);
    expect(hash).not.toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    );
  });

  it("returns empty string for nonexistent file", async () => {
    const hash = await hashFile("/nonexistent/path/file.md");
    expect(hash).toBe("");
  });
});
