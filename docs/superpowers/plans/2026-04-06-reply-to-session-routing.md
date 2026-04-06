# Reply-to Session Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route user input to a specific Claude Code session by replying to one of its Telegram messages, silently switching the active session.

**Architecture:** Track a `message_id -> { sessionId, cwd }` mapping in `NotificationService`. On reply-to, look up the session and override the attached session.

**Tech Stack:** TypeScript, grammy

---

### Task 1: Add message-to-session tracking in NotificationService

**Files:**
- Modify: `src/telegram/notifications.ts`
- Modify: `src/telegram/notifications.test.ts`

- [ ] **Step 1: Write the tests**

Add to `src/telegram/notifications.test.ts`:

```typescript
describe("message-to-session tracking", () => {
  it("tracks message_id from notifyResponse", async () => {
    notifications.register(mockBot as any, 123);
    mockBot.api.sendMessage.mockResolvedValue({ message_id: 55 });

    await notifications.notifyResponse({
      sessionId: "sess-1",
      projectName: "myproject",
      cwd: "/tmp/proj",
      filePath: "/tmp/f.jsonl",
      text: "Hello",
    });

    expect(notifications.getSessionForMessage(55)).toEqual({
      sessionId: "sess-1",
      cwd: "/tmp/proj",
    });
  });

  it("tracks message_id from notifyToolUse", async () => {
    notifications.register(mockBot as any, 123);
    mockBot.api.sendMessage.mockResolvedValue({ message_id: 66 });

    await notifications.notifyToolUse("myproject", "sess-2", [
      { id: "t1", name: "Bash", command: "ls" },
    ]);

    expect(notifications.getSessionForMessage(66)).toEqual({
      sessionId: "sess-2",
      cwd: undefined,
    });
  });

  it("returns undefined for unknown message_id", () => {
    notifications.register(mockBot as any, 123);
    expect(notifications.getSessionForMessage(999)).toBeUndefined();
  });

  it("evicts oldest entries when map exceeds 500", async () => {
    notifications.register(mockBot as any, 123);
    let msgId = 0;
    mockBot.api.sendMessage.mockImplementation(async () => ({ message_id: ++msgId }));

    for (let i = 0; i < 501; i++) {
      await notifications.notifyResponse({
        sessionId: `sess-${i}`,
        projectName: "p",
        cwd: `/tmp/${i}`,
        filePath: "/tmp/f.jsonl",
        text: "hi",
      });
    }

    // First entry (message_id=1) should be evicted
    expect(notifications.getSessionForMessage(1)).toBeUndefined();
    // Last entry should exist
    expect(notifications.getSessionForMessage(501)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/telegram/notifications.test.ts -v`
Expected: FAIL — `getSessionForMessage` does not exist.

- [ ] **Step 3: Implement message tracking**

In `src/telegram/notifications.ts`, add to the `NotificationService` class:

```typescript
  private messageToSession = new Map<number, { sessionId: string; cwd?: string }>();
  private static MAX_TRACKED_MESSAGES = 500;

  getSessionForMessage(messageId: number): { sessionId: string; cwd?: string } | undefined {
    return this.messageToSession.get(messageId);
  }

  private trackMessage(messageId: number, sessionId: string, cwd?: string): void {
    this.messageToSession.set(messageId, { sessionId, cwd });
    // Evict oldest if over limit
    if (this.messageToSession.size > NotificationService.MAX_TRACKED_MESSAGES) {
      const firstKey = this.messageToSession.keys().next().value!;
      this.messageToSession.delete(firstKey);
    }
  }
```

Clear the map in `register`:
```typescript
  register(bot: Bot, chatId: number): void {
    this.bot = bot;
    this.chatId = chatId;
    this.toolStatus.clear();
    this.messageToSession.clear();
    // ... rest unchanged
  }
```

In `notifyResponse`, the current code uses `sendMarkdownMessage` which returns `void` and doesn't expose the `message_id`. Change `notifyResponse` to call `bot.api.sendMessage` directly and track the result:

Replace the try block in `notifyResponse`:
```typescript
    try {
      const sent = await this.bot.api.sendMessage(this.chatId, text, { parse_mode: "Markdown" });
      this.trackMessage(sent.message_id, state.sessionId, state.cwd);
      log({ chatId: this.chatId, message: `notified response: ${state.projectName} (${state.text.slice(0, 60)})` });
    } catch {
      // Markdown failed — try plain text
      try {
        const sent = await this.bot.api.sendMessage(this.chatId, text);
        this.trackMessage(sent.message_id, state.sessionId, state.cwd);
        log({ chatId: this.chatId, message: `notified response: ${state.projectName} (${state.text.slice(0, 60)})` });
      } catch (err) {
        log({ message: `failed to send response notification: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
```

In `notifyToolUse`, the first message already uses `bot.api.sendMessage` and stores the result. Add tracking after the `this.toolStatus.set` line:

```typescript
        this.toolStatus.set(sessionId, { messageId: sent.message_id, tools: newEntries });
        this.trackMessage(sent.message_id, sessionId);
```

Also add a module-level wrapper:
```typescript
export function getSessionForMessage(messageId: number): { sessionId: string; cwd?: string } | undefined {
  return notifications.getSessionForMessage(messageId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/telegram/notifications.test.ts -v`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/telegram/notifications.ts src/telegram/notifications.test.ts
git commit -m "feat: track message-to-session mapping for reply routing"
```

---

### Task 2: Route replies to the correct session

**Files:**
- Modify: `src/telegram/handlers/text.ts`
- Modify: `src/telegram/handlers/text.test.ts`

- [ ] **Step 1: Write the test**

Add to `src/telegram/handlers/text.test.ts`. The test file mocks notifications — add `getSessionForMessage` to the mock:

```typescript
vi.mock("../notifications.js", () => ({
  // ... existing mocks ...
  getSessionForMessage: vi.fn(),
}));
```

Import it:
```typescript
import { getSessionForMessage } from "../notifications.js";
```

Add the test:
```typescript
describe("reply-to session routing", () => {
  it("routes to the session from the replied-to message", async () => {
    vi.mocked(getSessionForMessage).mockReturnValue({
      sessionId: "target-session",
      cwd: "/tmp/target",
    });

    // The ctx.message.reply_to_message.message_id should trigger lookup
    // This tests the logic indirectly — processTextTurn should use the reply session
    // We verify by checking that injectInput is called with the target cwd
  });
});
```

Note: The existing text.test.ts may already mock many things. Look at the existing test patterns and follow them. The key assertion is that when `ctx.message.reply_to_message` is present and `getSessionForMessage` returns a session, `injectInput` is called with that session's cwd instead of the attached session.

- [ ] **Step 2: Implement reply routing in processTextTurn**

In `src/telegram/handlers/text.ts`, import `getSessionForMessage` and `ATTACHED_SESSION_PATH`:

```typescript
import { getSessionForMessage } from "../notifications.js";
```

(`ATTACHED_SESSION_PATH` is already imported via `history.js`)

In `processTextTurn`, after the timer setup block and before `const attached = await ensureSession(ctx, chatId)`, add:

```typescript
  // Reply-to routing: if user replies to a message from a specific session, route there
  const replyToId = ctx.message?.reply_to_message?.message_id;
  if (replyToId) {
    const replySession = getSessionForMessage(replyToId);
    if (replySession?.cwd) {
      log({ chatId, message: `reply-to routing: message ${replyToId} → session ${replySession.sessionId.slice(0, 8)}` });
      await writeFile(ATTACHED_SESSION_PATH, `${replySession.sessionId}\n${replySession.cwd}`, "utf8").catch(() => {});

      const attached = { sessionId: replySession.sessionId, cwd: replySession.cwd };

      if (watcherManager.isActive) {
        const pane = await findClaudePane(attached.cwd);
        if (pane.found) {
          log({ message: `Interrupting Claude Code (Ctrl+C) for new message` });
          watcherManager.stopAndFlush();
          await sendInterrupt(pane.paneId);
          await new Promise((r) => setTimeout(r, 600));
        }
      }

      getStreamManager()?.pause(attached.cwd);

      const preBaseline = await watcherManager.snapshotBaseline(attached.cwd);

      log({ chatId, message: `inject: ${text.slice(0, 80)}` });
      const result = await injectInput(attached.cwd, text, launchedPaneId);

      if (!result.found) {
        await sendMarkdownReply(ctx, "No Claude Code running at this session. Start it, or use /sessions to switch.");
        return;
      }

      await ctx.replyWithChatAction("typing");
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);
      await watcherManager.startInjectionWatcher(attached, chatId, undefined, () => {
        clearInterval(typingInterval);
        watcherManager.clear();
        void getStreamManager()?.resume(attached.cwd);
      }, preBaseline);
      return;
    }
  }
```

This block is a self-contained early return — if the reply-to session is found, it handles the full injection flow and returns. If not (unknown message or no cwd), falls through to the normal flow.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/telegram/handlers/text.ts src/telegram/handlers/text.test.ts
git commit -m "feat: route replies to the session that produced the message"
```
