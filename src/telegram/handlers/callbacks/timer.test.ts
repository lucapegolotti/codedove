import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "grammy";
import { handleTimerCallback } from "./timer.js";
import { setTimerSetup } from "../timer.js";

vi.mock("../timer.js", () => ({
  setTimerSetup: vi.fn(),
  getTimerSetup: vi.fn(),
}));

function makeCtx() {
  return {
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("handleTimerCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("timer:confirm sets phase to awaiting_frequency, answers OK!, replies with frequency question", async () => {
    const ctx = makeCtx();
    await handleTimerCallback(ctx, "timer:confirm");

    expect(setTimerSetup).toHaveBeenCalledWith({ phase: "awaiting_frequency" });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "OK!" });
    expect(ctx.reply).toHaveBeenCalledWith("How often (in minutes)?");
  });

  it("timer:cancel sets timer setup to null, answers Cancelled.", async () => {
    const ctx = makeCtx();
    await handleTimerCallback(ctx, "timer:cancel");

    expect(setTimerSetup).toHaveBeenCalledWith(null);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Cancelled." });
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("unknown data does nothing", async () => {
    const ctx = makeCtx();
    await handleTimerCallback(ctx, "timer:unknown");

    expect(setTimerSetup).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
