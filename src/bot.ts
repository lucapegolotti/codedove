import { Bot, InputFile } from "grammy";
import { runAgentTurn } from "./sessions.js";
import { transcribeAudio, synthesizeSpeech } from "./voice.js";
import { log } from "./logger.js";

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;
    await ctx.replyWithChatAction("typing");
    log({ chatId, direction: "in", message: userText });

    try {
      const reply = await runAgentTurn(chatId, userText);
      log({ chatId, direction: "out", message: reply });
      await ctx.reply(reply);
    } catch (err) {
      log({ chatId, message: `Error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Something went wrong — try again?");
    }
  });

  bot.on("message:voice", async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.replyWithChatAction("record_voice");
    log({ chatId, direction: "in", message: "[voice note]" });

    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("Telegram did not return a file_path for this voice note");
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const audioResponse = await fetch(fileUrl);
      if (!audioResponse.ok) throw new Error(`Failed to download voice note: ${audioResponse.status}`);
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

      const transcript = await transcribeAudio(audioBuffer, "voice.ogg");
      log({ chatId, message: `transcribed: "${transcript}"` });

      const replyText = await runAgentTurn(chatId, transcript);
      log({ chatId, direction: "out", message: "[voice reply]" });
      const audioReply = await synthesizeSpeech(replyText);
      await ctx.replyWithVoice(new InputFile(audioReply, "reply.mp3"));
    } catch (err) {
      log({ chatId, message: `Voice error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Couldn't process your voice message — try again?");
    }
  });

  return bot;
}
