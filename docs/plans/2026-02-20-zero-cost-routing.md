# Zero-Cost Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the `classifyIntent` API call on every message so that messages route directly to Claude Code via tmux at zero token cost; add `/summarize` and `/polishvoice` commands.

**Architecture:** Rewrite `loop.ts` as a dumb pass-through (no API calls), delete the now-dead classifier and adapter files, add `/summarize` as an explicit command calling `summarizeSession` directly, and add `/polishvoice` as a toggle backed by a flag file in `~/.claude-voice/`.

**Tech Stack:** Node.js, TypeScript, vitest, grammY

---

### Task 1: Rewrite `loop.ts` as a pass-through and update its tests

**Files:**
- Modify: `src/agent/loop.ts`
- Modify: `src/agent/loop.test.ts`

**Step 1: Update the tests first (TDD)**

Replace the entire contents of `src/agent/loop.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleTurn, clearChatState } from "./loop.js";
import { injectInput } from "../session/tmux.js";

vi.mock("../session/tmux.js");
vi.mock("../logger.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleTurn", () => {
  it("returns __INJECTED__ when cwd is given and pane is found", async () => {
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%1" });
    const result = await handleTurn(123, "run tests", undefined, "/Users/luca/repos/app");
    expect(result).toBe("__INJECTED__");
  });

  it("returns no-running message when cwd given but pane not found", async () => {
    vi.mocked(injectInput).mockResolvedValue({ found: false, reason: "no_claude_pane" });
    const result = await handleTurn(123, "run tests", undefined, "/Users/luca/repos/app");
    expect(result).toMatch(/no claude code running/i);
  });

  it("returns no-running message when cwd given but result is ambiguous", async () => {
    vi.mocked(injectInput).mockResolvedValue({ found: false, reason: "ambiguous" });
    const result = await handleTurn(123, "run tests", undefined, "/Users/luca/repos/app");
    expect(result).toMatch(/no claude code running/i);
  });

  it("returns no-session message when no cwd provided", async () => {
    const result = await handleTurn(123, "hello");
    expect(result).toMatch(/no session attached/i);
    expect(injectInput).not.toHaveBeenCalled();
  });

  it("clearChatState does not throw", () => {
    expect(() => clearChatState(123)).not.toThrow();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npm test -- --reporter=verbose src/agent/loop.test.ts
```

Expected: several FAILs (old loop.ts doesn't match new test expectations)

**Step 3: Rewrite `src/agent/loop.ts`**

Replace the entire file with:

```ts
import { injectInput } from "../session/tmux.js";
import { log } from "../logger.js";

// no-op: chat state removed in zero-cost routing refactor
export function clearChatState(_chatId: number): void {}

export async function handleTurn(
  chatId: number,
  userMessage: string,
  _lastBotMessage?: string,
  knownCwd?: string
): Promise<string> {
  if (!knownCwd) {
    return "No session attached. Use /sessions to pick one.";
  }

  log({ chatId, message: `inject: ${userMessage.slice(0, 80)}` });
  const result = await injectInput(knownCwd, userMessage);
  if (result.found) {
    return "__INJECTED__";
  }
  return "No Claude Code running in the attached project. Start Claude Code there, or use /sessions to switch.";
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- --reporter=verbose src/agent/loop.test.ts
```

Expected: all 5 tests PASS

**Step 5: Run full test suite**

```bash
npm test
```

Expected: all tests pass (no regressions)

**Step 6: Commit**

```bash
git add src/agent/loop.ts src/agent/loop.test.ts
git commit -m "refactor: simplify loop.ts to zero-cost pass-through"
```

---

### Task 2: Delete dead files

**Files:**
- Delete: `src/agent/classifier.ts`
- Delete: `src/agent/classifier.test.ts`
- Delete: `src/session/adapter.ts`
- Delete: `src/session/adapter.test.ts`

**Step 1: Delete the files**

```bash
rm src/agent/classifier.ts src/agent/classifier.test.ts
rm src/session/adapter.ts src/session/adapter.test.ts
```

**Step 2: Verify type-check passes**

```bash
npx tsc --noEmit
```

Expected: no errors (nothing imports these files anymore)

**Step 3: Run full test suite**

```bash
npm test
```

Expected: all tests pass

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete unused classifier and adapter (zero-cost routing)"
```

---

### Task 3: Add `/summarize` command to `bot.ts`

**Files:**
- Modify: `src/telegram/bot.ts`

**Step 1: Add the `summarizeSession` import**

At the top of `src/telegram/bot.ts`, add this import (after the existing imports):

```ts
import { summarizeSession } from "../agent/summarizer.js";
```

**Step 2: Add the `/summarize` command handler**

Add after the existing `bot.command("compact", ...)` block:

```ts
bot.command("summarize", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try {
    const summary = await summarizeSession();
    await sendMarkdownReply(ctx, summary);
  } catch (err) {
    log({ message: `summarize error: ${err instanceof Error ? err.message : String(err)}` });
    await ctx.reply("Could not generate summary — try again?");
  }
});
```

**Step 3: Verify type-check passes**

```bash
npx tsc --noEmit
```

Expected: no errors

**Step 4: Run full test suite**

```bash
npm test
```

Expected: all tests pass

**Step 5: Commit**

```bash
git add src/telegram/bot.ts
git commit -m "feat: add /summarize command"
```

---

### Task 4: Add `/polishvoice` toggle and wire up voice handler

**Files:**
- Modify: `src/telegram/bot.ts`

The toggle is backed by a flag file: `~/.claude-voice/polish-voice-off`.
- File **absent** → polish on (default)
- File **present** → polish off

**Step 1: Add `access` to the `fs/promises` import**

Find this line near the top of `src/telegram/bot.ts`:

```ts
import { writeFile, mkdir, unlink } from "fs/promises";
```

Change to:

```ts
import { writeFile, mkdir, unlink, access } from "fs/promises";
```

**Step 2: Add the polish helpers and path constant**

Add after the existing `const pendingSessions = ...` line:

```ts
const POLISH_VOICE_OFF_PATH = join(homedir(), ".claude-voice", "polish-voice-off");

async function isVoicePolishEnabled(): Promise<boolean> {
  try {
    await access(POLISH_VOICE_OFF_PATH);
    return false; // flag file exists → polish off
  } catch {
    return true; // flag file absent → polish on (default)
  }
}
```

**Step 3: Update the voice handler to check the flag**

Find this line in the `bot.on("message:voice", ...)` handler:

```ts
      const polished = await polishTranscript(transcript);
```

Replace with:

```ts
      const polishEnabled = await isVoicePolishEnabled();
      const polished = polishEnabled ? await polishTranscript(transcript) : transcript;
```

**Step 4: Add the `/polishvoice` command handler**

Add after the `bot.command("summarize", ...)` block:

```ts
bot.command("polishvoice", async (ctx) => {
  const enabled = await isVoicePolishEnabled();
  if (enabled) {
    // Turn off: create the flag file
    await mkdir(join(homedir(), ".claude-voice"), { recursive: true });
    await writeFile(POLISH_VOICE_OFF_PATH, "", "utf8");
    await ctx.reply("Voice polish *off*. Raw Whisper transcripts will be injected.", { parse_mode: "Markdown" });
  } else {
    // Turn on: remove the flag file
    await unlink(POLISH_VOICE_OFF_PATH).catch(() => {});
    await ctx.reply("Voice polish *on*. Transcripts will be cleaned up before injection.", { parse_mode: "Markdown" });
  }
});
```

**Step 5: Verify type-check passes**

```bash
npx tsc --noEmit
```

Expected: no errors

**Step 6: Run full test suite**

```bash
npm test
```

Expected: all tests pass

**Step 7: Commit**

```bash
git add src/telegram/bot.ts
git commit -m "feat: add /polishvoice toggle for voice transcript polishing"
```

---

### Task 5: Install and smoke-test

**Step 1: Install globally**

```bash
npm install -g .
```

**Step 2: Restart bot via TUI**

Press `r` in the TUI.

**Step 3: Manual smoke tests**

1. Attach to a session, send a text message → verify it injects to Claude Code with no delay (no API call)
2. Send a message with no session attached → verify "No session attached. Use /sessions to pick one."
3. Send `/summarize` → verify a summary is returned
4. Send `/polishvoice` → verify reply confirms polish is now *off*
5. Send a voice message → verify raw transcript is injected (no polishing)
6. Send `/polishvoice` again → verify polish is back *on*
7. Send a voice message → verify polished transcript is injected
