import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "grammy";
import { handlePermissionCallback } from "./permissions.js";
import { log } from "../../../logger.js";
import { getAttachedSession } from "../../../session/history.js";
import { respondToPermission } from "../../../session/permissions.js";
import { findClaudePane, sendKeysToPane, sendRawKeyToPane } from "../../../session/tmux.js";

vi.mock("../../../logger.js", () => ({
  log: vi.fn(),
}));

vi.mock("../../../session/history.js", () => ({
  getAttachedSession: vi.fn(),
}));

vi.mock("../../../session/permissions.js", () => ({
  respondToPermission: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../session/tmux.js", () => ({
  findClaudePane: vi.fn(),
  sendKeysToPane: vi.fn().mockResolvedValue(undefined),
  sendRawKeyToPane: vi.fn().mockResolvedValue(undefined),
}));

function makeCtx() {
  return {
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("handlePermissionCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("approve: calls respondToPermission, sends '1' to pane, answers Approved", async () => {
    const ctx = makeCtx();
    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%1" });

    await handlePermissionCallback(ctx, "perm:approve:req-123");

    expect(respondToPermission).toHaveBeenCalledWith("req-123", "approve");
    expect(sendKeysToPane).toHaveBeenCalledWith("%1", "1");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Approved ✅" });
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled();
  });

  it("deny: calls respondToPermission with deny, sends Escape to pane, answers Denied", async () => {
    const ctx = makeCtx();
    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%1" });

    await handlePermissionCallback(ctx, "perm:deny:req-456");

    expect(respondToPermission).toHaveBeenCalledWith("req-456", "deny");
    expect(sendRawKeyToPane).toHaveBeenCalledWith("%1", "Escape");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Denied ❌" });
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled();
  });

  it("invalid data (no requestId): answers Invalid permission request.", async () => {
    const ctx = makeCtx();

    await handlePermissionCallback(ctx, "perm:approve:");

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Invalid permission request." });
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  it("invalid action (not approve/deny): answers Invalid permission request.", async () => {
    const ctx = makeCtx();

    await handlePermissionCallback(ctx, "perm:reject:req-123");

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Invalid permission request." });
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  it("no attached session: still answers callback, does not try pane", async () => {
    const ctx = makeCtx();
    vi.mocked(getAttachedSession).mockResolvedValue(null);

    await handlePermissionCallback(ctx, "perm:approve:req-789");

    expect(respondToPermission).toHaveBeenCalledWith("req-789", "approve");
    expect(findClaudePane).not.toHaveBeenCalled();
    expect(sendKeysToPane).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Approved ✅" });
  });

  it("respondToPermission error: logs error, still answers callback", async () => {
    const ctx = makeCtx();
    vi.mocked(respondToPermission).mockRejectedValue(new Error("file not found"));
    vi.mocked(getAttachedSession).mockResolvedValue(null);

    await handlePermissionCallback(ctx, "perm:approve:req-err");

    expect(log).toHaveBeenCalledWith({ message: "respondToPermission error: file not found" });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Approved ✅" });
  });

  it("pane not found: does not send keys, still answers callback", async () => {
    const ctx = makeCtx();
    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(findClaudePane).mockResolvedValue({ found: false, reason: "no_claude_pane" });

    await handlePermissionCallback(ctx, "perm:approve:req-nopane");

    expect(respondToPermission).toHaveBeenCalledWith("req-nopane", "approve");
    expect(sendKeysToPane).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Approved ✅" });
  });
});
