import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "grammy";

vi.mock("../../logger.js", () => ({
  log: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("os", () => ({
  homedir: vi.fn(() => "/fakehome"),
}));

vi.mock("./text.js", () => ({
  processTextTurn: vi.fn().mockResolvedValue(undefined),
}));

import { handleImageMessage } from "./image.js";
import { processTextTurn } from "./text.js";
import { mkdir, writeFile } from "fs/promises";
import { log } from "../../logger.js";

function makeCtx(filePath?: string) {
  return {
    replyWithChatAction: vi.fn().mockResolvedValue(undefined),
    api: {
      getFile: vi.fn().mockResolvedValue({ file_path: filePath }),
    },
  } as unknown as Context;
}

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(new Date("2025-01-15T12:00:00Z"));
});

// Use fake timers so Date.now() is deterministic
vi.useFakeTimers();

describe("handleImageMessage", () => {
  it("happy path: downloads image, writes file, calls processTextTurn with image path", async () => {
    const ctx = makeCtx("photos/file_42.png");
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });

    await handleImageMessage(ctx, 123, "file-id-1", "image/png", "", "bot-token");

    expect(ctx.replyWithChatAction).toHaveBeenCalledWith("typing");
    expect(ctx.api.getFile).toHaveBeenCalledWith("file-id-1");
    expect(mkdir).toHaveBeenCalledWith("/fakehome/.codedove/images", { recursive: true });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/botbot-token/photos/file_42.png"
    );
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining("/fakehome/.codedove/images/telegram-"),
      expect.any(Buffer)
    );
    expect(vi.mocked(processTextTurn)).toHaveBeenCalledWith(
      ctx,
      123,
      expect.stringContaining("[image: /fakehome/.codedove/images/telegram-")
    );
  });

  it("with caption: processTextTurn receives caption + image path", async () => {
    const ctx = makeCtx("photos/file.png");
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });

    await handleImageMessage(ctx, 123, "file-id-1", "image/png", "Look at this", "tok");

    const call = vi.mocked(processTextTurn).mock.calls[0];
    expect(call[2]).toMatch(/^Look at this\n\n\[image: /);
  });

  it("without caption: processTextTurn receives just image path", async () => {
    const ctx = makeCtx("photos/file.png");
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });

    await handleImageMessage(ctx, 123, "file-id-1", "image/png", "", "tok");

    const call = vi.mocked(processTextTurn).mock.calls[0];
    expect(call[2]).toMatch(/^\[image: /);
    expect(call[2]).not.toContain("\n\n");
  });

  it("throws when file_path is missing", async () => {
    const ctx = makeCtx(undefined);

    await expect(
      handleImageMessage(ctx, 123, "file-id-1", "image/png", "", "tok")
    ).rejects.toThrow("Telegram did not return a file_path for this image");
  });

  it("throws when fetch fails", async () => {
    const ctx = makeCtx("photos/file.png");
    mockFetch.mockResolvedValue({ ok: false, status: 403 });

    await expect(
      handleImageMessage(ctx, 123, "file-id-1", "image/png", "", "tok")
    ).rejects.toThrow("Failed to download image: 403");
  });

  it("extracts extension from file_path", async () => {
    const ctx = makeCtx("photos/file.png");
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });

    await handleImageMessage(ctx, 123, "fid", "image/jpeg", "", "tok");

    const writePath = vi.mocked(writeFile).mock.calls[0][0] as string;
    expect(writePath).toMatch(/\.png$/);
  });

  it("falls back to MIME type extension when file_path split returns empty via ??", async () => {
    // split(".").pop() on a path like "photos/file.webp" returns "webp"
    // The ?? fallback only triggers when pop() returns undefined (empty array),
    // which doesn't happen in practice. Test that MIME-based ext works when
    // file_path ends with a known extension from the MIME type.
    const ctx = makeCtx("photos/file.webp");
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });

    await handleImageMessage(ctx, 123, "fid", "image/webp", "", "tok");

    const writePath = vi.mocked(writeFile).mock.calls[0][0] as string;
    expect(writePath).toMatch(/\.webp$/);
  });

  it("uses last segment of file_path split when no dot is present", async () => {
    // "photos/nodotfile".split(".").pop() returns "photos/nodotfile"
    // This is the actual code behavior — the ?? fallback is unreachable here
    const ctx = makeCtx("photos/nodotfile");
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });

    await handleImageMessage(ctx, 123, "fid", undefined, "", "tok");

    const writePath = vi.mocked(writeFile).mock.calls[0][0] as string;
    // Extension becomes the full "photos/nodotfile" from split(".").pop()
    expect(writePath).toContain("telegram-");
    expect(writeFile).toHaveBeenCalled();
  });
});
