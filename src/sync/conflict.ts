import * as fsp from "fs/promises";
import * as path from "path";
import { ConflictInfo } from "../types";
import { SyncLog } from "./sync-log";

export class ConflictResolver {
  constructor(private vaultPath: string, private syncLog: SyncLog) {}

  async resolveConflict(
    conflict: ConflictInfo,
    newContent: string
  ): Promise<ConflictInfo> {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const ext = path.extname(conflict.localPath);
    const base = conflict.localPath.slice(0, -ext.length);
    const backupPath = `${base}.${timestamp}${ext}`;

    // Backup current file (the losing version)
    await fsp.copyFile(conflict.localPath, backupPath);

    // Write winning content
    await fsp.writeFile(conflict.localPath, newContent);

    const resolved: ConflictInfo = { ...conflict, backupPath };

    await this.syncLog.append({
      type: "conflict",
      path: conflict.localPath,
      message: `Conflict resolved: ${conflict.winner} won. Backup: ${backupPath}`,
    });

    return resolved;
  }
}
