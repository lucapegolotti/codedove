import { describe, it, expect, vi, beforeEach } from "vitest";
import { splitMessage, splitAtTables, sendMarkdownReply, sendMarkdownMessage } from "./utils.js";

// Mock tableImage — renderTableAsPng returns a small Buffer by default
const mockRenderTableAsPng = vi.fn();
vi.mock("./tableImage.js", () => ({
  renderTableAsPng: (...args: unknown[]) => mockRenderTableAsPng(...args),
}));

vi.mock("../logger.js", () => ({
  log: vi.fn(),
}));

// Mock grammy InputFile — just pass through the buffer
vi.mock("grammy", async () => {
  const actual = await vi.importActual("grammy");
  return {
    ...actual,
    InputFile: class InputFile {
      constructor(public data: unknown, public filename?: string) {}
    },
  };
});

beforeEach(() => vi.clearAllMocks());

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

describe("splitAtTables", () => {
  it("returns a single text part when there are no tables", () => {
    const parts = splitAtTables("Just some plain text.\nAnother line.");
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text");
  });

  it("returns a single table part for a pure table", () => {
    const input = "| A | B |\n|---|---|\n| x | y |";
    const parts = splitAtTables(input);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("table");
    if (parts[0].type === "table") {
      expect(parts[0].lines).toHaveLength(3);
    }
  });

  it("splits text/table/text correctly", () => {
    const input = "Intro\n| A |\n|---|\n| 1 |\nOutro";
    const parts = splitAtTables(input);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ type: "text", content: "Intro" });
    expect(parts[1].type).toBe("table");
    expect(parts[2]).toMatchObject({ type: "text", content: "Outro" });
  });

  it("handles multiple tables separated by text", () => {
    const input = "Before\n| A |\n|---|\n| 1 |\nMiddle\n| B |\n|---|\n| 2 |\nAfter";
    const parts = splitAtTables(input);
    expect(parts).toHaveLength(5);
    expect(parts.filter((p) => p.type === "table")).toHaveLength(2);
    expect(parts.filter((p) => p.type === "text")).toHaveLength(3);
  });

  it("handles adjacent tables with no text between them", () => {
    const input = "| A |\n|---|\n| 1 |\n| B |\n|---|\n| 2 |";
    // All lines start with | so treated as one table block
    const parts = splitAtTables(input);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("table");
  });
});

// ---------------------------------------------------------------------------
// sendMarkdownReply
// ---------------------------------------------------------------------------

describe("sendMarkdownReply", () => {
  function makeCtx() {
    return {
      reply: vi.fn().mockResolvedValue(undefined),
      replyWithPhoto: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  it("sends plain text with Markdown parse_mode", async () => {
    const ctx = makeCtx();
    await sendMarkdownReply(ctx, "Hello world");
    expect(ctx.reply).toHaveBeenCalledWith("Hello world", { parse_mode: "Markdown" });
  });

  it("renders table as PNG and sends photo", async () => {
    const ctx = makeCtx();
    const pngBuf = Buffer.from("fake-png");
    mockRenderTableAsPng.mockReturnValue(pngBuf);

    await sendMarkdownReply(ctx, "| A | B |\n|---|---|\n| 1 | 2 |");
    expect(mockRenderTableAsPng).toHaveBeenCalled();
    expect(ctx.replyWithPhoto).toHaveBeenCalled();
    // Should NOT have sent text for the table part
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("falls back to plain text when Markdown parse fails", async () => {
    const ctx = makeCtx();
    // First call with Markdown fails, second without parse_mode succeeds
    ctx.reply
      .mockRejectedValueOnce(new Error("parse error"))
      .mockResolvedValue(undefined);

    await sendMarkdownReply(ctx, "bad *markdown");
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    // Second call should be without parse_mode
    expect(ctx.reply.mock.calls[1]).toEqual(["bad *markdown"]);
  });
});

// ---------------------------------------------------------------------------
// sendMarkdownMessage
// ---------------------------------------------------------------------------

describe("sendMarkdownMessage", () => {
  function makeBot() {
    return {
      api: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendPhoto: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
  }

  it("sends plain text with Markdown parse_mode via bot.api", async () => {
    const bot = makeBot();
    await sendMarkdownMessage(bot, 12345, "Hello world");
    expect(bot.api.sendMessage).toHaveBeenCalledWith(12345, "Hello world", { parse_mode: "Markdown" });
  });

  it("renders table as PNG and sends photo via bot.api", async () => {
    const bot = makeBot();
    const pngBuf = Buffer.from("fake-png");
    mockRenderTableAsPng.mockReturnValue(pngBuf);

    await sendMarkdownMessage(bot, 12345, "| A | B |\n|---|---|\n| 1 | 2 |");
    expect(mockRenderTableAsPng).toHaveBeenCalled();
    expect(bot.api.sendPhoto).toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to plain text when Markdown parse fails", async () => {
    const bot = makeBot();
    bot.api.sendMessage
      .mockRejectedValueOnce(new Error("parse error"))
      .mockResolvedValue(undefined);

    await sendMarkdownMessage(bot, 12345, "bad *markdown");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.api.sendMessage.mock.calls[1]).toEqual([12345, "bad *markdown"]);
  });
});
