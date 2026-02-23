import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./waiting.js", () => ({ handleWaitingCallback: vi.fn() }));
vi.mock("./permissions.js", () => ({ handlePermissionCallback: vi.fn() }));
vi.mock("./sessions.js", () => ({ handleSessionCallback: vi.fn() }));
vi.mock("./launch.js", () => ({ handleLaunchCallback: vi.fn() }));
vi.mock("./images.js", () => ({
  handleImagesCallback: vi.fn(),
  pendingImages: new Map(),
  pendingImageCount: new Map(),
  clearPendingImageCount: vi.fn(),
}));
vi.mock("./model.js", () => ({ handleModelCallback: vi.fn() }));
vi.mock("./detach.js", () => ({ handleDetachCallback: vi.fn() }));
vi.mock("./timer.js", () => ({ handleTimerCallback: vi.fn() }));

import { registerCallbacks } from "./index.js";
import { handleWaitingCallback } from "./waiting.js";
import { handlePermissionCallback } from "./permissions.js";
import { handleSessionCallback } from "./sessions.js";
import { handleLaunchCallback } from "./launch.js";
import { handleImagesCallback } from "./images.js";
import { handleModelCallback } from "./model.js";
import { handleDetachCallback } from "./detach.js";
import { handleTimerCallback } from "./timer.js";

describe("registerCallbacks", () => {
  let callbackHandler: (ctx: any) => Promise<void>;
  let mockBot: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBot = {
      on: vi.fn((event: string, handler: (ctx: any) => Promise<void>) => {
        if (event === "callback_query:data") {
          callbackHandler = handler;
        }
      }),
    };
    registerCallbacks(mockBot);
  });

  function makeCtx(data: string) {
    return { callbackQuery: { data } } as any;
  }

  it("registers a callback_query:data handler on the bot", () => {
    expect(mockBot.on).toHaveBeenCalledWith("callback_query:data", expect.any(Function));
  });

  it("routes 'waiting:' prefix to handleWaitingCallback", async () => {
    const ctx = makeCtx("waiting:yes");
    await callbackHandler(ctx);
    expect(handleWaitingCallback).toHaveBeenCalledWith(ctx, "waiting:yes");
  });

  it("routes 'perm:' prefix to handlePermissionCallback", async () => {
    const ctx = makeCtx("perm:approve:123");
    await callbackHandler(ctx);
    expect(handlePermissionCallback).toHaveBeenCalledWith(ctx, "perm:approve:123");
  });

  it("routes 'session:' prefix to handleSessionCallback", async () => {
    const ctx = makeCtx("session:abc");
    await callbackHandler(ctx);
    expect(handleSessionCallback).toHaveBeenCalledWith(ctx, "session:abc");
  });

  it("routes 'launch:' prefix to handleLaunchCallback", async () => {
    const ctx = makeCtx("launch:proj");
    await callbackHandler(ctx);
    expect(handleLaunchCallback).toHaveBeenCalledWith(ctx, "launch:proj", mockBot);
  });

  it("routes 'images:' prefix to handleImagesCallback", async () => {
    const ctx = makeCtx("images:send:all:key1");
    await callbackHandler(ctx);
    expect(handleImagesCallback).toHaveBeenCalledWith(ctx, "images:send:all:key1", mockBot);
  });

  it("routes 'model:' prefix to handleModelCallback", async () => {
    const ctx = makeCtx("model:opus");
    await callbackHandler(ctx);
    expect(handleModelCallback).toHaveBeenCalledWith(ctx, "model:opus");
  });

  it("routes 'detach:' prefix to handleDetachCallback", async () => {
    const ctx = makeCtx("detach:session123");
    await callbackHandler(ctx);
    expect(handleDetachCallback).toHaveBeenCalledWith(ctx, "detach:session123");
  });

  it("routes 'timer:' prefix to handleTimerCallback", async () => {
    const ctx = makeCtx("timer:confirm");
    await callbackHandler(ctx);
    expect(handleTimerCallback).toHaveBeenCalledWith(ctx, "timer:confirm");
  });

  it("does not call any handler for unknown prefix", async () => {
    const ctx = makeCtx("unknown:data");
    await callbackHandler(ctx);
    expect(handleWaitingCallback).not.toHaveBeenCalled();
    expect(handlePermissionCallback).not.toHaveBeenCalled();
    expect(handleSessionCallback).not.toHaveBeenCalled();
    expect(handleLaunchCallback).not.toHaveBeenCalled();
    expect(handleImagesCallback).not.toHaveBeenCalled();
    expect(handleModelCallback).not.toHaveBeenCalled();
    expect(handleDetachCallback).not.toHaveBeenCalled();
    expect(handleTimerCallback).not.toHaveBeenCalled();
  });

  it("only calls the first matching handler (waiting: short-circuits)", async () => {
    const ctx = makeCtx("waiting:custom");
    await callbackHandler(ctx);
    expect(handleWaitingCallback).toHaveBeenCalledTimes(1);
    expect(handlePermissionCallback).not.toHaveBeenCalled();
  });
});
