# Codex CLI Support

Extend codedove to watch and interact with Codex CLI sessions running in tmux, alongside Claude Code sessions.

## Problem

Codedove today only watches Claude Code sessions. Users who also run Codex for coding tasks have no visibility into those sessions through the bot. Both CLIs work the same way (TUI in tmux with an on-disk session transcript), so codedove should handle both uniformly.

## Design

### Architecture

Introduce a `SessionAdapter` interface that abstracts the CLI-specific details. Two implementations: `ClaudeCodeAdapter` (wraps existing functions) and `CodexAdapter` (new). `SessionStreamManager`, `WatcherManager`, and `watchForResponse` work against adapters so both CLIs flow through the same plumbing.

### SessionAdapter interface

File: `src/session/adapter.ts`

```typescript
export type LatestSessionFile = { filePath: string; sessionId: string };

export interface SessionAdapter {
  name: string;                             // "claude" or "codex"
  projectsPath: string;                      // root transcript dir

  isAgentPane(pane: TmuxPane): boolean;
  getLatestSessionFileForCwd(cwd: string): Promise<LatestSessionFile | null>;

  parseAssistantText(lines: string[]): { text: string | null; cwd: string | null; model: string | undefined };
  findResultEvent(lines: string[]): boolean;
  extractToolUses(lines: string[]): ToolUseEntry[];
  friendlyModelName(modelId: string | undefined): string;
}
```

### ClaudeCodeAdapter

File: `src/session/adapters/claude.ts`. Wraps the existing `jsonl.ts` and `history.ts` functions verbatim. `projectsPath` = `~/.claude/projects`. `isAgentPane` matches the current `isClaudePane` logic. `name` = `"claude"`.

### CodexAdapter

File: `src/session/adapters/codex.ts`. New implementation over Codex's JSONL format.

- **`projectsPath`:** `~/.codex/sessions`
- **`isAgentPane`:** `pane.command` matches `/codex/i`
- **`getLatestSessionFileForCwd(cwd)`:** Codex partitions by date (`YYYY/MM/DD/rollout-<ts>-<session-id>.jsonl`). Scan the last 7 days of subdirectories, read the first line (`session_meta`) of each rollout file, match on `payload.cwd === cwd`, return the newest by mtime. Session ID is parsed from the filename.
- **`parseAssistantText(lines)`:** Scan backwards for the latest JSONL line where `type === "event_msg"` and `payload.type === "agent_message"` (both `commentary` and `final` phases). Return the `payload.message`. `cwd` and `model` come from the most recent `turn_context` event in the lines.
- **`findResultEvent(lines)`:** True if any line has `type === "event_msg"` and `payload.type === "task_complete"`.
- **`extractToolUses(lines)`:** Find all `event_msg` entries where `payload.type === "exec_command_end"`. Each yields `{ id: payload.call_id, name: "Bash", command: <truncated command> }`. The command is built by joining `payload.command` array, preferring the last element (the `-lc` shell payload) when it's clearly the actual command. Truncate to 60 chars like Claude's extractor.
- **`friendlyModelName(modelId)`:** Return the model ID as-is (Codex uses compact names like `gpt-5.4`). Fall back to `"codex"` if undefined.
- **`name`:** `"codex"`

### Wiring

**`SessionStreamManager`:** Constructor takes `SessionAdapter[]`. During `discover()`, for each tmux pane, pick the first adapter whose `isAgentPane` returns true. Use that adapter's `getLatestSessionFileForCwd` and store it on the `StreamEntry` so subsequent restarts use the same adapter.

**`WatcherManager`:** `startInjectionWatcher` picks the adapter by trying each adapter's `getLatestSessionFileForCwd(attached.cwd)` and using the one that returns a file. Stores the chosen adapter as `activeAdapter` so completion callbacks use the right one.

**`watchForResponse`:** New `adapter` parameter. Calls `adapter.parseAssistantText`, `adapter.findResultEvent`, `adapter.extractToolUses` instead of the current direct imports. `extractWrittenImagePaths` (Claude-only) stays as a direct import and is gated by a `supportsImageDetection: boolean` flag on the adapter (only Claude's adapter returns true).

**Singleton:** `src/session/adapters/index.ts` exports `export const adapters: SessionAdapter[] = [new ClaudeCodeAdapter(), new CodexAdapter()]`. Wired into managers at `index.ts` startup.

### Display

`notifyResponse` project prefix becomes `` `projectName (claude opus 4.6):` `` or `` `projectName (codex gpt-5.4):` ``. Adapter name is included to disambiguate which CLI is speaking. This is a visible change for Claude (previously `` `projectName (opus 4.6):` ``) — acceptable because disambiguation is the feature's core user-visible value.

### `/sessions` picker

`sendSessionPicker` in `src/telegram/handlers/sessions.ts` iterates all tmux panes, picks the adapter per pane, and deduplicates by cwd (if two CLIs run in the same directory, the first adapter wins — rare edge case, can improve later).

### Reply-to routing

Already adapter-agnostic once `getLatestSessionFileForCwd` is per-adapter. The fallback that parses project name from message text picks the adapter by trying each one's `getLatestSessionFileForCwd`.

### Input injection

Unchanged. `tmux send-keys` works for both TUIs. If Codex requires a different submit key in practice, we iterate after testing.

## Files changed

| File | Change |
|------|--------|
| `src/session/adapter.ts` | New: `SessionAdapter` interface + shared types |
| `src/session/adapters/claude.ts` | New: `ClaudeCodeAdapter` wrapping existing functions |
| `src/session/adapters/codex.ts` | New: `CodexAdapter` for Codex format |
| `src/session/adapters/index.ts` | New: exports `adapters` array |
| `src/session/monitor.ts` | `watchForResponse` takes an `adapter` param |
| `src/session/stream-manager.ts` | Takes `SessionAdapter[]`, dispatches per pane |
| `src/session/watcher-manager.ts` | Picks adapter by cwd, stores `activeAdapter` |
| `src/telegram/notifications.ts` | Project prefix includes CLI label |
| `src/telegram/handlers/sessions.ts` | `/sessions` discovers via all adapters |
| `src/telegram/handlers/text.ts` | Reply-routing fallback uses adapters |
| `src/index.ts` | Instantiate adapters, pass to managers |

## Testing

- `src/session/adapters/codex.test.ts`: fixture-based tests for `parseAssistantText`, `findResultEvent`, `extractToolUses`, `getLatestSessionFileForCwd` using real Codex JSONL samples captured from `~/.codex/sessions/`.
- `src/session/adapters/claude.test.ts`: smoke test that the wrapper returns the same values as the underlying functions (lightweight, since existing `jsonl.test.ts` covers the logic).
- Update existing `stream-manager`, `watcher-manager`, `monitor` tests to pass a mock adapter.

## Out of scope (future work)

- Codex permission/approval prompts (user runs yolo mode; low priority)
- Image detection for Codex
- Hook installation for Codex (not needed — `task_complete` is native to Codex)
