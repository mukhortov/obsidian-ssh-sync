import { Plugin, Notice, TAbstractFile, TFile, Menu, setIcon } from "obsidian";
import { SyncConfig, SyncStatus, DEFAULT_CONFIG, SyncLogEntry, MIN_POLL_INTERVAL_SECONDS, parseStoredSettings, withPluginExcludes } from "./types";
import { SSHSyncSettingTab } from "./settings";
import { SyncEngine } from "./sync/engine";
import { FileWatcher } from "./sync/watcher";
import { Poller } from "./sync/poller";
import { SyncOrchestrator, Platform } from "./sync/orchestrator";
import * as path from "path";

const STATUS_ICONS: Record<SyncStatus, string> = {
  idle: "cloud",
  syncing: "refresh-cw",
  error: "cloud-off",
  disabled: "cloud-off",
};

type PluginSettingManager = {
  open: () => void;
  openTabById: (id: string) => void;
};

export default class SSHSyncPlugin extends Plugin {
  settings: SyncConfig = { ...DEFAULT_CONFIG };
  private orchestrator: SyncOrchestrator | null = null;
  private syncEngine: SyncEngine | null = null;
  private statusBarEl: HTMLElement | null = null;
  private syncStatus: SyncStatus = "disabled";

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new SSHSyncSettingTab(this.app, this));

    // Status bar
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("ssh-sync-status");
    this.statusBarEl.addClass("mod-clickable");
    // eslint-disable-next-line obsidianmd/ui/sentence-case
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
        if (file instanceof TFile && file.path && this.settings.syncOnSave && this.settings.enabled) {
          this.watcher?.onFileChange(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (file instanceof TFile && file.path && this.settings.syncOnSave && this.settings.enabled) {
          this.watcher?.onFileChange(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (file instanceof TFile && file.path && this.settings.syncOnSave && this.settings.enabled) {
          this.watcher?.onFileDeleted(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (this.settings.syncOnSave && this.settings.enabled) {
          if (file instanceof TFile && oldPath && file.path) {
            this.watcher?.onFileRenamed(file.path, oldPath);
          }
        }
      })
    );

    this.initSync();

    if (this.settings.enabled) {
      void this.manualSync();
    }
  }

  private watcher: FileWatcher | null = null;

  private getVaultPath(): string {
    const adapter = this.app.vault.adapter as unknown;
    if (adapter && typeof adapter === "object") {
      const basePath = (adapter as { basePath?: unknown }).basePath;
      if (typeof basePath === "string") {
        return basePath;
      }
    }
    throw new Error("Vault adapter does not expose a base path");
  }

  private getSettingManager(): PluginSettingManager | null {
    const app = this.app as unknown;
    if (!app || typeof app !== "object") {
      return null;
    }
    const setting = (app as { setting?: unknown }).setting;
    if (!setting || typeof setting !== "object") {
      return null;
    }
    const manager = setting as { open?: unknown; openTabById?: unknown };
    if (typeof manager.open === "function" && typeof manager.openTabById === "function") {
      return manager as PluginSettingManager;
    }
    return null;
  }

  private initSync(): void {
    const vaultPath = this.getVaultPath();
    const manifestPath = path.join(
      vaultPath,
      this.app.vault.configDir,
      "plugins",
      "ssh-sync",
      "sync-manifest.json"
    );

    const engine = new SyncEngine(this.settings, vaultPath, manifestPath);
    this.syncEngine = engine;

    this.watcher = new FileWatcher(500, async (flush) => {
      await this.orchestrator?.handleFlush(flush);
    });

    const poller = new Poller(async () => {
      if (!this.settings.enabled) return;
      await this.orchestrator?.pollRemoteChanges();
    }, Math.max(this.settings.pollIntervalSeconds, MIN_POLL_INTERVAL_SECONDS) * 1000);

    const platform: Platform = {
      notify: (message: string) => new Notice(message),
      updateStatus: (status: SyncStatus) => this.updateStatusBar(status),
      getVaultPath: () => this.getVaultPath(),
    };

    this.orchestrator = new SyncOrchestrator(
      engine,
      this.watcher,
      poller,
      platform,
      () => this.settings
    );

    if (this.settings.enabled) {
      poller.start();
    }
  }

  async manualSync(): Promise<void> {
    if (!this.orchestrator) {
      return;
    }
    await this.orchestrator.manualSync();
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    if (!this.syncEngine) {
      return { success: false, error: "Sync not initialized" };
    }
    return this.syncEngine.testConnection();
  }

  async toggleSync(): Promise<void> {
    this.settings.enabled = !this.settings.enabled;
    await this.saveSettings();
    await this.orchestrator?.toggle();
  }

  onSettingsChanged(): void {
    void this.orchestrator?.onSettingsChanged();
  }

  getSyncLogs(): SyncLogEntry[] {
    return this.orchestrator?.getSyncLogs() || [];
  }

  onunload(): void {
    this.orchestrator?.dispose();
  }

  async loadSettings(): Promise<void> {
    const stored = parseStoredSettings(await this.loadData());
    const excludePatterns = withPluginExcludes(
      stored.excludePatterns ?? DEFAULT_CONFIG.excludePatterns,
      this.app.vault.configDir
    );
    this.settings = {
      ...DEFAULT_CONFIG,
      ...stored,
      excludePatterns,
    };
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
          const settingManager = this.getSettingManager();
          if (!settingManager) {
            // eslint-disable-next-line obsidianmd/ui/sentence-case
            new Notice("SSH Sync: Could not open settings");
            return;
          }
          settingManager.open();
          settingManager.openTabById("ssh-sync");
        });
    });

    menu.showAtMouseEvent(evt);
  }

  async syncCurrentFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      new Notice("SSH Sync: No active file");
      return;
    }
    if (!this.orchestrator) {
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      new Notice("SSH Sync: Sync not initialized");
      return;
    }
    await this.orchestrator.syncFile(file.path);
  }
}
