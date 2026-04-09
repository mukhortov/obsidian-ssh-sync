import * as fs from "fs";
import * as path from "path";
import { ManifestData, ManifestEntry } from "../types";

export interface RenameInfo {
  oldPath: string;
  newPath: string;
}

export class ManifestStore {
  private data: ManifestData;

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

  detectRenames(currentFiles: Map<string, { hash: string; mtime: number }>): RenameInfo[] {
    const renames: RenameInfo[] = [];
    const knownPaths = new Set(Object.keys(this.data.files));
    const currentPaths = new Set(currentFiles.keys());

    const deletedPaths = [...knownPaths].filter((p) => !currentPaths.has(p));
    const newPaths = new Set([...currentPaths].filter((p) => !knownPaths.has(p)));

    for (const oldPath of deletedPaths) {
      const oldEntry = this.data.files[oldPath];
      for (const newPath of newPaths) {
        const current = currentFiles.get(newPath)!;
        if (current.hash === oldEntry.hash) {
          renames.push({ oldPath, newPath });
          newPaths.delete(newPath);
          break;
        }
      }
    }

    return renames;
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}
