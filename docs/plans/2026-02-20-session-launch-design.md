# Session Launch Design

**Date:** 2026-02-20

## Overview

When the user attaches to a session via `/sessions`, the bot now checks whether Claude Code is already running in a tmux pane at that project's cwd. If not, it offers to launch a new tmux window with Claude Code. A new `/close_session` command terminates Claude Code and closes the tmux window.

## Session Attachment Flow

1. User taps a session button from `/sessions`
2. Bot checks for a running Claude Code pane via `findClaudePane(cwd)`
3. **Pane found** → attach as today (write `attached` file, reply "Attached to `project`")
4. **No pane found** → reply with launch prompt:
   > No Claude Code running at `project`. Launch one?
   > `[Launch]` `[Launch (skip permissions)]` `[Cancel]`
5. User taps `[Launch]` or `[Launch (skip permissions)]` → bot:
   - Creates a new tmux window at the project cwd named after the project
   - Runs `claude -C` (with `--dangerously-skip-permissions` if requested)
   - Writes the cwd to the attached file (the watcher uses cwd-based lookup to find the new session)
   - Replies: "Launched! Send a message once Claude Code is ready."
6. `[Cancel]` → dismiss with no state change

## `/close_session` Command

1. Check if a session is attached — if not, reply "No session attached."
2. Find the Claude Code pane via `findClaudePane(attached.cwd)`
3. If found: run `tmux kill-window -t <paneId>` to close the whole window
4. Clear the attached session file and chat state (same as `/detach`)
5. Reply "Session closed."
6. If no pane found: still clear attached file, reply "No running session found — detached."

## Implementation

### `src/session/tmux.ts`

New function:
```ts
launchClaudeInWindow(cwd: string, projectName: string, skipPermissions: boolean): Promise<void>
```
- Runs `tmux new-window -c <cwd> -n <projectName>`
- Captures the new window's pane ID
- Sends `claude -C [--dangerously-skip-permissions]` + Enter to that pane

### `src/telegram/bot.ts`

- **`session:` callback**: after writing the attached file, call `findClaudePane` — if no pane found, send the launch prompt. Reuse `pendingSessions` map for the launch step.
- **New `launch:` callbacks**: `launch:<sessionId>`, `launch:skip:<sessionId>`, `launch:cancel:<sessionId>`
- **New `/close_session` command**

### No changes to `src/session/history.ts`

Session listing stays as-is (most recent per project).
