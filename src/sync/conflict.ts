import * as fs from "fs";
import * as path from "path";
import { ConflictInfo, ManifestEntry, SyncLogEntry } from "../types";

const MAX_LOG_ENTRIES = 200;

export class ConflictResolver {
  private logs: SyncLogEntry[] = [];
  private conflicts: ConflictInfo[] = [];
  private logFilePath: string;

  constructor(private vaultPath: string, logFilePath?: string) {
    this.logFilePath = logFilePath || path.join(vaultPath, ".obsidian", "plugins", "obsidian-ssh-sync", "sync-log.json");
    this.loadLogs();
  }

  private loadLogs(): void {
    try {
      if (fs.existsSync(this.logFilePath)) {
        const raw = fs.readFileSync(this.logFilePath, "utf-8");
        this.logs = JSON.parse(raw);
      }
    } catch {
      this.logs = [];
    }
  }

  private saveLogs(): void {
    try {
      // Keep only the most recent entries
      if (this.logs.length > MAX_LOG_ENTRIES) {
        this.logs = this.logs.slice(-MAX_LOG_ENTRIES);
      }
      fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
      fs.writeFileSync(this.logFilePath, JSON.stringify(this.logs, null, 2));
    } catch {
      // Logging failure is non-fatal
    }
  }

  detectConflict(
    entry: ManifestEntry,
    current: { localMtime: number; remoteMtime: number }
  ): boolean {
    const localChanged = current.localMtime > entry.lastSyncedMtime;
    const remoteChanged = current.remoteMtime > entry.lastSyncedMtime;
    return localChanged && remoteChanged;
  }

  resolveConflict(
    conflict: ConflictInfo,
    newContent: string
  ): ConflictInfo {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const ext = path.extname(conflict.localPath);
    const base = conflict.localPath.slice(0, -ext.length);
    const backupPath = `${base}.${timestamp}${ext}`;

    // Backup current file (the losing version)
    fs.copyFileSync(conflict.localPath, backupPath);

    // Write winning content
    fs.writeFileSync(conflict.localPath, newContent);

    const resolved: ConflictInfo = { ...conflict, backupPath };
    this.conflicts.push(resolved);

    this.addLog({
      type: "conflict",
      path: conflict.localPath,
      message: `Conflict resolved: ${conflict.winner} won. Backup: ${backupPath}`,
    });

    return resolved;
  }

  getConflicts(): ConflictInfo[] {
    return [...this.conflicts];
  }

  clearConflicts(): void {
    this.conflicts = [];
  }

  getLogs(): SyncLogEntry[] {
    return [...this.logs];
  }

  addLog(entry: Omit<SyncLogEntry, "timestamp">): void {
    this.logs.push({ ...entry, timestamp: Date.now() });
    this.saveLogs();
  }
}
