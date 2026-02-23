import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Context } from "grammy";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetAttachedSession = vi.fn();
const mockListSessions = vi.fn();
vi.mock("../../session/history.js", () => ({
  ATTACHED_SESSION_PATH: "/tmp/codedove-test/attached",
  getAttachedSession: (...args: unknown[]) => mockGetAttachedSession(...args),
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  getLatestSessionFileForCwd: vi.fn().mockResolvedValue({ sessionId: "s1", filePath: "/s1.jsonl" }),
}));

const mockWatchForResponse = vi.fn().mockReturnValue(() => {});
const mockGetFileSize = vi.fn().mockResolvedValue(100);
vi.mock("../../session/monitor.js", () => ({
  watchForResponse: (...args: unknown[]) => mockWatchForResponse(...args),
  getFileSize: (...args: unknown[]) => mockGetFileSize(...args),
}));

vi.mock("../notifications.js", () => ({
  notifyResponse: vi.fn(),
  notifyImages: vi.fn(),
  sendPing: vi.fn(),
  registerForNotifications: vi.fn(),
}));

const mockSendMarkdownReply = vi.fn().mockResolvedValue(undefined);
vi.mock("../utils.js", () => ({
  sendMarkdownReply: (...args: unknown[]) => mockSendMarkdownReply(...args),
}));

vi.mock("./sessions.js", () => ({
  launchedPaneId: undefined,
}));

const mockFindClaudePane = vi.fn().mockResolvedValue({ found: false, reason: "no_claude_pane" });
const mockInjectInput = vi.fn().mockResolvedValue({ found: true, paneId: "%1" });
const mockSendInterrupt = vi.fn().mockResolvedValue(undefined);
vi.mock("../../session/tmux.js", () => ({
  findClaudePane: (...args: unknown[]) => mockFindClaudePane(...args),
  injectInput: (...args: unknown[]) => mockInjectInput(...args),
  sendInterrupt: (...args: unknown[]) => mockSendInterrupt(...args),
}));

vi.mock("../../logger.js", () => ({ log: vi.fn() }));

const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn().mockResolvedValue("");
vi.mock("fs/promises", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// Use vi.hoisted to create state that can be referenced in hoisted vi.mock factories
const {
  mockPendingImageCount,
  mockClearPendingImageCount,
  mockPendingImages,
  mockTimerSetup,
  mockSetTimerSetup,
  mockStartTimer,
} = vi.hoisted(() => {
  const state = {
    pendingImageCount: null as { key: string; max: number } | null,
    timerSetup: null as { phase: string; frequencyMin?: number } | null,
  };
  return {
    mockPendingImageCount: state,
    mockClearPendingImageCount: vi.fn(() => { state.pendingImageCount = null; }),
    mockPendingImages: new Map<string, Array<{ mediaType: string; data: string }>>(),
    mockTimerSetup: state,
    mockSetTimerSetup: vi.fn((s: any) => { state.timerSetup = s; }),
    mockStartTimer: vi.fn(),
  };
});

vi.mock("./callbacks/index.js", () => ({
  get pendingImageCount() { return mockPendingImageCount.pendingImageCount; },
  clearPendingImageCount: () => mockClearPendingImageCount(),
  pendingImages: mockPendingImages,
}));

vi.mock("./timer.js", () => ({
  getTimerSetup: () => mockTimerSetup.timerSetup,
  setTimerSetup: (s: any) => mockSetTimerSetup(s),
  startTimer: (...args: unknown[]) => mockStartTimer(...args),
}));

import { ensureSession, processTextTurn } from "./text.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx() {
  return {
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithPhoto: vi.fn().mockResolvedValue(undefined),
    replyWithDocument: vi.fn().mockResolvedValue(undefined),
    replyWithChatAction: vi.fn().mockResolvedValue(undefined),
    chat: { id: 12345 },
  } as unknown as Context;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPendingImageCount.pendingImageCount = null;
  mockPendingImages.clear();
  mockTimerSetup.timerSetup = null;
  mockGetAttachedSession.mockResolvedValue(null);
  mockListSessions.mockResolvedValue([]);
  mockFindClaudePane.mockResolvedValue({ found: false, reason: "no_claude_pane" });
  mockInjectInput.mockResolvedValue({ found: true, paneId: "%1" });
  mockGetFileSize.mockResolvedValue(100);
});

// ---------------------------------------------------------------------------
// ensureSession
// ---------------------------------------------------------------------------

describe("ensureSession", () => {
  it("returns existing attached session", async () => {
    const ctx = makeCtx();
    mockGetAttachedSession.mockResolvedValue({ sessionId: "s1", cwd: "/proj" });

    const result = await ensureSession(ctx, 12345);
    expect(result).toEqual({ sessionId: "s1", cwd: "/proj" });
    // Should NOT call listSessions when already attached
    expect(mockListSessions).not.toHaveBeenCalled();
  });

  it("auto-attaches to most recent session when none attached", async () => {
    const ctx = makeCtx();
    mockGetAttachedSession.mockResolvedValue(null);
    mockListSessions.mockResolvedValue([
      { sessionId: "recent1", cwd: "/proj/recent", projectName: "recent", lastMessage: "", mtime: new Date() },
    ]);

    const result = await ensureSession(ctx, 12345);
    expect(result).toEqual({ sessionId: "recent1", cwd: "/proj/recent" });
    // Should write attached file
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("attached"),
      expect.stringContaining("recent1"),
      "utf8"
    );
    // Should reply with auto-attached message
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("Auto-attached"),
      expect.objectContaining({ parse_mode: "Markdown" })
    );
  });

  it("returns null when no sessions available", async () => {
    const ctx = makeCtx();
    mockGetAttachedSession.mockResolvedValue(null);
    mockListSessions.mockResolvedValue([]);

    const result = await ensureSession(ctx, 12345);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// processTextTurn — pendingImageCount handling
// ---------------------------------------------------------------------------

describe("processTextTurn — pendingImageCount", () => {
  it("when pendingImageCount is set and user sends a number: picks images", async () => {
    const ctx = makeCtx();
    mockPendingImageCount.pendingImageCount = { key: "k1", max: 5 };
    mockPendingImages.set("k1", [
      { mediaType: "image/png", data: Buffer.from("img1").toString("base64") },
      { mediaType: "image/png", data: Buffer.from("img2").toString("base64") },
    ]);

    await processTextTurn(ctx, 12345, "2");

    expect(mockClearPendingImageCount).toHaveBeenCalled();
    expect(ctx.replyWithPhoto).toHaveBeenCalled();
    // Should NOT fall through to session handling
    expect(mockGetAttachedSession).not.toHaveBeenCalled();
  });

  it("when pendingImageCount is set and user sends non-number: clears and falls through", async () => {
    const ctx = makeCtx();
    mockPendingImageCount.pendingImageCount = { key: "k1", max: 5 };
    mockPendingImages.set("k1", [
      { mediaType: "image/png", data: Buffer.from("img1").toString("base64") },
    ]);

    // Set up ensureSession to return null so it doesn't go into injection
    mockGetAttachedSession.mockResolvedValue(null);
    mockListSessions.mockResolvedValue([]);

    await processTextTurn(ctx, 12345, "not a number");

    expect(mockClearPendingImageCount).toHaveBeenCalled();
    // Should fall through to normal message handling (ensureSession called)
    expect(mockGetAttachedSession).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processTextTurn — timer setup flow
// ---------------------------------------------------------------------------

describe("processTextTurn — timer setup", () => {
  it("awaiting_frequency with valid number: advances to awaiting_prompt", async () => {
    const ctx = makeCtx();
    mockTimerSetup.timerSetup = { phase: "awaiting_frequency" };

    await processTextTurn(ctx, 12345, "5");

    expect(mockSetTimerSetup).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "awaiting_prompt", frequencyMin: 5 })
    );
    expect(ctx.reply).toHaveBeenCalledWith("What prompt should be sent each time?");
  });

  it("awaiting_frequency with invalid input: asks again", async () => {
    const ctx = makeCtx();
    mockTimerSetup.timerSetup = { phase: "awaiting_frequency" };

    await processTextTurn(ctx, 12345, "abc");

    expect(ctx.reply).toHaveBeenCalledWith("Please enter a positive number (minutes).");
    // Should NOT advance
    expect(mockSetTimerSetup).not.toHaveBeenCalled();
  });

  it("awaiting_prompt with valid text: starts timer", async () => {
    const ctx = makeCtx();
    mockTimerSetup.timerSetup = { phase: "awaiting_prompt", frequencyMin: 10 };

    await processTextTurn(ctx, 12345, "Run tests");

    expect(mockStartTimer).toHaveBeenCalledWith(10, "Run tests");
    expect(mockSetTimerSetup).toHaveBeenCalledWith(null);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Timer started"));
  });
});
