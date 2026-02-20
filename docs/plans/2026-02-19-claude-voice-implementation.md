# claude-voice Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A Node.js/TypeScript server that bridges Telegram (text + voice notes) to the Claude Agent SDK, returning short conversational replies.

**Architecture:** Telegram bot (grammy) receives text/voice → voice notes go through Whisper STT → Claude Agent SDK runs the request with persistent sessions (keyed by chat ID) → Narrator (claude-haiku) converts verbose output to a friendly 1-3 sentence reply → reply goes back as text or via OpenAI TTS as a voice note.

**Tech Stack:** TypeScript, `grammy` (Telegram), `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk` (narrator), `openai` (Whisper + TTS), `tsx` (runtime)

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `src/index.ts`

**Step 1: Create `package.json`**

```json
{
  "name": "claude-voice",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "@anthropic-ai/sdk": "latest",
    "grammy": "latest",
    "openai": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "tsx": "latest",
    "typescript": "latest"
  }
}
```

**Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Create `.env.example`**

```
TELEGRAM_BOT_TOKEN=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
```

**Step 4: Create minimal `src/index.ts`**

```typescript
console.log("claude-voice starting...");
```

**Step 5: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, no errors

**Step 6: Verify it runs**

Run: `npm start`
Expected: prints "claude-voice starting..." then exits

**Step 7: Init git and commit**

```bash
git init
git add package.json tsconfig.json .env.example src/index.ts
git commit -m "chore: initial project scaffold"
```

---

### Task 2: Voice pipeline (Whisper STT + OpenAI TTS)

**Files:**
- Create: `src/voice.ts`

**Step 1: Create `src/voice.ts`**

```typescript
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function transcribeAudio(audioBuffer: Buffer, filename: string): Promise<string> {
  const file = new File([audioBuffer], filename, { type: "audio/ogg" });
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
  });
  return transcription.text;
}

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const response = await openai.audio.speech.create({
    model: "tts-1",
    voice: "nova",
    input: text,
  });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/voice.ts
git commit -m "feat: add voice pipeline (Whisper STT + OpenAI TTS)"
```

---

### Task 3: Narrator

**Files:**
- Create: `src/narrator.ts`

The narrator takes the raw result string from the Claude Agent SDK and rephrases it as a short, friendly reply with no markdown or code blocks.

**Step 1: Create `src/narrator.ts`**

```typescript
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM = `You are a friendly assistant relaying what a coding agent just did.
Given the agent's response, write a concise conversational reply in 1-3 sentences of plain text.
No markdown, no code blocks, no bullet points. Natural language, like you're texting.
If the agent completed a task, describe what it did. If it needs more info, relay the question clearly.`;

export async function narrate(agentResult: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    system: SYSTEM,
    messages: [{ role: "user", content: agentResult }],
  });
  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected narrator response type");
  return block.text;
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/narrator.ts
git commit -m "feat: add narrator layer (haiku conversational summarizer)"
```

---

### Task 4: Session manager

**Files:**
- Create: `src/sessions.ts`

Maps a Telegram chat ID to a Claude Agent SDK session ID. On the first message from a chat, creates a fresh session and captures its ID. On all subsequent messages, resumes the same session so Claude has full conversation history.

**Step 1: Create `src/sessions.ts`**

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { narrate } from "./narrator.js";
import { homedir } from "os";

// Maps Telegram chat ID → Claude Agent SDK session ID
const sessions = new Map<number, string>();

const SYSTEM_PROMPT = `You are a coding assistant accessed via Telegram.
When the user mentions a project by name, look for it in ${homedir()}/repositories/.
If the project directory is ambiguous, ask the user to clarify.
Keep responses concise.`;

export async function runAgentTurn(chatId: number, userMessage: string): Promise<string> {
  const existingSessionId = sessions.get(chatId);

  let result = "";
  let capturedSessionId: string | undefined;

  for await (const message of query({
    prompt: userMessage,
    options: {
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      permissionMode: "acceptEdits",
      cwd: homedir(),
      ...(existingSessionId
        ? { resume: existingSessionId }
        : { systemPrompt: SYSTEM_PROMPT }),
    },
  })) {
    if (message.type === "system" && message.subtype === "init" && !existingSessionId) {
      capturedSessionId = message.session_id;
    }
    if (message.type === "result" && message.subtype === "success") {
      result = message.result;
    }
  }

  if (capturedSessionId) {
    sessions.set(chatId, capturedSessionId);
  }

  return narrate(result || "The agent completed the task but produced no output.");
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/sessions.ts
git commit -m "feat: add session manager with Claude Agent SDK persistence"
```

---

### Task 5: Telegram bot

**Files:**
- Create: `src/bot.ts`

**Step 1: Create `src/bot.ts`**

```typescript
import { Bot, InputFile } from "grammy";
import { runAgentTurn } from "./sessions.js";
import { transcribeAudio, synthesizeSpeech } from "./voice.js";

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;
    await ctx.replyWithChatAction("typing");

    try {
      const reply = await runAgentTurn(chatId, userText);
      await ctx.reply(reply);
    } catch (err) {
      console.error("Agent error:", err);
      await ctx.reply("Something went wrong — try again?");
    }
  });

  bot.on("message:voice", async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.replyWithChatAction("record_voice");

    try {
      // Download voice note from Telegram
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const audioResponse = await fetch(fileUrl);
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

      // Transcribe with Whisper
      const transcript = await transcribeAudio(audioBuffer, "voice.ogg");

      // Run agent
      const replyText = await runAgentTurn(chatId, transcript);

      // Synthesize and send voice reply
      const audioReply = await synthesizeSpeech(replyText);
      await ctx.replyWithVoice(new InputFile(audioReply, "reply.mp3"));
    } catch (err) {
      console.error("Voice error:", err);
      await ctx.reply("Couldn't process your voice message — try again?");
    }
  });

  return bot;
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/bot.ts
git commit -m "feat: add Telegram bot (text + voice note handling)"
```

---

### Task 6: Entry point + smoke test

**Files:**
- Modify: `src/index.ts`
- Create: `.env` (from `.env.example`, with real values)

**Step 1: Get credentials**

Before running, you need three things:
- `TELEGRAM_BOT_TOKEN`: open Telegram, message `@BotFather`, send `/newbot`, follow the prompts. Copy the token it gives you.
- `ANTHROPIC_API_KEY`: from https://console.anthropic.com/
- `OPENAI_API_KEY`: from https://platform.openai.com/api-keys

Copy `.env.example` to `.env` and fill in the values.

**Step 2: Update `src/index.ts`**

```typescript
import { createBot } from "./bot.js";

const required = ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

const bot = createBot(process.env.TELEGRAM_BOT_TOKEN!);
bot.catch(console.error);

await bot.start();
console.log("claude-voice bot running");
```

**Step 3: Run the bot**

Run: `npm start`
Expected: "claude-voice bot running" — stays running, no crashes

**Step 4: Smoke test via Telegram**

Find your bot in Telegram (search for the username you gave BotFather).

Text test:
- Send: "what's in ~/repositories?"
- Expected: a short conversational reply like "You've got about 15 projects in there — I can see claude-voice, and a few others."

Voice test:
- Hold the mic button in Telegram, say "what projects do I have?"
- Expected: a voice message reply with a similar answer

**Step 5: Final commit**

```bash
git add src/index.ts
git commit -m "feat: wire up entry point with env validation"
```
