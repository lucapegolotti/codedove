# Session Launch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When `/sessions` attach finds no running Claude Code pane, offer to launch one in a new tmux window; add `/close_session` to kill Claude Code and close the window.

**Architecture:** Add `launchClaudeInWindow` to `tmux.ts`. Modify the `session:` callback in `bot.ts` to check for a running pane before attaching — if none found, send a 3-button launch prompt. Handle new `launch:` callback data. Add `/close_session` command.

**Tech Stack:** Node.js, TypeScript, grammY (Telegram bot), tmux CLI, vitest

---

### Task 1: Add `launchClaudeInWindow` to `tmux.ts`

**Files:**
- Modify: `src/session/tmux.ts`
- Test: `src/session/tmux.test.ts`

**Step 1: Write the failing test**

Add to `src/session/tmux.test.ts` after the existing `describe` block:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { findBestPane, type TmuxPane } from "./tmux.js";

// ... existing tests unchanged ...

describe("launchClaudeInWindow", () => {
  it("is exported from tmux.ts", async () => {
    const mod = await import("./tmux.js");
    expect(typeof mod.launchClaudeInWindow).toBe("function");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --reporter=verbose src/session/tmux.test.ts
```

Expected: FAIL — `launchClaudeInWindow is not a function` (or not exported)

**Step 3: Implement `launchClaudeInWindow` in `src/session/tmux.ts`**

Add after the `injectInput` export at the bottom of the file:

```ts
// Sanitize a string for use as a tmux window name (no dots, colons, or spaces)
function sanitizeWindowName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 30);
}

export async function launchClaudeInWindow(
  cwd: string,
  projectName: string,
  skipPermissions: boolean
): Promise<void> {
  const winName = sanitizeWindowName(projectName);
  // Create a new window and capture its ID
  const { stdout } = await execAsync(
    `tmux new-window -c '${cwd.replace(/'/g, "'\\''")}' -n '${winName}' -P -F '#{pane_id}'`
  );
  const paneId = stdout.trim();
  const cmd = skipPermissions
    ? "claude -C --dangerously-skip-permissions"
    : "claude -C";
  await execAsync(`tmux send-keys -t '${paneId}' '${cmd}'`);
  await new Promise((r) => setTimeout(r, 100));
  await execAsync(`tmux send-keys -t '${paneId}' Enter`);
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- --reporter=verbose src/session/tmux.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/session/tmux.ts src/session/tmux.test.ts
git commit -m "feat: add launchClaudeInWindow to tmux helpers"
```

---

### Task 2: Check for running pane on session attach, show launch prompt if none

**Files:**
- Modify: `src/telegram/bot.ts`

The `session:` callback (around line 449) currently writes the attached file immediately and replies "Attached". Change it to first check for a running pane.

**Step 1: Modify the `session:` callback handler**

Replace the existing `if (data.startsWith("session:"))` block (lines 449–464) with:

```ts
if (data.startsWith("session:")) {
  const sessionId = data.slice("session:".length);
  const session = pendingSessions.get(sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: "Session not found — try /sessions again." });
    return;
  }

  // Check whether Claude Code is already running at this cwd
  const pane = await findClaudePane(session.cwd).catch(() => ({ found: false as const, reason: "no_tmux" as const }));

  if (pane.found) {
    // Claude Code is running — attach immediately
    await mkdir(`${homedir()}/.claude-voice`, { recursive: true });
    await writeFile(ATTACHED_SESSION_PATH, `${session.sessionId}\n${session.cwd}`, "utf8");
    clearChatState(ctx.chat!.id);
    clearAdapterSession(ctx.chat!.id);
    await ctx.answerCallbackQuery({ text: "Attached!" });
    await ctx.reply(`Attached to \`${session.projectName}\`. Send your first message.`, {
      parse_mode: "Markdown",
    });
  } else {
    // No running pane — offer to launch
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard()
      .text("Launch", `launch:${sessionId}`)
      .text("Launch (skip permissions)", `launch:skip:${sessionId}`)
      .row()
      .text("Cancel", `launch:cancel:${sessionId}`);
    await ctx.reply(
      `No Claude Code running at \`${session.projectName}\`. Launch one?`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  }
  return;
}
```

**Step 2: Verify bot compiles**

```bash
npx tsc --noEmit
```

Expected: no errors

**Step 3: Commit**

```bash
git add src/telegram/bot.ts
git commit -m "feat: check for running pane before attaching session"
```

---

### Task 3: Handle `launch:` callback — launch tmux window and attach

**Files:**
- Modify: `src/telegram/bot.ts`

**Step 1: Add the `launch:` callback handler**

In the `bot.on("callback_query:data")` handler, add a new block before the final closing brace of the handler. Insert it after the `session:` block (after the `return;` at the end of the session block):

```ts
if (data.startsWith("launch:")) {
  // data is one of: launch:<sessionId>, launch:skip:<sessionId>, launch:cancel:<sessionId>
  if (data.startsWith("launch:cancel:")) {
    await ctx.answerCallbackQuery({ text: "Cancelled." });
    await ctx.editMessageReplyMarkup(); // remove buttons
    return;
  }

  const skipPermissions = data.startsWith("launch:skip:");
  const sessionId = skipPermissions
    ? data.slice("launch:skip:".length)
    : data.slice("launch:".length);

  const session = pendingSessions.get(sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: "Session not found — try /sessions again." });
    return;
  }

  try {
    await launchClaudeInWindow(session.cwd, session.projectName, skipPermissions);
  } catch (err) {
    await ctx.answerCallbackQuery({ text: "Failed to launch tmux window." });
    log({ message: `launchClaudeInWindow error: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  // Attach to this project's cwd — sessionId will be discovered lazily by the watcher
  await mkdir(`${homedir()}/.claude-voice`, { recursive: true });
  await writeFile(ATTACHED_SESSION_PATH, `${session.sessionId}\n${session.cwd}`, "utf8");
  clearChatState(ctx.chat!.id);
  clearAdapterSession(ctx.chat!.id);

  await ctx.answerCallbackQuery({ text: "Launched!" });
  const flag = skipPermissions ? " with `--dangerously-skip-permissions`" : "";
  await ctx.editMessageText(
    `Launching Claude Code${flag} at \`${session.projectName}\`…\n\nSend a message once it's ready.`,
    { parse_mode: "Markdown" }
  );
  return;
}
```

**Step 2: Add `launchClaudeInWindow` to the import at the top of `bot.ts`**

The import on line 9 currently reads:
```ts
import { injectInput, findClaudePane, sendKeysToPane, sendRawKeyToPane } from "../session/tmux.js";
```

Change to:
```ts
import { injectInput, findClaudePane, sendKeysToPane, sendRawKeyToPane, launchClaudeInWindow } from "../session/tmux.js";
```

**Step 3: Verify bot compiles**

```bash
npx tsc --noEmit
```

Expected: no errors

**Step 4: Commit**

```bash
git add src/telegram/bot.ts
git commit -m "feat: handle launch callbacks to open claude in new tmux window"
```

---

### Task 4: Add `/close_session` command

**Files:**
- Modify: `src/telegram/bot.ts`

**Step 1: Add the command handler**

Add after the existing `bot.command("detach", ...)` block:

```ts
bot.command("close_session", async (ctx) => {
  const attached = await getAttachedSession().catch(() => null);
  if (!attached) {
    await ctx.reply("No session attached.");
    return;
  }

  const pane = await findClaudePane(attached.cwd).catch(() => ({ found: false as const, reason: "no_tmux" as const }));

  // Clear bot state regardless of whether we find the pane
  try { await unlink(ATTACHED_SESSION_PATH); } catch { /* already gone */ }
  clearChatState(ctx.chat.id);
  clearAdapterSession(ctx.chat.id);
  if (activeWatcherStop) {
    activeWatcherStop();
    activeWatcherStop = null;
  }

  if (pane.found) {
    try {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      await promisify(exec)(`tmux kill-window -t '${pane.paneId}'`);
      await ctx.reply("Session closed.");
    } catch (err) {
      log({ message: `close_session kill-window error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Could not kill tmux window, but detached.");
    }
  } else {
    await ctx.reply("No running session found — detached.");
  }
});
```

Note: `exec` and `promisify` are already used in `tmux.ts` but not imported in `bot.ts`. Rather than adding those imports to `bot.ts`, add a `killWindow` helper to `tmux.ts` instead (see step 2).

**Step 2: Add `killWindow` to `tmux.ts` and use it**

In `src/session/tmux.ts`, add after `launchClaudeInWindow`:

```ts
export async function killWindow(paneId: string): Promise<void> {
  await execAsync(`tmux kill-window -t '${paneId}'`);
}
```

Then in the `/close_session` handler in `bot.ts`, replace the dynamic `import("child_process")` block with:

```ts
import { injectInput, findClaudePane, sendKeysToPane, sendRawKeyToPane, launchClaudeInWindow, killWindow } from "../session/tmux.js";
```

And the handler body becomes:

```ts
bot.command("close_session", async (ctx) => {
  const attached = await getAttachedSession().catch(() => null);
  if (!attached) {
    await ctx.reply("No session attached.");
    return;
  }

  const pane = await findClaudePane(attached.cwd).catch(() => ({ found: false as const, reason: "no_tmux" as const }));

  try { await unlink(ATTACHED_SESSION_PATH); } catch { /* already gone */ }
  clearChatState(ctx.chat.id);
  clearAdapterSession(ctx.chat.id);
  if (activeWatcherStop) {
    activeWatcherStop();
    activeWatcherStop = null;
  }

  if (pane.found) {
    await killWindow(pane.paneId).catch((err) => {
      log({ message: `killWindow error: ${err instanceof Error ? err.message : String(err)}` });
    });
    await ctx.reply("Session closed.");
  } else {
    await ctx.reply("No running session found — detached.");
  }
});
```

**Step 3: Verify bot compiles**

```bash
npx tsc --noEmit
```

Expected: no errors

**Step 4: Run all tests**

```bash
npm test
```

Expected: all pass

**Step 5: Commit**

```bash
git add src/session/tmux.ts src/telegram/bot.ts
git commit -m "feat: add /close_session command to kill tmux window and detach"
```

---

### Task 5: Install and smoke-test

**Step 1: Install globally**

```bash
npm install -g .
```

**Step 2: Restart the bot via TUI**

In the TUI, press `r` to restart the bot.

**Step 3: Manual smoke test**

1. Send `/sessions` — verify session list appears
2. Tap a session where Claude Code is **not** running — verify launch prompt appears with three buttons
3. Tap `[Launch]` — verify a new tmux window opens running `claude -C`, bot replies "Launching…"
4. Tap a session where Claude Code **is** running — verify bot attaches directly
5. Send `/close_session` — verify the tmux window closes and bot replies "Session closed."
6. Send `/close_session` with no session attached — verify "No session attached."
