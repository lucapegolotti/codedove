# claude-voice Agent Refactor Design

**Date:** 2026-02-19

## Overview

Refactor the claude-voice Telegram bot from a simple procedural relay into a proper agent-based system that detects user intent, monitors Claude Code session state, injects input into running tmux sessions, and proactively notifies the user when Claude is waiting for input.

---

## Architecture

```
Telegram
   │
   ▼
┌─────────────────────────────────────────────────────┐
│  telegram/bot.ts  (grammy)                          │
│  - receives text + voice messages                   │
│  - delegates ALL logic to agent/loop.ts             │
│  - sends text + audio replies                       │
└──────────┬──────────────────────────────────────────┘
           │
    ┌──────┴──────┐
    │  voice.ts   │  (only for voice notes — unchanged)
    │  Whisper STT│
    │  OpenAI TTS │
    └──────┬──────┘
           │
┌──────────▼──────────────────────────────────────────┐
│  agent/loop.ts  (decision brain)                    │
│  - classifies intent                                │
│  - routes to: summarizer / adapter / tmux / chat    │
│  - tracks per-chat session state                    │
└──┬───────────┬──────────────────────────────────────┘
   │           │
   │    ┌──────▼──────────────────────────────────────┐
   │    │  agent/classifier.ts                        │
   │    │  - haiku LLM → one of 6 intent types        │
   │    └─────────────────────────────────────────────┘
   │
   ├──▶ agent/summarizer.ts
   │       - reads JSONL via session/history.ts
   │       - calls haiku to produce actionable summary
   │
   ├──▶ session/adapter.ts
   │       - Claude Agent SDK query() / resume
   │       - returns raw result string
   │
   ├──▶ session/tmux.ts
   │       - tmux list-panes to find claude pane by cwd
   │       - tmux send-keys to inject input
   │
   └──▶ narrator.ts (unchanged)
           - haiku plain-text relay

┌─────────────────────────────────────────────────────┐
│  session/monitor.ts  (independent watcher)          │
│  - watches ~/.claude/projects/**/*.jsonl             │
│  - detects waiting state via pattern matching       │
│  - calls telegram/notifications.ts on state change  │
└──────────┬──────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────┐
│  telegram/notifications.ts                          │
│  - sends proactive Telegram alerts                  │
│  - shows context-aware inline buttons (y/n, Enter)  │
└─────────────────────────────────────────────────────┘
```

---

## File Structure

```
src/
  agent/
    classifier.ts    ← haiku LLM classifies intent into 6 types
    loop.ts          ← routes classified intent → action, returns reply
    summarizer.ts    ← reads JSONL history + calls haiku to summarize
  session/
    adapter.ts       ← Claude Agent SDK query()/resume; returns raw result
    monitor.ts       ← watches ~/.claude/projects/**/*.jsonl; detects waiting
    tmux.ts          ← tmux list-panes + send-keys injection
    history.ts       ← reads JSONL, returns structured session history
  telegram/
    bot.ts           ← grammy setup; delegates all logic to loop.ts
    notifications.ts ← sends proactive alerts with inline buttons
  voice.ts           ← unchanged
  narrator.ts        ← unchanged
  logger.ts          ← unchanged
  index.ts           ← entry point; starts bot + monitor
```

Files moved/renamed from current state:
- `src/bot.ts` → `src/telegram/bot.ts`
- `src/sessions.ts` → split into `session/adapter.ts` + `session/history.ts`
- `src/intent.ts` → replaced by `agent/classifier.ts` (multi-class)
- New: `agent/loop.ts`, `agent/summarizer.ts`, `session/monitor.ts`, `session/tmux.ts`, `telegram/notifications.ts`

---

## Intent Classification

**`agent/classifier.ts`** calls claude-haiku-4-5 with a structured prompt. Returns one of:

| Intent | Example messages |
|---|---|
| `SUMMARY_REQUEST` | "what's happening?", "summarize the session", "what did claude do?" |
| `COMMAND_EXECUTION` | "install deps", "run tests", "ask claude to fix the bug" |
| `FOLLOW_UP_INPUT` | "yes", "y", "no", "continue" — short answers after a pending prompt |
| `GENERAL_CHAT` | "thanks", "how are you?", off-topic messages |
| `SESSION_LIST` | "show sessions", "switch session", "list projects" |
| `UNKNOWN` | anything unclassifiable — defaults to COMMAND_EXECUTION |

The classifier receives: message text + the last bot message (for FOLLOW_UP_INPUT context).

---

## Agent Loop

**`agent/loop.ts`** decision pseudocode:

```
handleTurn(chatId, userMessage, sessionState):
  intent = classifier.classify(userMessage, sessionState.lastBotMessage)

  SUMMARY_REQUEST:
    history = history.read(sessionState.attachedSessionId)
    return summarizer.summarize(history)

  COMMAND_EXECUTION | UNKNOWN:
    if sessionState.waitingForInput (external session):
      target = tmux.findPane(sessionState.cwd)
      tmux.sendKeys(target, userMessage)
      return "Sent to Claude in [project]. I'll let you know when it responds."
    else:
      result = adapter.runTurn(chatId, userMessage)
      return narrator.narrate(result, userMessage)

  FOLLOW_UP_INPUT:
    target = tmux.findPane(sessionState.cwd)
    tmux.sendKeys(target, userMessage)
    return brief acknowledgment (no narrator)

  GENERAL_CHAT:
    return quickChat(userMessage)  // haiku direct reply, no agent

  SESSION_LIST:
    return session picker (existing behavior)
```

---

## Session Monitor

**`session/monitor.ts`** watches `~/.claude/projects/**/*.jsonl` using `fs.watch()`.

**Waiting detection:** when a JSONL file stops updating for >3 seconds after a change, read the last assistant message and match against:

```
/press\s+enter/i
/\(y\/n\)/i  |  /\[y\/N\]/i
/confirm\?/i
/\?\s*$/
/provide\s+(your\s+)?input/i
/waiting\s+for\s+(user\s+)?input/i
ends with `:` or `>` after stripping whitespace
```

**Per-session state:**
```ts
type SessionState = {
  sessionId: string
  projectName: string
  cwd: string
  isWaiting: boolean
  waitingPrompt: string | null
  lastUpdated: Date
}
```

---

## tmux Injection

**`session/tmux.ts`**:

1. Run `tmux list-panes -a -F '#{pane_id} #{pane_current_command} #{pane_current_path}'`
2. Filter panes where `pane_current_command` contains `claude`
3. Match by `pane_current_path == session.cwd` (or closest parent)
4. If unambiguous: `tmux send-keys -t <pane_id> "<input>" Enter`
5. If ambiguous (multiple claude panes): ask user to pick via inline keyboard

---

## Proactive Notifications

**`telegram/notifications.ts`** — triggered by monitor when waiting state detected:

```
Message: "⚠️ Claude is waiting in [project-name]:
"[waiting prompt text]""

Inline keyboard (context-aware):
  (y/n) pattern → [Yes] [No] [Send custom input] [Ignore]
  enter pattern  → [Continue ↩] [Send custom input] [Ignore]
  other          → [Send custom input] [Ignore]
```

After button tap, the response is injected via `tmux.ts`.

---

## Example Interactions

**Scenario 1: External session waiting, user responds**

> 🤖 Bot (proactive): Claude is waiting in `my-api`:
> "Should I delete the existing migration file? (y/n)"
> `[Yes]` `[No]` `[Send custom input]` `[Ignore]`
>
> 👤 You: *(taps Yes)*
>
> 🤖 Bot: Done — sent "y". Claude resumed and finished the migration update.

**Scenario 2: Summary request**

> 👤 You: What's happening in claude-voice right now?
>
> 🤖 Bot: Claude is working on the agent refactor in `claude-voice`. It just rewrote `sessions.ts` into layered modules and is now writing `agent/loop.ts`. No errors so far. Waiting for the next instruction.

**Scenario 3: Command to external session with follow-up**

> 👤 You: Tell claude-voice to run the TypeScript compiler and show me errors
>
> 🤖 Bot: I see a Claude Code session running in `claude-voice`. Sending that now.
> *(injects: "run npx tsc --noEmit and show me all errors")*
>
> 🤖 Bot (follow-up ~10s later, proactive): Claude found 3 type errors: `loop.ts:12` has an implicit any on the `intent` parameter, `monitor.ts:44` expects `SessionState` not `null`, `tmux.ts:8` is missing a return type. Waiting for your next instruction.

---

## Feasibility Notes

| Capability | Feasibility | Notes |
|---|---|---|
| Intent classification | ✅ | haiku + structured prompt |
| Session history summarization | ✅ | JSONL already has the data |
| Detect waiting in external sessions | ✅ | JSONL file watch + pattern match |
| Inject into tmux sessions | ✅ | `tmux send-keys` |
| Detect waiting in bot-spawned sessions mid-run | ⚠️ | SDK `query()` blocks; JSONL polling only after turn completes |
| Inject if NOT in tmux | ❌ | Requires pty-level access; out of scope |

---

## Dependencies (new)

- `chokidar` — reliable cross-platform file watching (replaces raw `fs.watch`)
- No other new dependencies required
