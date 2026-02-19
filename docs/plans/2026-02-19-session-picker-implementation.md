# Session Picker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the user ask the Telegram bot "what sessions are available?" (by text or voice) and pick a Claude Code session to resume via an inline keyboard.

**Architecture:** A new `src/intent.ts` handles LLM-based intent detection. `listSessions()` in `sessions.ts` scans `~/.claude/projects/**/*.jsonl`. `bot.ts` adds a `/sessions` command, intent interception in message handlers, an inline keyboard builder, and a callback handler that writes the selection to `~/.claude-voice/attached`.

**Tech Stack:** TypeScript, grammy (InlineKeyboard, callback_query), `@anthropic-ai/sdk` (Haiku for intent), Node.js `fs/promises` + `readline`

---

### Task 1: Add `listSessions()` to `src/sessions.ts`

**Files:**
- Modify: `src/sessions.ts`

**Step 1: Add the `SessionInfo` type and `listSessions` export**

Add these imports at the top of `src/sessions.ts` (after existing imports):

```typescript
import { readdir, stat } from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";
```

Add the type and constant after `ATTACHED_SESSION_PATH`:

```typescript
export type SessionInfo = {
  sessionId: string;
  cwd: string;
  projectName: string;
  lastMessage: string;
  mtime: Date;
};

const PROJECTS_PATH = `${homedir()}/.claude/projects`;
```

Add the function after `getAttachedSession`:

```typescript
export async function listSessions(limit = 5): Promise<SessionInfo[]> {
  const results: SessionInfo[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(PROJECTS_PATH);
  } catch {
    return [];
  }

  for (const dir of projectDirs) {
    const dirPath = `${PROJECTS_PATH}/${dir}`;
    let files: string[];
    try {
      files = (await readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      const filePath = `${dirPath}/${file}`;

      let mtime: Date;
      try {
        mtime = (await stat(filePath)).mtime;
      } catch {
        continue;
      }

      // Decode project name: "-Users-luca-repositories-foo" -> "foo"
      const segments = dir.replace(/^-/, "").split("-");
      const projectName = segments[segments.length - 1] || dir;

      // Read jsonl: collect cwd from first assistant line, lastMessage from last text block
      let cwd = homedir();
      let lastMessage = "";

      const rl = createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "assistant") {
            if (entry.cwd) cwd = entry.cwd;
            const textBlocks = (entry.message?.content ?? []).filter(
              (c: { type: string }) => c.type === "text"
            );
            if (textBlocks.length > 0) {
              lastMessage = textBlocks[0].text.slice(0, 100).replace(/\n/g, " ");
            }
          }
        } catch {
          // skip malformed lines
        }
      }

      results.push({ sessionId, cwd, projectName, lastMessage, mtime });
    }
  }

  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results.slice(0, limit);
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/sessions.ts
git commit -m "feat: add listSessions() to scan ~/.claude/projects"
```

---

### Task 2: Create `src/intent.ts`

**Files:**
- Create: `src/intent.ts`

**Step 1: Write the file**

```typescript
import Anthropic from "@anthropic-ai/sdk";

let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  return (anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
}

const SYSTEM = `You classify user messages. Answer with a single word: "sessions" if the message is asking to see a list of available Claude Code sessions or to pick/switch/connect to a session, otherwise "other". No punctuation, no explanation.`;

export async function detectSessionListIntent(text: string): Promise<boolean> {
  const response = await getClient().messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 5,
    system: SYSTEM,
    messages: [{ role: "user", content: text }],
  });
  const block = response.content[0];
  if (block.type !== "text") return false;
  return block.text.trim().toLowerCase().startsWith("sessions");
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/intent.ts
git commit -m "feat: add LLM-based session list intent detection"
```

---

### Task 3: Wire session picker into `src/bot.ts`

**Files:**
- Modify: `src/bot.ts`

**Step 1: Add imports**

Add at the top of `src/bot.ts`:

```typescript
import { InlineKeyboard } from "grammy";
import { listSessions, SessionInfo } from "./sessions.js";
import { detectSessionListIntent } from "./intent.js";
import { writeFile } from "fs/promises";
import { homedir } from "os";
```

**Step 2: Add module-level state and helpers**

Add after the imports:

```typescript
const ATTACHED_SESSION_PATH = `${homedir()}/.claude-voice/attached`;
const pendingSessions = new Map<string, SessionInfo>();

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

async function sendSessionPicker(ctx: { reply: Function }): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    await ctx.reply("No sessions found.");
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const s of sessions) {
    pendingSessions.set(s.sessionId, s);
    const label = `${s.projectName} · ${timeAgo(s.mtime)}`;
    keyboard.text(label, `session:${s.sessionId}`).row();
  }

  const lines = sessions.map((s) => {
    const preview = s.lastMessage ? `  "${s.lastMessage}"` : "  (no messages)";
    return `• ${s.projectName} · ${timeAgo(s.mtime)}\n${preview}`;
  });

  await ctx.reply(`Available sessions:\n\n${lines.join("\n\n")}`, {
    reply_markup: keyboard,
  });
}
```

**Step 3: Replace the `message:text` handler to add intent check**

Replace the existing `bot.on("message:text", ...)` handler:

```typescript
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;
    await ctx.replyWithChatAction("typing");
    log({ chatId, direction: "in", message: userText });

    try {
      if (await detectSessionListIntent(userText)) {
        await sendSessionPicker(ctx);
        return;
      }
      const reply = await runAgentTurn(chatId, userText);
      log({ chatId, direction: "out", message: reply });
      await ctx.reply(reply);
    } catch (err) {
      log({ chatId, message: `Error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Something went wrong — try again?");
    }
  });
```

**Step 4: Replace the `message:voice` handler to add intent check**

Replace the existing `bot.on("message:voice", ...)` handler:

```typescript
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

      if (await detectSessionListIntent(transcript)) {
        await sendSessionPicker(ctx);
        return;
      }

      const replyText = await runAgentTurn(chatId, transcript);
      log({ chatId, direction: "out", message: "[voice reply]" });
      const audioReply = await synthesizeSpeech(replyText);
      await ctx.replyWithVoice(new InputFile(audioReply, "reply.mp3"));
    } catch (err) {
      log({ chatId, message: `Voice error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Couldn't process your voice message — try again?");
    }
  });
```

**Step 5: Add `/sessions` command handler and callback handler**

Add these before the `return bot;` line:

```typescript
  bot.command("sessions", async (ctx) => {
    await sendSessionPicker(ctx);
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("session:")) return;

    const sessionId = data.slice("session:".length);
    const session = pendingSessions.get(sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "Session not found — try /sessions again." });
      return;
    }

    await writeFile(ATTACHED_SESSION_PATH, `${session.sessionId}\n${session.cwd}`, "utf8");
    await ctx.answerCallbackQuery({ text: "Attached!" });
    await ctx.reply(`Attached to \`${session.projectName}\`. Send your first message.`, {
      parse_mode: "Markdown",
    });
  });
```

**Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 7: Commit**

```bash
git add src/bot.ts
git commit -m "feat: add session picker with inline keyboard and intent detection"
```

---

### Task 4: Manual verification

**Step 1: Restart the bot**

In the TUI or terminal running the bot, restart it so the new code is live.

**Step 2: Send `/sessions` in Telegram**

Expected: bot replies with a list of 1–5 sessions, each showing project name, time ago, and last message preview. Inline buttons appear below.

**Step 3: Test voice trigger**

Send a voice message saying "what sessions are available" or "sessions".
Expected: same session list appears (not routed to the agent).

**Step 4: Tap a session**

Tap one of the inline buttons.
Expected: bot replies "Attached to `<project>`. Send your first message."

Verify the file:
```bash
cat ~/.claude-voice/attached
```
Expected: two lines — a UUID and a cwd path.

**Step 5: Send a follow-up message**

Send "what files are in this project?"
Expected: bot routes to the selected session and replies with a narrated response.

**Step 6: Commit (empty note)**

```bash
git commit --allow-empty -m "chore: verified session picker end-to-end"
```
