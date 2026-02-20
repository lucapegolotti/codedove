# claude-voice Design

**Date:** 2026-02-19

## Overview

A Node.js/TypeScript server running on a Mac that bridges Telegram to Claude Code. Users send text messages or voice notes → Claude Code does the work → a narrator layer distills the result into a short, friendly conversational reply → user receives text or a voice message back.

One Telegram conversation = one persistent Claude Code session.

## Architecture

```
Telegram
   │
   ▼
┌─────────────────────────────────────────────┐
│  Telegram Bot  (grammy)                     │
│  - receives text + voice notes              │
│  - sends text + audio replies               │
└──────────┬──────────────────────────────────┘
           │
    ┌──────┴──────┐
    │ Voice       │  (only for voice notes)
    │ Pipeline    │  OGG → Whisper STT → text
    │             │  text → OpenAI TTS → OGG
    └──────┬──────┘
           │
┌──────────▼──────────────────────────────────┐
│  Session Manager                            │
│  - maps chat ID → Claude Code session       │
│  - lazy-creates sessions on first message   │
│  - detects working directory from context   │
└──────────┬──────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────┐
│  Claude Code SDK  (@anthropic-ai/claude-code)│
│  - runs Claude Code programmatically        │
│  - streams structured events                │
└──────────┬──────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────┐
│  Narrator  (Claude API call)                │
│  - buffers events from one Claude Code turn │
│  - calls claude-haiku to produce a          │
│    1-3 sentence conversational summary      │
└─────────────────────────────────────────────┘
```

## Data Flow

### Text message
1. User sends Telegram text message
2. Bot receives message
3. Session Manager fetches or creates Claude Code session for this chat ID
4. Claude Code SDK runs the message, streams structured events (tool calls, file edits, assistant messages)
5. Narrator buffers all events, makes one Claude API call to summarize conversationally
6. Bot sends short text reply to Telegram

### Voice note
1. User holds mic in Telegram, sends voice note (OGG format)
2. Bot downloads the audio file
3. Whisper API transcribes it to text
4. Same as text path above
5. Narrator produces conversational text
6. OpenAI TTS converts text to audio (OGG/MP3)
7. Bot sends voice message reply to Telegram

### Working directory detection
Session Manager injects a system-level prompt at session start asking Claude Code to identify which project directory is relevant based on conversation context. Users can also explicitly say "work in ~/repositories/my-project".

## Technology Stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js + TypeScript | Claude Code SDK is Node-native |
| Telegram | `grammy` | Modern, well-maintained, TypeScript-first |
| Claude Code | `@anthropic-ai/claude-code` SDK | Structured events, proper session management |
| Narrator | Claude API (`claude-haiku-4-5-20251001`) | Fast + cheap for summarization |
| STT | OpenAI Whisper API | Best accuracy, simple API |
| TTS | OpenAI TTS API | Natural voice, low latency |
| Session state | In-memory (Map) | Simple; sessions reset on server restart |

## Project Structure

```
claude-voice/
├── src/
│   ├── index.ts          # Entry point
│   ├── bot.ts            # Telegram bot setup and message routing
│   ├── sessions.ts       # Claude Code session manager
│   ├── narrator.ts       # Event buffering + Claude API summarization
│   └── voice.ts          # Whisper STT + OpenAI TTS
├── docs/plans/
│   └── 2026-02-19-claude-voice-design.md
├── .env.example
├── package.json
└── tsconfig.json
```

## Configuration (environment variables)

- `TELEGRAM_BOT_TOKEN` — from BotFather
- `ANTHROPIC_API_KEY` — for narrator Claude API calls
- `OPENAI_API_KEY` — for Whisper STT and TTS
