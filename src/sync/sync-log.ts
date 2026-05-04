import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { SyncLogEntry } from "../types";

const MAX_LOG_ENTRIES = 200;

export class SyncLog {
  private logs: SyncLogEntry[] = [];

  constructor(private filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw) as unknown;
        this.logs = Array.isArray(parsed) ? (parsed as SyncLogEntry[]) : [];
      }
    } catch {
      this.logs = [];
    }
  }

  private async save(): Promise<void> {
    try {
      if (this.logs.length > MAX_LOG_ENTRIES) {
        this.logs = this.logs.slice(-MAX_LOG_ENTRIES);
      }
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      await fsp.writeFile(this.filePath, JSON.stringify(this.logs, null, 2));
    } catch {
      // Logging failure is non-fatal
    }
  }

  getEntries(): SyncLogEntry[] {
    return [...this.logs];
  }

  async append(entry: Omit<SyncLogEntry, "timestamp">): Promise<void> {
    this.logs.push({ ...entry, timestamp: Date.now() });
    await this.save();
  }
}
