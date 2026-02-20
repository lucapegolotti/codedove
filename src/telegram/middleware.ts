import type { Bot } from "grammy";

export function applyAllowlistMiddleware(bot: Bot, allowedChatId: number | undefined): void {
  if (!allowedChatId) return;
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id ?? ctx.from?.id;
    if (chatId === allowedChatId) return next();
    // Silently drop — don't reveal anything to unknown senders
  });
}
