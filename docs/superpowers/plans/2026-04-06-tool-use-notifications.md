# Tool Use Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live, editable status message in Telegram when Claude Code uses tools, giving real-time visibility into what's happening during a turn.

**Architecture:** Extract `tool_use` blocks from JSONL, pass them through a new `onToolUse` callback in `watchForResponse`, and render them as a single editable Telegram message per session that accumulates tool names (with Bash command previews) chained by `->`.

**Tech Stack:** TypeScript, grammy (`editMessageText`), existing JSONL parsing

---

### Task 1: Add `extractToolUses` to jsonl.ts

**Files:**
- Modify: `src/session/jsonl.ts`
- Modify: `src/session/jsonl.test.ts`

- [ ] **Step 1: Write the test**

Add to `src/session/jsonl.test.ts`:

```typescript
describe("extractToolUses", () => {
  it("extracts tool_use blocks with name and command for Bash", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls /tmp" } },
          ],
        },
      }),
    ];
    const result = extractToolUses(lines);
    expect(result).toEqual([{ id: "t1", name: "Bash", command: "ls /tmp" }]);
  });

  it("extracts non-Bash tools with name only", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/foo.ts" } },
          ],
        },
      }),
    ];
    const result = extractToolUses(lines);
    expect(result).toEqual([{ id: "t2", name: "Read" }]);
  });

  it("extracts multiple tools from multiple entries", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me check" },
            { type: "tool_use", id: "t3", name: "Grep", input: { pattern: "foo" } },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t4", name: "Bash", input: { command: "npm test" } },
          ],
        },
      }),
    ];
    const result = extractToolUses(lines);
    expect(result).toEqual([
      { id: "t3", name: "Grep" },
      { id: "t4", name: "Bash", command: "npm test" },
    ]);
  });

  it("skips non-assistant entries and entries without tool_use", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
    ];
    const result = extractToolUses(lines);
    expect(result).toEqual([]);
  });

  it("truncates long Bash commands to 60 chars", () => {
    const longCmd = "a".repeat(100);
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t5", name: "Bash", input: { command: longCmd } },
          ],
        },
      }),
    ];
    const result = extractToolUses(lines);
    expect(result[0].command).toBe("a".repeat(57) + "...");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/session/jsonl.test.ts -v`
Expected: FAIL — `extractToolUses` not exported.

- [ ] **Step 3: Implement extractToolUses**

Add to `src/session/jsonl.ts`:

```typescript
export type ToolUseEntry = {
  id: string;
  name: string;
  command?: string;
};

/**
 * Extract all tool_use blocks from JSONL lines.
 * For Bash, includes a truncated command preview.
 */
export function extractToolUses(lines: string[]): ToolUseEntry[] {
  const result: ToolUseEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "assistant") continue;
      const blocks: ContentBlock[] = entry.message?.content ?? [];
      for (const block of blocks) {
        if (block.type !== "tool_use" || !block.name || !block.id) continue;
        const tool: ToolUseEntry = { id: block.id, name: block.name };
        if (block.name === "Bash" && block.input) {
          const cmd = block.input.command;
          if (typeof cmd === "string") {
            tool.command = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
          }
        }
        result.push(tool);
      }
    } catch {
      continue;
    }
  }
  return result;
}
```

Also add the import of `extractToolUses` to the test file's imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/session/jsonl.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session/jsonl.ts src/session/jsonl.test.ts
git commit -m "feat: add extractToolUses for parsing tool_use blocks from JSONL"
```

---

### Task 2: Add `onToolUse` callback to `watchForResponse`

**Files:**
- Modify: `src/session/monitor.ts:215-392`
- Modify: `src/session/monitor.test.ts`

- [ ] **Step 1: Write the test**

Add to the `watchForResponse` describe block in `src/session/monitor.test.ts`:

```typescript
it("fires onToolUse when tool_use blocks appear after baseline", async () => {
  const file = join(tmpDir, "tool-session.jsonl");
  await writeFile(file, "");

  const tools: { id: string; name: string; command?: string }[][] = [];
  const stop = watchForResponse(
    file,
    0,
    async () => {},
    undefined,
    undefined,
    undefined,
    async (t) => { tools.push(t); }
  );

  // Write a tool_use entry
  await appendFile(
    file,
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    }) + "\n"
  );

  await new Promise((r) => setTimeout(r, 500));

  expect(tools.length).toBeGreaterThanOrEqual(1);
  expect(tools[0]).toEqual([{ id: "t1", name: "Bash", command: "ls" }]);

  stop();
});

it("does not fire onToolUse for already-reported tool IDs", async () => {
  const file = join(tmpDir, "tool-dedup.jsonl");
  await writeFile(file, "");

  const toolCalls: { id: string; name: string; command?: string }[][] = [];
  const stop = watchForResponse(
    file,
    0,
    async () => {},
    undefined,
    undefined,
    undefined,
    async (t) => { toolCalls.push(t); }
  );

  const entry = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/foo" } },
      ],
    },
  }) + "\n";

  // Write same entry twice (simulating chokidar firing twice)
  await appendFile(file, entry);
  await new Promise((r) => setTimeout(r, 500));

  // Write a new tool
  await appendFile(
    file,
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t2", name: "Edit", input: {} },
        ],
      },
    }) + "\n"
  );
  await new Promise((r) => setTimeout(r, 500));

  // First call should have t1, second should have only t2 (not t1 again)
  expect(toolCalls.length).toBeGreaterThanOrEqual(2);
  expect(toolCalls[0]).toEqual([{ id: "t1", name: "Read" }]);
  expect(toolCalls[1]).toEqual([{ id: "t2", name: "Edit" }]);

  stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/session/monitor.test.ts -v`
Expected: FAIL — `watchForResponse` doesn't accept 7th parameter.

- [ ] **Step 3: Add onToolUse to watchForResponse**

In `src/session/monitor.ts`, update the `watchForResponse` signature to add the 7th parameter:

```typescript
export type ToolUseCallback = (tools: ToolUseEntry[]) => Promise<void>;

export function watchForResponse(
  filePath: string,
  baselineSize: number,
  onResponse: ResponseCallback,
  onPing?: () => void,
  onComplete?: () => void,
  onImages?: ImagesCallback,
  onToolUse?: ToolUseCallback
): () => void {
```

Import `extractToolUses` and `ToolUseEntry` from `./jsonl.js`:

```typescript
import { parseAssistantText, extractCwd, findResultEvent, findExitPlanMode, extractWrittenImagePaths, extractToolUses, type ToolUseEntry } from "./jsonl.js";
```

Add a `Set<string>` to track reported tool IDs, after the existing `writtenImagePaths` set:

```typescript
const reportedToolIds = new Set<string>();
```

In the `watcher.on("change")` handler, after the `parseAssistantText` call and before the `isComplete` check, add tool use detection:

```typescript
        // Detect and report new tool_use blocks
        if (onToolUse) {
          const allTools = extractToolUses(lines);
          const newTools = allTools.filter((t) => !reportedToolIds.has(t.id));
          if (newTools.length > 0) {
            for (const t of newTools) reportedToolIds.add(t.id);
            onToolUse(newTools).catch(
              (err) => log({ message: `watchForResponse onToolUse error: ${err instanceof Error ? err.message : String(err)}` })
            );
          }
        }
```

Also export the `ToolUseCallback` type.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/session/monitor.test.ts -v`
Expected: PASS

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: All pass (existing callers pass `undefined` implicitly for the new parameter).

- [ ] **Step 6: Commit**

```bash
git add src/session/monitor.ts src/session/monitor.test.ts
git commit -m "feat: add onToolUse callback to watchForResponse"
```

---

### Task 3: Add `notifyToolUse` to NotificationService

**Files:**
- Modify: `src/telegram/notifications.ts`
- Modify: `src/telegram/notifications.test.ts`

- [ ] **Step 1: Write the tests**

Add to `src/telegram/notifications.test.ts`:

```typescript
describe("notifyToolUse", () => {
  it("sends a new message on first tool use for a session", async () => {
    notifications.register(mockBot as any, 123);
    await notifications.notifyToolUse("myproject", "session-1", [
      { id: "t1", name: "Bash", command: "ls /tmp" },
    ]);
    expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
      123,
      expect.stringContaining("Bash"),
      expect.any(Object)
    );
  });

  it("edits the existing message on subsequent tool uses for same session", async () => {
    notifications.register(mockBot as any, 123);
    mockBot.api.sendMessage.mockResolvedValue({ message_id: 42 });

    await notifications.notifyToolUse("myproject", "session-1", [
      { id: "t1", name: "Read" },
    ]);
    await notifications.notifyToolUse("myproject", "session-1", [
      { id: "t2", name: "Edit" },
    ]);

    expect(mockBot.api.editMessageText).toHaveBeenCalledWith(
      123,
      42,
      expect.stringContaining("Read"),
      expect.any(Object)
    );
  });

  it("includes truncated command for Bash tools", async () => {
    notifications.register(mockBot as any, 123);
    await notifications.notifyToolUse("myproject", "session-1", [
      { id: "t1", name: "Bash", command: "npm test" },
    ]);
    expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
      123,
      expect.stringContaining("Bash(`npm test`)"),
      expect.any(Object)
    );
  });

  it("clears tool status when notifyResponse fires for same session", async () => {
    notifications.register(mockBot as any, 123);
    mockBot.api.sendMessage.mockResolvedValue({ message_id: 42 });

    await notifications.notifyToolUse("myproject", "session-1", [
      { id: "t1", name: "Read" },
    ]);
    // notifyResponse clears the tool status
    await notifications.notifyResponse({
      sessionId: "session-1",
      projectName: "myproject",
      cwd: "/tmp",
      filePath: "/tmp/f.jsonl",
      text: "Done",
    });

    // Next tool use for same session should send a NEW message (not edit)
    mockBot.api.sendMessage.mockResolvedValue({ message_id: 99 });
    await notifications.notifyToolUse("myproject", "session-1", [
      { id: "t2", name: "Bash", command: "echo hi" },
    ]);
    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(3); // tool + response + new tool
  });
});
```

Add `editMessageText` to the `mockBot` setup if not already present:

```typescript
mockBot.api.editMessageText = vi.fn().mockResolvedValue({});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/telegram/notifications.test.ts -v`
Expected: FAIL — `notifyToolUse` does not exist.

- [ ] **Step 3: Implement notifyToolUse**

In `src/telegram/notifications.ts`, add to the `NotificationService` class:

```typescript
  // Tool use status messages: one editable message per session
  private toolStatus = new Map<string, { messageId: number; tools: { name: string; command?: string }[] }>();

  async notifyToolUse(
    projectName: string,
    sessionId: string,
    tools: { id: string; name: string; command?: string }[]
  ): Promise<void> {
    if (!this.bot || !this.chatId) return;

    const existing = this.toolStatus.get(sessionId);
    const newEntries = tools.map((t) => ({
      name: t.name,
      ...(t.command ? { command: t.command } : {}),
    }));

    if (existing) {
      existing.tools.push(...newEntries);
      const text = this.formatToolStatus(projectName, existing.tools);
      try {
        await this.bot.api.editMessageText(this.chatId, existing.messageId, text, {
          parse_mode: "Markdown",
        });
      } catch (err) {
        log({ message: `editMessageText error: ${err instanceof Error ? err.message : String(err)}` });
      }
    } else {
      const text = this.formatToolStatus(projectName, newEntries);
      try {
        const sent = await this.bot.api.sendMessage(this.chatId, text, {
          parse_mode: "Markdown",
        });
        this.toolStatus.set(sessionId, { messageId: sent.message_id, tools: newEntries });
      } catch (err) {
        log({ message: `notifyToolUse send error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }

  private formatToolStatus(projectName: string, tools: { name: string; command?: string }[]): string {
    const parts = tools.map((t) =>
      t.command ? `${t.name}(\`${t.command}\`)` : t.name
    );
    return `\`${projectName}:\` ${parts.join(" → ")}`;
  }
```

In `notifyResponse`, clear the tool status for the session. Add at the top of the method (after the bot/chatId check and the PLAN_APPROVAL check):

```typescript
    this.toolStatus.delete(state.sessionId);
```

Add a module-level wrapper export:

```typescript
export async function notifyToolUse(
  projectName: string,
  sessionId: string,
  tools: { id: string; name: string; command?: string }[]
): Promise<void> {
  return notifications.notifyToolUse(projectName, sessionId, tools);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/telegram/notifications.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/telegram/notifications.ts src/telegram/notifications.test.ts
git commit -m "feat: add notifyToolUse with editable status messages"
```

---

### Task 4: Wire onToolUse into stream-manager and watcher-manager

**Files:**
- Modify: `src/session/stream-manager.ts`
- Modify: `src/session/watcher-manager.ts`

- [ ] **Step 1: Update stream-manager to pass onToolUse**

In `src/session/stream-manager.ts`, import `notifyToolUse`:

```typescript
import { notifyResponse, notifyToolUse } from "../telegram/notifications.js";
```

In the `startWatcher` method, the `watchForResponse` call currently is:

```typescript
    const stop = watchForResponse(
      filePath,
      baseline,
      notifyResponse,
      undefined,
      onComplete,
    );
```

Add the `onToolUse` callback as the 7th parameter:

```typescript
    const projectName = cwd.split("/").pop() || cwd;

    const stop = watchForResponse(
      filePath,
      baseline,
      notifyResponse,
      undefined,
      onComplete,
      undefined,
      async (tools) => { await notifyToolUse(projectName, sessionId, tools); }
    );
```

- [ ] **Step 2: Update watcher-manager to pass onToolUse**

In `src/session/watcher-manager.ts`, import `notifyToolUse`:

```typescript
import { notifyResponse, notifyImages, sendPing, notifyToolUse } from "../telegram/notifications.js";
```

In the `startInjectionWatcher` method, the `watchForResponse` call currently is (around line 100):

```typescript
    this.activeStop = watchForResponse(
      filePath,
      baseline,
      wrappedOnResponse,
      () => sendPing("⏳ Still working..."),
      () => { ... },
      async (images: DetectedImage[]) => { ... }
    );
```

Add the 7th parameter:

```typescript
    const projectName = filePath.split("/").slice(-2, -1)[0];
    const decodedProjectName = projectName.replace(/^-/, "").replace(/-/g, "/").split("/").pop() || projectName;

    this.activeStop = watchForResponse(
      filePath,
      baseline,
      wrappedOnResponse,
      () => sendPing("⏳ Still working..."),
      () => { ... },
      async (images: DetectedImage[]) => { ... },
      async (tools) => { await notifyToolUse(decodedProjectName, latestSessionId, tools); }
    );
```

Also do the same for the `pollForPostCompactionSession` method's `watchForResponse` call (around line 140):

```typescript
        this.activeStop = watchForResponse(
          latest.filePath,
          0,
          async (state) => { await (onResponse ?? notifyResponse)(state); },
          () => sendPing("⏳ Still working..."),
          () => {
            this.activeOnComplete = null;
            onComplete?.();
          },
          undefined,
          async (tools) => {
            const pName = latest.filePath.split("/").slice(-2, -1)[0];
            const decoded = pName.replace(/^-/, "").replace(/-/g, "/").split("/").pop() || pName;
            await notifyToolUse(decoded, latest.sessionId, tools);
          }
        );
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/session/stream-manager.ts src/session/watcher-manager.ts
git commit -m "feat: wire onToolUse into stream and injection watchers"
```

---

### Task 5: Full test suite and manual verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Verify the bot starts cleanly**

Run: `timeout 5 npx tsx src/index.ts 2>&1 || true`
Expected: "codedove bot running" appears, no errors.

- [ ] **Step 3: Commit any remaining changes**

If there are any unstaged changes, commit them.
