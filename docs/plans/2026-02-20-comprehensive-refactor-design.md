# Comprehensive Refactor Design

_Date: 2026-02-20_

## Overview

A multi-phase refactor of claude-voice covering:
1. Module structure cleanup
2. Setup wizard expansion (repos folder, hooks, launchd, chat ID allowlist)
3. Usability improvements (/help, better errors, condensed /status, startup message)
4. Comprehensive README
5. Alternative name suggestions

## Phase 1 — Module structure & code quality

### Problems
- `splitMessage` duplicated in `bot.ts` and `notifications.ts`
- `bot.ts` is 735 lines mixing voice, text, image, commands, and callbacks
- Env validation inline in `index.ts`

### Solution
- Extract `splitMessage` and `sendMarkdownMessage` to `src/telegram/utils.ts`
- Split `bot.ts` into handler modules under `src/telegram/handlers/`:
  - `text.ts` — text message processing, session injection
  - `voice.ts` — voice message download, transcription, TTS reply
  - `image.ts` — photo and document image handling
  - `commands.ts` — all bot.command() handlers
  - `callbacks.ts` — callback_query handler (session, launch, detach, perm, waiting)
- `bot.ts` becomes the thin orchestrator that registers all handlers
- `src/config/env.ts` — env loading and validation exported for use by index.ts and tui.tsx

## Phase 2 — Setup wizard expansion

### New setup steps (after API key entry)
1. **Repositories folder** — ask for default folder (default: `~/repositories`). Store in `~/.claude-voice/config.json`.
2. **Chat ID allowlist** — ask for Telegram chat ID (show instructions: message @userinfobot). Store in `~/.claude-voice/config.json`.
3. **Install Claude Code hooks** — detect and offer to install Stop/Permission/Compact hooks inline.
4. **Register launchd service** — offer to write plist and `launchctl load` it.

### Config file format
```json
{
  "reposFolder": "/Users/luca/repositories",
  "allowedChatId": 123456789
}
```
Stored at `~/.claude-voice/config.json`.

### Bot middleware
If `allowedChatId` is set, a grammY middleware rejects messages from other chat IDs (silent drop).

### TUI Dashboard updates
- Show compact hook/permission hook/stop hook status in one line instead of separate banners
- On startup, auto-install compact hooks only if none are missing (already does this)

## Phase 3 — Usability improvements

### /help command
Lists all commands with one-line descriptions.

### Startup message
Instead of "claude-voice started.", send:
`claude-voice ready. Attached: projectname (or "no session attached")`

### Error message improvement
When Claude Code not running:
`No Claude Code running at \`projectname\`. Launch one? /sessions`

### /status condensed
Single line: `` `projectname` · /path/to/cwd · watcher: idle ``

## Phase 4 — README

Sections:
1. What it is
2. Install (clone → npm install -g . → claude-voice)
3. Usage (commands, text, voice, images, permission approval)
4. Architecture (message flow diagram, session discovery, hook mechanism)
5. Security (chat ID allowlist, permission modes)

## Phase 5 — Tests

- Tests for new handler modules (text, voice, image, commands, callbacks split)
- Tests for config loading (env.ts, config.json)
- Tests for chat ID allowlist middleware
- Tests for new /help and condensed /status commands
- Update existing tests that import from bot.ts directly

## Alternative names

| Name | Vibe |
|---|---|
| pocketclaude | Your AI in your pocket |
| whispr | Whisper to your AI (voice + coding) |
| codepage | Like a pager but for your code |
| tapline | You tap, it runs |
| pingbot | Ping your AI on the go |
| telebrain | Telegram + brain |
| **sidechannel** | A private channel to your dev machine (recommended) |
| fieldwork | Do work from the field |

## Architecture summary (for README)

```
User (Telegram) ──text/voice/image──▶ Bot (grammy)
                                           │
                          ┌────────────────┴───────────────────┐
                          │                                     │
                    Voice pipeline                        Text handler
               (OGG→Whisper STT                    (inject into tmux pane
               →polish→inject)                      via sendKeys)
                          │                                     │
                          └────────────────┬───────────────────┘
                                           │
                                    Claude Code (tmux)
                                           │
                                    JSONL file watcher
                                    (chokidar, byte offset)
                                           │
                                    Response delivery
                                    (text→Telegram / TTS→voice)
```

Session discovery: Claude Code writes sessions to `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
The bot scans this directory to list and attach to sessions.

Hook mechanism: A Stop hook (`claude-voice-stop.sh`) appends `{"type":"result"}` to the JSONL after
each Claude turn. The watcher fires immediately on this event rather than waiting for a silence timeout.
