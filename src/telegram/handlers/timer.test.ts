import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../logger.js", () => ({
  log: vi.fn(),
}));

vi.mock("../../session/history.js", () => ({
  getAttachedSession: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock("../../session/tmux.js", () => ({
  findClaudePane: vi.fn(),
  sendKeysToPane: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../notifications.js", () => ({
  sendPing: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./text.js", () => ({
  watcherManager: {
    snapshotBaseline: vi.fn().mockResolvedValue(null),
    startInjectionWatcher: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  getTimerSetup,
  setTimerSetup,
  isTimerActive,
  stopTimer,
  startTimer,
} from "./timer.js";
import { getAttachedSession, listSessions } from "../../session/history.js";
import { findClaudePane, sendKeysToPane } from "../../session/tmux.js";
import { sendPing } from "../notifications.js";
import { watcherManager } from "./text.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Reset timer state between tests
  stopTimer();
  setTimerSetup(null);
});

describe("getTimerSetup / setTimerSetup", () => {
  it("returns null initially", () => {
    expect(getTimerSetup()).toBeNull();
  });

  it("returns what was set", () => {
    setTimerSetup({ phase: "awaiting_frequency" });
    expect(getTimerSetup()).toEqual({ phase: "awaiting_frequency" });
  });

  it("can be set to awaiting_prompt with frequency", () => {
    setTimerSetup({ phase: "awaiting_prompt", frequencyMin: 5 });
    expect(getTimerSetup()).toEqual({ phase: "awaiting_prompt", frequencyMin: 5 });
  });

  it("can be cleared back to null", () => {
    setTimerSetup({ phase: "awaiting_frequency" });
    setTimerSetup(null);
    expect(getTimerSetup()).toBeNull();
  });
});

describe("isTimerActive", () => {
  it("returns false when no timer is active", () => {
    expect(isTimerActive()).toBe(false);
  });

  it("returns true after startTimer", () => {
    vi.useFakeTimers();
    startTimer(10, "test prompt");
    expect(isTimerActive()).toBe(true);
    stopTimer();
    vi.useRealTimers();
  });
});

describe("stopTimer", () => {
  it("returns null when no timer is active", () => {
    expect(stopTimer()).toBeNull();
  });

  it("returns frequencyMin and prompt when timer is active, and clears it", () => {
    vi.useFakeTimers();
    startTimer(5, "do something");

    const result = stopTimer();
    expect(result).toEqual({ frequencyMin: 5, prompt: "do something" });
    expect(isTimerActive()).toBe(false);
    vi.useRealTimers();
  });

  it("clears the interval so tick no longer fires", async () => {
    vi.useFakeTimers();
    vi.mocked(getAttachedSession).mockResolvedValue({
      sessionId: "s1",
      cwd: "/project",
    });
    vi.mocked(findClaudePane).mockResolvedValue({
      found: true as const,
      paneId: "p1",
    });
    vi.mocked(listSessions).mockResolvedValue([]);

    startTimer(1, "tick prompt");
    stopTimer();

    // Advance past the interval — tick should NOT fire
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    expect(sendKeysToPane).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("startTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopTimer();
    vi.useRealTimers();
  });

  it("sets up an interval that fires tick", async () => {
    vi.mocked(getAttachedSession).mockResolvedValue({
      sessionId: "s1",
      cwd: "/project",
    });
    vi.mocked(findClaudePane).mockResolvedValue({
      found: true as const,
      paneId: "p1",
    });
    vi.mocked(listSessions).mockResolvedValue([]);

    startTimer(1, "hello");

    // Advance by 1 minute (the interval)
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(sendKeysToPane).toHaveBeenCalledWith("p1", "hello");
    expect(sendPing).toHaveBeenCalledWith(expect.stringContaining("hello"));
  });

  it("replaces existing timer when called again", () => {
    startTimer(5, "first");
    expect(isTimerActive()).toBe(true);

    startTimer(10, "second");
    expect(isTimerActive()).toBe(true);

    const result = stopTimer();
    expect(result).toEqual({ frequencyMin: 10, prompt: "second" });
  });

  it("skips when no attached session", async () => {
    vi.mocked(getAttachedSession).mockRejectedValue(new Error("none"));

    startTimer(1, "prompt");
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(sendKeysToPane).not.toHaveBeenCalled();
  });

  it("skips when no Claude pane found", async () => {
    vi.mocked(getAttachedSession).mockResolvedValue({
      sessionId: "s1",
      cwd: "/project",
    });
    vi.mocked(findClaudePane).mockResolvedValue({
      found: false as const,
      reason: "no_tmux" as const,
    });

    startTimer(1, "prompt");
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(sendKeysToPane).not.toHaveBeenCalled();
  });

  it("starts injection watcher after sending keys", async () => {
    vi.mocked(getAttachedSession).mockResolvedValue({
      sessionId: "s1",
      cwd: "/project",
    });
    vi.mocked(findClaudePane).mockResolvedValue({
      found: true as const,
      paneId: "p1",
    });
    vi.mocked(listSessions).mockResolvedValue([]);

    startTimer(1, "go");
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(watcherManager.snapshotBaseline).toHaveBeenCalledWith("/project");
    expect(watcherManager.startInjectionWatcher).toHaveBeenCalled();
  });
});
