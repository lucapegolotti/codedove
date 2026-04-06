# Tool Use Notifications

Show a live status message in Telegram when Claude Code is using tools (Bash, Read, Write, Edit, etc.), giving visibility into what's happening during a turn.

## Problem

Codedove only forwards assistant text responses. When Claude runs a sequence of tools (Bash commands, file reads/writes, agent dispatches), the user sees nothing until the text response arrives. For long-running turns (ML training babysitting, multi-file refactors), this feels like a black hole.

## Design

### Status message format

A single editable Telegram message per turn, updated as tools accumulate:

```
classifier: Bash(`ssh luca-dev 'tail -10 train.log'`) -> Read -> Edit -> Bash(`npm test`)
```

- Project name prefix, same as regular responses.
- Tools chained with ` -> `.
- Bash commands include a truncated preview of `input.command` (max 60 chars).
- All other tools show just the name (Read, Write, Edit, Grep, Glob, Agent, etc.).

### Lifecycle

1. **First tool_use detected** in a turn: send a new message, store its `message_id`.
2. **More tool_uses**: edit the same message, appending the new tool.
3. **Text response arrives** (`notifyResponse` fires): clear the stored `message_id`. The status message remains in chat as a log of what was done.
4. **New turn starts**: cycle repeats from step 1.

### Tool use detection

New function `extractToolUses(lines: string[])` in `src/session/jsonl.ts`. Parses JSONL lines and returns `{ name: string, command?: string }[]` for all `tool_use` blocks found. For Bash tools, extracts `input.command`. For others, just the tool name.

### watchForResponse changes

Add `onToolUse?: (tools: { name: string, command?: string }[]) => Promise<void>` callback parameter. Track which tool_use block IDs have already been reported (by `id` field in the JSONL). On each file change, extract tool uses from new content, diff against reported set, and fire `onToolUse` with only new ones.

### NotificationService changes

New method `notifyToolUse(projectName: string, tools: { name: string, command?: string }[])`:
- Maintains a `toolStatusMessageId: number | null` and `toolStatusTools: { name: string, command?: string }[]` per active turn.
- First call: sends message via `sendMessage`, stores `message_id`.
- Subsequent calls: appends to `toolStatusTools`, edits the message via `editMessageText`.
- `notifyResponse` clears `toolStatusMessageId` and `toolStatusTools` so the next turn starts fresh.

Key the status per session (`sessionId`) so multiple sessions don't interfere. Debounce edits to avoid hitting Telegram's rate limit (~30 edits/min): if multiple tool_uses arrive within 500ms, batch them into a single edit.

### Integration

- `SessionStreamManager`: pass `notifyToolUse` callback when creating stream watchers.
- `WatcherManager`: pass `notifyToolUse` callback for injection watchers.

### Files changed

| File | Change |
|------|--------|
| `src/session/jsonl.ts` | New `extractToolUses(lines)` function |
| `src/session/monitor.ts` | Add `onToolUse` callback to `watchForResponse`, track reported tool IDs |
| `src/telegram/notifications.ts` | New `notifyToolUse` method, edit-in-place logic, clear on `notifyResponse` |
| `src/session/stream-manager.ts` | Pass `onToolUse` to `watchForResponse` |
| `src/session/watcher-manager.ts` | Pass `onToolUse` to `watchForResponse` |

No new files. No new dependencies. Uses grammy's `bot.api.editMessageText`.
