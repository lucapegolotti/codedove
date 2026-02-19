# Agent Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor claude-voice into a layered agent-based system with multi-class intent detection, JSONL session monitoring, tmux input injection, and proactive Telegram notifications.

**Architecture:** `telegram/bot.ts` delegates all logic to `agent/loop.ts`, which classifies intent with haiku and routes to `session/adapter.ts` (SDK query), `session/tmux.ts` (inject into terminal), or `agent/summarizer.ts`. A separate `session/monitor.ts` watches JSONL files and triggers proactive notifications via `telegram/notifications.ts`.

**Tech Stack:** TypeScript, grammy, @anthropic-ai/claude-agent-sdk, @anthropic-ai/sdk (haiku), openai (Whisper/TTS), chokidar (file watching), vitest (tests), tsx (runtime)

**Design doc:** `docs/plans/2026-02-19-agent-refactor-design.md`

**DO NOT TOUCH:** `src/tui.tsx`, `src/tui/` (all TUI components), `src/voice.ts`, `src/narrator.ts`, `src/logger.ts` — these are unchanged.

---

### Task 1: Scaffold directories + test runner

**Files:**
- Modify: `package.json`
- Create: `src/agent/` (dir)
- Create: `src/session/` (dir)
- Create: `src/telegram/` (dir)
- Create: `vitest.config.ts`

**Step 1: Add chokidar and vitest**

Run: `npm install chokidar && npm install --save-dev vitest @vitest/coverage-v8`
Expected: installs cleanly, no peer dep errors

**Step 2: Add test script to package.json**

In `package.json`, add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

**Step 4: Create directory structure**

Run: `mkdir -p src/agent src/session src/telegram`
Expected: three empty dirs created

**Step 5: Verify test runner works**

Run: `npm test`
Expected: "No test files found" or similar — exits 0

**Step 6: Commit**

```bash
git add package.json vitest.config.ts src/agent/.gitkeep src/session/.gitkeep src/telegram/.gitkeep
git commit -m "chore: scaffold agent/session/telegram dirs + vitest"
```

---

### Task 2: session/history.ts — JSONL reader

**Files:**
- Create: `src/session/history.ts`
- Create: `src/session/history.test.ts`

This is a pure extraction from `src/sessions.ts`. It reads JSONL files to build session metadata and history. No API calls — pure file I/O and parsing.

**Step 1: Write the failing tests**

Create `src/session/history.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseJsonlLines, extractWaitingPrompt } from "./history.js";

const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  cwd: "/Users/luca/repositories/my-app",
  message: {
    content: [{ type: "text", text: "I've updated the migration file. Should I delete the old one? (y/n)" }],
  },
});

const TOOL_LINE = JSON.stringify({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Bash", input: { command: "npm install" } }],
  },
});

describe("parseJsonlLines", () => {
  it("extracts cwd from first assistant line", () => {
    const result = parseJsonlLines([ASSISTANT_LINE]);
    expect(result.cwd).toBe("/Users/luca/repositories/my-app");
  });

  it("extracts last text message", () => {
    const result = parseJsonlLines([ASSISTANT_LINE]);
    expect(result.lastMessage).toContain("updated the migration file");
  });

  it("skips malformed lines", () => {
    const result = parseJsonlLines(["not json", ASSISTANT_LINE]);
    expect(result.cwd).toBe("/Users/luca/repositories/my-app");
  });

  it("records tool calls", () => {
    const result = parseJsonlLines([TOOL_LINE]);
    expect(result.toolCalls).toContainEqual({ name: "Bash", input: { command: "npm install" } });
  });
});

describe("extractWaitingPrompt", () => {
  it("detects y/n prompt", () => {
    expect(extractWaitingPrompt("Should I delete it? (y/n)")).toBe("Should I delete it? (y/n)");
  });

  it("detects press enter", () => {
    expect(extractWaitingPrompt("Press enter to continue")).toBe("Press enter to continue");
  });

  it("detects trailing question mark", () => {
    expect(extractWaitingPrompt("Do you want me to proceed?")).toBe("Do you want me to proceed?");
  });

  it("returns null for non-waiting text", () => {
    expect(extractWaitingPrompt("I have updated the file.")).toBeNull();
  });

  it("returns null for short non-prompts", () => {
    expect(extractWaitingPrompt("Done.")).toBeNull();
  });
});
```

**Step 2: Run tests — verify they fail**

Run: `npm test -- src/session/history.test.ts`
Expected: FAIL — "Cannot find module './history.js'"

**Step 3: Create src/session/history.ts**

```typescript
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { readdir, stat } from "fs/promises";
import { homedir } from "os";

export const PROJECTS_PATH = `${homedir()}/.claude/projects`;
export const ATTACHED_SESSION_PATH = `${homedir()}/.claude-voice/attached`;

export type SessionInfo = {
  sessionId: string;
  cwd: string;
  projectName: string;
  lastMessage: string;
  mtime: Date;
};

export type ToolCall = {
  name: string;
  input: Record<string, unknown>;
};

export type ParsedSession = {
  cwd: string;
  lastMessage: string;
  toolCalls: ToolCall[];
  allMessages: string[];
};

// Waiting patterns — exported so monitor.ts can import them
const WAITING_PATTERNS = [
  /press\s+enter/i,
  /\(y\/n\)/i,
  /\[y\/N\]/i,
  /confirm\?/i,
  /provide\s+(your\s+)?input/i,
  /waiting\s+for\s+(user\s+)?input/i,
];

export function extractWaitingPrompt(text: string): string | null {
  const trimmed = text.trim();
  const endsWithQuestion = /\?\s*$/.test(trimmed);
  const endsWithPrompt = /[>:]\s*$/.test(trimmed);
  const matchesPattern = WAITING_PATTERNS.some((p) => p.test(trimmed));

  if (matchesPattern || endsWithQuestion || endsWithPrompt) {
    return trimmed;
  }
  return null;
}

export function parseJsonlLines(lines: string[]): ParsedSession {
  let cwd = homedir();
  let lastMessage = "";
  const toolCalls: ToolCall[] = [];
  const allMessages: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "assistant") {
        if (entry.cwd && cwd === homedir()) cwd = entry.cwd;
        const content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> =
          entry.message?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text) {
            lastMessage = block.text.slice(0, 200).replace(/\n/g, " ");
            allMessages.push(block.text);
          }
          if (block.type === "tool_use" && block.name) {
            toolCalls.push({ name: block.name, input: block.input ?? {} });
          }
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  return { cwd, lastMessage, toolCalls, allMessages };
}

export async function readSessionLines(filePath: string): Promise<string[]> {
  const lines: string[] = [];
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lines.push(line);
    }
  } finally {
    rl.close();
  }
  return lines;
}

export async function listSessions(limit = 5): Promise<SessionInfo[]> {
  const results: SessionInfo[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(PROJECTS_PATH);
  } catch {
    return [];
  }

  for (const dir of projectDirs) {
    const dirPath = `${PROJECTS_PATH}/${dir}`;
    let files: string[];
    try {
      files = (await readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      const filePath = `${dirPath}/${file}`;

      let mtime: Date;
      try {
        mtime = (await stat(filePath)).mtime;
      } catch {
        continue;
      }

      const encoded = dir.replace(/^-/, "").replace(/-/g, "/");
      const projectName = encoded.split("/").pop() || dir;

      const lines = await readSessionLines(filePath).catch(() => []);
      const parsed = parseJsonlLines(lines);

      results.push({
        sessionId,
        cwd: parsed.cwd,
        projectName,
        lastMessage: parsed.lastMessage,
        mtime,
      });
    }
  }

  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results.slice(0, limit);
}

export async function getAttachedSession(): Promise<{ sessionId: string; cwd: string } | null> {
  try {
    const { readFile } = await import("fs/promises");
    const content = await readFile(ATTACHED_SESSION_PATH, "utf8");
    const [sessionId, cwd] = content.trim().split("\n");
    if (!sessionId) return null;
    return { sessionId, cwd: cwd || homedir() };
  } catch {
    return null;
  }
}

export async function getSessionFilePath(sessionId: string): Promise<string | null> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(PROJECTS_PATH);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = `${PROJECTS_PATH}/${dir}/${sessionId}.jsonl`;
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
```

**Step 4: Run tests — verify they pass**

Run: `npm test -- src/session/history.test.ts`
Expected: all 9 tests PASS

**Step 5: Commit**

```bash
git add src/session/history.ts src/session/history.test.ts
git commit -m "feat: add session/history.ts with JSONL parsing and waiting detection"
```

---

### Task 3: agent/classifier.ts — multi-class intent detection

**Files:**
- Create: `src/agent/classifier.ts`
- Create: `src/agent/classifier.test.ts`

**Step 1: Write the failing tests**

Create `src/agent/classifier.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseIntentResponse, Intent } from "./classifier.js";

describe("parseIntentResponse", () => {
  it("parses SUMMARY_REQUEST", () => {
    expect(parseIntentResponse("SUMMARY_REQUEST")).toBe(Intent.SUMMARY_REQUEST);
  });

  it("parses COMMAND_EXECUTION", () => {
    expect(parseIntentResponse("COMMAND_EXECUTION")).toBe(Intent.COMMAND_EXECUTION);
  });

  it("parses FOLLOW_UP_INPUT", () => {
    expect(parseIntentResponse("FOLLOW_UP_INPUT")).toBe(Intent.FOLLOW_UP_INPUT);
  });

  it("parses GENERAL_CHAT", () => {
    expect(parseIntentResponse("GENERAL_CHAT")).toBe(Intent.GENERAL_CHAT);
  });

  it("parses SESSION_LIST", () => {
    expect(parseIntentResponse("SESSION_LIST")).toBe(Intent.SESSION_LIST);
  });

  it("falls back to UNKNOWN for unrecognized text", () => {
    expect(parseIntentResponse("something random")).toBe(Intent.UNKNOWN);
  });

  it("is case-insensitive", () => {
    expect(parseIntentResponse("summary_request")).toBe(Intent.SUMMARY_REQUEST);
  });

  it("ignores surrounding whitespace", () => {
    expect(parseIntentResponse("  GENERAL_CHAT  ")).toBe(Intent.GENERAL_CHAT);
  });
});
```

**Step 2: Run tests — verify they fail**

Run: `npm test -- src/agent/classifier.test.ts`
Expected: FAIL — "Cannot find module './classifier.js'"

**Step 3: Create src/agent/classifier.ts**

```typescript
import Anthropic from "@anthropic-ai/sdk";

export enum Intent {
  SUMMARY_REQUEST = "SUMMARY_REQUEST",
  COMMAND_EXECUTION = "COMMAND_EXECUTION",
  FOLLOW_UP_INPUT = "FOLLOW_UP_INPUT",
  GENERAL_CHAT = "GENERAL_CHAT",
  SESSION_LIST = "SESSION_LIST",
  UNKNOWN = "UNKNOWN",
}

let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  return (anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
}

const SYSTEM = `Classify the user message into exactly one of these intents. Respond with the intent name only, no punctuation, no explanation.

SUMMARY_REQUEST — asking what Claude is doing, what happened, summarize session, current status
COMMAND_EXECUTION — asking Claude to do something: run code, edit files, install deps, fix bugs
FOLLOW_UP_INPUT — a short reply to a pending prompt (y, n, yes, no, ok, continue, a number, a filename)
GENERAL_CHAT — greeting, thanks, off-topic, small talk
SESSION_LIST — asking to list, pick, switch, or attach to a Claude Code session
UNKNOWN — anything else`;

export function parseIntentResponse(raw: string): Intent {
  const normalized = raw.trim().toUpperCase();
  const valid = Object.values(Intent) as string[];
  if (valid.includes(normalized)) return normalized as Intent;
  return Intent.UNKNOWN;
}

export async function classifyIntent(
  userMessage: string,
  lastBotMessage?: string
): Promise<Intent> {
  const context = lastBotMessage
    ? `Previous bot message: "${lastBotMessage}"\n\nUser message: "${userMessage}"`
    : `User message: "${userMessage}"`;

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system: SYSTEM,
      messages: [{ role: "user", content: context }],
    });
    const block = response.content[0];
    if (block.type !== "text") return Intent.UNKNOWN;
    return parseIntentResponse(block.text);
  } catch {
    return Intent.UNKNOWN;
  }
}
```

**Step 4: Run tests — verify they pass**

Run: `npm test -- src/agent/classifier.test.ts`
Expected: all 8 tests PASS

**Step 5: Commit**

```bash
git add src/agent/classifier.ts src/agent/classifier.test.ts
git commit -m "feat: add agent/classifier.ts with 6-class intent detection"
```

---

### Task 4: session/adapter.ts — Claude Agent SDK wrapper

**Files:**
- Create: `src/session/adapter.ts`

This is a clean extraction of `runAgentTurn()` from `src/sessions.ts`. No new logic — just moved and cleaned up.

**Step 1: Create src/session/adapter.ts**

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { narrate } from "../narrator.js";
import { log, logEmitter } from "../logger.js";
import { getAttachedSession } from "./history.js";
import { homedir } from "os";

const sessions = new Map<number, string>();

const SYSTEM_PROMPT = `You are a coding assistant accessed via Telegram.
When the user mentions a project by name, look for it in ${homedir()}/repositories/.
If the project directory is ambiguous, ask the user to clarify.
Keep responses concise.`;

export function getActiveSessions(): number[] {
  return [...sessions.keys()];
}

export async function runAgentTurn(chatId: number, userMessage: string): Promise<string> {
  const attached = await getAttachedSession();
  const existingSessionId = attached?.sessionId ?? sessions.get(chatId);

  if (attached) {
    log({ chatId, message: `joining attached session ${attached.sessionId.slice(0, 8)}... (${attached.cwd})` });
  } else if (existingSessionId) {
    log({ chatId, message: `resuming session ${existingSessionId.slice(0, 8)}...` });
  } else {
    log({ chatId, message: "starting new session" });
  }

  let result = "";
  let capturedSessionId: string | undefined;

  for await (const message of query({
    prompt: userMessage,
    options: attached
      ? { resume: attached.sessionId, cwd: attached.cwd }
      : {
          allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
          permissionMode: "acceptEdits",
          cwd: homedir(),
          ...(existingSessionId
            ? { resume: existingSessionId }
            : { systemPrompt: SYSTEM_PROMPT }),
        },
  })) {
    if (message.type === "system" && message.subtype === "init" && !attached) {
      capturedSessionId = message.session_id;
    }
    if (message.type === "result" && message.subtype === "success") {
      result = message.result;
    }
    if (message.type === "result" && message.subtype !== "success") {
      const detail = "error_message" in message ? `: ${message.error_message}` : "";
      throw new Error(`Agent error (${message.subtype}${detail})`);
    }
  }

  if (capturedSessionId && !attached) {
    sessions.set(chatId, capturedSessionId);
    log({ chatId, message: "session established" });
    logEmitter.emit("session");
  }

  const raw = result || "The agent completed the task but produced no output.";
  if (/\braw\b/i.test(userMessage)) return raw;
  return narrate(raw, userMessage);
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/session/adapter.ts
git commit -m "feat: add session/adapter.ts (extracted from sessions.ts)"
```

---

### Task 5: session/tmux.ts — tmux injection

**Files:**
- Create: `src/session/tmux.ts`
- Create: `src/session/tmux.test.ts`

**Step 1: Write the failing tests**

Create `src/session/tmux.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { findBestPane, type TmuxPane } from "./tmux.js";

const panes: TmuxPane[] = [
  { paneId: "%1", command: "node", cwd: "/Users/luca/repositories/my-app" },
  { paneId: "%2", command: "claude", cwd: "/Users/luca/repositories/my-app" },
  { paneId: "%3", command: "claude", cwd: "/Users/luca/repositories/other-app" },
  { paneId: "%4", command: "bash", cwd: "/Users/luca/repositories/my-app" },
];

describe("findBestPane", () => {
  it("returns pane running claude in matching cwd", () => {
    const result = findBestPane(panes, "/Users/luca/repositories/my-app");
    expect(result?.paneId).toBe("%2");
  });

  it("returns null when no claude pane matches cwd", () => {
    const result = findBestPane(panes, "/Users/luca/repositories/nonexistent");
    expect(result).toBeNull();
  });

  it("returns null when no claude panes exist", () => {
    const noClaude = panes.filter((p) => p.command !== "claude");
    const result = findBestPane(noClaude, "/Users/luca/repositories/my-app");
    expect(result).toBeNull();
  });

  it("returns first claude pane when multiple match cwd", () => {
    const dupe: TmuxPane[] = [
      { paneId: "%2", command: "claude", cwd: "/Users/luca/repositories/my-app" },
      { paneId: "%5", command: "claude", cwd: "/Users/luca/repositories/my-app" },
    ];
    const result = findBestPane(dupe, "/Users/luca/repositories/my-app");
    expect(result?.paneId).toBe("%2");
  });

  it("falls back to parent directory match", () => {
    const result = findBestPane(panes, "/Users/luca/repositories/my-app/subdir");
    expect(result?.paneId).toBe("%2");
  });
});
```

**Step 2: Run tests — verify they fail**

Run: `npm test -- src/session/tmux.test.ts`
Expected: FAIL — "Cannot find module './tmux.js'"

**Step 3: Create src/session/tmux.ts**

```typescript
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export type TmuxPane = {
  paneId: string;
  command: string;
  cwd: string;
};

export type TmuxResult =
  | { found: true; paneId: string }
  | { found: false; reason: "no_tmux" | "no_claude_pane" | "ambiguous"; panes?: TmuxPane[] };

export function findBestPane(panes: TmuxPane[], targetCwd: string): TmuxPane | null {
  const claudePanes = panes.filter((p) => p.command.includes("claude"));
  if (claudePanes.length === 0) return null;

  // Exact match first
  const exact = claudePanes.find((p) => p.cwd === targetCwd);
  if (exact) return exact;

  // Parent directory match (e.g. cwd is a subdir of the pane's path)
  const parent = claudePanes.find((p) => targetCwd.startsWith(p.cwd + "/"));
  if (parent) return parent;

  return null;
}

export async function listTmuxPanes(): Promise<TmuxPane[]> {
  try {
    const { stdout } = await execAsync(
      "tmux list-panes -a -F '#{pane_id} #{pane_current_command} #{pane_current_path}'"
    );
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(" ");
        const paneId = parts[0];
        const command = parts[1];
        const cwd = parts.slice(2).join(" "); // handle spaces in paths
        return { paneId, command, cwd };
      });
  } catch {
    return [];
  }
}

export async function findClaudePane(targetCwd: string): Promise<TmuxResult> {
  let panes: TmuxPane[];
  try {
    panes = await listTmuxPanes();
  } catch {
    return { found: false, reason: "no_tmux" };
  }

  if (panes.length === 0) return { found: false, reason: "no_tmux" };

  const best = findBestPane(panes, targetCwd);
  if (best) return { found: true, paneId: best.paneId };

  const claudePanes = panes.filter((p) => p.command.includes("claude"));
  if (claudePanes.length === 0) return { found: false, reason: "no_claude_pane" };
  if (claudePanes.length > 1) return { found: false, reason: "ambiguous", panes: claudePanes };

  // One claude pane exists but cwd doesn't match — use it anyway
  return { found: true, paneId: claudePanes[0].paneId };
}

export async function sendKeysToPane(paneId: string, input: string): Promise<void> {
  // Escape single quotes in input for shell safety
  const safe = input.replace(/'/g, "'\\''");
  await execAsync(`tmux send-keys -t '${paneId}' '${safe}' Enter`);
}

export async function injectInput(targetCwd: string, input: string): Promise<TmuxResult> {
  const result = await findClaudePane(targetCwd);
  if (result.found) {
    await sendKeysToPane(result.paneId, input);
  }
  return result;
}
```

**Step 4: Run tests — verify they pass**

Run: `npm test -- src/session/tmux.test.ts`
Expected: all 5 tests PASS

**Step 5: Commit**

```bash
git add src/session/tmux.ts src/session/tmux.test.ts
git commit -m "feat: add session/tmux.ts with pane detection and send-keys injection"
```

---

### Task 6: session/monitor.ts — JSONL file watcher

**Files:**
- Create: `src/session/monitor.ts`
- Create: `src/session/monitor.test.ts`

**Step 1: Write the failing tests**

Create `src/session/monitor.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { classifyWaitingType, WaitingType } from "./monitor.js";

describe("classifyWaitingType", () => {
  it("detects y/n prompt", () => {
    expect(classifyWaitingType("Should I delete the file? (y/n)")).toBe(WaitingType.YES_NO);
  });

  it("detects [y/N] variant", () => {
    expect(classifyWaitingType("Overwrite existing file? [y/N]")).toBe(WaitingType.YES_NO);
  });

  it("detects press enter", () => {
    expect(classifyWaitingType("Press enter to continue")).toBe(WaitingType.ENTER);
  });

  it("detects question prompt", () => {
    expect(classifyWaitingType("What should I name the new file?")).toBe(WaitingType.QUESTION);
  });

  it("returns null for completed statement", () => {
    expect(classifyWaitingType("I have updated the migration file.")).toBeNull();
  });

  it("returns null for short non-prompts", () => {
    expect(classifyWaitingType("Done.")).toBeNull();
  });

  it("detects confirm prompt", () => {
    expect(classifyWaitingType("Are you sure you want to proceed? Confirm?")).toBe(WaitingType.YES_NO);
  });
});
```

**Step 2: Run tests — verify they fail**

Run: `npm test -- src/session/monitor.test.ts`
Expected: FAIL — "Cannot find module './monitor.js'"

**Step 3: Create src/session/monitor.ts**

```typescript
import chokidar from "chokidar";
import { readFile } from "fs/promises";
import { readdir } from "fs/promises";
import { PROJECTS_PATH } from "./history.js";
import { log } from "../logger.js";

export enum WaitingType {
  YES_NO = "YES_NO",
  ENTER = "ENTER",
  QUESTION = "QUESTION",
}

export type SessionWaitingState = {
  sessionId: string;
  projectName: string;
  cwd: string;
  filePath: string;
  waitingType: WaitingType;
  prompt: string;
};

export type WaitingCallback = (state: SessionWaitingState) => Promise<void>;

const YES_NO_PATTERNS = [/\(y\/n\)/i, /\[y\/N\]/i, /confirm\?/i];
const ENTER_PATTERNS = [/press\s+enter/i, /hit\s+enter/i];

export function classifyWaitingType(text: string): WaitingType | null {
  const trimmed = text.trim();

  if (YES_NO_PATTERNS.some((p) => p.test(trimmed))) return WaitingType.YES_NO;
  if (ENTER_PATTERNS.some((p) => p.test(trimmed))) return WaitingType.ENTER;
  if (/\?\s*$/.test(trimmed) && trimmed.length > 10) return WaitingType.QUESTION;

  return null;
}

function decodeProjectName(dir: string): string {
  const encoded = dir.replace(/^-/, "").replace(/-/g, "/");
  return encoded.split("/").pop() || dir;
}

async function getLastAssistantText(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);

    // Read from the end to find the last assistant text block
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type !== "assistant") continue;
        const textBlocks = (entry.message?.content ?? []).filter(
          (c: { type: string }) => c.type === "text"
        );
        if (textBlocks.length > 0) {
          return textBlocks[textBlocks.length - 1].text;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // file unreadable
  }
  return null;
}

function sessionIdFromPath(filePath: string): { sessionId: string; projectDir: string } {
  const parts = filePath.split("/");
  const filename = parts[parts.length - 1];
  const projectDir = parts[parts.length - 2];
  return { sessionId: filename.replace(".jsonl", ""), projectDir };
}

// Debounce: wait N ms of silence before treating file as "stopped updating"
const DEBOUNCE_MS = 3000;

export function startMonitor(onWaiting: WaitingCallback): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const watcher = chokidar.watch(`${PROJECTS_PATH}/**/*.jsonl`, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: false,
  });

  watcher.on("change", (filePath: string) => {
    // Clear existing timer for this file (debounce)
    const existing = timers.get(filePath);
    if (existing) clearTimeout(existing);

    // Set new timer: check for waiting state after silence
    const timer = setTimeout(async () => {
      timers.delete(filePath);

      const lastText = await getLastAssistantText(filePath);
      if (!lastText) return;

      const waitingType = classifyWaitingType(lastText);
      if (!waitingType) return;

      const { sessionId, projectDir } = sessionIdFromPath(filePath);
      const projectName = decodeProjectName(projectDir);

      // Get cwd from the session file
      let cwd = "";
      try {
        const content = await readFile(filePath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === "assistant" && entry.cwd) {
              cwd = entry.cwd;
              break;
            }
          } catch {
            continue;
          }
        }
      } catch {
        // ignore
      }

      log({ message: `session ${sessionId.slice(0, 8)} waiting (${waitingType}): ${lastText.slice(0, 80)}` });

      await onWaiting({ sessionId, projectName, cwd, filePath, waitingType, prompt: lastText }).catch(
        (err) => log({ message: `notification error: ${err instanceof Error ? err.message : String(err)}` })
      );
    }, DEBOUNCE_MS);

    timers.set(filePath, timer);
  });

  watcher.on("error", (err: unknown) => {
    log({ message: `monitor error: ${err instanceof Error ? err.message : String(err)}` });
  });

  return () => {
    watcher.close();
    for (const t of timers.values()) clearTimeout(t);
  };
}
```

**Step 4: Run tests — verify they pass**

Run: `npm test -- src/session/monitor.test.ts`
Expected: all 7 tests PASS

**Step 5: Compile check**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 6: Commit**

```bash
git add src/session/monitor.ts src/session/monitor.test.ts
git commit -m "feat: add session/monitor.ts with chokidar JSONL watcher and waiting detection"
```

---

### Task 7: agent/summarizer.ts — session summarization

**Files:**
- Create: `src/agent/summarizer.ts`

**Step 1: Create src/agent/summarizer.ts**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { getAttachedSession, getSessionFilePath, readSessionLines, parseJsonlLines } from "../session/history.js";
import { log } from "../logger.js";

let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  return (anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
}

const SYSTEM = `Summarize the current state of a Claude Code coding session.

Be concise and actionable. Cover:
- What task is currently being worked on
- What actions were taken recently (files edited, commands run)
- Any errors encountered
- Whether there is a pending prompt waiting for input
- What would logically come next

Plain text only. No markdown, no bullet points, no headers. 3-6 sentences maximum.`;

export async function summarizeSession(sessionId?: string): Promise<string> {
  const attached = await getAttachedSession();
  const targetId = sessionId ?? attached?.sessionId;

  if (!targetId) {
    return "No session is currently attached. Use /sessions to pick one.";
  }

  const filePath = await getSessionFilePath(targetId);
  if (!filePath) {
    return "Could not find the session file. The session may have been cleared.";
  }

  const allLines = await readSessionLines(filePath);
  // Use last 60 lines to keep context window small
  const recentLines = allLines.slice(-60);
  const parsed = parseJsonlLines(recentLines);

  if (parsed.allMessages.length === 0 && parsed.toolCalls.length === 0) {
    return "The session exists but has no readable history yet.";
  }

  const toolSummary = parsed.toolCalls
    .slice(-10)
    .map((t) => `${t.name}(${JSON.stringify(t.input).slice(0, 60)})`)
    .join(", ");

  const context = [
    parsed.allMessages.length > 0
      ? `Recent assistant messages:\n${parsed.allMessages.slice(-5).join("\n\n")}`
      : "",
    toolSummary ? `Recent tool calls: ${toolSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: SYSTEM,
      messages: [{ role: "user", content: context }],
    });
    const block = response.content[0];
    if (block.type !== "text") throw new Error("Unexpected summarizer response");
    return block.text;
  } catch (err) {
    log({ message: `summarizer error: ${err instanceof Error ? err.message : String(err)}` });
    return `Last message: ${parsed.lastMessage || "(none)"}`;
  }
}
```

**Step 2: Compile check**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/agent/summarizer.ts
git commit -m "feat: add agent/summarizer.ts for session summarization"
```

---

### Task 8: telegram/notifications.ts — proactive alerts

**Files:**
- Create: `src/telegram/notifications.ts`

**Step 1: Create src/telegram/notifications.ts**

```typescript
import { Bot, InlineKeyboard } from "grammy";
import { WaitingType, type SessionWaitingState } from "../session/monitor.js";
import { log } from "../logger.js";

let registeredBot: Bot | null = null;
let registeredChatId: number | null = null;

export function registerForNotifications(bot: Bot, chatId: number): void {
  registeredBot = bot;
  registeredChatId = chatId;
}

function buildWaitingKeyboard(waitingType: WaitingType): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (waitingType === WaitingType.YES_NO) {
    kb.text("Yes", "waiting:yes").text("No", "waiting:no").row();
  } else if (waitingType === WaitingType.ENTER) {
    kb.text("Continue ↩", "waiting:enter").row();
  }
  kb.text("Send custom input", "waiting:custom").text("Ignore", "waiting:ignore");
  return kb;
}

export async function notifyWaiting(state: SessionWaitingState): Promise<void> {
  if (!registeredBot || !registeredChatId) return;

  const prompt = state.prompt.slice(0, 200);
  const text = `⚠️ Claude is waiting in \`${state.projectName}\`:\n\n_"${prompt}"_`;
  const keyboard = buildWaitingKeyboard(state.waitingType);

  try {
    await registeredBot.api.sendMessage(registeredChatId, text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    log({ chatId: registeredChatId, message: `notified: ${state.projectName} waiting (${state.waitingType})` });
  } catch (err) {
    log({ message: `failed to send waiting notification: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// Maps waiting:yes/no/enter to the actual text to inject
export function resolveWaitingAction(callbackData: string): string | null {
  const map: Record<string, string> = {
    "waiting:yes": "y",
    "waiting:no": "n",
    "waiting:enter": "",
  };
  return callbackData in map ? map[callbackData] : null;
}
```

**Step 2: Compile check**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/telegram/notifications.ts
git commit -m "feat: add telegram/notifications.ts for proactive waiting alerts"
```

---

### Task 9: agent/loop.ts — decision brain

**Files:**
- Create: `src/agent/loop.ts`
- Create: `src/agent/loop.test.ts`

**Step 1: Write the failing tests**

Create `src/agent/loop.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Intent } from "./classifier.js";

// Mock all dependencies before importing loop
vi.mock("./classifier.js", () => ({
  Intent: {
    SUMMARY_REQUEST: "SUMMARY_REQUEST",
    COMMAND_EXECUTION: "COMMAND_EXECUTION",
    FOLLOW_UP_INPUT: "FOLLOW_UP_INPUT",
    GENERAL_CHAT: "GENERAL_CHAT",
    SESSION_LIST: "SESSION_LIST",
    UNKNOWN: "UNKNOWN",
  },
  classifyIntent: vi.fn(),
}));
vi.mock("./summarizer.js", () => ({ summarizeSession: vi.fn() }));
vi.mock("../session/adapter.js", () => ({ runAgentTurn: vi.fn() }));
vi.mock("../session/tmux.js", () => ({ injectInput: vi.fn() }));
vi.mock("../logger.js", () => ({ log: vi.fn() }));

import { classifyIntent } from "./classifier.js";
import { summarizeSession } from "./summarizer.js";
import { runAgentTurn } from "../session/adapter.js";
import { injectInput } from "../session/tmux.js";
import { handleTurn } from "./loop.js";

beforeEach(() => vi.clearAllMocks());

describe("handleTurn", () => {
  it("calls summarizer for SUMMARY_REQUEST", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.SUMMARY_REQUEST);
    vi.mocked(summarizeSession).mockResolvedValue("Claude is refactoring sessions.ts");

    const result = await handleTurn(123, "what's happening?");
    expect(summarizeSession).toHaveBeenCalled();
    expect(result).toBe("Claude is refactoring sessions.ts");
  });

  it("calls runAgentTurn for COMMAND_EXECUTION", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.COMMAND_EXECUTION);
    vi.mocked(runAgentTurn).mockResolvedValue("Installed 3 packages.");

    const result = await handleTurn(123, "install deps");
    expect(runAgentTurn).toHaveBeenCalledWith(123, "install deps");
    expect(result).toBe("Installed 3 packages.");
  });

  it("injects via tmux for FOLLOW_UP_INPUT when cwd is known", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.FOLLOW_UP_INPUT);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%2" });

    const result = await handleTurn(123, "y", undefined, "/Users/luca/repos/app");
    expect(injectInput).toHaveBeenCalledWith("/Users/luca/repos/app", "y");
    expect(result).toContain("Sent");
  });

  it("falls back to runAgentTurn for FOLLOW_UP_INPUT when no cwd", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.FOLLOW_UP_INPUT);
    vi.mocked(runAgentTurn).mockResolvedValue("ok");

    const result = await handleTurn(123, "y");
    expect(runAgentTurn).toHaveBeenCalledWith(123, "y");
  });

  it("returns a chat reply for GENERAL_CHAT without calling agent", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.GENERAL_CHAT);

    const result = await handleTurn(123, "thanks!");
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(result.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run tests — verify they fail**

Run: `npm test -- src/agent/loop.test.ts`
Expected: FAIL — "Cannot find module './loop.js'"

**Step 3: Create src/agent/loop.ts**

```typescript
import { classifyIntent, Intent } from "./classifier.js";
import { summarizeSession } from "./summarizer.js";
import { runAgentTurn } from "../session/adapter.js";
import { injectInput } from "../session/tmux.js";
import { log } from "../logger.js";

// Per-chat state: tracks last bot message for FOLLOW_UP_INPUT context
const chatState = new Map<number, { lastBotMessage: string; lastCwd?: string }>();

export function updateChatState(chatId: number, lastBotMessage: string, cwd?: string): void {
  chatState.set(chatId, { lastBotMessage, lastCwd: cwd });
}

export async function handleTurn(
  chatId: number,
  userMessage: string,
  lastBotMessage?: string,
  knownCwd?: string
): Promise<string> {
  const state = chatState.get(chatId);
  const contextMessage = lastBotMessage ?? state?.lastBotMessage;
  const cwd = knownCwd ?? state?.lastCwd;

  const intent = await classifyIntent(userMessage, contextMessage);
  log({ chatId, message: `intent: ${intent}` });

  let reply: string;

  switch (intent) {
    case Intent.SUMMARY_REQUEST: {
      reply = await summarizeSession();
      break;
    }

    case Intent.FOLLOW_UP_INPUT: {
      if (cwd) {
        const result = await injectInput(cwd, userMessage);
        if (result.found) {
          reply = `Sent to Claude. I'll let you know when it responds.`;
        } else if (result.reason === "ambiguous") {
          reply = `Multiple Claude sessions found. Please use /sessions to attach to the right one first.`;
        } else {
          // No tmux pane found — fall back to agent turn
          reply = await runAgentTurn(chatId, userMessage);
        }
      } else {
        reply = await runAgentTurn(chatId, userMessage);
      }
      break;
    }

    case Intent.GENERAL_CHAT: {
      reply = "Got it! Send me a command or ask what Claude is up to.";
      break;
    }

    case Intent.SESSION_LIST: {
      // Signal to bot.ts to show the session picker
      reply = "__SESSION_PICKER__";
      break;
    }

    case Intent.COMMAND_EXECUTION:
    case Intent.UNKNOWN:
    default: {
      reply = await runAgentTurn(chatId, userMessage);
      break;
    }
  }

  chatState.set(chatId, { lastBotMessage: reply, lastCwd: cwd });
  return reply;
}
```

**Step 4: Run tests — verify they pass**

Run: `npm test -- src/agent/loop.test.ts`
Expected: all 5 tests PASS

**Step 5: Full test suite**

Run: `npm test`
Expected: all tests pass across all files

**Step 6: Commit**

```bash
git add src/agent/loop.ts src/agent/loop.test.ts
git commit -m "feat: add agent/loop.ts — intent-based decision router"
```

---

### Task 10: telegram/bot.ts — simplified bot + notification wiring

**Files:**
- Create: `src/telegram/bot.ts`

This replaces `src/bot.ts`. Key changes:
- Delegates all message logic to `handleTurn()` from `loop.ts`
- Handles `__SESSION_PICKER__` sentinel from loop
- Handles `waiting:*` callback queries (from notifications)
- Registers with `notifications.ts`

**Step 1: Create src/telegram/bot.ts**

```typescript
import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import { handleTurn, updateChatState } from "../agent/loop.js";
import { transcribeAudio, synthesizeSpeech } from "../voice.js";
import { log } from "../logger.js";
import { listSessions, ATTACHED_SESSION_PATH } from "../session/history.js";
import { registerForNotifications, resolveWaitingAction } from "./notifications.js";
import { injectInput } from "../session/tmux.js";
import { getAttachedSession } from "../session/history.js";
import { writeFile, mkdir } from "fs/promises";
import { homedir } from "os";

const pendingSessions = new Map<string, { sessionId: string; cwd: string; projectName: string }>();

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds <= 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

async function sendSessionPicker(ctx: Context): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    await ctx.reply("No sessions found.");
    return;
  }

  const keyboard = new InlineKeyboard();
  pendingSessions.clear();
  for (const s of sessions) {
    pendingSessions.set(s.sessionId, s);
    keyboard.text(`${s.projectName} · ${timeAgo(s.mtime)}`, `session:${s.sessionId}`).row();
  }

  const lines = sessions.map((s) => {
    const preview = s.lastMessage ? `  "${s.lastMessage}"` : "  (no messages)";
    return `• ${s.projectName} · ${timeAgo(s.mtime)}\n${preview}`;
  });

  await ctx.reply(`Available sessions:\n\n${lines.join("\n\n")}`, { reply_markup: keyboard });
}

async function processTextTurn(ctx: Context, chatId: number, text: string): Promise<void> {
  const attached = await getAttachedSession();
  const reply = await handleTurn(chatId, text, undefined, attached?.cwd);

  if (reply === "__SESSION_PICKER__") {
    await sendSessionPicker(ctx);
    return;
  }

  log({ chatId, direction: "out", message: reply });
  await ctx.reply(reply);
}

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;
    await ctx.replyWithChatAction("typing");
    log({ chatId, direction: "in", message: userText });

    // Register this chat for proactive notifications
    registerForNotifications(bot, chatId);

    try {
      await processTextTurn(ctx, chatId, userText);
    } catch (err) {
      log({ chatId, message: `Error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Something went wrong — try again?");
    }
  });

  bot.on("message:voice", async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.replyWithChatAction("record_voice");
    registerForNotifications(bot, chatId);

    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("Telegram did not return a file_path for this voice note");
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const audioResponse = await fetch(fileUrl);
      if (!audioResponse.ok) throw new Error(`Failed to download voice note: ${audioResponse.status}`);
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

      const transcript = await transcribeAudio(audioBuffer, "voice.ogg");
      log({ chatId, direction: "in", message: transcript });

      const attached = await getAttachedSession();
      const reply = await handleTurn(chatId, transcript, undefined, attached?.cwd);

      if (reply === "__SESSION_PICKER__") {
        await sendSessionPicker(ctx);
        return;
      }

      log({ chatId, direction: "out", message: reply });
      const audioReply = await synthesizeSpeech(reply);
      await ctx.replyWithVoice(new InputFile(audioReply, "reply.mp3"));
    } catch (err) {
      log({ chatId, message: `Voice error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Couldn't process your voice message — try again?");
    }
  });

  bot.command("sessions", async (ctx) => {
    await sendSessionPicker(ctx);
  });

  // Session attachment callback
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Handle waiting:* callbacks from notifications
    if (data.startsWith("waiting:")) {
      if (data === "waiting:ignore") {
        await ctx.answerCallbackQuery({ text: "Ignored." });
        return;
      }
      if (data === "waiting:custom") {
        await ctx.answerCallbackQuery({ text: "Send your input as a text message." });
        return;
      }
      const input = resolveWaitingAction(data);
      if (input !== null) {
        const attached = await getAttachedSession();
        if (attached) {
          const result = await injectInput(attached.cwd, input);
          if (result.found) {
            await ctx.answerCallbackQuery({ text: "Sent!" });
            await ctx.reply(`Sent "${input || "↩"}". Claude is resuming.`);
          } else {
            await ctx.answerCallbackQuery({ text: "Could not find tmux pane." });
          }
        } else {
          await ctx.answerCallbackQuery({ text: "No attached session." });
        }
      }
      return;
    }

    // Handle session:* callbacks from picker
    if (data.startsWith("session:")) {
      const sessionId = data.slice("session:".length);
      const session = pendingSessions.get(sessionId);
      if (!session) {
        await ctx.answerCallbackQuery({ text: "Session not found — try /sessions again." });
        return;
      }
      await mkdir(`${homedir()}/.claude-voice`, { recursive: true });
      await writeFile(ATTACHED_SESSION_PATH, `${session.sessionId}\n${session.cwd}`, "utf8");
      await ctx.answerCallbackQuery({ text: "Attached!" });
      await ctx.reply(`Attached to \`${session.projectName}\`. Send your first message.`, {
        parse_mode: "Markdown",
      });
    }
  });

  return bot;
}
```

**Step 2: Compile check**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/telegram/bot.ts
git commit -m "feat: add telegram/bot.ts with loop delegation + notification wiring"
```

---

### Task 11: Update index.ts + wire monitor

**Files:**
- Modify: `src/index.ts`

**Step 1: Read current src/index.ts before modifying**

The current entry point starts the bot. We need to also start the session monitor.

**Step 2: Update src/index.ts**

```typescript
import { createBot } from "./telegram/bot.js";
import { startMonitor } from "./session/monitor.js";
import { notifyWaiting } from "./telegram/notifications.js";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

// Unset CLAUDECODE so the SDK can spawn claude subprocesses without hitting
// the "cannot launch inside another Claude Code session" guard.
delete process.env.CLAUDECODE;

const required = ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

const bot = createBot(process.env.TELEGRAM_BOT_TOKEN!);
bot.catch(console.error);

// Start session monitor — watches all Claude JSONL files for waiting state
const stopMonitor = startMonitor(notifyWaiting);

// Graceful shutdown
process.on("SIGINT", () => {
  stopMonitor();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopMonitor();
  process.exit(0);
});

await bot.start({ onStart: () => console.log("claude-voice bot running") });
```

**Step 3: Full compile check**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 4: Run full test suite**

Run: `npm test`
Expected: all tests PASS, no regressions

**Step 5: Smoke test**

Run: `npm start`
Expected: "claude-voice bot running" — stays running, no startup crashes

Send from Telegram:
- "what's happening?" → should get a session summary (or "no session attached" message)
- "list my sessions" → should show session picker
- "thanks" → should get a brief chat reply (not an agent turn)

**Step 6: Final commit**

```bash
git add src/index.ts
git commit -m "feat: wire index.ts with session monitor and graceful shutdown"
```

---

### Task 12: Deprecate old files

**Files:**
- Delete (after verifying nothing imports them): `src/bot.ts`, `src/sessions.ts`, `src/intent.ts`

**Step 1: Check for imports**

Run: `grep -r "from.*['\"]\.\/bot" src/ --include="*.ts"`
Expected: no results (nothing should import old bot.ts)

Run: `grep -r "from.*['\"]\.\/sessions" src/ --include="*.ts"`
Expected: no results

Run: `grep -r "from.*['\"]\.\/intent" src/ --include="*.ts"`
Expected: no results

**Step 2: Delete old files**

Run: `rm src/bot.ts src/sessions.ts src/intent.ts`

**Step 3: Final compile check**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 4: Full test suite**

Run: `npm test`
Expected: all tests PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove deprecated bot.ts, sessions.ts, intent.ts"
```

---

## New dependencies

- `chokidar` — reliable JSONL file watching (add to dependencies)
- `vitest`, `@vitest/coverage-v8` — test runner (add to devDependencies)
