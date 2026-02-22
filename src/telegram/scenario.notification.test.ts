/**
 * Smoke test: JSONL write → watchForResponse → notifyResponse → Telegram API
 *
 * Verifies the full notification pipeline end-to-end:
 *   1. A JSONL file is written to disk (real filesystem)
 *   2. watchForResponse (real chokidar watcher) detects the change
 *   3. notifyResponse is called as the onResponse callback
 *   4. The mock Telegram bot's sendMessage is invoked with correctly formatted text
 *
 * Only the Telegram API and getAttachedSession are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, appendFile, rm } from "fs/promises";
import { join } from "path";

vi.mock("../session/history.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, getAttachedSession: vi.fn() };
});

import { getAttachedSession, PROJECTS_PATH } from "../session/history.js";
import { watchForResponse, getFileSize } from "../session/monitor.js";
import { notifyResponse, registerForNotifications } from "./notifications.js";

const CHAT_ID = 99887766;

function assistantEntry(text: string, cwd = "/tmp/proj"): string {
  return JSON.stringify({ type: "assistant", cwd, message: { content: [{ type: "text", text }] } }) + "\n";
}

function resultEntry(): string {
  return JSON.stringify({ type: "result", source: "stop-hook" }) + "\n";
}

describe("scenario: JSONL write → watchForResponse → notifyResponse → Telegram API", () => {
  let projectDir: string;
  let mockBot: { api: { sendMessage: ReturnType<typeof vi.fn>; sendPhoto: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockBot = {
      api: {
        sendMessage: vi.fn().mockResolvedValue({}),
        sendPhoto: vi.fn().mockResolvedValue({}),
      },
    };
    registerForNotifications(mockBot as any, CHAT_ID);
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("delivers formatted assistant text to Telegram when JSONL is appended", async () => {
    const testId = Date.now();
    const sessionId = `session-smoke-${testId}`;
    const fakeCwd = `/cv-notify-smoke-${testId}`;
    const encodedCwd = fakeCwd.replace(/[^a-zA-Z0-9]/g, "-");
    projectDir = join(PROJECTS_PATH, encodedCwd);
    await mkdir(projectDir, { recursive: true });

    const sessionFile = join(projectDir, `${sessionId}.jsonl`);
    await writeFile(sessionFile, "");
    const baseline = await getFileSize(sessionFile);

    // Mock getAttachedSession to match the session being watched
    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId, cwd: fakeCwd });

    let completed = false;
    const stop = watchForResponse(
      sessionFile,
      baseline,
      notifyResponse,
      undefined,
      () => { completed = true; },
    );

    // Simulate Claude writing a response with both `:` and `;` characters
    await new Promise((r) => setTimeout(r, 50));
    await appendFile(sessionFile, assistantEntry("Step one: done; step two: done"));
    await new Promise((r) => setTimeout(r, 50));
    await appendFile(sessionFile, resultEntry());

    // Wait up to 3 s for the watcher to fire and onComplete to be called
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (completed) { clearInterval(interval); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(interval); resolve(); }, 3000);
    });

    stop();

    // Pipeline must have completed
    expect(completed).toBe(true);

    // Telegram sendMessage must have been called at least once
    expect(mockBot.api.sendMessage).toHaveBeenCalled();

    // Extract the call arguments
    const calls = mockBot.api.sendMessage.mock.calls;
    const [sentChatId, sentText] = calls[0] as [number, string];

    // Must be sent to the configured chat ID
    expect(sentChatId).toBe(CHAT_ID);

    // Must start with a backtick-quoted project-name prefix
    expect(sentText).toMatch(/^`[^`]+:`/);

    // Colons and semicolons are preserved (TTS sanitization moved to voice layer)
    expect(sentText).toContain("Step one: done; step two: done");
  }, 8_000);
});
