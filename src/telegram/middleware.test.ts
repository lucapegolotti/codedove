import { describe, it, expect, vi } from "vitest";
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

  it("silently drops messages from unlisted chat IDs", async () => {
    const sendCalls: unknown[] = [];
    const { bot } = await makeBot(111);
    // Override API to detect if sendMessage is called
    bot.api.config.use(async (prev, method, payload) => {
      if (method === "sendMessage") sendCalls.push(payload);
      return { ok: true as const, result: {} };
    });
    await bot.handleUpdate(textUpdate(999) as any);
    expect(sendCalls).toHaveLength(0);
  });
});
