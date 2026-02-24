import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "grammy";
import { handleWaitingCallback } from "./waiting.js";
import { getAttachedSession } from "../../../session/history.js";
import { injectInput } from "../../../session/tmux.js";
import { resolveWaitingAction } from "../../notifications.js";
import { startInjectionWatcher, snapshotBaseline } from "../text.js";

vi.mock("../../../session/history.js", () => ({
  getAttachedSession: vi.fn(),
}));

vi.mock("../../../session/tmux.js", () => ({
  injectInput: vi.fn(),
}));

vi.mock("../../notifications.js", () => ({
  resolveWaitingAction: vi.fn(),
  registerForNotifications: vi.fn(),
  notifyResponse: vi.fn(),
  sendPing: vi.fn(),
}));

vi.mock("../text.js", () => ({
  startInjectionWatcher: vi.fn().mockResolvedValue(undefined),
  snapshotBaseline: vi.fn().mockResolvedValue({ filePath: "/test.jsonl", sessionId: "s1", size: 0 }),
}));

function makeCtx() {
  return {
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    chat: { id: 12345 },
  } as unknown as Context;
}

describe("handleWaitingCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("waiting:ignore answers Ignored.", async () => {
    const ctx = makeCtx();
    await handleWaitingCallback(ctx, "waiting:ignore");

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Ignored." });
    expect(resolveWaitingAction).not.toHaveBeenCalled();
  });

  it("waiting:custom answers Send your input as a text message.", async () => {
    const ctx = makeCtx();
    await handleWaitingCallback(ctx, "waiting:custom");

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Send your input as a text message." });
    expect(resolveWaitingAction).not.toHaveBeenCalled();
  });

  it("valid action with found pane: resolves, injects, answers Sent!, starts watcher", async () => {
    const ctx = makeCtx();
    vi.mocked(resolveWaitingAction).mockReturnValue("y");
    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%1" });

    await handleWaitingCallback(ctx, "waiting:yes");

    expect(resolveWaitingAction).toHaveBeenCalledWith("waiting:yes");
    expect(snapshotBaseline).toHaveBeenCalledWith("/proj");
    expect(injectInput).toHaveBeenCalledWith("/proj", "y");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Sent!" });
    expect(ctx.reply).toHaveBeenCalledWith('Sent "y". Claude is resuming.');
    expect(startInjectionWatcher).toHaveBeenCalled();
  });

  it("valid action with no pane: answers Could not find tmux pane.", async () => {
    const ctx = makeCtx();
    vi.mocked(resolveWaitingAction).mockReturnValue("y");
    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(injectInput).mockResolvedValue({ found: false, reason: "no_claude_pane" });

    await handleWaitingCallback(ctx, "waiting:yes");

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Could not find tmux pane." });
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("valid action with no session: answers No attached session.", async () => {
    const ctx = makeCtx();
    vi.mocked(resolveWaitingAction).mockReturnValue("y");
    vi.mocked(getAttachedSession).mockResolvedValue(null);

    await handleWaitingCallback(ctx, "waiting:yes");

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "No attached session." });
  });

  it("resolveWaitingAction returns null: does nothing", async () => {
    const ctx = makeCtx();
    vi.mocked(resolveWaitingAction).mockReturnValue(null);

    await handleWaitingCallback(ctx, "waiting:something");

    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
    expect(getAttachedSession).not.toHaveBeenCalled();
  });
});
