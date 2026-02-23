import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBot } from "./bot.js";
import { findClaudePane, listTmuxPanes, isClaudePane, launchClaudeInWindow, killWindow, sendKeysToPane, injectInput } from "../session/tmux.js";
import { getAttachedSession, listSessions, getLatestSessionFileForCwd, readSessionLines, parseJsonlLines } from "../session/history.js";
import { unlink, writeFile } from "fs/promises";
import { watchForResponse, getFileSize } from "../session/monitor.js";
import { isServiceInstalled } from "../service/index.js";
import { handleVoice } from "./handlers/voice.js";
import { handleImageMessage } from "./handlers/image.js";
import { summarizeSession } from "../agent/summarizer.js";
import { isTimerActive, stopTimer } from "./handlers/timer.js";
import { fetchAndOfferImages } from "./handlers/text.js";
import { access } from "fs/promises";

vi.mock("./handlers/voice.js", () => ({
  handleVoice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./handlers/image.js", () => ({
  handleImageMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./handlers/timer.js", () => ({
  isTimerActive: vi.fn().mockReturnValue(false),
  stopTimer: vi.fn().mockReturnValue(null),
  setTimerSetup: vi.fn(),
  getTimerSetup: vi.fn().mockReturnValue(null),
  startTimer: vi.fn(),
}));

vi.mock("../session/tmux.js", () => ({
  findClaudePane: vi.fn(),
  listTmuxPanes: vi.fn(),
  isClaudePane: vi.fn(),
  launchClaudeInWindow: vi.fn(),
  killWindow: vi.fn(),
  injectInput: vi.fn(),
  sendKeysToPane: vi.fn(),
  sendRawKeyToPane: vi.fn(),
}));

vi.mock("../session/history.js", () => ({
  ATTACHED_SESSION_PATH: "/tmp/cv-test/attached",
  getAttachedSession: vi.fn(),
  listSessions: vi.fn(),
  getLatestSessionFileForCwd: vi.fn(),
  readSessionLines: vi.fn().mockResolvedValue([]),
  parseJsonlLines: vi.fn().mockReturnValue({ lastMessage: "", cwd: "", toolCalls: [], allMessages: [] }),
}));

vi.mock("../session/monitor.js", () => ({
  watchForResponse: vi.fn().mockReturnValue(() => {}),
  getFileSize: vi.fn().mockResolvedValue(100),
}));

vi.mock("./notifications.js", () => ({
  registerForNotifications: vi.fn(),
  resolveWaitingAction: vi.fn(),
  notifyResponse: vi.fn(),
  sendPing: vi.fn(),
}));

vi.mock("../session/permissions.js", () => ({
  watchPermissionRequests: vi.fn().mockReturnValue(() => {}),
  respondToPermission: vi.fn(),
}));

vi.mock("../agent/summarizer.js", () => ({
  summarizeSession: vi.fn(),
}));

vi.mock("../voice.js", () => ({
  transcribeAudio: vi.fn(),
  synthesizeSpeech: vi.fn(),
  polishTranscript: vi.fn(),
}));

vi.mock("../narrator.js", () => ({
  narrate: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  log: vi.fn(),
}));

vi.mock("../service/index.js", () => ({
  isServiceInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
}));

vi.mock("fs/promises", () => ({
  unlink: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(""),
  access: vi.fn().mockRejectedValue(new Error("ENOENT")), // polish voice on by default
  stat: vi.fn().mockResolvedValue({ mtimeMs: Date.now() }),
}));

// ---------------------------------------------------------------------------
// Bot setup helpers
// ---------------------------------------------------------------------------

const BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: "TestBot",
  username: "testbot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

type ApiCall = { method: string; payload: Record<string, unknown> };

async function makeBot() {
  const bot = createBot("test-token");
  const apiCalls: ApiCall[] = [];

  // Install a transformer that intercepts all API calls without hitting the network
  bot.api.config.use(async (prev, method, payload, signal) => {
    apiCalls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "getMe") {
      return { ok: true as const, result: BOT_INFO };
    }
    return { ok: true as const, result: {} };
  });

  await bot.init();

  return { bot, apiCalls };
}

function callbackUpdate(data: string, chatId = 12345) {
  return {
    update_id: 1,
    callback_query: {
      id: "cq-id",
      from: { id: chatId, is_bot: false, first_name: "Test" },
      message: {
        message_id: 42,
        date: 0,
        chat: { id: chatId, type: "private" as const, first_name: "Test" },
        text: "original message",
      },
      data,
      chat_instance: "chat",
    },
  };
}

function commandUpdate(command: string, chatId = 12345) {
  const text = command.startsWith("/") ? command : `/${command}`;
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: chatId, type: "private" as const, first_name: "Test" },
      from: { id: chatId, is_bot: false, first_name: "Test" },
      text,
      entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0].length }],
    },
  };
}

function textUpdate(text: string, chatId = 12345) {
  return {
    update_id: 2,
    message: {
      message_id: 2,
      date: 0,
      chat: { id: chatId, type: "private" as const, first_name: "Test" },
      from: { id: chatId, is_bot: false, first_name: "Test" },
      text,
    },
  };
}

// ---------------------------------------------------------------------------
// /clear then question — session rotation e2e (bot handler level)
//
// Verifies that when the user sends /clear followed by a question, the bot
// sets up the watcher on the NEW session file (created after /clear), not the
// old one.
//
// Key mechanics:
//  - /clear is a bot command: handled by bot.command("clear") → sendKeysToPane only,
//    NO watcher is set up (Claude Code has no response for /clear itself)
//  - The question is a plain text message: handled by processTextTurn →
//    snapshotBaseline → getLatestSessionFileForCwd → startInjectionWatcher →
//    watchForResponse
//
// Reproduces the bug where the new session file had file-history-snapshot
// metadata (non-empty, no assistant messages), was skipped by
// getLatestSessionFileForCwd, and the bot watched the old file forever.
// ---------------------------------------------------------------------------

describe("e2e: /clear then question — watchForResponse called on new session file", () => {
  const CWD = "/proj/myapp";
  const NEW_SESSION = { sessionId: "new-session-id", filePath: "/new-session-id.jsonl" };

  beforeEach(() => {
    vi.clearAllMocks();
    // /clear goes through bot.command("clear") → getAttachedSession + findClaudePane + sendKeysToPane
    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "old-session-id", cwd: CWD });
    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%1" });
    // question goes through processTextTurn → getLatestSessionFileForCwd must return new session
    vi.mocked(getLatestSessionFileForCwd).mockResolvedValue(NEW_SESSION);
    vi.mocked(getFileSize).mockResolvedValue(0);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%1" });
  });

  afterEach(() => {
    // mockReset clears implementations AND once-queues; vi.clearAllMocks() does not.
    // This prevents leftover state from leaking into subsequent describe blocks.
    vi.mocked(getLatestSessionFileForCwd).mockReset();
    vi.mocked(injectInput).mockReset();
    vi.mocked(getAttachedSession).mockReset();
    vi.mocked(findClaudePane).mockReset();
  });

  it("after /clear, question message watches the new session file", async () => {
    const { bot } = await makeBot();

    let capturedWatchPath: string | null = null;
    vi.mocked(watchForResponse).mockImplementation((filePath) => {
      capturedWatchPath = filePath;
      return () => {};
    });

    // Message 1: /clear → bot.command("clear") → sendKeysToPane only, NO watcher
    await bot.handleUpdate(commandUpdate("/clear") as any);
    expect(capturedWatchPath).toBeNull(); // confirmed: /clear does not start a watcher

    // Message 2: question → processTextTurn → snapshotBaseline → watchForResponse
    // After /clear, getLatestSessionFileForCwd returns the new session (with metadata)
    await bot.handleUpdate(textUpdate("Does Claude Code fire a hook on Ctrl+C?") as any);

    // The watcher must be on the NEW session file, not the old one
    expect(capturedWatchPath).toBe(NEW_SESSION.filePath);
  });
});

// ---------------------------------------------------------------------------
// processTextTurn — no session / no Claude Code running
// ---------------------------------------------------------------------------

describe("processTextTurn edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure watcher is inactive so the interrupt block doesn't fire
    vi.mocked(findClaudePane).mockResolvedValue({ found: false, reason: "no_claude_pane" });
  });

  afterEach(() => {
    vi.mocked(getAttachedSession).mockReset();
    vi.mocked(listSessions).mockReset();
    vi.mocked(injectInput).mockReset();
    vi.mocked(findClaudePane).mockReset();
    vi.mocked(getLatestSessionFileForCwd).mockReset();
  });

  it("replies 'No session attached' when no session exists", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue(null);
    vi.mocked(listSessions).mockResolvedValue([]);

    await bot.handleUpdate(textUpdate("hello") as any);

    const texts = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("No session attached"))).toBe(true);
  });

  it("replies 'No Claude Code running' when injection fails", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({ sessionId: "s1", filePath: "/s1.jsonl" });
    vi.mocked(getFileSize).mockResolvedValue(0);
    vi.mocked(injectInput).mockResolvedValue({ found: false, reason: "no_claude_pane" });

    await bot.handleUpdate(textUpdate("hello") as any);

    const texts = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("No Claude Code running"))).toBe(true);
  });

  it("sets up watcher when injection succeeds", async () => {
    const { bot } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({ sessionId: "s1", filePath: "/s1.jsonl" });
    vi.mocked(getFileSize).mockResolvedValue(0);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%1" });

    let watchCalled = false;
    vi.mocked(watchForResponse).mockImplementation(() => {
      watchCalled = true;
      return () => {};
    });

    await bot.handleUpdate(textUpdate("hello") as any);

    expect(watchCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /detach command
// ---------------------------------------------------------------------------

describe("/detach command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows close-window keyboard when Claude Code pane is running", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%5" });

    await bot.handleUpdate(commandUpdate("/detach") as any);

    expect(vi.mocked(unlink)).toHaveBeenCalled();
    const sendMessages = apiCalls.filter((c) => c.method === "sendMessage");
    const texts = sendMessages.map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Close the tmux Claude Code window"))).toBe(true);
  });

  it("sends simple Detached message when no Claude Code pane is running", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(findClaudePane).mockResolvedValue({ found: false, reason: "no_claude_pane" });

    await bot.handleUpdate(commandUpdate("/detach") as any);

    const sendMessages = apiCalls.filter((c) => c.method === "sendMessage");
    const texts = sendMessages.map((c) => c.payload.text as string);
    expect(texts.some((t) => t === "Detached.")).toBe(true);
  });

  it("detaches even when no session is attached", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue(null);

    await bot.handleUpdate(commandUpdate("/detach") as any);

    expect(vi.mocked(unlink)).toHaveBeenCalled();
    const sendMessages = apiCalls.filter((c) => c.method === "sendMessage");
    const texts = sendMessages.map((c) => c.payload.text as string);
    expect(texts.some((t) => t === "Detached.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detach: callbacks
// ---------------------------------------------------------------------------

describe("detach: callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detach:keep removes buttons without changing text", async () => {
    const { bot, apiCalls } = await makeBot();

    await bot.handleUpdate(callbackUpdate("detach:keep") as any);

    const answers = apiCalls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.some((c) => c.payload.text === "Kept open.")).toBe(true);
    const edits = apiCalls.filter((c) => c.method === "editMessageReplyMarkup");
    expect(edits.length).toBeGreaterThan(0);
  });

  it("detach:close:<paneId> kills the tmux window", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(killWindow).mockResolvedValue(undefined);

    await bot.handleUpdate(callbackUpdate("detach:close:%5") as any);

    expect(killWindow).toHaveBeenCalledWith("%5");

    const answers = apiCalls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.some((c) => c.payload.text === "Closed.")).toBe(true);

    const edits = apiCalls.filter((c) => c.method === "editMessageText");
    expect(edits.some((c) => c.payload.text === "Detached. tmux window closed.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// session: callbacks
// ---------------------------------------------------------------------------

describe("session: callbacks", () => {
  const SESSION = {
    sessionId: "s1",
    cwd: "/proj",
    projectName: "myproject",
    lastMessage: "",
    mtime: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function setupWithSessions(bot: Awaited<ReturnType<typeof makeBot>>["bot"], apiCalls: ApiCall[]) {
    const pane = { paneId: "%1", cwd: SESSION.cwd, command: "claude", shellPid: 0 };
    vi.mocked(listTmuxPanes).mockResolvedValue([pane]);
    vi.mocked(isClaudePane).mockReturnValue(true);
    vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({ sessionId: SESSION.sessionId, filePath: `/tmp/${SESSION.sessionId}.jsonl` });
    vi.mocked(readSessionLines).mockResolvedValue([]);
    vi.mocked(parseJsonlLines).mockReturnValue({ lastMessage: SESSION.lastMessage, cwd: SESSION.cwd, toolCalls: [], allMessages: [] });
    await bot.handleUpdate(commandUpdate("/sessions") as any);
    // Clear apiCalls after /sessions so we start fresh for the actual test assertions
    apiCalls.length = 0;
  }

  it("attaches immediately when Claude Code is already running", async () => {
    const { bot, apiCalls } = await makeBot();
    await setupWithSessions(bot, apiCalls);

    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%3" });
    vi.mocked(getAttachedSession).mockResolvedValue(null);

    await bot.handleUpdate(callbackUpdate("session:s1") as any);

    expect(writeFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("s1"),
      expect.anything()
    );
    const sendMessages = apiCalls.filter((c) => c.method === "sendMessage");
    const texts = sendMessages.map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Attached"))).toBe(true);
  });

  it("shows launch prompt when Claude Code is not running", async () => {
    const { bot, apiCalls } = await makeBot();
    await setupWithSessions(bot, apiCalls);

    vi.mocked(findClaudePane).mockResolvedValue({ found: false, reason: "no_claude_pane" });

    await bot.handleUpdate(callbackUpdate("session:s1") as any);

    const sendMessages = apiCalls.filter((c) => c.method === "sendMessage");
    const texts = sendMessages.map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Launch"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// launch: callbacks
// ---------------------------------------------------------------------------

describe("launch: callbacks", () => {
  const SESSION = {
    sessionId: "s1",
    cwd: "/proj/myproject",
    projectName: "myproject",
    lastMessage: "",
    mtime: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function setupWithSessions(bot: Awaited<ReturnType<typeof makeBot>>["bot"], apiCalls: ApiCall[]) {
    const pane = { paneId: "%1", cwd: SESSION.cwd, command: "claude", shellPid: 0 };
    vi.mocked(listTmuxPanes).mockResolvedValue([pane]);
    vi.mocked(isClaudePane).mockReturnValue(true);
    vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({ sessionId: SESSION.sessionId, filePath: `/tmp/${SESSION.sessionId}.jsonl` });
    vi.mocked(readSessionLines).mockResolvedValue([]);
    vi.mocked(parseJsonlLines).mockReturnValue({ lastMessage: SESSION.lastMessage, cwd: SESSION.cwd, toolCalls: [], allMessages: [] });
    await bot.handleUpdate(commandUpdate("/sessions") as any);
    apiCalls.length = 0;
  }

  it("launch:cancel removes keyboard", async () => {
    const { bot, apiCalls } = await makeBot();
    await setupWithSessions(bot, apiCalls);

    await bot.handleUpdate(callbackUpdate("launch:cancel:s1") as any);

    const answers = apiCalls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.some((c) => c.payload.text === "Cancelled.")).toBe(true);
    const edits = apiCalls.filter((c) => c.method === "editMessageReplyMarkup");
    expect(edits.length).toBeGreaterThan(0);
  });

  it("launch:<id> launches Claude Code and shows launching message", async () => {
    const { bot, apiCalls } = await makeBot();
    await setupWithSessions(bot, apiCalls);

    vi.mocked(launchClaudeInWindow).mockResolvedValue("%9");
    // findClaudePane always returns found so the first poll (at t=2000ms) fires immediately
    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%9" });

    await bot.handleUpdate(callbackUpdate("launch:s1") as any);

    expect(launchClaudeInWindow).toHaveBeenCalledWith("/proj/myproject", "myproject", false);
    expect(writeFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("s1"),
      expect.anything()
    );

    const editTexts = apiCalls
      .filter((c) => c.method === "editMessageText")
      .map((c) => c.payload.text as string);
    expect(editTexts.some((t) => t.includes("Launching"))).toBe(true);

    // The polling loop waits 2000ms before the first findClaudePane call.
    // Give it a little extra buffer to fire and send the ready message.
    await new Promise((r) => setTimeout(r, 2100));

    const sendMessages = apiCalls.filter((c) => c.method === "sendMessage");
    const texts = sendMessages.map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("ready"))).toBe(true);
  }, 10000);

  it("launch:skip:<id> launches with dangerously-skip-permissions", async () => {
    const { bot, apiCalls } = await makeBot();
    await setupWithSessions(bot, apiCalls);

    vi.mocked(launchClaudeInWindow).mockResolvedValue("%9");
    vi.mocked(findClaudePane).mockResolvedValue({ found: false, reason: "no_claude_pane" });

    await bot.handleUpdate(callbackUpdate("launch:skip:s1") as any);

    expect(launchClaudeInWindow).toHaveBeenCalledWith("/proj/myproject", "myproject", true);
  });
});

// ---------------------------------------------------------------------------
// /help command
// ---------------------------------------------------------------------------

describe("/help command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replies with a list including all major commands", async () => {
    const { bot, apiCalls } = await makeBot();
    await bot.handleUpdate(commandUpdate("/help") as any);
    const texts = apiCalls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);
    expect(texts.length).toBeGreaterThan(0);
    const combined = texts.join("\n");
    expect(combined).toMatch(/sessions/i);
    expect(combined).toMatch(/detach/i);
    expect(combined).toMatch(/status/i);
    expect(combined).toMatch(/help/i);
  });
});

// ---------------------------------------------------------------------------
// /restart command
// ---------------------------------------------------------------------------

describe("/restart command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replies with a restarting message", async () => {
    const { bot, apiCalls } = await makeBot();
    await bot.handleUpdate(commandUpdate("/restart") as any);
    const texts = apiCalls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);
    expect(texts.some((t) => /restart/i.test(t))).toBe(true);
  });

  it("persists chat-id before replying", async () => {
    const { bot } = await makeBot();
    await bot.handleUpdate(commandUpdate("/restart", 99999) as any);
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining("chat-id"),
      "99999",
      "utf8"
    );
  });
});

// ---------------------------------------------------------------------------
// /model command
// ---------------------------------------------------------------------------

describe("/model command", () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  // Run no-key test first — cache starts null, stays null (fetchModels returns [] without setting cache)
  it("shows fallback keyboard when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { bot, apiCalls } = await makeBot();
    await bot.handleUpdate(commandUpdate("/model") as any);

    const sends = apiCalls.filter((c) => c.method === "sendMessage");
    expect(sends.length).toBeGreaterThan(0);
    const keyboard = sends[0].payload.reply_markup as any;
    const labels = keyboard.inline_keyboard.flat().map((b: any) => b.text);
    expect(labels).toContain("Default (Sonnet)");
    expect(labels).toContain("Opus 4.6");
    expect(labels).toContain("Sonnet 4.6");
    expect(labels).toContain("Haiku 4.5");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Cache still null — fetch rejects → returns []
  it("shows fallback keyboard when API fetch fails", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    fetchSpy.mockRejectedValue(new Error("network error"));

    const { bot, apiCalls } = await makeBot();
    await bot.handleUpdate(commandUpdate("/model") as any);

    const sends = apiCalls.filter((c) => c.method === "sendMessage");
    const keyboard = sends[0].payload.reply_markup as any;
    const labels = keyboard.inline_keyboard.flat().map((b: any) => b.text);
    expect(labels).toContain("Default (Sonnet)");
    expect(labels).toContain("Opus 4.6");
  });

  // This test populates the cache — runs last in this describe block
  it("shows API models when fetch succeeds", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
          { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
        ],
      }),
    });

    const { bot, apiCalls } = await makeBot();
    await bot.handleUpdate(commandUpdate("/model") as any);

    const sends = apiCalls.filter((c) => c.method === "sendMessage");
    const keyboard = sends[0].payload.reply_markup as any;
    const labels = keyboard.inline_keyboard.flat().map((b: any) => b.text);
    expect(labels).toContain("Default (Sonnet)");
    expect(labels).toContain("Claude Opus 4.6");
    expect(labels).toContain("Claude Sonnet 4.6");
    // Should NOT have the hardcoded fallbacks
    expect(labels).not.toContain("Haiku 4.5");
  });
});

// ---------------------------------------------------------------------------
// model: callbacks
// ---------------------------------------------------------------------------

describe("model: callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends /model command to tmux pane on happy path", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%3" });

    await bot.handleUpdate(callbackUpdate("model:claude-opus-4-6") as any);

    expect(sendKeysToPane).toHaveBeenCalledWith("%3", "/model claude-opus-4-6");
    const answers = apiCalls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.some((c) => c.payload.text === "Switched to claude-opus-4-6")).toBe(true);
    const edits = apiCalls.filter((c) => c.method === "editMessageText");
    expect(edits.some((c) => (c.payload.text as string).includes("claude-opus-4-6"))).toBe(true);
  });

  it("answers with error when no session is attached", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue(null);

    await bot.handleUpdate(callbackUpdate("model:claude-opus-4-6") as any);

    const answers = apiCalls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.some((c) => c.payload.text === "No session attached.")).toBe(true);
    expect(sendKeysToPane).not.toHaveBeenCalled();
  });

  it("answers with error when no tmux pane is found", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(findClaudePane).mockResolvedValue({ found: false, reason: "no_claude_pane" });

    await bot.handleUpdate(callbackUpdate("model:claude-opus-4-6") as any);

    const answers = apiCalls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.some((c) => c.payload.text === "Could not find the Claude Code tmux pane.")).toBe(true);
    expect(sendKeysToPane).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Update helpers for media message types
// ---------------------------------------------------------------------------

function photoUpdate(chatId = 12345) {
  return {
    update_id: 3,
    message: {
      message_id: 3, date: 0,
      chat: { id: chatId, type: "private" as const, first_name: "Test" },
      from: { id: chatId, is_bot: false, first_name: "Test" },
      photo: [
        { file_id: "small-id", file_unique_id: "s1", width: 90, height: 90 },
        { file_id: "large-id", file_unique_id: "l1", width: 800, height: 600 },
      ],
      caption: "test caption",
    },
  };
}

function documentUpdate(mimeType: string, chatId = 12345) {
  return {
    update_id: 4,
    message: {
      message_id: 4, date: 0,
      chat: { id: chatId, type: "private" as const, first_name: "Test" },
      from: { id: chatId, is_bot: false, first_name: "Test" },
      document: { file_id: "doc-id", file_unique_id: "d1", file_name: "image.png", mime_type: mimeType },
    },
  };
}

function voiceUpdate(chatId = 12345) {
  return {
    update_id: 5,
    message: {
      message_id: 5, date: 0,
      chat: { id: chatId, type: "private" as const, first_name: "Test" },
      from: { id: chatId, is_bot: false, first_name: "Test" },
      voice: { file_id: "voice-id", file_unique_id: "v1", duration: 3 },
    },
  };
}

// ---------------------------------------------------------------------------
// message:photo handler
// ---------------------------------------------------------------------------

describe("message:photo handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls handleImageMessage with the largest photo", async () => {
    const { bot } = await makeBot();

    await bot.handleUpdate(photoUpdate() as any);

    expect(handleImageMessage).toHaveBeenCalledWith(
      expect.anything(),   // ctx
      12345,               // chatId
      "large-id",          // file_id of the largest photo
      "image/jpeg",        // mime type
      "test caption",      // caption
      "test-token"         // token
    );
  });

  it("replies with error when handleImageMessage throws", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(handleImageMessage).mockRejectedValueOnce(new Error("image processing failed"));

    await bot.handleUpdate(photoUpdate() as any);

    const texts = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Couldn't process the image"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// message:document handler
// ---------------------------------------------------------------------------

describe("message:document handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls handleImageMessage for image MIME types", async () => {
    const { bot } = await makeBot();

    await bot.handleUpdate(documentUpdate("image/png") as any);

    expect(handleImageMessage).toHaveBeenCalledWith(
      expect.anything(),   // ctx
      12345,               // chatId
      "doc-id",            // file_id
      "image/png",         // mime type
      "",                  // caption (none in documentUpdate)
      "test-token"         // token
    );
  });

  it("ignores non-image documents", async () => {
    const { bot } = await makeBot();

    await bot.handleUpdate(documentUpdate("application/pdf") as any);

    expect(handleImageMessage).not.toHaveBeenCalled();
  });

  it("replies with error when handleImageMessage throws", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(handleImageMessage).mockRejectedValueOnce(new Error("image processing failed"));

    await bot.handleUpdate(documentUpdate("image/png") as any);

    const texts = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Couldn't process the image"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// message:voice handler
// ---------------------------------------------------------------------------

describe("message:voice handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls handleVoice with correct arguments", async () => {
    const { bot } = await makeBot();

    await bot.handleUpdate(voiceUpdate() as any);

    expect(handleVoice).toHaveBeenCalledWith(
      expect.anything(),   // ctx
      12345,               // chatId
      "test-token"         // token
    );
  });

  it("replies with error when handleVoice throws", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(handleVoice).mockRejectedValueOnce(new Error("voice processing failed"));

    await bot.handleUpdate(voiceUpdate() as any);

    const texts = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Couldn't process your voice message"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// message:text error handling
// ---------------------------------------------------------------------------

describe("message:text error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.mocked(getAttachedSession).mockReset();
    vi.mocked(findClaudePane).mockReset();
  });

  it("replies 'Something went wrong' when processTextTurn throws", async () => {
    const { bot, apiCalls } = await makeBot();

    // Make getAttachedSession throw an unexpected error (not return null)
    // This will cause processTextTurn to throw, triggering the catch block in bot.ts
    vi.mocked(getAttachedSession).mockRejectedValue(new Error("unexpected DB failure"));
    vi.mocked(findClaudePane).mockResolvedValue({ found: false, reason: "no_claude_pane" });

    await bot.handleUpdate(textUpdate("hello") as any);

    const texts = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Something went wrong"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /status command
// ---------------------------------------------------------------------------

describe("/status command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.mocked(getAttachedSession).mockReset();
    vi.mocked(listSessions).mockReset();
  });

  it("shows project name and watcher state when session is attached", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj/myapp" });
    vi.mocked(listSessions).mockResolvedValue([
      { sessionId: "s1", cwd: "/proj/myapp", projectName: "myapp", lastMessage: "", mtime: new Date() },
    ]);

    await bot.handleUpdate(commandUpdate("/status") as any);

    const texts = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("myapp") && t.includes("watcher"))).toBe(true);
  });

  it("replies 'No session attached' when no session exists", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue(null);

    await bot.handleUpdate(commandUpdate("/status") as any);

    const texts = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("No session attached"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /images command
// ---------------------------------------------------------------------------

describe("/images command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.mocked(getAttachedSession).mockReset();
  });

  it("sends asking message when session is attached", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(injectInput).mockResolvedValue({ found: false, reason: "no_claude_pane" });

    await bot.handleUpdate(commandUpdate("/images") as any);

    const texts = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Asking Claude Code for image files"))).toBe(true);
  });

  it("replies 'No session attached' when no session exists", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue(null);

    await bot.handleUpdate(commandUpdate("/images") as any);

    const texts = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("No session attached"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /timer command
// ---------------------------------------------------------------------------

describe("/timer command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops timer and shows message when timer is active", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(isTimerActive).mockReturnValue(true);
    vi.mocked(stopTimer).mockReturnValue({ frequencyMin: 5, prompt: "check status" });

    await bot.handleUpdate(commandUpdate("/timer") as any);

    const texts = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Timer stopped") && t.includes("5min"))).toBe(true);
  });

  it("shows setup keyboard when timer is inactive", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(isTimerActive).mockReturnValue(false);

    await bot.handleUpdate(commandUpdate("/timer") as any);

    const sends = apiCalls.filter((c) => c.method === "sendMessage");
    expect(sends.length).toBeGreaterThan(0);
    const keyboard = sends[0].payload.reply_markup as any;
    expect(keyboard).toBeDefined();
    expect(keyboard.inline_keyboard).toBeDefined();
    const texts = sends.map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("recurring prompt"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /summarize command
// ---------------------------------------------------------------------------

describe("/summarize command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows summary on happy path", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(summarizeSession).mockResolvedValue("Here is a summary of the session.");

    await bot.handleUpdate(commandUpdate("/summarize") as any);

    const texts = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("summary of the session"))).toBe(true);
  });

  it("shows error message when summarization fails", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(summarizeSession).mockRejectedValue(new Error("API failure"));

    await bot.handleUpdate(commandUpdate("/summarize") as any);

    const texts = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Could not generate summary"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /polishvoice command
// ---------------------------------------------------------------------------

describe("/polishvoice command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("toggles polish off when currently on (flag file absent)", async () => {
    const { bot, apiCalls } = await makeBot();

    // access rejects = file absent = polish ON (default in mock setup)
    vi.mocked(access).mockRejectedValue(new Error("ENOENT"));

    await bot.handleUpdate(commandUpdate("/polishvoice") as any);

    const texts = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Voice polish") && t.includes("off"))).toBe(true);
    expect(writeFile).toHaveBeenCalled();
  });

  it("toggles polish on when currently off (flag file exists)", async () => {
    const { bot, apiCalls } = await makeBot();

    // access resolves = file exists = polish OFF
    vi.mocked(access).mockResolvedValue(undefined as any);

    await bot.handleUpdate(commandUpdate("/polishvoice") as any);

    const texts = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Voice polish") && t.includes("on"))).toBe(true);
    expect(unlink).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// /escape command
// ---------------------------------------------------------------------------

describe("/escape command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.mocked(getAttachedSession).mockReset();
    vi.mocked(findClaudePane).mockReset();
  });

  it("sends Escape via sendClaudeCommand", async () => {
    const { bot } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%3" });

    await bot.handleUpdate(commandUpdate("/escape") as any);

    expect(sendKeysToPane).toHaveBeenCalledWith("%3", "Escape");
  });
});
