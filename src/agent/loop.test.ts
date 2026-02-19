import { describe, it, expect, vi, beforeEach } from "vitest";
import { Intent } from "./classifier.js";

// Mock all dependencies before importing loop
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
import { handleTurn } from "./loop.js";

beforeEach(() => vi.clearAllMocks());

describe("handleTurn", () => {
  it("calls summarizer for SUMMARY_REQUEST", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.SUMMARY_REQUEST);
    vi.mocked(summarizeSession).mockResolvedValue("Claude is refactoring sessions.ts");

    const result = await handleTurn(123, "what's happening?");
    expect(summarizeSession).toHaveBeenCalled();
    expect(result).toBe("Claude is refactoring sessions.ts");
  });

  it("calls runAgentTurn for COMMAND_EXECUTION", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.COMMAND_EXECUTION);
    vi.mocked(runAgentTurn).mockResolvedValue("Installed 3 packages.");

    const result = await handleTurn(123, "install deps");
    expect(runAgentTurn).toHaveBeenCalledWith(123, "install deps");
    expect(result).toBe("Installed 3 packages.");
  });

  it("injects via tmux for FOLLOW_UP_INPUT when cwd is known", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.FOLLOW_UP_INPUT);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%2" });

    const result = await handleTurn(123, "y", undefined, "/Users/luca/repos/app");
    expect(injectInput).toHaveBeenCalledWith("/Users/luca/repos/app", "y");
    expect(result).toContain("Sent");
  });

  it("falls back to runAgentTurn for FOLLOW_UP_INPUT when no cwd", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.FOLLOW_UP_INPUT);
    vi.mocked(runAgentTurn).mockResolvedValue("ok");

    const result = await handleTurn(123, "y");
    expect(runAgentTurn).toHaveBeenCalledWith(123, "y");
  });

  it("returns a chat reply for GENERAL_CHAT without calling agent", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.GENERAL_CHAT);

    const result = await handleTurn(123, "thanks!");
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(result.length).toBeGreaterThan(0);
  });
});
