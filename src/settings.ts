import { App, Notice, PluginSettingTab, Setting, Modal } from "obsidian";
import type SSHSyncPlugin from "./main";
import { SyncLogEntry, MIN_POLL_INTERVAL_SECONDS, clampPollInterval } from "./types";

export class SSHSyncSettingTab extends PluginSettingTab {
  plugin: SSHSyncPlugin;

  constructor(app: App, plugin: SSHSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "SSH Sync Settings" });

    new Setting(containerEl)
      .setName("Enable sync")
      .setDesc("Turn on automatic sync for this vault")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
          this.plugin.onSettingsChanged();
        })
      );

    new Setting(containerEl)
      .setName("SSH host")
      .setDesc("SSH connection string (e.g., user@hostname)")
      .addText((text) =>
        text
          .setPlaceholder("user@my-vps.example.com")
          .setValue(this.plugin.settings.sshHost)
          .onChange(async (value) => {
            this.plugin.settings.sshHost = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Remote vault path")
      .setDesc("Absolute path to the vault on the remote server")
      .addText((text) =>
        text
          .setPlaceholder("/home/user/vaults/my-vault")
          .setValue(this.plugin.settings.remotePath)
          .onChange(async (value) => {
            this.plugin.settings.remotePath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Poll interval")
      .setDesc(`How often to check for remote changes (in seconds, minimum ${MIN_POLL_INTERVAL_SECONDS})`)
      .addText((text) => {
        text
          .setPlaceholder("60")
          .setValue(String(this.plugin.settings.pollIntervalSeconds));
        text.inputEl.type = "number";
        text.inputEl.min = String(MIN_POLL_INTERVAL_SECONDS);
        text.inputEl.step = "1";
        // Validate on blur instead of every keystroke so the user can
        // freely clear and retype values without the field resetting.
        text.inputEl.addEventListener("blur", async () => {
          const clamped = clampPollInterval(text.inputEl.value);
          if (clamped !== parseInt(text.inputEl.value, 10)) {
            text.setValue(String(clamped));
          }
          this.plugin.settings.pollIntervalSeconds = clamped;
          await this.plugin.saveSettings();
          this.plugin.onSettingsChanged();
        });
      });

    new Setting(containerEl)
      .setName("Sync on save")
      .setDesc("Automatically push changes when files are modified")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnSave).onChange(async (value) => {
          this.plugin.settings.syncOnSave = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Conflict resolution")
      .setDesc("How to resolve conflicts when both local and remote change the same file")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("remote-wins", "Remote wins (default)")
          .addOption("local-wins", "Local wins")
          .addOption("newest-wins", "Newest wins")
          .setValue(this.plugin.settings.conflictPolicy || "remote-wins")
          .onChange(async (value) => {
            this.plugin.settings.conflictPolicy = value as "remote-wins" | "local-wins" | "newest-wins";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Exclude patterns")
      .setDesc("Glob patterns to exclude from sync (one per line)")
      .addTextArea((text) =>
        text
          .setPlaceholder(".obsidian/**\n.git/**\n.DS_Store")
          .setValue(this.plugin.settings.excludePatterns.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.excludePatterns = value
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 0);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify SSH connection and remote path")
      .addButton((btn) =>
        btn.setButtonText("Test").onClick(async () => {
          btn.setButtonText("Testing...");
          btn.setDisabled(true);
          try {
            const result = await this.plugin.testConnection();
            if (result.success) {
              new Notice("Connection successful!");
            } else {
              new Notice(`Connection failed: ${result.error}`);
            }
          } catch (err) {
            new Notice(`Connection error: ${(err as Error).message}`);
          } finally {
            btn.setButtonText("Test");
            btn.setDisabled(false);
          }
        })
      );

    new Setting(containerEl)
      .setName("Manual sync")
      .setDesc("Run a full sync now")
      .addButton((btn) =>
        btn.setButtonText("Sync now").onClick(async () => {
          btn.setButtonText("Syncing...");
          btn.setDisabled(true);
          try {
            await this.plugin.manualSync();
          } catch (err) {
            new Notice(`Sync error: ${(err as Error).message}`);
          } finally {
            btn.setButtonText("Sync now");
            btn.setDisabled(false);
          }
        })
      );

    new Setting(containerEl)
      .setName("View sync log")
      .setDesc("View recent sync activity and conflicts")
      .addButton((btn) =>
        btn.setButtonText("View log").onClick(() => {
          this.showSyncLog();
        })
      );
  }

  private showSyncLog(): void {
    const logs = this.plugin.getSyncLogs();
    const modal = new SyncLogModal(this.app, logs);
    modal.open();
  }
}

class SyncLogModal extends Modal {
  constructor(app: App, private logs: SyncLogEntry[]) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Sync Log");
    const { contentEl } = this;
    contentEl.empty();

    if (this.logs.length === 0) {
      contentEl.createEl("p", { text: "No sync activity yet." });
    } else {
      const list = contentEl.createEl("ul");
      for (const entry of this.logs.slice(-50).reverse()) {
        const li = list.createEl("li");
        const time = new Date(entry.timestamp).toLocaleTimeString();
        li.setText(`[${time}] ${entry.type}: ${entry.path} — ${entry.message}`);
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
