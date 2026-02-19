# Session Attach Design

**Date:** 2026-02-19

## Overview

Allow the Telegram bot to join an existing Claude Code session running on the machine, so both the terminal and Telegram share the same conversation thread.

## Flow

1. Open a Claude Code terminal — `SessionStart` hook fires, writes session_id to `~/.claude-voice/current-session`
2. Type `/attach` in Claude Code — bash command copies that ID to `~/.claude-voice/attached`
3. Send a Telegram message — bot reads `~/.claude-voice/attached`, calls `resume: <id>` instead of its own session
4. Claude Code terminal and Telegram now share the same conversation history

## Components

### 1. `SessionStart` hook (`~/.claude/settings.json`)

Fires whenever a Claude Code session starts. Writes the session_id to `~/.claude-voice/current-session`, creating the directory if needed.

### 2. `/attach` slash command (`~/.claude/commands/attach.md`)

Instructs Claude to run:
```bash
mkdir -p ~/.claude-voice && cp ~/.claude-voice/current-session ~/.claude-voice/attached && echo "Attached session: $(cat ~/.claude-voice/attached)"
```

Prints the session ID as confirmation. If `~/.claude-voice/current-session` doesn't exist, prints a clear error.

### 3. `/detach` slash command (`~/.claude/commands/detach.md`)

Instructs Claude to run:
```bash
rm -f ~/.claude-voice/attached && echo "Detached"
```

### 4. `src/sessions.ts` changes

In `runAgentTurn`, before using the per-chat session map, check for `~/.claude-voice/attached`. If present, use that session_id as `resume`. If absent, fall back to the existing per-chat session logic.

## Behaviour

- **While attached:** all Telegram messages go into the Claude Code session thread
- **After detach:** bot starts a fresh session on next message (per-chat map cleared for that chat)
- **Bot restart:** attachment persists — bot re-reads `~/.claude-voice/attached` on startup
- **Concurrent access:** not supported — don't send from Telegram while Claude Code is mid-response

## Files Changed

- Create: `~/.claude/settings.json` (or merge into existing)
- Create: `~/.claude/commands/attach.md`
- Create: `~/.claude/commands/detach.md`
- Modify: `src/sessions.ts`
