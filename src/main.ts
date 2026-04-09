import { Plugin, Notice, TAbstractFile, TFile, Menu, setIcon } from "obsidian";
import { SyncConfig, SyncStatus, DEFAULT_CONFIG, SyncLogEntry, ManifestEntry } from "./types";
import { SyncResult } from "./sync/engine";
import { SSHSyncSettingTab } from "./settings";
import { SyncEngine } from "./sync/engine";
import { FileWatcher, WatcherFlush } from "./sync/watcher";
import { Poller } from "./sync/poller";
import { SyncLock } from "./utils/sync-lock";
import {
  decidePollAction,
  decidePullAction,
  decideFlushAction,
  decideManualSyncAction,
  decideSyncFileAction,
  decideToggleAction,
  resolveConflictWinner,
  createInitialState,
  SyncState,
  SyncEffect,
} from "./sync/coordinator";
import * as path from "path";
import * as fs from "fs";

const STATUS_ICONS: Record<SyncStatus, string> = {
  idle: "cloud",
  syncing: "refresh-cw",
  error: "cloud-off",
  disabled: "cloud-off",
};

export default class SSHSyncPlugin extends Plugin {
  settings: SyncConfig = { ...DEFAULT_CONFIG };
  private syncEngine: SyncEngine | null = null;
  private fileWatcher: FileWatcher | null = null;
  private poller: Poller | null = null;
  private statusBarEl: HTMLElement | null = null;
  private syncStatus: SyncStatus = "disabled";
  private syncLock = new SyncLock();
  private syncState: SyncState = createInitialState(false);

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new SSHSyncSettingTab(this.app, this));

    // Status bar
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("obsidian-ssh-sync-status");
    this.statusBarEl.addClass("mod-clickable");
    this.statusBarEl.setAttribute("title", "SSH Sync status - click for options");
    this.statusBarEl.addEventListener("click", (evt: MouseEvent) => {
      this.showStatusBarMenu(evt);
    });
    this.updateStatusBar(this.settings.enabled ? "idle" : "disabled");

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.manualSync(),
    });

    this.addCommand({
      id: "sync-current-file",
      name: "Sync current file",
      callback: () => this.syncCurrentFile(),
    });

    this.addCommand({
      id: "toggle-sync",
      name: "Toggle sync",
      callback: () => this.toggleSync(),
    });

    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (file.path && this.settings.syncOnSave && this.settings.enabled) {
          this.fileWatcher?.onFileChange(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (file.path && this.settings.syncOnSave && this.settings.enabled) {
          this.fileWatcher?.onFileChange(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (file.path && this.settings.syncOnSave && this.settings.enabled) {
          this.fileWatcher?.onFileDeleted(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (this.settings.syncOnSave && this.settings.enabled) {
          if (oldPath && file.path) {
            this.fileWatcher?.onFileRenamed(file.path, oldPath);
          }
        }
      })
    );

    this.initSync();

    if (this.settings.enabled) {
      this.manualSync();
    }
  }

  private initSync(): void {
    const vaultPath = (this.app.vault.adapter as any).basePath;
    const manifestPath = path.join(
      vaultPath,
      this.app.vault.configDir,
      "plugins",
      "obsidian-ssh-sync",
      "sync-manifest.json"
    );

    this.syncEngine = new SyncEngine(this.settings, vaultPath, manifestPath);

    this.fileWatcher = new FileWatcher(500, async (flush: WatcherFlush) => {
      if (!this.settings.enabled || !this.syncEngine) return;
      await this.syncLock.run(async () => {
        this.updateStatusBar("syncing");
        let hasError = false;

        // Push changed files
        for (const file of flush.changedFiles) {
          const result = await this.syncEngine!.pushFile(file);
          if (!result.success) {
            hasError = true;
            new Notice(`Sync failed for ${file}: ${result.error}`);
          }
        }

        // Delete remote files that were deleted locally
        for (const file of flush.deletedFiles) {
          const result = await this.syncEngine!.deleteRemoteFile(file);
          if (!result.success) {
            hasError = true;
            new Notice(`Remote delete failed for ${file}: ${result.error}`);
          }
        }

        this.updateStatusBar(hasError ? "error" : "idle");
      });
    });

    this.poller = new Poller(async () => {
      if (!this.settings.enabled || !this.syncEngine) return;
      await this.pollRemoteChanges();
    }, this.settings.pollIntervalSeconds * 1000);

    if (this.settings.enabled) {
      this.poller.start();
    }
  }

  private async pollRemoteChanges(): Promise<void> {
    if (!this.syncEngine) return;

    const hasPending = this.fileWatcher?.hasPending() ?? false;
    const pollDecision = decidePollAction(this.syncState, hasPending);
    this.syncState = pollDecision.state;

    if (pollDecision.effects.length === 0) return;

    await this.syncLock.run(async () => {
      // Re-check after acquiring lock
      if (this.fileWatcher?.hasPending()) return;

      this.updateStatusBar("syncing");
      const changes = await this.syncEngine!.detectRemoteChanges();

      // Gather local file mtimes for conflict detection
      const localMtimes = new Map<string, number>();
      const vaultPath = (this.app.vault.adapter as any).basePath;
      for (const file of [...changes.changedFiles, ...changes.deletedFiles]) {
        const fullPath = path.join(vaultPath, file);
        if (fs.existsSync(fullPath)) {
          localMtimes.set(file, fs.statSync(fullPath).mtimeMs);
        }
      }

      const manifest = this.syncEngine!.getManifest().getEntries();
      const pendingPaths = this.fileWatcher?.getPendingPaths() ?? new Set<string>();

      const pullDecision = decidePullAction(
        this.syncState,
        changes,
        manifest,
        this.settings,
        pendingPaths,
        localMtimes
      );
      this.syncState = pullDecision.state;

      await this.executeEffects(pullDecision.effects);
    });
  }

  private async executeEffects(effects: readonly SyncEffect[]): Promise<void> {
    for (const effect of effects) {
      switch (effect.type) {
        case "pushFiles":
          for (const file of effect.files) {
            const result = await this.syncEngine!.pushFile(file);
            if (!result.success) {
              new Notice(`Sync failed for ${file}: ${result.error}`);
            }
          }
          break;
        case "pushFile":
          if (this.syncEngine) {
            const result = await this.syncEngine.pushFile(effect.file);
            if (result.success) {
              this.updateStatusBar("idle");
              new Notice(`SSH Sync: Pushed ${effect.file}`);
            } else {
              this.updateStatusBar("error");
              new Notice(`SSH Sync: Failed to push ${effect.file} — ${result.error}`);
            }
          }
          break;
        case "pushAll":
          await this.syncEngine?.pushAll();
          break;
        case "pullWithoutDelete":
          if (this.syncEngine) {
            const result = await this.syncEngine.pullWithoutDelete();
            if (!result.success) {
              this.updateStatusBar("error");
              new Notice(`SSH Sync pull failed: ${result.error}`);
            }
          }
          break;
        case "pullWithDelete":
          await this.syncEngine?.pull();
          break;
        case "deleteRemoteFiles":
          if (this.syncEngine) {
            for (const file of effect.files) {
              const result = await this.syncEngine.deleteRemoteFile(file);
              if (!result.success) {
                new Notice(`Remote delete failed for ${file}: ${result.error}`);
              }
            }
          }
          break;
        case "deleteLocalFiles":
          if (this.syncEngine) {
            const deleted = this.syncEngine.deleteLocalFiles(effect.files, new Set(effect.skipPaths));
            // Notification handled by the notify effect that follows
          }
          break;
        case "resolveConflict": {
          if (this.syncEngine) {
            const vaultPath = (this.app.vault.adapter as any).basePath;
            const fullPath = path.join(vaultPath, effect.file);
            const winner = resolveConflictWinner(effect.policy, effect.localMtime, effect.remoteMtime);
            if (winner === "remote") {
              // Pull will overwrite — backup local version first
              const localContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf-8") : "";
              // After pull, the conflict resolver will handle backup
              this.syncEngine.getConflictResolver().resolveConflict(
                {
                  localPath: fullPath,
                  localMtime: effect.localMtime,
                  remoteMtime: effect.remoteMtime,
                  winner: "remote",
                  backupPath: "",
                  timestamp: Date.now(),
                },
                localContent // backup local, pull will overwrite
              );
            } else {
              // Local wins — log it but don't pull this file
              this.syncEngine.getConflictResolver().addLog({
                type: "conflict",
                path: effect.file,
                message: `Conflict resolved: local wins. Remote version discarded.`,
              });
            }
          }
          break;
        }
        case "preserveLocalFile":
          // No-op: the file is kept as-is. The pushFile effect that follows will push it back.
          break;
        case "fullSync":
          if (this.syncEngine) {
            const result = await this.syncEngine.fullSync();
            if (result.success) {
              this.updateStatusBar("idle");
              new Notice(`SSH Sync: Complete — ${result.changedFiles.length} file(s) synced`);
            } else {
              this.updateStatusBar("error");
              new Notice(`SSH Sync: Failed — ${result.error}`);
            }
          }
          break;
        case "notify":
          new Notice(effect.message);
          break;
        case "notifyError":
          new Notice(effect.message);
          break;
        case "updateStatus":
          this.updateStatusBar(effect.status);
          break;
        case "startPoller":
          this.poller?.updateInterval(effect.intervalMs);
          this.poller?.start();
          break;
        case "stopPoller":
          this.poller?.stop();
          break;
        case "detectRemoteChanges":
          // Handled inline in pollRemoteChanges
          break;
        case "log":
          this.syncEngine?.getConflictResolver().addLog(effect.entry);
          break;
      }
    }
  }

  async manualSync(): Promise<SyncResult> {
    if (!this.syncEngine) {
      return { success: false, changedFiles: [], conflicts: 0, error: "Sync engine not initialized" };
    }
    return this.syncLock.run(async () => {
      this.updateStatusBar("syncing");
      new Notice("SSH Sync: Starting full sync...");
      try {
        const result = await this.syncEngine!.fullSync();
        if (result.success) {
          this.updateStatusBar("idle");
          new Notice(`SSH Sync: Complete — ${result.changedFiles.length} file(s) synced`);
        } else {
          this.updateStatusBar("error");
          new Notice(`SSH Sync: Failed — ${result.error}`);
        }
        return result;
      } catch (err) {
        this.updateStatusBar("error");
        const message = (err as Error).message || "Unknown error";
        new Notice(`SSH Sync: Error — ${message}`);
        return { success: false, changedFiles: [], conflicts: 0, error: message };
      }
    });
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    if (!this.syncEngine) {
      return { success: false, error: "Sync engine not initialized" };
    }
    return this.syncEngine.testConnection();
  }

  async toggleSync(): Promise<void> {
    this.settings.enabled = !this.settings.enabled;
    await this.saveSettings();
    this.onSettingsChanged();
    this.updateStatusBar(this.settings.enabled ? "idle" : "disabled");
    new Notice(`SSH Sync ${this.settings.enabled ? "enabled" : "disabled"}`);
  }

  onSettingsChanged(): void {
    if (this.poller) {
      if (this.settings.enabled) {
        this.poller.updateInterval(this.settings.pollIntervalSeconds * 1000);
        this.poller.start();
      } else {
        this.poller.stop();
      }
    }
  }

  getSyncLogs(): SyncLogEntry[] {
    return this.syncEngine?.getConflictResolver().getLogs() || [];
  }

  async onunload(): Promise<void> {
    this.fileWatcher?.dispose();
    this.poller?.stop();
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_CONFIG, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private updateStatusBar(status: SyncStatus): void {
    this.syncStatus = status;
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();
    setIcon(this.statusBarEl, STATUS_ICONS[status]);
  }

  private showStatusBarMenu(evt: MouseEvent): void {
    const menu = new Menu();

    menu.addItem((item) => {
      item
        .setTitle("Sync current file")
        .setIcon("file-up")
        .onClick(() => this.syncCurrentFile());
    });

    menu.addItem((item) => {
      item
        .setTitle("Sync vault")
        .setIcon("refresh-cw")
        .onClick(() => this.manualSync());
    });

    menu.addItem((item) => {
      item
        .setTitle("Settings")
        .setIcon("settings")
        .onClick(() => {
          (this.app as any).setting.open();
          (this.app as any).setting.openTabById("obsidian-ssh-sync");
        });
    });

    menu.showAtMouseEvent(evt);
  }

  async syncCurrentFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("SSH Sync: No active file");
      return;
    }
    if (!this.syncEngine) {
      new Notice("SSH Sync: Sync engine not initialized");
      return;
    }
    await this.syncLock.run(async () => {
      this.updateStatusBar("syncing");
      try {
        const result = await this.syncEngine!.pushFile(file.path);
        if (result.success) {
          this.updateStatusBar("idle");
          new Notice(`SSH Sync: Pushed ${file.name}`);
        } else {
          this.updateStatusBar("error");
          new Notice(`SSH Sync: Failed to push ${file.name} — ${result.error}`);
        }
      } catch (err) {
        this.updateStatusBar("error");
        new Notice(`SSH Sync: Error — ${(err as Error).message}`);
      }
    });
  }
}
