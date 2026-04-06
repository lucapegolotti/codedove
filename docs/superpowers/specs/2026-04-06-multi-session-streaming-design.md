# Multi-Session Streaming

Stream responses from all active Claude Code sessions to Telegram continuously, not just the session the user is interacting with.

## Problem

Codedove only watches the "attached" session for responses. When Claude Code works autonomously in another session (e.g. babysitting ML training with 30-minute sleep intervals), responses are lost after the injection watcher times out. The user has no visibility into what those sessions are doing.

## Design

### Concepts

- **Active session:** The session that receives user input (text/voice). Controlled by `/sessions` and stored in `~/.codedove/attached`. Unchanged.
- **Stream watcher:** A long-lived `watchForResponse` instance per active Claude Code tmux session. Forwards all assistant text to Telegram regardless of which session is active.

### New component: SessionStreamManager

A long-lived service (`src/session/stream-manager.ts`) that maintains one `watchForResponse` per active Claude Code session. Started in `index.ts` alongside `startMonitor`.

**Lifecycle:**

1. **Startup:** Scan all tmux panes for Claude Code sessions. For each, find the latest JSONL file and start a `watchForResponse` from the current end-of-file (no history replay).
2. **Discovery loop (every 30s):** Re-scan tmux panes. Start watchers for new sessions. Remove watchers for sessions whose tmux pane is gone.
3. **Watcher restart:** When a `watchForResponse` completes (result event) or times out (inactivity), restart the watcher from the new end-of-file. The session is only removed when its tmux pane disappears.
4. **Shutdown:** Stop all watchers on SIGINT/SIGTERM.

**Watcher map:** Keyed by `cwd` (since tmux panes are deduplicated by cwd, and `getLatestSessionFileForCwd` resolves the latest JSONL for a given cwd). Each entry tracks the stop function and current session ID, so we can detect session rotation (new JSONL file for the same cwd).

**Interface:**

```typescript
class SessionStreamManager {
  // Start the discovery loop and initial scan
  start(): void;

  // Stop the stream watcher for a specific cwd (used during injection)
  pause(cwd: string): void;

  // Restart the stream watcher for a cwd from current EOF (after injection completes)
  resume(cwd: string): void;

  // Stop all watchers and the discovery loop
  stop(): void;
}
```

### Injection coordination

When the user sends a message to the active session:

1. `processTextTurn` calls `streamManager.pause(cwd)` before injection
2. `WatcherManager.startInjectionWatcher` runs as today
3. When the injection watcher's `onComplete` fires, it calls `streamManager.resume(cwd)`

This prevents duplicate messages during injection without coupling the two systems.

### Notification changes

Remove the attached-session filter from `notifyResponse` in `notifications.ts` (line 76: `if (!attached || attached.sessionId !== state.sessionId) return;`). All sessions stream to Telegram. The project name prefix already disambiguates sessions.

`notifyWaiting` and `notifyPermission` are unchanged (they already work for all sessions).

Input routing (`ensureSession`, `processTextTurn`, `/sessions` picker) is unchanged. The `attached` file only controls where user input goes.

### Files changed

| File | Change |
|------|--------|
| `src/session/stream-manager.ts` | New. `SessionStreamManager` class |
| `src/telegram/notifications.ts` | Remove attached-session filter from `notifyResponse` |
| `src/index.ts` | Instantiate and start `SessionStreamManager`, wire shutdown |
| `src/telegram/handlers/text.ts` | Call `pause`/`resume` around injection |
| `src/session/watcher-manager.ts` | Accept `SessionStreamManager` ref, call pause/resume in `startInjectionWatcher` and its onComplete |

No new dependencies. Uses existing `watchForResponse`, `listTmuxPanes`, `isClaudePane`, `getLatestSessionFileForCwd`, `getFileSize`.
