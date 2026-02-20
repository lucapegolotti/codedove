# Comprehensive Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor module structure, expand the setup wizard (repos folder, chat ID allowlist, hooks, launchd), add `/help` + usability improvements, and write a comprehensive README.

**Architecture:** Split the 735-line `bot.ts` into focused handler modules; extract shared utilities; add a `~/.claude-voice/config.json` for user config; expand the TUI wizard with hook/launchd/allowlist setup steps.

**Tech Stack:** TypeScript, Node.js, grammy (Telegram), Ink/React (TUI), vitest (tests), chokidar (file watch), launchctl (macOS service)

---

## Task 1: Extract shared Telegram utilities

**Files:**
- Create: `src/telegram/utils.ts`
- Modify: `src/telegram/notifications.ts`
- Modify: `src/telegram/bot.ts`
- Create: `src/telegram/utils.test.ts`

**Step 1: Write the failing test**

Create `src/telegram/utils.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { splitMessage } from "./utils.js";

describe("splitMessage", () => {
  it("returns single chunk when text fits within limit", () => {
    expect(splitMessage("hello", 100)).toEqual(["hello"]);
  });

  it("splits at newline boundary when text exceeds limit", () => {
    const text = "line one\nline two\nline three";
    const chunks = splitMessage(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(15));
  });

  it("falls back to hard split when no newline found within limit", () => {
    const text = "a".repeat(50);
    const chunks = splitMessage(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(20));
  });

  it("returns empty array for empty string", () => {
    expect(splitMessage("", 100)).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/luca/repositories/claude-voice && npm test -- --reporter=verbose src/telegram/utils.test.ts
```
Expected: FAIL — `utils.js` not found

**Step 3: Create `src/telegram/utils.ts`**

```typescript
import type { Context, Bot } from "grammy";

export function splitMessage(text: string, limit = 4000): string[] {
  if (!text) return [];
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export async function sendMarkdownReply(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    try {
      await ctx.reply(chunk, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(chunk);
    }
  }
}

export async function sendMarkdownMessage(bot: Bot, chatId: number, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    try {
      await bot.api.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    } catch {
      await bot.api.sendMessage(chatId, chunk);
    }
  }
}
```

**Step 4: Update `src/telegram/notifications.ts`**

Replace the local `splitMessage` and `sendMarkdownMessage` definitions at lines 16–38 with imports:

```typescript
import { splitMessage, sendMarkdownMessage } from "./utils.js";
```

Remove the `splitMessage` and `sendMarkdownMessage` function bodies from that file.

**Step 5: Update `src/telegram/bot.ts`**

Replace the local `splitMessage` (lines 42–54) and `sendMarkdownReply` (lines 56–64) function bodies with imports:

```typescript
import { splitMessage, sendMarkdownReply } from "./utils.js";
```

Remove those two function bodies from `bot.ts`.

**Step 6: Run tests to verify they pass**

```bash
cd /Users/luca/repositories/claude-voice && npm test
```
Expected: all tests pass

**Step 7: Commit**

```bash
git add src/telegram/utils.ts src/telegram/utils.test.ts src/telegram/notifications.ts src/telegram/bot.ts
git commit -m "refactor: extract shared telegram utilities to utils.ts"
```

---

## Task 2: Create config module

The config module reads/writes `~/.claude-voice/config.json` with user preferences (`reposFolder`, `allowedChatId`).

**Files:**
- Create: `src/config/config.ts`
- Create: `src/config/config.test.ts`

**Step 1: Write the failing test**

Create `src/config/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// Override CONFIG_PATH for tests by pointing to a temp dir
const TMP_DIR = join(tmpdir(), `cv-config-test-${Date.now()}`);
const TMP_CONFIG = join(TMP_DIR, "config.json");

// Dynamically import so we can test against a known path
async function getModule() {
  // We'll test loadConfig and saveConfig directly with the temp path
  const { loadConfig, saveConfig } = await import("./config.js");
  return { loadConfig, saveConfig };
}

describe("loadConfig", () => {
  beforeEach(async () => {
    await mkdir(TMP_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it("returns defaults when config file does not exist", async () => {
    const { loadConfig } = await import("./config.js");
    const config = await loadConfig(TMP_CONFIG);
    expect(config.reposFolder).toMatch(/repositories/);
    expect(config.allowedChatId).toBeUndefined();
  });

  it("reads saved values from config file", async () => {
    await writeFile(TMP_CONFIG, JSON.stringify({ reposFolder: "/custom/repos", allowedChatId: 999 }));
    const { loadConfig } = await import("./config.js");
    const config = await loadConfig(TMP_CONFIG);
    expect(config.reposFolder).toBe("/custom/repos");
    expect(config.allowedChatId).toBe(999);
  });

  it("returns defaults for missing keys in partial config", async () => {
    await writeFile(TMP_CONFIG, JSON.stringify({ reposFolder: "/custom" }));
    const { loadConfig } = await import("./config.js");
    const config = await loadConfig(TMP_CONFIG);
    expect(config.allowedChatId).toBeUndefined();
  });
});

describe("saveConfig", () => {
  beforeEach(async () => {
    await mkdir(TMP_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it("writes config to file", async () => {
    const { saveConfig } = await import("./config.js");
    await saveConfig({ reposFolder: "/my/repos" }, TMP_CONFIG);
    const raw = await readFile(TMP_CONFIG, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.reposFolder).toBe("/my/repos");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/luca/repositories/claude-voice && npm test -- --reporter=verbose src/config/config.test.ts
```
Expected: FAIL — `config.js` not found

**Step 3: Create `src/config/config.ts`**

```typescript
import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";

export type BotConfig = {
  reposFolder: string;
  allowedChatId?: number;
};

export const DEFAULT_CONFIG_PATH = join(homedir(), ".claude-voice", "config.json");

const DEFAULTS: BotConfig = {
  reposFolder: join(homedir(), "repositories"),
};

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH): Promise<BotConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<BotConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(config: Partial<BotConfig>, configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const existing = await loadConfig(configPath);
  const merged = { ...existing, ...config };
  await writeFile(configPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
}
```

**Step 4: Run tests**

```bash
cd /Users/luca/repositories/claude-voice && npm test -- --reporter=verbose src/config/config.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/config/config.ts src/config/config.test.ts
git commit -m "feat: add config module for ~/.claude-voice/config.json"
```

---

## Task 3: Add chat ID allowlist middleware

When `allowedChatId` is configured, the bot silently drops messages from all other chat IDs.

**Files:**
- Create: `src/telegram/middleware.ts`
- Create: `src/telegram/middleware.test.ts`
- Modify: `src/telegram/bot.ts` (register middleware)

**Step 1: Write the failing test**

Create `src/telegram/middleware.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Bot } from "grammy";
import { applyAllowlistMiddleware } from "./middleware.js";

const BOT_INFO = {
  id: 1, is_bot: true as const, first_name: "T", username: "t",
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
};

function textUpdate(chatId: number) {
  return {
    update_id: 1,
    message: {
      message_id: 1, date: 0,
      chat: { id: chatId, type: "private" as const, first_name: "Test" },
      from: { id: chatId, is_bot: false, first_name: "Test" },
      text: "hello",
    },
  };
}

async function makeBot(allowedChatId: number | undefined) {
  const bot = new Bot("test-token");
  bot.api.config.use(async (prev, method, payload) => {
    if (method === "getMe") return { ok: true as const, result: BOT_INFO };
    return { ok: true as const, result: {} };
  });
  applyAllowlistMiddleware(bot, allowedChatId);
  const handled: number[] = [];
  bot.on("message:text", (ctx) => { handled.push(ctx.chat.id); });
  await bot.init();
  return { bot, handled };
}

describe("applyAllowlistMiddleware", () => {
  it("allows all chat IDs when no allowedChatId configured", async () => {
    const { bot, handled } = await makeBot(undefined);
    await bot.handleUpdate(textUpdate(111) as any);
    await bot.handleUpdate(textUpdate(222) as any);
    expect(handled).toEqual([111, 222]);
  });

  it("allows only the configured chat ID", async () => {
    const { bot, handled } = await makeBot(111);
    await bot.handleUpdate(textUpdate(111) as any);
    await bot.handleUpdate(textUpdate(999) as any);
    expect(handled).toEqual([111]);
  });

  it("silently drops messages from unlisted chat IDs (no reply sent)", async () => {
    const replyCalls: unknown[] = [];
    const { bot } = await makeBot(111);
    bot.api.config.use(async (prev, method, payload) => {
      if (method === "sendMessage") replyCalls.push(payload);
      return { ok: true as const, result: {} };
    });
    await bot.handleUpdate(textUpdate(999) as any);
    expect(replyCalls).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/luca/repositories/claude-voice && npm test -- --reporter=verbose src/telegram/middleware.test.ts
```
Expected: FAIL

**Step 3: Create `src/telegram/middleware.ts`**

```typescript
import type { Bot } from "grammy";

export function applyAllowlistMiddleware(bot: Bot, allowedChatId: number | undefined): void {
  if (!allowedChatId) return;
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id ?? ctx.from?.id;
    if (chatId === allowedChatId) return next();
    // Silently drop — don't reveal anything to unknown senders
  });
}
```

**Step 4: Update `src/telegram/bot.ts`**

In `createBot`, import and call `applyAllowlistMiddleware` before registering any handlers. The `allowedChatId` comes from the config loaded at startup. Add a parameter to `createBot`:

```typescript
import { applyAllowlistMiddleware } from "./middleware.js";

// Change signature:
export function createBot(token: string, allowedChatId?: number): Bot {
  const bot = new Bot(token);
  applyAllowlistMiddleware(bot, allowedChatId);
  // ... rest of handlers unchanged
```

**Step 5: Update `src/index.ts`** to load config and pass `allowedChatId`:

```typescript
import { loadConfig } from "./config/config.js";

const config = await loadConfig();
const bot = createBot(token, config.allowedChatId);
```

**Step 6: Run all tests**

```bash
cd /Users/luca/repositories/claude-voice && npm test
```
Expected: all pass

**Step 7: Commit**

```bash
git add src/telegram/middleware.ts src/telegram/middleware.test.ts src/telegram/bot.ts src/index.ts
git commit -m "feat: add chat ID allowlist middleware"
```

---

## Task 4: Split bot.ts into handler modules

`bot.ts` is 735 lines. Split it into four focused handler files. `createBot` becomes a thin wiring layer.

**Files:**
- Create: `src/telegram/handlers/text.ts`
- Create: `src/telegram/handlers/voice.ts`
- Create: `src/telegram/handlers/image.ts`
- Create: `src/telegram/handlers/commands.ts`
- Create: `src/telegram/handlers/callbacks.ts`
- Modify: `src/telegram/bot.ts` (shrink to wiring only)

This task has no new tests (existing `bot.test.ts` covers the behaviour via `createBot`). The refactor must keep all existing tests passing.

**Step 1: Create `src/telegram/handlers/text.ts`**

Extract the `processTextTurn`, `ensureSession`, `snapshotBaseline`, `startInjectionWatcher`, `pollForPostCompactionSession` functions and the `pendingSessions`, `launchedPaneId`, `activeWatcherStop`, `activeWatcherOnComplete`, `compactPollGeneration` module-level state into this file.

Export: `processTextTurn`, `ensureSession`, `snapshotBaseline`, `startInjectionWatcher`, `pendingSessions`, `launchedPaneId` (as a getter/setter pair or `let` export).

```typescript
// src/telegram/handlers/text.ts
import { Context } from "grammy";
import { handleTurn, clearChatState } from "../../agent/loop.js";
import { sendMarkdownReply } from "../utils.js";
import { sendSessionPicker } from "./sessions.js";
import { getAttachedSession, getLatestSessionFileForCwd, ATTACHED_SESSION_PATH } from "../../session/history.js";
import { watchForResponse, getFileSize } from "../../session/monitor.js";
import { notifyResponse, sendPing } from "../notifications.js";
import { log } from "../../logger.js";
import { writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import type { SessionResponseState } from "../../session/monitor.js";

// ... (all extracted state and functions)
```

Note: to keep `launchedPaneId` mutable and accessible to the session picker callback (in `callbacks.ts`), export it as:
```typescript
export let launchedPaneId: string | undefined;
export function setLaunchedPaneId(id: string | undefined) { launchedPaneId = id; }
```

**Step 2: Create `src/telegram/handlers/sessions.ts`**

Extract `sendSessionPicker` and `timeAgo` and the `pendingSessions` map:

```typescript
// src/telegram/handlers/sessions.ts
import { Context, InlineKeyboard } from "grammy";
import { listSessions } from "../../session/history.js";

export const pendingSessions = new Map<string, { sessionId: string; cwd: string; projectName: string }>();

export function timeAgo(date: Date): string { /* ... */ }
export async function sendSessionPicker(ctx: Context): Promise<void> { /* ... */ }
```

**Step 3: Create `src/telegram/handlers/voice.ts`**

Extract the `message:voice` handler body and `isVoicePolishEnabled` into a function `handleVoice(ctx, token)`:

```typescript
// src/telegram/handlers/voice.ts
export async function handleVoice(ctx: Context, chatId: number, token: string): Promise<void> { /* ... */ }
```

**Step 4: Create `src/telegram/handlers/image.ts`**

Extract `handleImageMessage`:

```typescript
// src/telegram/handlers/image.ts
export async function handleImageMessage(ctx, chatId, fileId, fileMimeType, caption, token): Promise<void> { /* ... */ }
```

**Step 5: Create `src/telegram/handlers/commands.ts`**

Extract all `bot.command(...)` registrations into a `registerCommands(bot)` function:

```typescript
// src/telegram/handlers/commands.ts
export function registerCommands(bot: Bot): void {
  bot.command("compact", ...);
  bot.command("polishvoice", ...);
  bot.command("summarize", ...);
  // etc.
}
```

**Step 6: Create `src/telegram/handlers/callbacks.ts`**

Extract the entire `bot.on("callback_query:data", ...)` body into `registerCallbacks(bot)`:

```typescript
// src/telegram/handlers/callbacks.ts
export function registerCallbacks(bot: Bot): void {
  bot.on("callback_query:data", async (ctx) => { /* ... */ });
}
```

**Step 7: Rewrite `src/telegram/bot.ts`**

```typescript
import { Bot } from "grammy";
import { applyAllowlistMiddleware } from "./middleware.js";
import { sendMarkdownReply } from "./utils.js";
import { handleTurn } from "../agent/loop.js";
import { registerCommands } from "./handlers/commands.js";
import { registerCallbacks } from "./handlers/callbacks.js";
import { processTextTurn, launchedPaneId } from "./handlers/text.js";
import { handleVoice } from "./handlers/voice.js";
import { handleImageMessage } from "./handlers/image.js";
import { registerForNotifications } from "./notifications.js";
import { log } from "../logger.js";

export function createBot(token: string, allowedChatId?: number): Bot {
  const bot = new Bot(token);
  applyAllowlistMiddleware(bot, allowedChatId);

  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) return next();
    const chatId = ctx.chat.id;
    await ctx.replyWithChatAction("typing");
    log({ chatId, direction: "in", message: ctx.message.text });
    registerForNotifications(bot, chatId);
    try {
      await processTextTurn(ctx, chatId, ctx.message.text);
    } catch (err) {
      log({ chatId, message: `Error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Something went wrong — try again?");
    }
  });

  bot.on("message:voice", async (ctx) => {
    registerForNotifications(bot, ctx.chat.id);
    await handleVoice(ctx, ctx.chat.id, token);
  });

  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;
    try {
      const largest = ctx.message.photo[ctx.message.photo.length - 1];
      await handleImageMessage(ctx, chatId, largest.file_id, "image/jpeg", ctx.message.caption ?? "", token);
    } catch (err) {
      await ctx.reply("Couldn't process the image — try again?");
    }
  });

  bot.on("message:document", async (ctx) => {
    const mime = ctx.message.document.mime_type ?? "";
    if (!mime.startsWith("image/")) return;
    try {
      await handleImageMessage(ctx, ctx.chat.id, ctx.message.document.file_id, mime, ctx.message.caption ?? "", token);
    } catch (err) {
      await ctx.reply("Couldn't process the image — try again?");
    }
  });

  registerCommands(bot);
  registerCallbacks(bot);
  return bot;
}
```

**Step 8: Run all tests**

```bash
cd /Users/luca/repositories/claude-voice && npm test
```
Expected: all pass. If any fail due to mock path changes, update the mock paths in `bot.test.ts` accordingly.

**Step 9: Commit**

```bash
git add src/telegram/handlers/ src/telegram/bot.ts
git commit -m "refactor: split bot.ts into focused handler modules"
```

---

## Task 5: Add /help command

**Files:**
- Modify: `src/telegram/handlers/commands.ts`
- Modify: `src/telegram/bot.test.ts` (add test)

**Step 1: Write the failing test**

Add to `src/telegram/bot.test.ts` (in an appropriate describe block):

```typescript
describe("/help command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replies with a list of all commands", async () => {
    const { bot, apiCalls } = await makeBot();
    await bot.handleUpdate(commandUpdate("/help"));
    const texts = apiCalls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("/sessions"))).toBe(true);
    expect(texts.some((t) => t.includes("/detach"))).toBe(true);
    expect(texts.some((t) => t.includes("/status"))).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/luca/repositories/claude-voice && npm test -- --reporter=verbose src/telegram/bot.test.ts
```
Expected: FAIL — no /help handler

**Step 3: Add /help to `src/telegram/handlers/commands.ts`**

```typescript
const HELP_TEXT = `*claude-voice commands*

/sessions — pick a Claude Code session to attach to
/detach — detach from current session
/status — show attached session info
/summarize — summarise the current session
/compact — trigger /compact in Claude Code
/clear — clear Claude Code context
/close_session — close the Claude Code window
/polishvoice — toggle voice transcript polishing on/off
/restart — restart the bot
/help — show this list`;

// Inside registerCommands:
bot.command("help", async (ctx) => {
  await ctx.reply(HELP_TEXT, { parse_mode: "Markdown" });
});
```

**Step 4: Run tests**

```bash
cd /Users/luca/repositories/claude-voice && npm test
```
Expected: all pass

**Step 5: Commit**

```bash
git add src/telegram/handlers/commands.ts src/telegram/bot.test.ts
git commit -m "feat: add /help command listing all bot commands"
```

---

## Task 6: Improve /status and startup message

**Files:**
- Modify: `src/telegram/handlers/commands.ts` (/status)
- Modify: `src/telegram/notifications.ts` (startup message)
- Modify: `src/telegram/bot.test.ts` (add /status test)
- Modify: `src/telegram/notifications.test.ts` (add startup message test)

**Step 1: Write failing test for /status**

Add to `src/telegram/bot.test.ts`:

```typescript
describe("/status command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows project name, cwd, and watcher state in one message", async () => {
    const { bot, apiCalls } = await makeBot();
    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "abc123def456", cwd: "/proj" });
    vi.mocked(listSessions).mockResolvedValue([{
      sessionId: "abc123def456", cwd: "/proj", projectName: "myproject",
      lastMessage: "", mtime: new Date(),
    }]);
    await bot.handleUpdate(commandUpdate("/status"));
    const texts = apiCalls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);
    // Should be a single condensed message
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("myproject");
    expect(texts[0]).toContain("/proj");
  });

  it("says no session when nothing attached", async () => {
    const { bot, apiCalls } = await makeBot();
    vi.mocked(getAttachedSession).mockResolvedValue(null);
    await bot.handleUpdate(commandUpdate("/status"));
    const texts = apiCalls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("No session"))).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/luca/repositories/claude-voice && npm test -- --reporter=verbose src/telegram/bot.test.ts
```

**Step 3: Update /status in `src/telegram/handlers/commands.ts`**

Replace the existing verbose multi-line /status handler with:

```typescript
bot.command("status", async (ctx) => {
  const attached = await getAttachedSession();
  if (!attached) {
    await ctx.reply("No session attached. Use /sessions to pick one.");
    return;
  }
  const sessions = await listSessions(20);
  const info = sessions.find((s) => s.sessionId === attached.sessionId);
  const project = info?.projectName ?? attached.sessionId.slice(0, 8);
  const watcher = activeWatcherStop ? "⏳ active" : "✅ idle";
  await ctx.reply(
    `\`${project}\` · \`${attached.cwd}\` · watcher: ${watcher}`,
    { parse_mode: "Markdown" }
  );
});
```

**Step 4: Update startup message in `src/telegram/notifications.ts`**

Change `sendStartupMessage` to include the attached session if known:

```typescript
export async function sendStartupMessage(bot: Bot): Promise<void> {
  let chatId: number;
  try {
    const raw = await readFile(CHAT_ID_PATH, "utf8");
    chatId = parseInt(raw.trim(), 10);
    if (!Number.isFinite(chatId)) return;
  } catch {
    return;
  }
  const attached = await getAttachedSession().catch(() => null);
  const sessionInfo = attached
    ? `Attached: \`${attached.sessionId.slice(0, 8)}…\``
    : "No session attached — use /sessions to pick one.";
  await bot.api.sendMessage(chatId, `claude\\-voice started\\. ${sessionInfo}`, { parse_mode: "MarkdownV2" }).catch(() =>
    bot.api.sendMessage(chatId, `claude-voice started. ${attached ? "Attached: " + attached.sessionId.slice(0, 8) : "No session attached."}`)
  );
}
```

**Step 5: Run all tests**

```bash
cd /Users/luca/repositories/claude-voice && npm test
```
Expected: all pass

**Step 6: Commit**

```bash
git add src/telegram/handlers/commands.ts src/telegram/notifications.ts src/telegram/bot.test.ts
git commit -m "feat: condense /status to one line, improve startup message"
```

---

## Task 7: Improve error messages for no Claude Code running

**Files:**
- Modify: `src/agent/loop.ts`
- Modify: `src/agent/loop.test.ts`

**Step 1: Write failing test**

Update `src/agent/loop.test.ts` (create it if it doesn't exist with meaningful content):

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleTurn } from "./loop.js";
import { injectInput } from "../session/tmux.js";

vi.mock("../session/tmux.js", () => ({
  injectInput: vi.fn(),
}));
vi.mock("../logger.js", () => ({ log: vi.fn() }));

describe("handleTurn", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns __INJECTED__ when injection succeeds", async () => {
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%1" });
    const result = await handleTurn(1, "hello", undefined, "/proj");
    expect(result).toBe("__INJECTED__");
  });

  it("returns prompt to use /sessions when no cwd provided", async () => {
    const result = await handleTurn(1, "hello");
    expect(result).toContain("/sessions");
  });

  it("returns short error with /sessions link when Claude Code not running", async () => {
    vi.mocked(injectInput).mockResolvedValue({ found: false, reason: "no_claude_pane" });
    const result = await handleTurn(1, "hello", undefined, "/proj");
    expect(result).toContain("No Claude Code running");
    expect(result).toContain("/sessions");
    // Should be concise — not a multi-sentence paragraph
    expect(result.length).toBeLessThan(120);
  });
});
```

**Step 2: Run test to verify failure case**

```bash
cd /Users/luca/repositories/claude-voice && npm test -- --reporter=verbose src/agent/loop.test.ts
```

**Step 3: Update `src/agent/loop.ts`**

```typescript
export async function handleTurn(
  chatId: number,
  userMessage: string,
  _lastBotMessage?: string,
  knownCwd?: string,
  fallbackPaneId?: string
): Promise<string> {
  if (!knownCwd) {
    return "No session attached. Use /sessions to pick one.";
  }
  log({ chatId, message: `inject: ${userMessage.slice(0, 80)}` });
  const result = await injectInput(knownCwd, userMessage, fallbackPaneId);
  if (result.found) return "__INJECTED__";
  return "No Claude Code running at this session. Start it, or use /sessions to switch.";
}
```

**Step 4: Run all tests**

```bash
cd /Users/luca/repositories/claude-voice && npm test
```

**Step 5: Commit**

```bash
git add src/agent/loop.ts src/agent/loop.test.ts
git commit -m "fix: concise error when Claude Code not running"
```

---

## Task 8: Expand TUI setup wizard — repositories folder + chat ID steps

The setup wizard in `src/tui/Setup.tsx` currently asks for 3 API keys. Add two more steps: repos folder and chat ID.

**Files:**
- Modify: `src/tui/Setup.tsx`
- Modify: `src/config/config.ts` (already done in Task 2)

No automated test for TUI components (they require interactive rendering). Manual test: run `claude-voice` and verify the new steps appear after API key entry.

**Step 1: Update `src/tui/Setup.tsx`**

Add two new steps after `OPENAI_API_KEY`. The setup now has 5 steps:

```typescript
import { saveConfig } from "../config/config.js";
import { homedir } from "os";
import { join } from "path";

const API_STEPS = [
  { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", hint: "Get from @BotFather → /newbot", mask: true },
  { key: "ANTHROPIC_API_KEY",  label: "Anthropic API key",  hint: "console.anthropic.com", mask: true },
  { key: "OPENAI_API_KEY",     label: "OpenAI API key",     hint: "platform.openai.com/api-keys", mask: true },
] as const;

type ApiKey = typeof API_STEPS[number]["key"];

// Config steps are separate — they go to config.json not .env
const CONFIG_STEPS = [
  {
    key: "reposFolder",
    label: "Repositories folder",
    hint: "Default folder for your projects (press Enter to use default)",
    defaultValue: join(homedir(), "repositories"),
    mask: false,
  },
  {
    key: "allowedChatId",
    label: "Your Telegram chat ID (optional)",
    hint: "Message @userinfobot on Telegram to get your chat ID. Leave blank to allow all.",
    defaultValue: "",
    mask: false,
  },
] as const;
```

The `handleSubmit` in Setup walks through API_STEPS first, then CONFIG_STEPS. After API steps, write the `.env`. After config steps, write `~/.claude-voice/config.json` via `saveConfig`.

Allow pressing Enter on config steps with defaults (don't require non-empty for config steps).

Full updated component:

```typescript
type Phase = "api" | "config";

export function Setup({ envPath, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>("api");
  const [apiStep, setApiStep] = useState(0);
  const [configStep, setConfigStep] = useState(0);
  const [apiValues, setApiValues] = useState<Partial<Record<ApiKey, string>>>({});
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const currentApiStep = API_STEPS[apiStep];
  const currentConfigStep = CONFIG_STEPS[configStep];

  async function handleApiSubmit(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    const next = { ...apiValues, [currentApiStep.key]: trimmed };
    setApiValues(next);
    setInput("");

    if (apiStep === API_STEPS.length - 1) {
      // Write .env
      const content = API_STEPS.map((s) => {
        const v = next[s.key] ?? "";
        const escaped = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
        return `${s.key}="${escaped}"`;
      }).join("\n") + "\n";
      try {
        await writeFile(envPath, content, "utf8");
        setPhase("config");
      } catch (err) {
        setError(`Failed to write .env: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      setApiStep(apiStep + 1);
    }
  }

  async function handleConfigSubmit(value: string) {
    const step = currentConfigStep;
    const trimmed = value.trim() || step.defaultValue;
    const next = { ...configValues, [step.key]: trimmed };
    setConfigValues(next);
    setInput("");

    if (configStep === CONFIG_STEPS.length - 1) {
      // Write config.json
      try {
        const chatId = next.allowedChatId ? parseInt(next.allowedChatId, 10) : undefined;
        await saveConfig({
          reposFolder: next.reposFolder || CONFIG_STEPS[0].defaultValue,
          ...(chatId && Number.isFinite(chatId) ? { allowedChatId: chatId } : {}),
        });
        onComplete();
      } catch (err) {
        setError(`Failed to write config: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      setConfigStep(configStep + 1);
    }
  }

  if (error) {
    return (
      <Box flexDirection="column" gap={1} padding={2}>
        <Text bold color="red">Setup failed</Text>
        <Text>{error}</Text>
      </Box>
    );
  }

  if (phase === "api") {
    return (
      <Box flexDirection="column" gap={1} padding={2}>
        <Text bold>claude-voice setup — API keys (step {apiStep + 1}/{API_STEPS.length})</Text>
        <Text dimColor>Credentials are saved to .env in the install directory.</Text>
        <Box flexDirection="column" marginTop={1} gap={1}>
          {API_STEPS.slice(0, apiStep).map((s) => (
            <Text key={s.key} color="green">✓ {s.label}</Text>
          ))}
          <Box gap={1}>
            <Text bold>{currentApiStep.label}: </Text>
            <TextInput value={input} onChange={setInput} onSubmit={handleApiSubmit} mask="*" />
          </Box>
          <Text dimColor>{currentApiStep.hint}</Text>
        </Box>
      </Box>
    );
  }

  // config phase
  return (
    <Box flexDirection="column" gap={1} padding={2}>
      <Text bold>claude-voice setup — preferences (step {configStep + 1}/{CONFIG_STEPS.length})</Text>
      <Text dimColor>These are saved to ~/.claude-voice/config.json</Text>
      <Box flexDirection="column" marginTop={1} gap={1}>
        {CONFIG_STEPS.slice(0, configStep).map((s) => (
          <Text key={s.key} color="green">✓ {s.label}</Text>
        ))}
        <Box gap={1}>
          <Text bold>{currentConfigStep.label}: </Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleConfigSubmit} />
        </Box>
        <Text dimColor>
          {currentConfigStep.hint}
          {currentConfigStep.defaultValue ? `  Default: ${currentConfigStep.defaultValue}` : ""}
        </Text>
      </Box>
    </Box>
  );
}
```

**Step 2: Manual test**

```bash
# Delete .env to trigger setup
mv /path/to/claude-voice/.env /tmp/cv-env-backup
claude-voice
# Verify: API key steps appear, then repos folder step, then chat ID step
# Press Enter on repos folder to accept default
# Leave chat ID blank and press Enter
# Verify bot starts normally
# Restore: mv /tmp/cv-env-backup /path/to/claude-voice/.env
```

**Step 3: Commit**

```bash
git add src/tui/Setup.tsx
git commit -m "feat: add repos folder and chat ID steps to setup wizard"
```

---

## Task 9: Add hooks + launchd steps to setup wizard

After the config steps, the wizard offers to install Claude Code hooks and register the launchd service.

**Files:**
- Create: `src/tui/SetupHooks.tsx`
- Create: `src/tui/SetupLaunchd.tsx`
- Modify: `src/tui/Setup.tsx` (add two more phases: "hooks" and "launchd")
- Create: `src/launchd/install.ts`

**Step 1: Create `src/launchd/install.ts`**

```typescript
import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execAsync = promisify(execFile);

export const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.claude-voice.bot.plist");
export const SERVICE_LABEL = "com.claude-voice.bot";

function buildPlist(executablePath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${executablePath}</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${homedir()}/.claude-voice/bot.log</string>
  <key>StandardErrorPath</key>
  <string>${homedir()}/.claude-voice/bot.err</string>
</dict>
</plist>
`;
}

export async function isPlistInstalled(): Promise<boolean> {
  try {
    await readFile(PLIST_PATH, "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function isServiceRunning(): Promise<boolean> {
  try {
    const { stdout } = await execAsync("launchctl", ["list", SERVICE_LABEL]);
    return stdout.includes('"PID"');
  } catch {
    return false;
  }
}

export async function installLaunchd(claudeVicePath: string): Promise<void> {
  await mkdir(dirname(PLIST_PATH), { recursive: true });
  await writeFile(PLIST_PATH, buildPlist(claudeVicePath), "utf8");
  const uid = process.getuid ? process.getuid() : 501;
  await execAsync("launchctl", ["load", "-w", PLIST_PATH]).catch(() => {});
}
```

**Step 2: Create `src/tui/SetupHooks.tsx`**

An Ink component that shows hook status and offers to install them:

```typescript
import { Box, Text, useInput } from "ink";
import { useState, useEffect } from "react";
import {
  isHookInstalled, installHook,
  isPermissionHookInstalled, installPermissionHook,
  isCompactHooksInstalled, installCompactHooks,
} from "../hooks/install.js";

type Props = { onComplete: () => void };

type HookState = "checking" | "installed" | "missing" | "installing" | "done";

export function SetupHooks({ onComplete }: Props) {
  const [stop, setStop] = useState<HookState>("checking");
  const [perm, setPerm] = useState<HookState>("checking");
  const [compact, setCompact] = useState<HookState>("checking");

  useEffect(() => {
    isHookInstalled().then((ok) => setStop(ok ? "installed" : "missing"));
    isPermissionHookInstalled().then((ok) => setPerm(ok ? "installed" : "missing"));
    isCompactHooksInstalled().then((ok) => setCompact(ok ? "installed" : "missing"));
  }, []);

  async function installAll() {
    if (stop === "missing") { setStop("installing"); await installHook().catch(() => {}); setStop("installed"); }
    if (perm === "missing") { setPerm("installing"); await installPermissionHook().catch(() => {}); setPerm("installed"); }
    if (compact === "missing") { setCompact("installing"); await installCompactHooks().catch(() => {}); setCompact("installed"); }
  }

  useInput((input) => {
    if (input === "y" || input === "Y") { void installAll().then(onComplete); }
    if (input === "n" || input === "N") { onComplete(); }
  });

  const allInstalled = stop === "installed" && perm === "installed" && compact === "installed";
  const checking = stop === "checking" || perm === "checking" || compact === "checking";

  if (allInstalled) {
    return (
      <Box flexDirection="column" gap={1} padding={2}>
        <Text color="green">✓ All Claude Code hooks installed.</Text>
        <Text dimColor>Press any key to continue…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1} padding={2}>
      <Text bold>Claude Code hooks</Text>
      <Text dimColor>These hooks let the bot know when Claude finishes a turn and handle permissions.</Text>
      <Box flexDirection="column" marginTop={1} gap={0}>
        <Text>{stop === "installed" ? "✓" : "✗"} Stop hook (turn completion signal)</Text>
        <Text>{perm === "installed" ? "✓" : "✗"} Permission hook (approve/deny from Telegram)</Text>
        <Text>{compact === "installed" ? "✓" : "✗"} Compact hooks (compaction notifications)</Text>
      </Box>
      {!checking && (
        <Box marginTop={1}>
          <Text bold>Install missing hooks? [y/n]</Text>
        </Box>
      )}
    </Box>
  );
}
```

**Step 3: Create `src/tui/SetupLaunchd.tsx`**

```typescript
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { installLaunchd, PLIST_PATH } from "../launchd/install.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_VOICE_BIN = resolve(__dirname, "..", "..", "bin", "claude-voice");

type Props = { onComplete: () => void };

export function SetupLaunchd({ onComplete }: Props) {
  const [state, setState] = useState<"prompt" | "installing" | "done" | "skipped">("prompt");

  useInput(async (input) => {
    if (state !== "prompt") return;
    if (input === "y" || input === "Y") {
      setState("installing");
      await installLaunchd(CLAUDE_VOICE_BIN).catch(() => {});
      setState("done");
    }
    if (input === "n" || input === "N") {
      setState("skipped");
      onComplete();
    }
  });

  if (state === "done") {
    return (
      <Box flexDirection="column" gap={1} padding={2}>
        <Text color="green">✓ Bot registered as a launch agent. It will start automatically on login.</Text>
        <Text dimColor>Press any key to continue…</Text>
      </Box>
    );
  }

  if (state === "skipped") return null;

  return (
    <Box flexDirection="column" gap={1} padding={2}>
      <Text bold>Register as macOS launch agent?</Text>
      <Text dimColor>This starts the bot automatically when you log in.</Text>
      <Text dimColor>Plist: {PLIST_PATH}</Text>
      <Box marginTop={1}>
        <Text bold>Register now? [y/n]</Text>
      </Box>
    </Box>
  );
}
```

**Step 4: Modify `src/tui/Setup.tsx` to add hooks and launchd phases**

Update the phase type:
```typescript
type Phase = "api" | "config" | "hooks" | "launchd";
```

After config phase completes → set phase to "hooks".
After hooks phase → set phase to "launchd".
After launchd → call onComplete.

Import and render `SetupHooks` and `SetupLaunchd`:
```typescript
if (phase === "hooks") return <SetupHooks onComplete={() => setPhase("launchd")} />;
if (phase === "launchd") return <SetupLaunchd onComplete={onComplete} />;
```

**Step 5: Commit**

```bash
git add src/launchd/ src/tui/SetupHooks.tsx src/tui/SetupLaunchd.tsx src/tui/Setup.tsx
git commit -m "feat: add hooks and launchd steps to setup wizard"
```

---

## Task 10: Update Dashboard — cleaner hook status display

The Dashboard currently shows three separate hook status banners. Consolidate into one.

**Files:**
- Modify: `src/tui/Dashboard.tsx`

**Step 1: Update `src/tui/Dashboard.tsx`**

Replace the three separate hook status sections with a single combined line. If all hooks installed: one green line. If any missing: one yellow warning with `[i] install`.

```typescript
// Derive combined status
const hooksAllInstalled = hookStatus === "installed" && permHookStatus === "installed";
const hooksAnyMissing = hookStatus === "missing" || permHookStatus === "missing";
const hooksInstalling = hookStatus === "installing" || permHookStatus === "installing";

// In JSX:
{hooksInstalling && (
  <Box paddingX={1}>
    <Text color="yellow">Installing hooks…</Text>
  </Box>
)}
{hooksAnyMissing && !hooksInstalling && (
  <Box paddingX={1} backgroundColor="yellow">
    <Text color="black">
      ⚠ Hook{hookStatus === "missing" && permHookStatus === "missing" ? "s" : ""} missing
      {hookStatus === "missing" ? " (stop)" : ""}
      {permHookStatus === "missing" ? " (permission)" : ""}
      {" — [i] install"}
    </Text>
  </Box>
)}
{hooksAllInstalled && (
  <Box paddingX={1}>
    <Text color="green">✓ All hooks installed</Text>
  </Box>
)}
```

**Step 2: Commit**

```bash
git add src/tui/Dashboard.tsx
git commit -m "refactor: consolidate hook status banners in Dashboard"
```

---

## Task 11: Write comprehensive README

**Files:**
- Modify: `README.md`

**Step 1: Rewrite README.md**

The README should have these sections:

1. **Title + tagline**
2. **What it is** (1 paragraph)
3. **Install**
   - Prerequisites (Node 18+, tmux, macOS)
   - `git clone` → `npm install` → `npm install -g .` → `claude-voice`
   - Guided setup wizard (API keys, repos folder, chat ID, hooks, launchd)
4. **Usage**
   - First time: auto-attaches to most recent session
   - `/sessions` to pick a session
   - Text and voice messages
   - Image messages
   - Permission approval inline from Telegram
   - All commands table
5. **Architecture**
   - Overview diagram (ASCII)
   - How sessions are discovered (`~/.claude/projects/`)
   - How injection works (tmux send-keys)
   - How responses are detected (JSONL watcher + byte baseline)
   - How the Stop hook signals turn completion
   - How voice works (Whisper STT → inject → TTS reply)
   - How permissions work (hook writes file, bot reads and responds)
6. **Security**
   - Chat ID allowlist
   - What permissions the bot runs with
   - Recommendation to not share the bot token
7. **Alternative names** (fun section, not in navigation)
8. **Stack table**

Full content (write this to README.md):

```markdown
# claude-voice

> Control Claude Code from your phone via Telegram — text, voice, or image.

Send a message from Telegram. Claude Code runs on your Mac. You get the response back in Telegram — as text or as a voice note.

## What it is

claude-voice is a Telegram bot that acts as a remote interface for [Claude Code](https://claude.ai/code) sessions running in tmux on your machine. You can type or speak commands, receive responses as text or audio, approve tool permissions from your phone, and manage multiple Claude Code sessions from a single Telegram chat.

## Prerequisites

- macOS (uses launchd + tmux)
- Node.js 18+
- [tmux](https://github.com/tmux/tmux) — `brew install tmux`
- Claude Code — `npm install -g @anthropic-ai/claude-code`

## Install

\`\`\`bash
git clone https://github.com/your-username/claude-voice.git
cd claude-voice
npm install
npm install -g .
claude-voice
\`\`\`

On first run, a setup wizard walks you through:
1. **API keys** — Telegram bot token (from [@BotFather](https://t.me/BotFather)), Anthropic API key, OpenAI API key
2. **Repositories folder** — where Claude Code looks for your projects (default: `~/repositories`)
3. **Chat ID allowlist** — your Telegram chat ID so only you can use the bot (get it from [@userinfobot](https://t.me/userinfobot))
4. **Claude Code hooks** — installs Stop/Permission/Compact hooks so the bot knows when Claude finishes a turn and receives permission requests
5. **Launch agent** — registers the bot as a macOS launch agent so it starts automatically on login

## Usage

Open Telegram, find your bot (the username you set with @BotFather), and send a message.

### First message

If no session is attached, the bot auto-attaches to the most recently active Claude Code session. Or use `/sessions` to pick one explicitly.

### Text messages

Type anything. The message is injected directly into Claude Code's input.

```
What files are in ~/repositories?
Fix the null pointer in auth.ts
Run the tests and tell me what's failing
```

### Voice messages

Hold the mic button in Telegram and speak your request. The bot:
1. Downloads the OGG audio from Telegram
2. Transcribes it with OpenAI Whisper
3. Optionally polishes the transcript with Claude Haiku (toggle with `/polishvoice`)
4. Injects the cleaned text into Claude Code
5. Synthesizes Claude's response as a voice note (OpenAI TTS, `nova` voice) and sends it back

### Image messages

Send a photo or image file. The bot saves it to `~/.claude-voice/images/` and injects a message telling Claude Code where to find it. Add a caption to include instructions alongside the image.

### Permission approval

When Claude Code needs your approval to run a command, you get a Telegram notification with the command shown and Yes/No buttons. Approve or deny from your phone.

### Commands

| Command | Description |
|---|---|
| `/sessions` | Pick a Claude Code session to attach to |
| `/detach` | Detach from the current session |
| `/status` | Show attached session, cwd, watcher state |
| `/summarize` | Summarise the current Claude Code session |
| `/compact` | Trigger `/compact` in Claude Code |
| `/clear` | Clear Claude Code context |
| `/close_session` | Kill the Claude Code tmux window |
| `/polishvoice` | Toggle voice transcript polishing on/off |
| `/restart` | Restart the bot process |
| `/help` | Show this command list |

## Architecture

### Message flow

\`\`\`
User (Telegram)
      │  text / voice / image
      ▼
Bot (grammy)
      │
      ├── Voice pipeline (voice messages only)
      │     OGG → Whisper STT → polish (Claude Haiku) → text
      │
      ├── Image handler (photo/document messages)
      │     Download → save to ~/.claude-voice/images/ → inject path
      │
      └── Text injection
            tmux send-keys → Claude Code pane
                    │
                    ▼
              Claude Code runs
              (reads files, runs bash, edits code)
                    │
                    ▼
            ~/.claude/projects/<cwd>/<session>.jsonl
                    │
                    ▼
            JSONL watcher (chokidar)
            reads new bytes after baseline
                    │
                    ▼
            Response delivery
            text → Telegram message
            voice → OpenAI TTS → voice note
\`\`\`

### Session discovery

Claude Code writes its conversation history to `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, where the cwd is encoded by replacing `/` with `-`. The bot scans this directory to list available sessions, reads the most recent JSONL per project, and extracts the last assistant message for display in `/sessions`.

When a session is attached, the bot stores `<sessionId>\n<cwd>` in `~/.claude-voice/attached`.

### Injection

Messages are injected into the Claude Code tmux pane using `tmux send-keys`. The bot identifies the correct pane by matching the current working directory and checking that the process command matches Claude Code's title string (a semver like `2.1.47`).

Text and Enter are sent in two separate `send-keys` calls with a 100ms delay — sending them together in one call causes Enter to fire before Claude Code finishes processing the text.

### Response detection

Before injecting a message, the bot records the current byte offset of the session JSONL file. After injection, a `chokidar` watcher monitors the file for changes. Each new line after the baseline is parsed: if it's an `assistant` message with a text block, the text is delivered to Telegram. If a `result` event is found (written by the Stop hook), the watcher fires the final response and stops.

This approach avoids the debounce problem: during an active session, Claude Code continuously writes tool results to the JSONL, which would reset a debounce timer indefinitely. Reading only post-injection bytes solves this.

### The Stop hook

A shell hook (`~/.claude/hooks/claude-voice-stop.sh`) is registered as a Claude Code `Stop` hook. After each Claude turn completes, it appends `{"type":"result","source":"stop-hook"}` to the session JSONL. The bot's watcher detects this event and fires immediately instead of waiting for a timeout.

### Permission hook

When Claude Code needs permission to use a tool, a `Notification` hook (`claude-voice-permission.sh`) writes a permission request to `~/.claude-voice/permission-request-<id>.json` and polls for a response file. The bot detects the request via a file watcher, sends a Telegram message with Approve/Deny buttons, and writes the response file when the user taps a button. The hook reads the response and exits with 0 (approve) or 2 (deny).

### Voice pipeline

Incoming voice notes (OGG format) are downloaded from Telegram, transcribed with OpenAI Whisper (`whisper-1`), optionally cleaned up by Claude Haiku, and injected into Claude Code as text. The response is narrated by Claude Haiku into plain prose (no markdown), then converted to audio by OpenAI TTS and sent back as a Telegram voice note.

## Security

- **Chat ID allowlist**: configure your Telegram chat ID in the setup wizard (or in `~/.claude-voice/config.json` as `allowedChatId`). The bot silently ignores messages from all other chat IDs.
- **Bot token**: keep your bot token private. Anyone who can message your bot can run commands on your machine.
- **Tool permissions**: by default Claude Code runs with `acceptEdits` permission mode. The permission hook lets you approve or deny individual tool uses from Telegram.
- **Local only**: the bot runs entirely on your Mac. No data is sent anywhere except to the Telegram Bot API, Anthropic API, and OpenAI API for the specific operations requested.

## Stack

| Layer | Technology |
|---|---|
| Telegram | [grammy](https://grammy.dev) |
| Session bridge | tmux send-keys + JSONL watcher |
| STT | OpenAI Whisper (`whisper-1`) |
| TTS | OpenAI TTS (`nova` voice) |
| Narrator | Claude Haiku (`claude-haiku-4-5-20251001`) |
| Voice polish | Claude Haiku |
| TUI | [Ink](https://github.com/vadimdemedes/ink) (React for terminals) |
| Runtime | Node.js + TypeScript (`tsx`) |
| Service | macOS launchd |

---

## What else could this be called?

Some names that might suit this better than `claude-voice`:

| Name | Vibe |
|---|---|
| **sidechannel** | A private back-channel to your dev machine — technical, evocative |
| **pocketclaude** | Your AI in your pocket, always on call |
| **whispr** | Whisper to your AI; it whispers back |
| **codepage** | Like a pager, but for your code |
| **tapline** | You tap the message, it runs the code |
| **telebrain** | Telegram as a brain interface |
| **fieldwork** | Do real work from anywhere |
\`\`\`
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: comprehensive README with install, usage, and architecture"
```

---

## Task 12: Final test pass — add tests for new commands and middleware

**Files:**
- Modify: `src/telegram/bot.test.ts`

**Step 1: Add remaining test coverage**

Add to `src/telegram/bot.test.ts`:

```typescript
// /help
describe("/help command", () => {
  it("replies with a command list including /sessions and /detach", async () => {
    const { bot, apiCalls } = await makeBot();
    await bot.handleUpdate(commandUpdate("/help"));
    const texts = apiCalls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("/sessions"))).toBe(true);
    expect(texts.some((t) => t.includes("/detach"))).toBe(true);
  });
});

// /restart
describe("/restart command", () => {
  it("replies with Restarting…", async () => {
    const { bot, apiCalls } = await makeBot();
    await bot.handleUpdate(commandUpdate("/restart"));
    const texts = apiCalls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Restarting"))).toBe(true);
  });
});
```

**Step 2: Run all tests**

```bash
cd /Users/luca/repositories/claude-voice && npm test
```
Expected: all pass

**Step 3: Commit**

```bash
git add src/telegram/bot.test.ts
git commit -m "test: add coverage for /help and /restart commands"
```

---

## Task 13: Final verification

```bash
cd /Users/luca/repositories/claude-voice
npm test
git log --oneline -15
```

Verify:
- All tests pass
- 13 commits on the branch covering the full refactor
- `claude-voice` binary still works (manual test: `claude-voice` launches TUI)
