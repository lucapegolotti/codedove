# Reply-to Session Routing

Route user input to a specific Claude Code session by replying to one of its messages in Telegram. Silently switches the active session.

## Problem

With multi-session streaming, messages from different sessions are interleaved in the Telegram chat. To send input to a specific session, the user must use `/sessions` to switch. Replying to a message is a more natural way to target a session.

## Design

### Message-to-session tracking

`NotificationService` tracks a mapping of Telegram `message_id` to `{ sessionId, cwd }` for messages it sends. Populated in:
- `notifyResponse` — from the `sendMessage` return value
- `notifyToolUse` — from the `sendMessage` return value (first message per session)

The map is capped at 500 entries (evict oldest) to prevent unbounded growth.

New method: `getSessionForMessage(messageId: number): { sessionId: string; cwd: string } | undefined`

### Reply detection in text handler

In `processTextTurn`, before `ensureSession`:
1. Check `ctx.message?.reply_to_message?.message_id`
2. If present, call `getSessionForMessage(messageId)`
3. If found, use that session (override attached), write to `~/.codedove/attached` (silent switch)
4. Skip `ensureSession` since we already have the session

### Files changed

| File | Change |
|------|--------|
| `src/telegram/notifications.ts` | Track `message_id -> session` in `notifyResponse` and `notifyToolUse`. New `getSessionForMessage` method. Cap at 500 entries. |
| `src/telegram/handlers/text.ts` | In `processTextTurn`, check reply-to, look up session, override attached, write to `attached` file. |
