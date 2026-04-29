import {
  SyncConfig,
  SyncStatus,
  SyncLogEntry,
  SUPPRESS_PRE_OP_MS,
  SUPPRESS_POST_OP_MS,
  MIN_POLL_INTERVAL_SECONDS,
} from "../types";
import { SyncEngine } from "./engine";
import { FileWatcher, WatcherFlush } from "./watcher";
import { Poller } from "./poller";
import { SyncLock } from "../utils/sync-lock";
import {
  decidePollAction,
  decidePullAction,
  decideFlushAction,
  decideManualSyncAction,
  decideSyncFileAction,
  decideToggleAction,
  decideSettingsChangedAction,
  resolveConflictWinner,
  createInitialState,
  SyncState,
  SyncEffect,
} from "./coordinator";

/**
 * Platform seam — abstracts the Obsidian-specific APIs that the
 * orchestrator needs. The plugin class is the real adapter.
 * Tests can supply a stub.
 */
export interface Platform {
  /** Show a user-visible notification. */
  notify(message: string): void;
  /** Update the status bar indicator. */
  updateStatus(status: SyncStatus): void;
  /** The absolute path to the vault root on disk. */
  getVaultPath(): string;
}

/**
 * Orchestrates sync operations: interprets effects from the coordinator,
 * manages the watcher/poller/lock lifecycle, and delegates platform
 * concerns (notifications, status bar) to the Platform seam.
 *
 * All sync decisions flow through the coordinator's pure `decide*`
 * functions. This class is the effect interpreter.
 */
export class SyncOrchestrator {
  private syncState: SyncState;
  private syncLock = new SyncLock();

  constructor(
    private engine: SyncEngine,
    private watcher: FileWatcher,
    private poller: Poller,
    private platform: Platform,
    private getConfig: () => SyncConfig
  ) {
    this.syncState = createInitialState(this.getConfig().enabled);
  }

  /** Execute a list of effects produced by the coordinator. */
  async executeEffects(effects: readonly SyncEffect[]): Promise<void> {
    for (const effect of effects) {
      switch (effect.type) {
        case "pushFiles":
          for (const file of effect.files) {
            const result = await this.engine.pushFile(file);
            if (!result.success) {
              this.platform.notify(`Sync failed for ${file}: ${result.error}`);
            }
          }
          break;
        case "pushFile": {
          const result = await this.engine.pushFile(effect.file);
          if (result.success) {
            this.platform.updateStatus("idle");
            this.platform.notify(`SSH Sync: Pushed ${effect.file}`);
          } else {
            this.platform.updateStatus("error");
            this.platform.notify(`SSH Sync: Failed to push ${effect.file} — ${result.error}`);
          }
          break;
        }
        case "pushAll":
          await this.engine.pushAll();
          break;
        case "pullWithoutDelete": {
          this.watcher.suppress(SUPPRESS_PRE_OP_MS);
          const result = await this.engine.pullWithoutDelete();
          this.watcher.suppress(SUPPRESS_POST_OP_MS);
          if (!result.success) {
            this.platform.updateStatus("error");
            this.platform.notify(`SSH Sync pull failed: ${result.error}`);
          }
          break;
        }
        case "pullWithDelete":
          this.watcher.suppress(SUPPRESS_PRE_OP_MS);
          await this.engine.pull();
          this.watcher.suppress(SUPPRESS_POST_OP_MS);
          break;
        case "deleteRemoteFiles":
          for (const file of effect.files) {
            const result = await this.engine.deleteRemoteFile(file);
            if (!result.success) {
              this.platform.notify(`Remote delete failed for ${file}: ${result.error}`);
            }
          }
          break;
        case "deleteLocalFiles":
          this.watcher.suppress(SUPPRESS_PRE_OP_MS);
          await this.engine.deleteLocalFiles(effect.files, effect.skipPaths);
          this.watcher.suppress(SUPPRESS_POST_OP_MS);
          break;
        case "resolveConflict": {
          const winner = resolveConflictWinner(effect.policy, effect.localMtime, effect.remoteMtime);
          await this.engine.resolveConflict(effect.file, winner, effect.localMtime, effect.remoteMtime);
          break;
        }
        case "preserveLocalFile":
          // No-op: kept as-is. The pushFile effect that follows will push it back.
          break;
        case "fullSync": {
          this.watcher.suppress(SUPPRESS_PRE_OP_MS);
          const result = await this.engine.fullSync();
          this.watcher.suppress(SUPPRESS_POST_OP_MS);
          if (result.success) {
            this.platform.updateStatus("idle");
            this.platform.notify(`SSH Sync: Complete — ${result.changedFiles.length} file(s) synced`);
          } else {
            this.platform.updateStatus("error");
            this.platform.notify(`SSH Sync: Failed — ${result.error}`);
          }
          break;
        }
        case "notify":
          this.platform.notify(effect.message);
          break;
        case "notifyError":
          this.platform.notify(effect.message);
          break;
        case "updateStatus":
          this.platform.updateStatus(effect.status);
          break;
        case "startPoller":
          this.poller.updateInterval(effect.intervalMs);
          this.poller.start();
          break;
        case "stopPoller":
          this.poller.stop();
          break;
        case "detectRemoteChanges": {
          if (this.watcher.hasPending()) break;

          const changes = await this.engine.detectRemoteChanges();
          const allFiles = [...changes.changedFiles, ...changes.deletedFiles];
          const localMtimes = await this.engine.getLocalMtimes(allFiles);
          const manifest = this.engine.getManifestEntries();
          const pendingPaths = this.watcher.getPendingPaths();

          // Fetch real remote mtimes for conflict resolution (newest-wins)
          let remoteFileMtimes: Map<string, number> | undefined;
          if (changes.changedFiles.length > 0) {
            try {
              remoteFileMtimes = await this.engine.statRemoteFiles(changes.changedFiles);
            } catch {
              // Fall back to manifest remoteMtime if stat fails
            }
          }

          const pullDecision = decidePullAction(
            this.syncState,
            changes,
            manifest,
            this.getConfig(),
            pendingPaths,
            localMtimes,
            remoteFileMtimes
          );
          this.syncState = pullDecision.state;

          await this.executeEffects(pullDecision.effects);
          break;
        }
        case "log":
          await this.engine.appendLog(effect.entry);
          break;
      }
    }
  }

  /** Called by the poller to check for and pull remote changes. */
  async pollRemoteChanges(): Promise<void> {
    const hasPending = this.watcher.hasPending();
    const pollDecision = decidePollAction(this.syncState, hasPending);
    this.syncState = pollDecision.state;

    if (pollDecision.effects.length === 0) return;

    await this.syncLock.run(async () => {
      await this.executeEffects(pollDecision.effects);
    });
  }

  /** Run a full manual sync (push-then-pull). */
  async manualSync(): Promise<void> {
    await this.syncLock.run(async () => {
      // Flush any pending watcher changes first so that local deletions
      // propagate to remote before fullSync pulls remote state back.
      if (this.watcher.hasPending()) {
        const flush = await this.watcher.flushNow();
        if (flush) {
          const config = this.getConfig();
          const flushDecision = decideFlushAction(
            this.syncState,
            { changedFiles: flush.changedFiles, deletedFiles: flush.deletedFiles },
            config.enabled
          );
          this.syncState = flushDecision.state;
          await this.executeEffects(flushDecision.effects);
        }
      }

      const decision = decideManualSyncAction(this.syncState, true);
      this.syncState = decision.state;
      await this.executeEffects(decision.effects);
    });
  }

  /** Handle a watcher flush (batched file changes/deletions). */
  async handleFlush(flush: WatcherFlush): Promise<void> {
    const config = this.getConfig();
    const decision = decideFlushAction(
      this.syncState,
      { changedFiles: flush.changedFiles, deletedFiles: flush.deletedFiles },
      config.enabled
    );
    this.syncState = decision.state;

    if (decision.effects.length === 0) return;

    await this.syncLock.run(async () => {
      await this.executeEffects(decision.effects);
      // Option B: orchestrator sets final status based on errors
      // The coordinator can't know if effects will fail, so we
      // set idle here. Individual effect handlers set "error" on failure.
      this.platform.updateStatus("idle");
    });
  }

  /** Push a single file to the remote. */
  async syncFile(relativePath: string): Promise<void> {
    const decision = decideSyncFileAction(this.syncState, relativePath, true);
    this.syncState = decision.state;

    await this.syncLock.run(async () => {
      await this.executeEffects(decision.effects);
    });
  }

  /** Toggle sync on/off. */
  async toggle(): Promise<void> {
    const config = this.getConfig();
    const pollIntervalMs = Math.max(config.pollIntervalSeconds, MIN_POLL_INTERVAL_SECONDS) * 1000;
    const decision = decideToggleAction(this.syncState, config.enabled, pollIntervalMs);
    this.syncState = decision.state;
    await this.syncLock.run(async () => {
      await this.executeEffects(decision.effects);
    });
  }

  /** Update poller settings when config changes. */
  async onSettingsChanged(): Promise<void> {
    const config = this.getConfig();
    const pollIntervalMs = Math.max(config.pollIntervalSeconds, MIN_POLL_INTERVAL_SECONDS) * 1000;
    const decision = decideSettingsChangedAction(this.syncState, config.enabled, pollIntervalMs);
    this.syncState = decision.state;
    await this.syncLock.run(async () => {
      await this.executeEffects(decision.effects);
    });
  }

  /** Get sync log entries. */
  getSyncLogs(): SyncLogEntry[] {
    return this.engine.getSyncLogEntries();
  }

  /** Clean up resources. */
  dispose(): void {
    this.watcher.dispose();
    this.poller.stop();
  }
}
