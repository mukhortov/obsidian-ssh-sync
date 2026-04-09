# Obsidian SSH Sync

[![CI](https://github.com/mukhortov/obsidian-ssh-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/mukhortov/obsidian-ssh-sync/actions/workflows/ci.yml)

Sync your Obsidian vaults with remote servers via SSH.

## Features

- **Bidirectional sync** — Changes on both local and remote are synchronized
- **Automatic sync on save** — Local changes are pushed immediately
- **Periodic polling** — Remote changes are detected on a configurable interval
- **Conflict resolution** — Timestamp-based resolution with automatic backups
- **File rename detection** — Detects renames via content hashing
- **Uses existing SSH config** — No key management, relies on `~/.ssh/config`
- **Status bar indicator** — Shows sync state (idle, syncing, error) in the Obsidian status bar

## Prerequisites

- Obsidian desktop (macOS or Linux)
- `rsync` installed (included by default on macOS, available via package manager on Linux)
- SSH access to remote server configured in `~/.ssh/config`

## Installation

### From release

1. Download `obsidian-ssh-sync-v*.zip` from the [latest release](https://github.com/mukhortov/obsidian-ssh-sync/releases/latest)
2. Unzip into your vault's plugins directory:
   ```
   <vault>/.obsidian/plugins/
   ```
   This creates `<vault>/.obsidian/plugins/obsidian-ssh-sync/` with `main.js` and `manifest.json` inside.
3. Enable "SSH Sync" in Obsidian Settings > Community Plugins

### Manual install (local build)

1. Clone this repository and build:
   ```
   git clone https://github.com/mukhortov/obsidian-ssh-sync.git
   cd obsidian-ssh-sync
   npm install && npm run build
   ```
2. Copy `main.js` and `manifest.json` into your vault's plugins directory:
   ```
   <vault>/.obsidian/plugins/obsidian-ssh-sync/
   ```
3. Enable "SSH Sync" in Obsidian Settings > Community Plugins

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| Enable sync | Turn sync on/off | false |
| SSH host | SSH connection string (user@hostname) | "" |
| Remote vault path | Absolute path on remote server | "" |
| Poll interval | Seconds between remote change checks | 60 |
| Sync on save | Push changes immediately on file modify | true |
| Conflict policy | How to resolve conflicts: remote-wins, local-wins, newest-wins | remote-wins |
| Exclude patterns | Glob patterns to skip | .git/**, .DS_Store, plugin manifest |

## How It Works

1. **Local > Remote:** File changes trigger an rsync push over SSH
2. **Remote > Local:** Periodic rsync dry-run detects remote changes, then pulls
3. **Conflicts:** When both sides changed, newer wins, older is backed up next to the original
4. **Renames:** Content hash matching detects file renames and cleans up old paths

## Testing

### Unit tests

```bash
npm test
```

Runs all unit, scenario, and E2E tests via Vitest. E2E tests are skipped automatically unless SSH connectivity is available. Tests are organized by category:

| Directory | Tests | Description |
|-----------|-------|-------------|
| `tests/scenarios/` | Local changes, remote changes, conflicts, sync triggers, edge cases, lifecycle, setup, multi-device | End-to-end logic with mocked SSH |
| `tests/sync/` | Coordinator, engine, manifest, conflict resolver, watcher, poller | Core sync component unit tests |
| `tests/ssh/` | Command building, path escaping, output parsing | SSH/rsync command unit tests |
| `tests/utils/` | File hashing | Utility unit tests |
| `tests/e2e/` | Real rsync over SSH | Integration tests (require SSH) |

### Watch mode

```bash
npm run test:watch
```

### E2E tests

E2E tests perform real rsync operations over SSH. They are **skipped by default** unless SSH connectivity is available.

```bash
# Run against localhost (requires passwordless SSH to localhost)
npm test

# Run against a specific host and remote path
E2E_SSH_HOST=myserver.local E2E_REMOTE_PATH=/tmp/test-vault npm test
```

| Variable | Description | Default |
|----------|-------------|---------|
| `E2E_SSH_HOST` | SSH host to connect to | `localhost` |
| `E2E_REMOTE_PATH` | Base directory for remote test vaults | auto-created temp dir |

**Note:** Remote file verification uses local filesystem calls, so the remote path must be accessible from the test runner's filesystem (same machine or mounted path).

### Build

```bash
npm run build
```

Type-checks with `tsc` then bundles with esbuild.

## Commands

- **SSH Sync: Sync now** — Run a full manual sync
- **SSH Sync: Sync current file** — Sync the currently opened file
- **SSH Sync: Toggle sync** — Enable/disable sync
