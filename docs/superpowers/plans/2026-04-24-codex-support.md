# Codex CLI Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend codedove to watch and interact with Codex CLI sessions in tmux alongside Claude Code sessions.

**Architecture:** Introduce a `SessionAdapter` interface that abstracts CLI-specific details (transcript location, pane detection, JSONL parsing, completion detection, tool extraction). `ClaudeCodeAdapter` wraps existing functions; `CodexAdapter` implements the same contract over Codex's format. `SessionStreamManager`, `WatcherManager`, and `watchForResponse` work against adapters.

**Tech Stack:** TypeScript, chokidar (existing), grammy (existing)

---

### Task 1: Create the SessionAdapter interface

**Files:**
- Create: `src/session/adapter.ts`

- [ ] **Step 1: Write the interface**

Create `src/session/adapter.ts`:

```typescript
import type { TmuxPane } from "./tmux.js";
import type { ToolUseEntry } from "./jsonl.js";

export type LatestSessionFile = { filePath: string; sessionId: string };

export interface SessionAdapter {
  /** Short label for logs and the message prefix ("claude", "codex"). */
  name: string;

  /** Root directory watched for this CLI's transcripts. */
  projectsPath: string;

  /** Whether this adapter can detect images written by the agent (Claude only for now). */
  supportsImageDetection: boolean;

  /** Detect a tmux pane running this CLI. */
  isAgentPane(pane: TmuxPane): boolean;

  /** Find the most recent transcript file for a given working directory. */
  getLatestSessionFileForCwd(cwd: string): Promise<LatestSessionFile | null>;

  /** Extract the latest assistant text (scanning backwards). */
  parseAssistantText(lines: string[]): {
    text: string | null;
    cwd: string | null;
    model: string | undefined;
  };

  /** Detect turn completion (Claude: `result` event; Codex: `task_complete`). */
  findResultEvent(lines: string[]): boolean;

  /** Extract tool_use / exec_command entries with stable IDs. Bash-equivalent only. */
  extractToolUses(lines: string[]): ToolUseEntry[];

  /** Convert a model identifier to a short display name. */
  friendlyModelName(modelId: string | undefined): string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/session/adapter.ts
git commit -m "feat: add SessionAdapter interface for CLI abstraction"
```

---

### Task 2: Implement ClaudeCodeAdapter

**Files:**
- Create: `src/session/adapters/claude.ts`
- Create: `src/session/adapters/claude.test.ts`

- [ ] **Step 1: Write the smoke tests**

Create `src/session/adapters/claude.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter } from "./claude.js";

describe("ClaudeCodeAdapter", () => {
  const adapter = new ClaudeCodeAdapter();

  it("has name 'claude'", () => {
    expect(adapter.name).toBe("claude");
  });

  it("supports image detection", () => {
    expect(adapter.supportsImageDetection).toBe(true);
  });

  it("projectsPath points to ~/.claude/projects", () => {
    expect(adapter.projectsPath).toMatch(/\.claude\/projects$/);
  });

  it("isAgentPane detects Claude by command", () => {
    expect(adapter.isAgentPane({ paneId: "%1", shellPid: 1, command: "claude", cwd: "/tmp" })).toBe(true);
    expect(adapter.isAgentPane({ paneId: "%1", shellPid: 1, command: "2.1.47", cwd: "/tmp" })).toBe(true);
    expect(adapter.isAgentPane({ paneId: "%1", shellPid: 1, command: "zsh", cwd: "/tmp" })).toBe(false);
  });

  it("parseAssistantText returns text block", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        cwd: "/tmp/p",
        message: { model: "claude-opus-4-7", content: [{ type: "text", text: "hello" }] },
      }),
    ];
    const result = adapter.parseAssistantText(lines);
    expect(result.text).toBe("hello");
    expect(result.cwd).toBe("/tmp/p");
    expect(result.model).toBe("claude-opus-4-7");
  });

  it("findResultEvent detects result event", () => {
    expect(adapter.findResultEvent([JSON.stringify({ type: "result" })])).toBe(true);
    expect(adapter.findResultEvent([JSON.stringify({ type: "assistant" })])).toBe(false);
  });

  it("extractToolUses returns Bash entries", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    ];
    const tools = adapter.extractToolUses(lines);
    expect(tools).toEqual([{ id: "t1", name: "Bash", command: "ls" }]);
  });

  it("friendlyModelName strips claude- prefix", () => {
    expect(adapter.friendlyModelName("claude-opus-4-7")).toMatch(/opus/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/session/adapters/claude.test.ts -v`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the adapter**

Create `src/session/adapters/claude.ts`:

```typescript
import { homedir } from "os";
import type { SessionAdapter, LatestSessionFile } from "../adapter.js";
import type { TmuxPane } from "../tmux.js";
import { isClaudePane } from "../tmux.js";
import { PROJECTS_PATH, getLatestSessionFileForCwd } from "../history.js";
import {
  parseAssistantText,
  findResultEvent,
  extractToolUses,
  type ToolUseEntry,
} from "../jsonl.js";
import { friendlyModelName } from "../../telegram/notifications.js";

export class ClaudeCodeAdapter implements SessionAdapter {
  name = "claude";
  projectsPath = PROJECTS_PATH;
  supportsImageDetection = true;

  isAgentPane(pane: TmuxPane): boolean {
    return isClaudePane(pane);
  }

  async getLatestSessionFileForCwd(cwd: string): Promise<LatestSessionFile | null> {
    return getLatestSessionFileForCwd(cwd);
  }

  parseAssistantText(lines: string[]) {
    return parseAssistantText(lines);
  }

  findResultEvent(lines: string[]): boolean {
    return findResultEvent(lines);
  }

  extractToolUses(lines: string[]): ToolUseEntry[] {
    return extractToolUses(lines);
  }

  friendlyModelName(modelId: string | undefined): string {
    if (!modelId) return "claude";
    return friendlyModelName(modelId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/session/adapters/claude.test.ts -v`
Expected: PASS (all 8)

- [ ] **Step 5: Commit**

```bash
git add src/session/adapters/claude.ts src/session/adapters/claude.test.ts
git commit -m "feat: ClaudeCodeAdapter wrapping existing functions"
```

---

### Task 3: Implement CodexAdapter parsing functions

**Files:**
- Create: `src/session/adapters/codex.ts`
- Create: `src/session/adapters/codex.test.ts`

- [ ] **Step 1: Write the parsing tests**

Create `src/session/adapters/codex.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { CodexAdapter } from "./codex.js";

describe("CodexAdapter parsing", () => {
  const adapter = new CodexAdapter();

  describe("parseAssistantText", () => {
    it("returns the latest agent_message", () => {
      const lines = [
        JSON.stringify({
          type: "turn_context",
          payload: { cwd: "/tmp/proj", model: "gpt-5.4" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "First update", phase: "commentary" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "Final answer", phase: "final" },
        }),
      ];
      const result = adapter.parseAssistantText(lines);
      expect(result.text).toBe("Final answer");
      expect(result.cwd).toBe("/tmp/proj");
      expect(result.model).toBe("gpt-5.4");
    });

    it("handles commentary-only messages", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "still working", phase: "commentary" },
        }),
      ];
      const result = adapter.parseAssistantText(lines);
      expect(result.text).toBe("still working");
    });

    it("returns null text when no agent_message present", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_started" },
        }),
      ];
      const result = adapter.parseAssistantText(lines);
      expect(result.text).toBeNull();
    });

    it("stops at user_message boundary", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "old reply" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "new question" },
        }),
      ];
      const result = adapter.parseAssistantText(lines);
      expect(result.text).toBeNull();
    });
  });

  describe("findResultEvent", () => {
    it("detects task_complete", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "t1" },
        }),
      ];
      expect(adapter.findResultEvent(lines)).toBe(true);
    });

    it("returns false without task_complete", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "hi" },
        }),
      ];
      expect(adapter.findResultEvent(lines)).toBe(false);
    });
  });

  describe("extractToolUses", () => {
    it("returns Bash entries from exec_command_end, preferring the actual shell payload", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "exec_command_end",
            call_id: "call_ABC",
            command: ["/bin/zsh", "-lc", "pwd"],
            exit_code: 0,
          },
        }),
      ];
      const tools = adapter.extractToolUses(lines);
      expect(tools).toEqual([{ id: "call_ABC", name: "Bash", command: "pwd" }]);
    });

    it("truncates long commands", () => {
      const longCmd = "a".repeat(100);
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "exec_command_end",
            call_id: "c1",
            command: ["/bin/zsh", "-lc", longCmd],
            exit_code: 0,
          },
        }),
      ];
      const tools = adapter.extractToolUses(lines);
      expect(tools[0].command).toBe("a".repeat(57) + "...");
    });

    it("skips non-exec events", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "hi" },
        }),
      ];
      expect(adapter.extractToolUses(lines)).toEqual([]);
    });

    it("falls back to joined command array if no -lc pattern", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "exec_command_end",
            call_id: "c2",
            command: ["ls", "/tmp"],
            exit_code: 0,
          },
        }),
      ];
      const tools = adapter.extractToolUses(lines);
      expect(tools[0].command).toBe("ls /tmp");
    });
  });

  describe("friendlyModelName", () => {
    it("returns model ID as-is", () => {
      expect(adapter.friendlyModelName("gpt-5.4")).toBe("gpt-5.4");
    });

    it("falls back to 'codex' when undefined", () => {
      expect(adapter.friendlyModelName(undefined)).toBe("codex");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/session/adapters/codex.test.ts -v`
Expected: FAIL — `CodexAdapter` does not exist.

- [ ] **Step 3: Implement parsing**

Create `src/session/adapters/codex.ts` with the parsing methods (discovery comes in Task 4):

```typescript
import { homedir } from "os";
import type { SessionAdapter, LatestSessionFile } from "../adapter.js";
import type { TmuxPane } from "../tmux.js";
import type { ToolUseEntry } from "../jsonl.js";

const CODEX_PROJECTS_PATH = `${homedir()}/.codex/sessions`;
const COMMAND_TRUNCATE_LIMIT = 60;

export class CodexAdapter implements SessionAdapter {
  name = "codex";
  projectsPath = CODEX_PROJECTS_PATH;
  supportsImageDetection = false;

  isAgentPane(pane: TmuxPane): boolean {
    return /codex/i.test(pane.command);
  }

  async getLatestSessionFileForCwd(_cwd: string): Promise<LatestSessionFile | null> {
    // Implemented in Task 4.
    return null;
  }

  parseAssistantText(lines: string[]): {
    text: string | null;
    cwd: string | null;
    model: string | undefined;
  } {
    // Walk backwards to find the latest agent_message, collecting cwd/model
    // from the most recent turn_context. Stop at user_message boundary.
    let text: string | null = null;
    let cwd: string | null = null;
    let model: string | undefined;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "event_msg") {
          const p = entry.payload;
          if (p?.type === "user_message") {
            // crossed a user turn boundary before finding a fresh agent_message
            if (text === null) break;
          }
          if (p?.type === "agent_message" && text === null && typeof p.message === "string") {
            text = p.message;
          }
        }
        if (entry.type === "turn_context" && (cwd === null || model === undefined)) {
          const p = entry.payload;
          if (typeof p?.cwd === "string" && cwd === null) cwd = p.cwd;
          if (typeof p?.model === "string" && model === undefined) model = p.model;
        }
      } catch {
        continue;
      }
    }

    return { text, cwd, model };
  }

  findResultEvent(lines: string[]): boolean {
    return lines.some((line) => {
      try {
        const entry = JSON.parse(line);
        return entry.type === "event_msg" && entry.payload?.type === "task_complete";
      } catch {
        return false;
      }
    });
  }

  extractToolUses(lines: string[]): ToolUseEntry[] {
    const result: ToolUseEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "event_msg") continue;
        const p = entry.payload;
        if (p?.type !== "exec_command_end") continue;
        if (typeof p.call_id !== "string") continue;
        const cmd = pickCommandString(p.command);
        const truncated =
          cmd.length > COMMAND_TRUNCATE_LIMIT
            ? cmd.slice(0, COMMAND_TRUNCATE_LIMIT - 3) + "..."
            : cmd;
        result.push({ id: p.call_id, name: "Bash", command: truncated });
      } catch {
        continue;
      }
    }
    return result;
  }

  friendlyModelName(modelId: string | undefined): string {
    return modelId ?? "codex";
  }
}

// Codex's command is usually ["/bin/zsh", "-lc", "<actual command>"]. The actual
// command is the last element. If the array doesn't match that pattern, fall back
// to joining all tokens.
function pickCommandString(command: unknown): string {
  if (!Array.isArray(command)) return "";
  const lcIndex = command.indexOf("-lc");
  if (lcIndex !== -1 && lcIndex < command.length - 1) {
    const payload = command[lcIndex + 1];
    if (typeof payload === "string") return payload;
  }
  return command.filter((t) => typeof t === "string").join(" ");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/session/adapters/codex.test.ts -v`
Expected: PASS (11/11)

- [ ] **Step 5: Commit**

```bash
git add src/session/adapters/codex.ts src/session/adapters/codex.test.ts
git commit -m "feat: CodexAdapter parsing (parseAssistantText, findResultEvent, extractToolUses)"
```

---

### Task 4: CodexAdapter session discovery

**Files:**
- Modify: `src/session/adapters/codex.ts`
- Modify: `src/session/adapters/codex.test.ts`

- [ ] **Step 1: Write the test**

Add to `src/session/adapters/codex.test.ts`:

```typescript
import { mkdtemp, mkdir, writeFile, utimes } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("CodexAdapter session discovery", () => {
  it("finds the newest rollout file matching cwd across date subdirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-adapter-"));
    const adapter = new CodexAdapter();
    (adapter as any).projectsPath = root;

    const day1 = join(root, "2026", "04", "20");
    const day2 = join(root, "2026", "04", "23");
    await mkdir(day1, { recursive: true });
    await mkdir(day2, { recursive: true });

    const oldFile = join(day1, "rollout-2026-04-20T10-00-00-aaa-bbb-ccc-ddd-000000000001.jsonl");
    const newFile = join(day2, "rollout-2026-04-23T10-00-00-aaa-bbb-ccc-ddd-000000000002.jsonl");
    const otherCwdFile = join(day2, "rollout-2026-04-23T11-00-00-aaa-bbb-ccc-ddd-000000000003.jsonl");

    await writeFile(
      oldFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/target" } }) + "\n"
    );
    await writeFile(
      newFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/target" } }) + "\n"
    );
    await writeFile(
      otherCwdFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/other" } }) + "\n"
    );

    // Force newFile to have the newest mtime
    const now = Date.now();
    await utimes(oldFile, new Date(now - 10_000), new Date(now - 10_000));
    await utimes(newFile, new Date(now), new Date(now));
    await utimes(otherCwdFile, new Date(now + 5_000), new Date(now + 5_000));

    const result = await adapter.getLatestSessionFileForCwd("/tmp/target");
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe(newFile);
    expect(result!.sessionId).toBe("019dbb80-3d3b-7461-af88-81cf54376e27".replace(/./g, (c, i) => i < 4 ? "0" : c).substring(0, 0) + "aaa-bbb-ccc-ddd-000000000002"); // session ID is parsed from filename
  });

  it("returns null when no matching cwd is found", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-adapter-"));
    const adapter = new CodexAdapter();
    (adapter as any).projectsPath = root;

    const result = await adapter.getLatestSessionFileForCwd("/tmp/nonexistent");
    expect(result).toBeNull();
  });
});
```

Note: the `sessionId` assertion above is awkward. Replace with a direct assertion on the session ID parsed from the filename pattern — the filename is `rollout-<timestamp>-<sessionId>.jsonl`. Use this simpler assertion:

```typescript
    expect(result!.sessionId).toBe("aaa-bbb-ccc-ddd-000000000002");
```

Update the test to use that exact assertion.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/session/adapters/codex.test.ts -v`
Expected: FAIL — `getLatestSessionFileForCwd` currently returns null.

- [ ] **Step 3: Implement discovery**

Replace the stub `getLatestSessionFileForCwd` in `src/session/adapters/codex.ts`:

```typescript
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";

// ... inside CodexAdapter class ...

  async getLatestSessionFileForCwd(cwd: string): Promise<LatestSessionFile | null> {
    // Codex partitions sessions as <projectsPath>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
    // Scan the last 7 days of subdirectories (sessions older than that are stale).
    const dayDirs = await this.recentDayDirs(7);

    let best: { filePath: string; sessionId: string; mtime: number } | null = null;

    for (const dayDir of dayDirs) {
      let files: string[];
      try {
        files = (await readdir(dayDir)).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = join(dayDir, file);
        let fileCwd: string | null = null;
        try {
          // Read only enough bytes for the first line (session_meta is always first).
          const buf = await readFile(filePath, { encoding: "utf8" });
          const firstLine = buf.split("\n", 1)[0];
          const entry = JSON.parse(firstLine);
          if (entry.type === "session_meta" && typeof entry.payload?.cwd === "string") {
            fileCwd = entry.payload.cwd;
          }
        } catch {
          continue;
        }

        if (fileCwd !== cwd) continue;

        let mtime: number;
        try {
          mtime = (await stat(filePath)).mtime.getTime();
        } catch {
          continue;
        }

        if (best === null || mtime > best.mtime) {
          const sessionId = file.replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, "").replace(/\.jsonl$/, "");
          best = { filePath, sessionId, mtime };
        }
      }
    }

    if (!best) return null;
    return { filePath: best.filePath, sessionId: best.sessionId };
  }

  private async recentDayDirs(days: number): Promise<string[]> {
    const result: string[] = [];
    const now = new Date();
    for (let d = 0; d < days; d++) {
      const dt = new Date(now.getTime() - d * 86_400_000);
      const yyyy = dt.getUTCFullYear().toString();
      const mm = (dt.getUTCMonth() + 1).toString().padStart(2, "0");
      const dd = dt.getUTCDate().toString().padStart(2, "0");
      const dir = join(this.projectsPath, yyyy, mm, dd);
      try {
        await stat(dir);
        result.push(dir);
      } catch {
        continue;
      }
    }
    return result;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/session/adapters/codex.test.ts -v`
Expected: PASS (13/13)

- [ ] **Step 5: Commit**

```bash
git add src/session/adapters/codex.ts src/session/adapters/codex.test.ts
git commit -m "feat: CodexAdapter session discovery via recent date dirs"
```

---

### Task 5: Adapters registry

**Files:**
- Create: `src/session/adapters/index.ts`

- [ ] **Step 1: Create the module**

Create `src/session/adapters/index.ts`:

```typescript
import type { SessionAdapter } from "../adapter.js";
import type { TmuxPane } from "../tmux.js";
import { ClaudeCodeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";

export const adapters: SessionAdapter[] = [
  new ClaudeCodeAdapter(),
  new CodexAdapter(),
];

/** Pick the first adapter that recognises this pane, or null. */
export function adapterForPane(pane: TmuxPane): SessionAdapter | null {
  for (const adapter of adapters) {
    if (adapter.isAgentPane(pane)) return adapter;
  }
  return null;
}

/** Pick an adapter for a cwd by trying each one's getLatestSessionFileForCwd. */
export async function adapterForCwd(cwd: string): Promise<{ adapter: SessionAdapter; file: { filePath: string; sessionId: string } } | null> {
  for (const adapter of adapters) {
    const file = await adapter.getLatestSessionFileForCwd(cwd);
    if (file) return { adapter, file };
  }
  return null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/session/adapters/index.ts
git commit -m "feat: adapters registry with adapterForPane/adapterForCwd"
```

---

### Task 6: Thread adapter through watchForResponse

**Files:**
- Modify: `src/session/monitor.ts`
- Modify: `src/session/monitor.test.ts`

- [ ] **Step 1: Update the signature and implementation**

In `src/session/monitor.ts`, change `watchForResponse` to accept an `adapter` parameter as the last argument.

At the top, add imports:

```typescript
import type { SessionAdapter } from "./adapter.js";
```

Change the signature:

```typescript
export function watchForResponse(
  filePath: string,
  baselineSize: number,
  onResponse: ResponseCallback,
  onPing?: () => void,
  onComplete?: () => void,
  onImages?: ImagesCallback,
  onToolUse?: ToolUseCallback,
  adapter?: SessionAdapter
): () => void {
```

`adapter` is optional for backward compatibility. Inside the function, when `adapter` is provided, use it for:

- `parseAssistantText` → `adapter.parseAssistantText`
- `findResultEvent` → `adapter.findResultEvent`
- `extractToolUses` → `adapter.extractToolUses`
- Skip `extractWrittenImagePaths` when `!adapter.supportsImageDetection`

When `adapter` is undefined, fall back to the existing direct imports (preserves current tests).

Also extend the `SessionResponseState` type in this file to include `cliName?: string`:

```typescript
export type SessionResponseState = {
  sessionId: string;
  projectName: string;
  cwd: string;
  filePath: string;
  text: string;
  model?: string;
  cliName?: string;
};
```

Populate `cliName: adapter?.name` whenever a state object is constructed for `onResponse` (both the regular-fire path and the final-flush path).

Add a small helper at the top of the function:

```typescript
  const _parseAssistantText = adapter?.parseAssistantText.bind(adapter) ?? parseAssistantText;
  const _findResultEvent = adapter?.findResultEvent.bind(adapter) ?? findResultEvent;
  const _extractToolUses = adapter?.extractToolUses.bind(adapter) ?? extractToolUses;
  const _supportsImages = adapter ? adapter.supportsImageDetection : true;
```

Then replace the direct calls inside the change handler with `_parseAssistantText(lines)`, `_findResultEvent(lines)`, `_extractToolUses(lines)`. Gate the image-detection block on `if (onImages && _supportsImages) { ... }`.

- [ ] **Step 2: Write a test exercising the adapter override**

Add to `src/session/monitor.test.ts`:

```typescript
import type { SessionAdapter } from "./adapter.js";

it("uses adapter methods when provided", async () => {
  const file = join(tmpdir(), `cv-watch-adapter-${Date.now()}.jsonl`);
  await writeFile(file, "");

  const parseCalls: string[][] = [];
  const adapter: SessionAdapter = {
    name: "test",
    projectsPath: "/tmp",
    supportsImageDetection: false,
    isAgentPane: () => false,
    getLatestSessionFileForCwd: async () => null,
    parseAssistantText: (lines) => {
      parseCalls.push(lines);
      return { text: "ADAPTER-TEXT", cwd: "/tmp/from-adapter", model: "test-model" };
    },
    findResultEvent: () => false,
    extractToolUses: () => [],
    friendlyModelName: (m) => m ?? "test",
  };

  const responses: string[] = [];
  const stop = watchForResponse(
    file,
    0,
    async (state) => { responses.push(state.text); },
    undefined,
    undefined,
    undefined,
    undefined,
    adapter
  );

  await appendFile(file, "something\n");
  await new Promise((r) => setTimeout(r, 500));

  expect(parseCalls.length).toBeGreaterThan(0);
  expect(responses[0]).toBe("ADAPTER-TEXT");

  stop();
});
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All pass. Existing `watchForResponse` tests still work (no adapter passed = fallback path).

- [ ] **Step 4: Commit**

```bash
git add src/session/monitor.ts src/session/monitor.test.ts
git commit -m "feat: watchForResponse accepts optional SessionAdapter"
```

---

### Task 7: SessionStreamManager uses adapters

**Files:**
- Modify: `src/session/stream-manager.ts`
- Modify: `src/session/stream-manager.test.ts`

- [ ] **Step 1: Update SessionStreamManager**

In `src/session/stream-manager.ts`:

Replace the imports:

```typescript
import { log } from "../logger.js";
import { listTmuxPanes } from "./tmux.js";
import { watchForResponse, getFileSize } from "./monitor.js";
import { notifyResponse, notifyToolUse } from "../telegram/notifications.js";
import type { SessionAdapter } from "./adapter.js";
import { adapters as defaultAdapters, adapterForPane } from "./adapters/index.js";
```

Update `StreamEntry`:

```typescript
type StreamEntry = {
  cwd: string;
  filePath: string;
  sessionId: string;
  stop: () => void;
  paused: boolean;
  adapter: SessionAdapter;
};
```

Update the class to accept adapters:

```typescript
export class SessionStreamManager {
  private streams = new Map<string, StreamEntry>();
  private discoveryId: ReturnType<typeof setInterval> | null = null;
  private adapters: SessionAdapter[];

  constructor(adapters: SessionAdapter[] = defaultAdapters) {
    this.adapters = adapters;
  }

  // ... start(), pause(), stop() unchanged ...
```

Update `resume`:

```typescript
  async resume(cwd: string): Promise<void> {
    const entry = this.streams.get(cwd);
    if (!entry) return;
    entry.paused = false;
    const latest = await entry.adapter.getLatestSessionFileForCwd(cwd);
    const filePath = latest?.filePath ?? entry.filePath;
    await this.startWatcher(entry.cwd, filePath, entry.adapter);
    log({ message: `stream resumed for ${cwd}` });
  }
```

Update `discover`:

```typescript
  private async discover(): Promise<void> {
    let allPanes;
    try {
      allPanes = await listTmuxPanes();
    } catch (err) {
      log({ message: `stream discovery error: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    // Pair each pane with its adapter (if any)
    const paneAdapters = new Map<string, SessionAdapter>();
    for (const pane of allPanes) {
      const adapter = adapterForPane(pane);
      if (adapter) paneAdapters.set(pane.cwd, adapter);
    }

    // Start watchers for new sessions
    for (const [cwd, adapter] of paneAdapters) {
      if (this.streams.has(cwd)) continue;

      const latest = await adapter.getLatestSessionFileForCwd(cwd);
      if (!latest) continue;

      await this.startWatcher(cwd, latest.filePath, adapter);
    }

    // Remove watchers for sessions whose tmux pane is gone
    for (const [cwd, entry] of this.streams) {
      if (!paneAdapters.has(cwd)) {
        entry.stop();
        this.streams.delete(cwd);
        log({ message: `stream removed for ${cwd} (pane gone)` });
      }
    }
  }
```

Update `startWatcher`:

```typescript
  private async startWatcher(cwd: string, filePath: string, adapter: SessionAdapter): Promise<void> {
    const sessionId = filePath.split("/").pop()!.replace(".jsonl", "");
    const baseline = await getFileSize(filePath);

    const onComplete = async () => {
      const entry = this.streams.get(cwd);
      if (!entry || entry.paused) return;

      const latest = await entry.adapter.getLatestSessionFileForCwd(cwd);
      if (!latest) return;

      await this.startWatcher(cwd, latest.filePath, entry.adapter);
    };

    const projectName = cwd.split("/").pop() || cwd;

    const stop = watchForResponse(
      filePath,
      baseline,
      notifyResponse,
      undefined,
      onComplete,
      undefined,
      async (tools) => { await notifyToolUse(projectName, sessionId, tools); },
      adapter
    );

    this.streams.set(cwd, { cwd, filePath, sessionId, stop, paused: false, adapter });
  }
}
```

- [ ] **Step 2: Update existing stream-manager tests**

The existing tests mock `getLatestSessionFileForCwd` and `isClaudePane` from `./history.js` / `./tmux.js`. Replace those mocks with a mock adapter passed to the constructor. Example update at the top of `src/session/stream-manager.test.ts`:

Replace the existing mocks with:

```typescript
vi.mock("./tmux.js", () => ({
  listTmuxPanes: vi.fn().mockResolvedValue([]),
}));

vi.mock("./monitor.js", () => ({
  watchForResponse: vi.fn().mockReturnValue(() => {}),
  getFileSize: vi.fn().mockResolvedValue(0),
}));

vi.mock("../telegram/notifications.js", () => ({
  notifyResponse: vi.fn(),
  notifyToolUse: vi.fn(),
}));

vi.mock("../logger.js", () => ({ log: vi.fn() }));
```

At the top of the describe block, add a factory that creates the manager with a mock adapter:

```typescript
function makeManager(overrides: Partial<SessionAdapter> = {}) {
  const adapter: SessionAdapter = {
    name: "claude",
    projectsPath: "/claude",
    supportsImageDetection: true,
    isAgentPane: (p: any) => p.command.includes("claude"),
    getLatestSessionFileForCwd: vi.fn().mockResolvedValue({
      filePath: "/tmp/a.jsonl",
      sessionId: "session-a",
    }) as any,
    parseAssistantText: () => ({ text: null, cwd: null, model: undefined }),
    findResultEvent: () => false,
    extractToolUses: () => [],
    friendlyModelName: () => "claude",
    ...overrides,
  };
  return { adapter, manager: new SessionStreamManager([adapter]) };
}
```

Update each test to use `makeManager()`. For instance, the "discovers tmux sessions and starts watchers on start" test becomes:

```typescript
it("discovers tmux sessions and starts watchers on start", async () => {
  const { manager } = makeManager();
  vi.mocked(listTmuxPanes).mockResolvedValue([claudePane("/tmp/projectA")]);
  vi.mocked(getFileSize).mockResolvedValue(500);

  await manager.start();

  expect(watchForResponse).toHaveBeenCalledWith(
    "/tmp/a.jsonl",
    500,
    expect.any(Function),
    undefined,
    expect.any(Function),
    undefined,
    expect.any(Function),
    expect.any(Object),
  );

  manager.stop();
});
```

Apply the same pattern to every test in the file: for each test, replace the direct `SessionStreamManager` instantiation with `const { adapter, manager } = makeManager(<overrides>);`. Where a test previously did `vi.mocked(getLatestSessionFileForCwd).mockResolvedValue(X)`, replace with `makeManager({ getLatestSessionFileForCwd: vi.fn().mockResolvedValue(X) as any })`. Where a test asserted `watchForResponse` was called with N arguments, add `expect.any(Object)` as the 8th argument (the adapter). The `listTmuxPanes` mock stays as-is; the adapter's `isAgentPane` returns true for `p.command.includes("claude")` so existing `claudePane("/tmp/...")` helpers still work.

For tests that previously relied on `getLatestSessionFileForCwd` being called differently per case, override that method via `makeManager({ getLatestSessionFileForCwd: ... })`.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/session/stream-manager.test.ts -v`
Expected: PASS

Run: `npm test`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/session/stream-manager.ts src/session/stream-manager.test.ts
git commit -m "feat: SessionStreamManager uses SessionAdapter[]"
```

---

### Task 8: WatcherManager uses adapters

**Files:**
- Modify: `src/session/watcher-manager.ts`
- Modify: `src/session/watcher-manager.test.ts`

- [ ] **Step 1: Update WatcherManager**

In `src/session/watcher-manager.ts`:

Add imports:

```typescript
import type { SessionAdapter } from "./adapter.js";
import { adapterForCwd, adapters as defaultAdapters } from "./adapters/index.js";
```

Change the imports for `getLatestSessionFileForCwd` — remove it from the `history.js` import since we'll route through adapters. Keep `ATTACHED_SESSION_PATH`.

Change `snapshotBaseline` to use adapters:

```typescript
  async snapshotBaseline(
    cwd: string
  ): Promise<{ filePath: string; sessionId: string; size: number } | null> {
    const resolved = await adapterForCwd(cwd);
    if (!resolved) return null;
    const size = await getFileSize(resolved.file.filePath);
    return { ...resolved.file, size };
  }
```

Change `startInjectionWatcher` to pick an adapter (store it on the instance so `pollForPostCompactionSession` can use it):

Add field:
```typescript
  private activeAdapter: SessionAdapter | null = null;
```

Near the top of `startInjectionWatcher`, after `stopAndFlush`:

```typescript
    let adapter: SessionAdapter;
    let filePath: string;
    let latestSessionId: string;
    let baseline: number;

    if (preBaseline) {
      // We need an adapter even with preBaseline; pick it by cwd.
      const resolved = await adapterForCwd(attached.cwd);
      adapter = resolved?.adapter ?? defaultAdapters[0]; // fall back to claude
      ({ filePath, sessionId: latestSessionId, size: baseline } = preBaseline);
    } else {
      const resolved = await adapterForCwd(attached.cwd);
      if (!resolved) {
        log({ message: `watchForResponse: could not find session for cwd ${attached.cwd}` });
        onComplete?.();
        return;
      }
      adapter = resolved.adapter;
      filePath = resolved.file.filePath;
      latestSessionId = resolved.file.sessionId;
      baseline = await getFileSize(filePath);
    }

    this.activeAdapter = adapter;
```

Pass `adapter` as the 8th argument to the `watchForResponse` call:

```typescript
    this.activeStop = watchForResponse(
      filePath,
      baseline,
      wrappedOnResponse,
      undefined,
      () => {
        this.compactPollGeneration++;
        this.activeOnComplete = null;
        onComplete?.();
        if (!responseDelivered) void sendPing("✅ Done.");
      },
      async (images: DetectedImage[]) => {
        const key = `${Date.now()}`;
        pendingImages.set(key, images);
        await notifyImages(images, key);
      },
      async (tools) => { await notifyToolUse(injectionProjectName, latestSessionId, tools); },
      adapter
    );
```

In `pollForPostCompactionSession`, use `this.activeAdapter` for the poll lookup and pass it to the restarted watcher:

```typescript
  private async pollForPostCompactionSession(
    generation: number,
    cwd: string,
    oldFilePath: string,
    onResponse?: (state: SessionResponseState) => Promise<void>,
    onComplete?: () => void
  ): Promise<void> {
    const deadline = Date.now() + 60_000;
    const adapter = this.activeAdapter;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 3_000));
      if (this.compactPollGeneration !== generation) return;

      if (!adapter) continue;
      const latest = await adapter.getLatestSessionFileForCwd(cwd);
      if (latest && latest.filePath !== oldFilePath) {
        log({ message: `post-compact: new session found ${latest.sessionId.slice(0, 8)}, restarting watcher` });
        await writeFile(ATTACHED_SESSION_PATH, `${latest.sessionId}\n${cwd}`, "utf8").catch(() => {});
        this.activeStop?.();
        this.activeOnComplete = onComplete ?? null;
        this.activeStop = watchForResponse(
          latest.filePath,
          0,
          async (state) => { await (onResponse ?? notifyResponse)(state); },
          undefined,
          () => {
            this.activeOnComplete = null;
            onComplete?.();
          },
          undefined,
          async (tools) => {
            const pName = cwd.split("/").pop() || cwd;
            await notifyToolUse(pName, latest.sessionId, tools);
          },
          adapter
        );
        return;
      }
    }
    log({ message: `post-compact: no new session found for ${cwd} after 60s` });
    onComplete?.();
  }
```

Also clear `this.activeAdapter = null` in the `clear()` method.

- [ ] **Step 2: Update watcher-manager tests**

In `src/session/watcher-manager.test.ts`, replace the existing `vi.mock("./history.js", ...)` mock — since we no longer call `getLatestSessionFileForCwd` from `history.js`, mock `./adapters/index.js` instead:

```typescript
vi.mock("./adapters/index.js", () => ({
  adapters: [],
  adapterForCwd: vi.fn(),
  adapterForPane: vi.fn(),
}));

vi.mock("./history.js", () => ({
  ATTACHED_SESSION_PATH: "/tmp/test-attached",
}));
```

Keep the other mocks (monitor, notifications, logger, fs).

Add at the top of each test a mock adapter shape that `adapterForCwd` returns:

```typescript
function mockResolvedAdapter(filePath: string, sessionId: string) {
  const adapter = {
    name: "claude",
    projectsPath: "/claude",
    supportsImageDetection: true,
    isAgentPane: () => true,
    getLatestSessionFileForCwd: vi.fn().mockResolvedValue({ filePath, sessionId }),
    parseAssistantText: () => ({ text: null, cwd: null, model: undefined }),
    findResultEvent: () => false,
    extractToolUses: () => [],
    friendlyModelName: () => "claude",
  };
  vi.mocked(adapterForCwd).mockResolvedValue({ adapter, file: { filePath, sessionId } });
  return adapter;
}
```

Replace the `getLatestSessionFileForCwd` mock setup in each test with a call to `mockResolvedAdapter(...)`.

Update `toHaveBeenCalledWith` / `toHaveBeenLastCalledWith` assertions for `watchForResponse` to include an 8th argument `expect.any(Object)` (the adapter).

For the "detects new session and restarts watcher" test, make the mock adapter's `getLatestSessionFileForCwd` return different values on the second call:

```typescript
const adapter = mockResolvedAdapter("/tmp/old-session.jsonl", "old-session");
// Later, to simulate rotation:
adapter.getLatestSessionFileForCwd.mockResolvedValueOnce({
  filePath: "/tmp/new-session.jsonl",
  sessionId: "new-session",
});
```

For the "updates attached session file when sessionId rotates" test: update it to call `mockResolvedAdapter("/tmp/new-session.jsonl", "new-session-id")` at the start, then assert that `writeFile` was called when `startInjectionWatcher` is called with a stale `sessionId`.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/session/watcher-manager.test.ts -v`
Expected: PASS (21/21)

Run: `npm test`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/session/watcher-manager.ts src/session/watcher-manager.test.ts
git commit -m "feat: WatcherManager dispatches via SessionAdapter"
```

---

### Task 9: Notification prefix with CLI label

**Files:**
- Modify: `src/telegram/notifications.ts`
- Modify: `src/telegram/notifications.test.ts`

- [ ] **Step 1: Update the test**

In `src/telegram/notifications.test.ts`, change the tests that assert on the response text prefix. The existing prefix is `` `projectName (opus 4.6):` ``. Update them to expect `` `projectName (claude opus 4.6):` ``.

Find tests that check `notifyResponse` output and update the expected prefix. Also add a test for Codex:

```typescript
it("includes codex CLI label when adapter name is codex", async () => {
  notifications.register(mockBot as any, 123);
  mockBot.api.sendMessage.mockResolvedValue({ message_id: 10 });

  await notifications.notifyResponse({
    sessionId: "s1",
    projectName: "myproj",
    cwd: "/tmp/p",
    filePath: "/tmp/p.jsonl",
    text: "Hello",
    model: "gpt-5.4",
    cliName: "codex",
  });

  expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
    123,
    expect.stringContaining("myproj (codex gpt-5.4):"),
    expect.any(Object),
  );
});
```

- [ ] **Step 2: Update notifyResponse**

The `SessionResponseState` type already includes `cliName?: string` (added in Task 6). In `src/telegram/notifications.ts`, update `notifyResponse` to include the CLI label:

```typescript
  async notifyResponse(state: SessionResponseState): Promise<void> {
    if (!this.bot || !this.chatId) return;
    if (PLAN_APPROVAL_RE.test(state.text)) return;
    this.toolStatus.delete(state.sessionId);

    const cliLabel = state.cliName ?? "";
    const modelPart = state.model ? (cliLabel ? `${cliLabel} ${friendlyModelName(state.model)}` : friendlyModelName(state.model)) : cliLabel;
    const suffix = modelPart ? ` (${modelPart})` : "";
    const text = `\`${state.projectName}${suffix}:\` ${state.text.replace(/:$/m, "")}`;

    // rest unchanged (sendMessage + trackMessage + error handling)
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/telegram/notifications.test.ts -v`
Expected: PASS

Run: `npm test`
Expected: All pass (some existing prefix expectations will need updating — do that inline if any remain).

- [ ] **Step 4: Commit**

```bash
git add src/telegram/notifications.ts src/telegram/notifications.test.ts src/session/monitor.ts
git commit -m "feat: include CLI label in response prefix (claude/codex)"
```

---

### Task 10: /sessions picker uses all adapters

**Files:**
- Modify: `src/telegram/handlers/sessions.ts`

- [ ] **Step 1: Update sendSessionPicker**

In `src/telegram/handlers/sessions.ts`:

Replace the `isClaudePane` filter with adapter-based discovery. Add import:

```typescript
import { adapterForPane } from "../../session/adapters/index.js";
```

Change the pane-filtering block:

```typescript
  const allPanes = await listTmuxPanes();

  type ActiveSession = {
    sessionId: string;
    cwd: string;
    projectName: string;
    lastMessage: string;
    cliName: string;
  };
  const sessions: ActiveSession[] = [];
  const seenCwds = new Set<string>();

  for (const pane of allPanes) {
    if (seenCwds.has(pane.cwd)) continue;
    const adapter = adapterForPane(pane);
    if (!adapter) continue;
    seenCwds.add(pane.cwd);

    const found = await adapter.getLatestSessionFileForCwd(pane.cwd);
    if (!found) continue;

    const projectName = pane.cwd.split("/").pop() || pane.cwd;
    const lines = await readSessionLines(found.filePath).catch(() => []);
    const parsed = parseJsonlLines(lines);

    sessions.push({
      sessionId: found.sessionId,
      cwd: pane.cwd,
      projectName,
      lastMessage: parsed.lastMessage,
      cliName: adapter.name,
    });
  }

  if (sessions.length === 0) {
    await ctx.reply("No active Claude Code or Codex sessions found in tmux.");
    return;
  }
```

Update the displayed lines to include the CLI label:

```typescript
  const lines_out = sessions.map((s) => {
    const preview = s.lastMessage ? `  "${s.lastMessage}"` : "  (no messages yet)";
    return `• ${s.projectName} (${s.cliName})\n${preview}`;
  });
```

Note: `parseJsonlLines` is Claude-specific (it extracts `lastMessage` from Claude's format). For Codex, it will return an empty `lastMessage`. That's acceptable for this first pass — the picker still functions; the preview is just blank for Codex sessions. A future refinement is to ask the adapter for a preview, but out of scope here.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add src/telegram/handlers/sessions.ts
git commit -m "feat: /sessions picker discovers via all adapters"
```

---

### Task 11: Reply-to routing uses adapters

**Files:**
- Modify: `src/telegram/handlers/text.ts`

- [ ] **Step 1: Update the reply-routing fallback**

In `src/telegram/handlers/text.ts`, the fallback block that parses the project name from the replied-to message text currently only looks up Claude Code sessions via `getLatestSessionFileForCwd` + `isClaudePane`.

Replace:

```typescript
    if (!replySession?.cwd) {
      const replyText = ctx.message?.reply_to_message?.text ?? "";
      const match = replyText.match(/^`([^(`]+?)(?:\s*\([^)]*\))?:`/);
      if (match) {
        const projectName = match[1].trim();
        const allPanes = await listTmuxPanes();
        const pane = allPanes.filter(isClaudePane).find(
          (p) => (p.cwd.split("/").pop() || p.cwd) === projectName
        );
        if (pane) {
          const latest = await getLatestSessionFileForCwd(pane.cwd);
          if (latest) {
            replySession = { sessionId: latest.sessionId, cwd: pane.cwd };
          }
        }
      }
    }
```

With:

```typescript
    if (!replySession?.cwd) {
      const replyText = ctx.message?.reply_to_message?.text ?? "";
      const match = replyText.match(/^`([^(`]+?)(?:\s*\([^)]*\))?:`/);
      if (match) {
        const projectName = match[1].trim();
        const allPanes = await listTmuxPanes();
        for (const pane of allPanes) {
          if ((pane.cwd.split("/").pop() || pane.cwd) !== projectName) continue;
          const adapter = adapterForPane(pane);
          if (!adapter) continue;
          const latest = await adapter.getLatestSessionFileForCwd(pane.cwd);
          if (latest) {
            replySession = { sessionId: latest.sessionId, cwd: pane.cwd };
            break;
          }
        }
      }
    }
```

Add import:

```typescript
import { adapterForPane } from "../../session/adapters/index.js";
```

Remove unused imports from the old path (`isClaudePane` if it becomes unused, `getLatestSessionFileForCwd` if unused).

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add src/telegram/handlers/text.ts
git commit -m "feat: reply-to routing discovers session via adapters"
```

---

### Task 12: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All pass (or only the known pre-existing flaky tests fail).

- [ ] **Step 2: Verify the bot starts cleanly**

Run: `timeout 5 npx tsx src/index.ts 2>&1 || true`
Expected: "codedove bot running" appears, no errors.

- [ ] **Step 3: Manual smoke test outline (for the human)**

After restart, open a tmux pane, run `codex` in a directory with a test script, send a `/sessions` command in Telegram, and confirm:
1. The codex session appears in the picker with `(codex)` label
2. Messages from the codex session are forwarded with `(codex gpt-5.4)` prefix
3. Bash commands run by codex show up in the tool-use status message
4. Replying to a codex message routes input back to that session

- [ ] **Step 4: If any remaining unstaged changes, commit**
