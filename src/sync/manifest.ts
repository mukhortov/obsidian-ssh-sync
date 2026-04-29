import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { ManifestData, ManifestEntry } from "../types";

/** Mutable internal representation — ManifestStore is the sole owner. */
interface MutableManifestData {
  files: Record<string, ManifestEntry>;
  lastSyncTime: number;
}

export class ManifestStore {
  private data: MutableManifestData;

  constructor(private filePath: string) {
    this.data = this.load();
  }

  private load(): ManifestData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw);
        return {
          files: parsed.files || {},
          lastSyncTime: parsed.lastSyncTime || 0,
        };
      }
    } catch {
      // Corrupted or unreadable — start fresh
    }
    return { files: {}, lastSyncTime: 0 };
  }

  getEntries(): Record<string, ManifestEntry> {
    return { ...this.data.files };
  }

  getEntry(filePath: string): ManifestEntry | undefined {
    return this.data.files[filePath];
  }

  setEntry(filePath: string, entry: ManifestEntry): void {
    this.data.files[filePath] = entry;
  }

  removeEntry(filePath: string): void {
    delete this.data.files[filePath];
  }

  getLastSyncTime(): number {
    return this.data.lastSyncTime;
  }

  setLastSyncTime(time: number): void {
    this.data.lastSyncTime = time;
  }

  async save(): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsp.writeFile(this.filePath, JSON.stringify(this.data, null, 2));
  }
}
