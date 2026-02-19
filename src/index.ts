import { createBot } from "./bot.js";

const required = ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

const bot = createBot(process.env.TELEGRAM_BOT_TOKEN!);
bot.catch(console.error);

await bot.start({ onStart: () => console.log("claude-voice bot running") });
