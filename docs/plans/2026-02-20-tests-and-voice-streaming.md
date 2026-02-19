# Tests and Voice Streaming Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stream text blocks to the user as they arrive during voice messages (with a `[transcription]` prefix up front), and add comprehensive test coverage for all features added this session.

**Architecture:** Voice handler sends transcription immediately, then streams each `[claude-code]` text block via `voiceResponseHandler`, finally sends audio after a 3s debounce. Tests use Vitest with real tmp files for `watchForResponse` (parameterised debounce to keep tests fast), and `vi.mock` for all external API calls.

**Tech Stack:** Vitest 4, chokidar, TypeScript ESM (`import`/`export`), `fs/promises`

---

### Task 1: Stream text + transcription prefix in voice handler

**Files:**
- Modify: `src/telegram/bot.ts`

The voice handler currently collects all text blocks silently and only sends audio at the end. We need to:
1. Send `` `[transcription]` ${polished} `` immediately when injection succeeds
2. In `voiceResponseHandler`, send each new text block as a markdown reply *before* starting the audio debounce

**Step 1: Locate the voice `__INJECTED__` block in bot.ts**

It starts at line 194. The current `voiceResponseHandler` only manages a debounce timer. Understand the full shape before editing.

**Step 2: Add transcription reply + streaming text to voiceResponseHandler**

Replace the `__INJECTED__` handling block (lines 194–225) with:

```typescript
if (reply === "__INJECTED__") {
  await ctx.reply(`\`[transcription]\` ${polished}`);
  await ctx.replyWithChatAction("typing");
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);

  if (attached) {
    let lastText = "";
    let responseTimer: ReturnType<typeof setTimeout> | null = null;

    const voiceResponseHandler = async (state: SessionResponseState) => {
      // Stream text block immediately
      await sendMarkdownReply(ctx, `\`[claude-code]\` ${state.text}`).catch(() => {});

      // Debounce for final audio summary
      lastText = state.text;
      if (responseTimer) clearTimeout(responseTimer);
      responseTimer = setTimeout(async () => {
        try {
          const summary = await narrate(lastText, polished);
          const audio = await synthesizeSpeech(summary);
          await ctx.replyWithVoice(new InputFile(audio, "reply.mp3"));
          log({ chatId, direction: "out", message: `[voice response] ${summary.slice(0, 80)}` });
        } catch (err) {
          log({ chatId, message: `Voice response error: ${err instanceof Error ? err.message : String(err)}` });
        }
      }, 3000);
    };

    await startInjectionWatcher(attached, chatId, () => clearInterval(typingInterval), voiceResponseHandler);
  } else {
    clearInterval(typingInterval);
  }
  return;
}
```

Key changes:
- `await ctx.reply(...)` with transcription BEFORE `ctx.replyWithChatAction`
- `voiceResponseHandler` sends text block immediately via `sendMarkdownReply`
- Error catch no longer re-sends text (already streamed)

**Step 3: Build to check for type errors**

```bash
npx tsc --noEmit
```
Expected: no errors.

**Step 4: Commit**

```bash
git add src/telegram/bot.ts
git commit -m "feat: stream text blocks and show transcription prefix in voice messages"
```

---

### Task 2: Make `splitMessage` testable by exporting it from notifications.ts

**Files:**
- Modify: `src/telegram/notifications.ts`

`splitMessage` is currently a private function. Tests need to import it directly.

**Step 1: Add `export` to `splitMessage`**

Change line 9 from:
```typescript
function splitMessage(text: string, limit = 4000): string[] {
```
to:
```typescript
export function splitMessage(text: string, limit = 4000): string[] {
```

**Step 2: Build to check no type errors**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/telegram/notifications.ts
git commit -m "refactor: export splitMessage for testing"
```

---

### Task 3: Add optional `debounceMs` parameter to `watchForResponse`

**Files:**
- Modify: `src/session/monitor.ts`

Tests need a short debounce (50ms) to avoid 1-second waits per test case. Add an optional parameter defaulting to `1000`.

**Step 1: Add `debounceMs` parameter**

Change the function signature from:
```typescript
export function watchForResponse(
  filePath: string,
  baselineSize: number,
  onResponse: ResponseCallback,
  timeoutMs = 120_000,
  onPing?: () => void
): () => void {
```
to:
```typescript
export function watchForResponse(
  filePath: string,
  baselineSize: number,
  onResponse: ResponseCallback,
  timeoutMs = 120_000,
  onPing?: () => void,
  debounceMs = 1000
): () => void {
```

Then replace the hardcoded `1000` in the debounce timer (inside the `watcher.on("change")` callback, near the bottom):
```typescript
debounceTimer = setTimeout(async () => {
```
This line currently fires after `1000`ms. Change it to:
```typescript
debounceTimer = setTimeout(async () => {
```
...but using `debounceMs`:

Find:
```typescript
        debounceTimer = setTimeout(async () => {
          if (done || capturedText === lastSentText) return;
```
Replace with:
```typescript
        debounceTimer = setTimeout(async () => {
          if (done || capturedText === lastSentText) return;
```
Wait — the `1000` is on a different line. Find the line:
```typescript
        }, 1000);
```
(inside the `watcher.on("change")` handler, after the `debounceTimer = setTimeout(async () => { ... }` block) and replace with:
```typescript
        }, debounceMs);
```

**Step 2: Build to check no type errors**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/session/monitor.ts
git commit -m "refactor: make watchForResponse debounce delay configurable for testing"
```

---

### Task 4: Update `loop.test.ts` for current behaviour

**Files:**
- Modify: `src/agent/loop.test.ts`

The current `loop.test.ts` has two problems:
1. `GENERAL_CHAT` test: expects no agent call and a chat reply — but now with a `cwd` it tries `injectInput` first and returns `__INJECTED__`
2. Missing: `__INJECTED__` sentinel test for injection success
3. Missing: `clearChatState` test

**Step 1: Read the current test file**

```bash
cat src/agent/loop.test.ts
```

**Step 2: Rewrite the GENERAL_CHAT test and add new cases**

Replace the file content with:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Intent } from "./classifier.js";

vi.mock("./classifier.js", () => ({
  Intent: {
    SUMMARY_REQUEST: "SUMMARY_REQUEST",
    COMMAND_EXECUTION: "COMMAND_EXECUTION",
    FOLLOW_UP_INPUT: "FOLLOW_UP_INPUT",
    GENERAL_CHAT: "GENERAL_CHAT",
    SESSION_LIST: "SESSION_LIST",
    UNKNOWN: "UNKNOWN",
  },
  classifyIntent: vi.fn(),
}));
vi.mock("./summarizer.js", () => ({ summarizeSession: vi.fn() }));
vi.mock("../session/adapter.js", () => ({ runAgentTurn: vi.fn() }));
vi.mock("../session/tmux.js", () => ({ injectInput: vi.fn() }));
vi.mock("../logger.js", () => ({ log: vi.fn() }));

import { classifyIntent } from "./classifier.js";
import { summarizeSession } from "./summarizer.js";
import { runAgentTurn } from "../session/adapter.js";
import { injectInput } from "../session/tmux.js";
import { handleTurn, clearChatState } from "./loop.js";

beforeEach(() => vi.clearAllMocks());

describe("handleTurn", () => {
  it("calls summarizer for SUMMARY_REQUEST", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.SUMMARY_REQUEST);
    vi.mocked(summarizeSession).mockResolvedValue("Claude is refactoring sessions.ts");

    const result = await handleTurn(123, "what's happening?");
    expect(summarizeSession).toHaveBeenCalled();
    expect(result).toContain("Claude is refactoring sessions.ts");
  });

  it("injects via tmux for COMMAND_EXECUTION when cwd is known", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.COMMAND_EXECUTION);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%2" });

    const result = await handleTurn(123, "install deps", undefined, "/Users/luca/repos/app");
    expect(injectInput).toHaveBeenCalledWith("/Users/luca/repos/app", "install deps");
    expect(result).toBe("__INJECTED__");
  });

  it("falls back to runAgentTurn for COMMAND_EXECUTION when no pane found", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.COMMAND_EXECUTION);
    vi.mocked(injectInput).mockResolvedValue({ found: false, reason: "not_found" });
    vi.mocked(runAgentTurn).mockResolvedValue("Installed 3 packages.");

    const result = await handleTurn(123, "install deps", undefined, "/Users/luca/repos/app");
    expect(runAgentTurn).toHaveBeenCalledWith(123, "install deps");
    expect(result).toContain("Installed 3 packages.");
  });

  it("injects via tmux for FOLLOW_UP_INPUT when cwd is known", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.FOLLOW_UP_INPUT);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%2" });

    const result = await handleTurn(123, "y", undefined, "/Users/luca/repos/app");
    expect(injectInput).toHaveBeenCalledWith("/Users/luca/repos/app", "y");
    expect(result).toBe("__INJECTED__");
  });

  it("falls back to runAgentTurn for FOLLOW_UP_INPUT when no cwd", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.FOLLOW_UP_INPUT);
    vi.mocked(runAgentTurn).mockResolvedValue("ok");

    await handleTurn(123, "y");
    expect(runAgentTurn).toHaveBeenCalledWith(123, "y");
  });

  it("injects via tmux for GENERAL_CHAT when cwd is known", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.GENERAL_CHAT);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%2" });

    const result = await handleTurn(123, "thanks!", undefined, "/Users/luca/repos/app");
    expect(injectInput).toHaveBeenCalledWith("/Users/luca/repos/app", "thanks!");
    expect(result).toBe("__INJECTED__");
  });

  it("returns no-session message for GENERAL_CHAT without cwd", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.GENERAL_CHAT);

    const result = await handleTurn(123, "thanks!");
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(result).toMatch(/no session/i);
  });

  it("returns SESSION_PICKER sentinel for SESSION_LIST intent", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.SESSION_LIST);

    const result = await handleTurn(123, "show sessions");
    expect(result).toBe("__SESSION_PICKER__");
  });

  it("returns ambiguous message when multiple panes found", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.COMMAND_EXECUTION);
    vi.mocked(injectInput).mockResolvedValue({ found: false, reason: "ambiguous" });

    const result = await handleTurn(123, "run tests", undefined, "/Users/luca/repos/app");
    expect(result).toMatch(/multiple/i);
  });
});

describe("clearChatState", () => {
  it("removes stored state so next turn has no prior context", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.COMMAND_EXECUTION);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%2" });

    // First turn — establishes lastBotMessage state
    await handleTurn(42, "first message", undefined, "/cwd");

    clearChatState(42);

    // After clear, classifyIntent should be called without lastBotMessage context
    vi.mocked(classifyIntent).mockResolvedValue(Intent.GENERAL_CHAT);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%2" });

    await handleTurn(42, "second message", undefined, "/cwd");

    // classifyIntent's second call should have no contextMessage (undefined second arg)
    const secondCall = vi.mocked(classifyIntent).mock.calls[1];
    expect(secondCall[1]).toBeUndefined();
  });
});
```

**Step 3: Run the updated tests**

```bash
npm test -- src/agent/loop.test.ts
```
Expected: all tests pass.

**Step 4: Commit**

```bash
git add src/agent/loop.test.ts
git commit -m "test: update loop.test.ts for injection-first behaviour and clearChatState"
```

---

### Task 5: Add `watchForResponse` and `getFileSize` tests to monitor.test.ts

**Files:**
- Modify: `src/session/monitor.test.ts`

**Step 1: Read the current monitor.test.ts**

It only tests `classifyWaitingType`. We will append new `describe` blocks.

**Step 2: Append the new tests**

Add to the bottom of `src/session/monitor.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { writeFile, appendFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { getFileSize, watchForResponse } from "./monitor.js";
import type { SessionResponseState } from "./monitor.js";

// Helper: write a JSONL assistant line
function assistantLine(text: string, cwd = "/tmp/project"): string {
  return JSON.stringify({
    type: "assistant",
    cwd,
    message: { content: [{ type: "text", text }] },
  }) + "\n";
}

describe("getFileSize", () => {
  const tmpFile = join(tmpdir(), `cv-getfilesize-${Date.now()}.jsonl`);

  afterEach(async () => {
    await unlink(tmpFile).catch(() => {});
  });

  it("returns byte count of file contents", async () => {
    await writeFile(tmpFile, "hello");
    expect(await getFileSize(tmpFile)).toBe(5);
  });

  it("returns 0 for a non-existent file", async () => {
    expect(await getFileSize("/tmp/definitely-does-not-exist-cv.jsonl")).toBe(0);
  });
});

describe("watchForResponse", () => {
  let tmpFile: string;
  let stopWatcher: (() => void) | null = null;

  afterEach(async () => {
    stopWatcher?.();
    stopWatcher = null;
    if (tmpFile) await unlink(tmpFile).catch(() => {});
  });

  it("fires callback when new assistant text appears after baseline", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    const received: SessionResponseState[] = [];
    stopWatcher = watchForResponse(tmpFile, baseline, async (state) => {
      received.push(state);
    }, 10_000, undefined, 50);

    // Wait for chokidar to start watching
    await new Promise((r) => setTimeout(r, 200));
    await appendFile(tmpFile, assistantLine("Build succeeded."));

    // Wait for debounce (50ms) + buffer
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("Build succeeded.");
  });

  it("ignores content written before the baseline", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    // Pre-existing content before baseline
    await writeFile(tmpFile, assistantLine("Old message from before injection."));
    const baseline = await getFileSize(tmpFile);

    const received: SessionResponseState[] = [];
    stopWatcher = watchForResponse(tmpFile, baseline, async (state) => {
      received.push(state);
    }, 10_000, undefined, 50);

    await new Promise((r) => setTimeout(r, 200));
    // No new content written — old content is below baseline
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toHaveLength(0);
  });

  it("does not fire twice for the same text block", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    const received: SessionResponseState[] = [];
    stopWatcher = watchForResponse(tmpFile, baseline, async (state) => {
      received.push(state);
    }, 10_000, undefined, 50);

    await new Promise((r) => setTimeout(r, 200));
    // Write same line twice (simulates chokidar firing twice)
    await appendFile(tmpFile, assistantLine("Done."));
    await new Promise((r) => setTimeout(r, 50));
    await appendFile(tmpFile, assistantLine("Done.")); // duplicate

    await new Promise((r) => setTimeout(r, 300));

    expect(received).toHaveLength(1);
  });

  it("fires separately for two distinct text blocks", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    const received: SessionResponseState[] = [];
    stopWatcher = watchForResponse(tmpFile, baseline, async (state) => {
      received.push(state);
    }, 10_000, undefined, 50);

    await new Promise((r) => setTimeout(r, 200));

    await appendFile(tmpFile, assistantLine("First block."));
    await new Promise((r) => setTimeout(r, 300));

    await appendFile(tmpFile, assistantLine("Second block."));
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toHaveLength(2);
    expect(received[0].text).toBe("First block.");
    expect(received[1].text).toBe("Second block.");
  });

  it("stop function prevents further callbacks", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    const received: SessionResponseState[] = [];
    stopWatcher = watchForResponse(tmpFile, baseline, async (state) => {
      received.push(state);
    }, 10_000, undefined, 50);

    await new Promise((r) => setTimeout(r, 200));
    stopWatcher();
    stopWatcher = null;

    await appendFile(tmpFile, assistantLine("Should not arrive."));
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toHaveLength(0);
  });
});
```

**Step 3: Run the tests**

```bash
npm test -- src/session/monitor.test.ts
```
Expected: all `classifyWaitingType` tests still pass, all new tests pass.

**Step 4: Commit**

```bash
git add src/session/monitor.test.ts
git commit -m "test: add watchForResponse and getFileSize tests"
```

---

### Task 6: Add `voice.test.ts`

**Files:**
- Create: `src/voice.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @anthropic-ai/sdk before importing voice.ts
vi.mock("@anthropic-ai/sdk", () => {
  const create = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create },
    })),
  };
});

import Anthropic from "@anthropic-ai/sdk";
import { polishTranscript } from "./voice.js";

function getMessagesCreate() {
  const instance = vi.mocked(Anthropic).mock.results[0]?.value;
  return instance?.messages.create as ReturnType<typeof vi.fn>;
}

beforeEach(() => vi.clearAllMocks());

describe("polishTranscript", () => {
  it("returns cleaned text from the model response", async () => {
    vi.mocked(Anthropic).mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "Run the test suite." }],
        }),
      },
    }) as unknown as Anthropic);

    const result = await polishTranscript("uh run the uh tests please");
    expect(result).toBe("Run the test suite.");
  });

  it("passes the raw transcript in the prompt", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Install dependencies." }],
    });
    vi.mocked(Anthropic).mockImplementation(() => ({
      messages: { create },
    }) as unknown as Anthropic);

    await polishTranscript("install the things");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining("install the things"),
          }),
        ]),
      })
    );
  });

  it("falls back to raw transcript when model returns a non-text block", async () => {
    vi.mocked(Anthropic).mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
        }),
      },
    }) as unknown as Anthropic);

    const result = await polishTranscript("some input");
    expect(result).toBe("some input");
  });
});
```

**Step 2: Run the test**

```bash
npm test -- src/voice.test.ts
```
Expected: 3 tests pass.

**Step 3: Commit**

```bash
git add src/voice.test.ts
git commit -m "test: add polishTranscript tests"
```

---

### Task 7: Add `notifications.test.ts`

**Files:**
- Create: `src/telegram/notifications.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { splitMessage } from "./notifications.js";

describe("splitMessage", () => {
  it("returns a single chunk when text is under the limit", () => {
    expect(splitMessage("hello world")).toEqual(["hello world"]);
  });

  it("returns a single chunk when text equals the limit exactly", () => {
    const text = "a".repeat(4000);
    expect(splitMessage(text)).toEqual([text]);
  });

  it("splits at the last newline before the limit", () => {
    const first = "a".repeat(3990);
    const second = "b".repeat(100);
    const text = first + "\n" + second;
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(first);
    expect(chunks[1]).toBe(second);
  });

  it("hard-splits at the limit when there is no newline", () => {
    const text = "x".repeat(4500);
    const chunks = splitMessage(text);
    expect(chunks[0]).toHaveLength(4000);
    expect(chunks[1]).toHaveLength(500);
  });

  it("handles three chunks correctly", () => {
    const chunk = "a".repeat(3999) + "\n";
    const text = chunk + chunk + "end";
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(3);
    expect(chunks[2]).toBe("end");
  });
});
```

**Step 2: Run the test**

```bash
npm test -- src/telegram/notifications.test.ts
```
Expected: 5 tests pass.

**Step 3: Commit**

```bash
git add src/telegram/notifications.test.ts
git commit -m "test: add splitMessage tests"
```

---

### Task 8: Add `adapter.test.ts`

**Files:**
- Create: `src/session/adapter.test.ts`

`clearAdapterSession` removes a chat ID from the internal `sessions` Map. We can verify this by calling `getActiveSessions()` before and after.

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("../narrator.js", () => ({ narrate: vi.fn(async (s: string) => s) }));
vi.mock("../logger.js", () => ({
  log: vi.fn(),
  logEmitter: { emit: vi.fn() },
}));
vi.mock("./history.js", () => ({ getAttachedSession: vi.fn().mockResolvedValue(null) }));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { clearAdapterSession, getActiveSessions, runAgentTurn } from "./adapter.js";

beforeEach(() => vi.clearAllMocks());

describe("clearAdapterSession", () => {
  it("removes a session so it no longer appears in getActiveSessions", async () => {
    // Simulate a completed agent turn that establishes a session
    vi.mocked(query).mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "abc-session-123" };
      yield { type: "result", subtype: "success", result: "done" };
    });

    await runAgentTurn(99, "do something");
    expect(getActiveSessions()).toContain(99);

    clearAdapterSession(99);
    expect(getActiveSessions()).not.toContain(99);
  });

  it("is a no-op for a chat ID with no session", () => {
    expect(() => clearAdapterSession(9999)).not.toThrow();
    expect(getActiveSessions()).not.toContain(9999);
  });
});
```

**Step 2: Run the test**

```bash
npm test -- src/session/adapter.test.ts
```
Expected: 2 tests pass.

**Step 3: Commit**

```bash
git add src/session/adapter.test.ts
git commit -m "test: add clearAdapterSession tests"
```

---

### Task 9: Run the full test suite

**Step 1: Run all tests**

```bash
npm test
```
Expected: all tests pass, no failures.

**Step 2: Commit if there were any last-minute fixes**

Only commit if something needed to be fixed in this step.

---

### Task 10: Final build check

**Step 1: Compile TypeScript**

```bash
npx tsc --noEmit
```
Expected: no errors.

**Step 2: If all good — done. Use superpowers:finishing-a-development-branch.**
