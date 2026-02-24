import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Bot, Context } from "grammy";
import { InputFile } from "grammy";

vi.mock("../../../logger.js", () => ({
  log: vi.fn(),
}));

import {
  handleImagesCallback,
  pendingImages,
  pendingImageCount,
  clearPendingImageCount,
} from "./images.js";
import { log } from "../../../logger.js";

function makeCtx() {
  return {
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    chat: { id: 12345 },
  } as unknown as Context;
}

function makeBot() {
  return {
    api: {
      sendPhoto: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Bot;
}

beforeEach(() => {
  vi.clearAllMocks();
  pendingImages.clear();
  clearPendingImageCount();
});

describe("handleImagesCallback", () => {
  describe("skip action", () => {
    it("deletes from pendingImages, answers Skipped., edits markup", async () => {
      const ctx = makeCtx();
      const bot = makeBot();
      pendingImages.set("mykey", [{ data: "abc", mediaType: "image/png" }]);

      await handleImagesCallback(ctx, "images:skip:mykey", bot);

      expect(pendingImages.has("mykey")).toBe(false);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Skipped." });
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalled();
    });
  });

  describe("part action", () => {
    it("sets pendingImageCount and asks how many when images available", async () => {
      const ctx = makeCtx();
      const bot = makeBot();
      const images = [
        { data: "abc", mediaType: "image/png" },
        { data: "def", mediaType: "image/jpeg" },
      ];
      pendingImages.set("k1", images);

      await handleImagesCallback(ctx, "images:part:k1", bot);

      // pendingImageCount is a module-level let; we imported it
      // but since it's re-read via the module, check via the export
      const { pendingImageCount: pic } = await import("./images.js");
      expect(pic).toEqual({ key: "k1", max: 2 });
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith();
      expect(ctx.reply).toHaveBeenCalledWith("How many images would you like? (1\u20132)");
    });

    it("answers 'Images no longer available.' when no images", async () => {
      const ctx = makeCtx();
      const bot = makeBot();

      await handleImagesCallback(ctx, "images:part:missing", bot);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Images no longer available." });
      expect(ctx.reply).not.toHaveBeenCalled();
    });
  });

  describe("send action", () => {
    it("deletes from map, answers Sending, edits markup, sends photos", async () => {
      const ctx = makeCtx();
      const bot = makeBot();
      const images = [
        { data: Buffer.from("img1").toString("base64"), mediaType: "image/png" },
      ];
      pendingImages.set("s1", images);

      await handleImagesCallback(ctx, "images:send:all:s1", bot);

      expect(pendingImages.has("s1")).toBe(false);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Sending\u2026" });
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalled();
      expect(bot.api.sendPhoto).toHaveBeenCalledWith(12345, expect.any(InputFile));
    });

    it("answers 'Images no longer available.' when no images", async () => {
      const ctx = makeCtx();
      const bot = makeBot();

      await handleImagesCallback(ctx, "images:send:all:gone", bot);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Images no longer available." });
      expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
    });

    it("falls back to sendDocument when sendPhoto fails", async () => {
      const ctx = makeCtx();
      const bot = makeBot();
      vi.mocked(bot.api.sendPhoto).mockRejectedValue(new Error("photo failed"));

      const images = [
        { data: Buffer.from("img").toString("base64"), mediaType: "image/jpeg" },
      ];
      pendingImages.set("fb1", images);

      await handleImagesCallback(ctx, "images:send:all:fb1", bot);

      expect(bot.api.sendPhoto).toHaveBeenCalled();
      expect(bot.api.sendDocument).toHaveBeenCalledWith(12345, expect.any(InputFile));
    });

    it("logs error when both sendPhoto and sendDocument fail", async () => {
      const ctx = makeCtx();
      const bot = makeBot();
      vi.mocked(bot.api.sendPhoto).mockRejectedValue(new Error("photo failed"));
      vi.mocked(bot.api.sendDocument).mockRejectedValue(new Error("doc failed"));

      const images = [
        { data: Buffer.from("img").toString("base64"), mediaType: "image/png" },
      ];
      pendingImages.set("fb2", images);

      await handleImagesCallback(ctx, "images:send:all:fb2", bot);

      expect(log).toHaveBeenCalledWith({
        message: expect.stringContaining("sendPhoto/sendDocument error: doc failed"),
      });
    });
  });

  describe("key with colons", () => {
    it("correctly joins key parts containing colons", async () => {
      const ctx = makeCtx();
      const bot = makeBot();
      pendingImages.set("a:b:c", [{ data: "x", mediaType: "image/png" }]);

      await handleImagesCallback(ctx, "images:skip:a:b:c", bot);

      expect(pendingImages.has("a:b:c")).toBe(false);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Skipped." });
    });
  });
});
