# TUI Dashboard Design

**Date:** 2026-02-19

## Overview

A full-screen terminal dashboard built with `ink` (React for the terminal) that wraps the existing bot. Running `claude-voice` (or `npm run tui`) launches the dashboard, runs the setup wizard on first use, then shows a live view of bot status, logs, and active sessions.

The headless `npm start` mode remains unchanged.

## Layout

```
┌─────────────────────────────────────────────────┐
│  claude-voice              ● RUNNING   [q] quit │
├────────────────────────┬────────────────────────┤
│  LOGS                  │  SESSIONS              │
│                        │                        │
│  12:34 ← chat 1234567  │  1234567890            │
│    voice: "fix the     │  9876543210            │
│    bug in auth.ts"     │                        │
│  12:34 → agent running │                        │
│  12:34 → replied ✓     │                        │
│                        │                        │
├────────────────────────┴────────────────────────┤
│  [s] start  [x] stop  [r] restart  [c] clear   │
└─────────────────────────────────────────────────┘
```

## Flow

**First run (`.env` missing or incomplete):** Setup wizard runs — prompts for each of the 3 keys one at a time with masked input, writes `.env`, then transitions to the dashboard.

**Normal run:** Dashboard launches immediately, bot starts polling, logs stream in real time.

**Keyboard shortcuts:** `s` start, `x` stop, `r` restart, `c` clear logs, `q` quit.

## Architecture

```
src/
  tui.tsx            ← entry point with shebang; checks .env, shows Setup or Dashboard
  tui/
    Setup.tsx        ← credential wizard using ink-text-input
    Dashboard.tsx    ← full-screen layout, manages bot lifecycle
    LogPane.tsx      ← scrollable log pane (left column)
    SessionPane.tsx  ← active session list (right column)
    StatusBar.tsx    ← top bar: app name, status pill, quit hint
    KeyBar.tsx       ← bottom bar: keyboard shortcut hints
  logger.ts          ← shared log emitter; replaces console.log/error in bot + sessions
```

## Key Changes to Existing Code

- `src/logger.ts` — new module, exports `log(entry: LogEntry)` and an `EventEmitter`
- `src/sessions.ts` — import and use `logger` instead of inline strings passed to narrator fallback; emit session create/resume events
- `src/bot.ts` — import and use `logger` instead of `console.error`

`src/index.ts` (headless mode) remains unchanged — it imports nothing from the TUI.

## `claude-voice` Global Command

```json
// package.json
"bin": {
  "claude-voice": "src/tui.tsx"
}
```

`src/tui.tsx` gets a `#!/usr/bin/env tsx` shebang. One-time setup: `npm link` registers the command globally.

## New Dependencies

| Package | Purpose |
|---|---|
| `ink` | React-based terminal UI renderer |
| `react` | Required peer dep of ink |
| `ink-text-input` | Masked text input for setup wizard |
| `@types/react` | TypeScript types for React/ink components |

## Scripts

```json
"tui": "tsx src/tui.tsx",
"start": "tsx src/index.ts"   // unchanged
```
