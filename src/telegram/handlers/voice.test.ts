import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Context } from "grammy";

const mockTranscribeAudio = vi.fn().mockResolvedValue("transcribed text");
const mockSynthesizeSpeech = vi.fn().mockResolvedValue(Buffer.from("audio"));
const mockPolishTranscript = vi.fn().mockResolvedValue("polished text");
const mockSanitizeForTts = vi.fn((t: string) => t);

vi.mock("../../voice.js", () => ({
  transcribeAudio: (...args: unknown[]) => mockTranscribeAudio(...args),
  synthesizeSpeech: (...args: unknown[]) => mockSynthesizeSpeech(...args),
  polishTranscript: (...args: unknown[]) => mockPolishTranscript(...args),
  sanitizeForTts: (t: string) => mockSanitizeForTts(t),
}));

const mockInjectInput = vi.fn().mockResolvedValue({ found: true, paneId: "%1" });
vi.mock("../../session/tmux.js", () => ({
  injectInput: (...args: unknown[]) => mockInjectInput(...args),
}));

vi.mock("../../narrator.js", () => ({
  narrate: vi.fn().mockResolvedValue("summary"),
}));

const mockSendMarkdownReply = vi.fn().mockResolvedValue(undefined);
vi.mock("../utils.js", () => ({
  sendMarkdownReply: (...args: unknown[]) => mockSendMarkdownReply(...args),
}));

vi.mock("./sessions.js", () => ({
  launchedPaneId: undefined,
}));

const mockEnsureSession = vi.fn();
const mockSnapshotBaseline = vi.fn().mockResolvedValue({ filePath: "/f.jsonl", sessionId: "s1", size: 0 });
const mockStartInjectionWatcher = vi.fn().mockResolvedValue(undefined);

vi.mock("./text.js", () => ({
  ensureSession: (...args: unknown[]) => mockEnsureSession(...args),
  snapshotBaseline: (...args: unknown[]) => mockSnapshotBaseline(...args),
  startInjectionWatcher: (...args: unknown[]) => mockStartInjectionWatcher(...args),
}));

const mockAccess = vi.fn().mockRejectedValue(new Error("ENOENT")); // polish on by default
vi.mock("fs/promises", () => ({
  access: (...args: unknown[]) => mockAccess(...args),
}));

vi.mock("../../logger.js", () => ({ log: vi.fn() }));

import { handleVoice } from "./voice.js";

function makeCtx() {
  return {
    replyWithChatAction: vi.fn().mockResolvedValue(undefined),
    getFile: vi.fn().mockResolvedValue({ file_path: "voice/file.ogg" }),
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithVoice: vi.fn().mockResolvedValue(undefined),
    chat: { id: 12345 },
  } as unknown as Context;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset defaults
  mockTranscribeAudio.mockResolvedValue("transcribed text");
  mockSynthesizeSpeech.mockResolvedValue(Buffer.from("audio"));
  mockPolishTranscript.mockResolvedValue("polished text");
  mockSanitizeForTts.mockImplementation((t: string) => t);
  mockInjectInput.mockResolvedValue({ found: true, paneId: "%1" });
  mockEnsureSession.mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
  mockSnapshotBaseline.mockResolvedValue({ filePath: "/f.jsonl", sessionId: "s1", size: 0 });
  mockStartInjectionWatcher.mockResolvedValue(undefined);
  mockAccess.mockRejectedValue(new Error("ENOENT")); // polish on

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleVoice", () => {
  it("happy path: transcribes, polishes, injects, starts watcher", async () => {
    const ctx = makeCtx();

    await handleVoice(ctx, 12345, "test-token");

    expect(mockTranscribeAudio).toHaveBeenCalled();
    expect(mockPolishTranscript).toHaveBeenCalledWith("transcribed text");
    expect(mockInjectInput).toHaveBeenCalled();
    expect(mockStartInjectionWatcher).toHaveBeenCalled();
    // Should show transcription message
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("[transcription]"));
  });

  it("no session: replies with voice message", async () => {
    const ctx = makeCtx();
    mockEnsureSession.mockResolvedValue(null);

    await handleVoice(ctx, 12345, "test-token");

    expect(mockSynthesizeSpeech).toHaveBeenCalled();
    const speechArg = mockSanitizeForTts.mock.calls[0][0];
    expect(speechArg).toContain("No session attached");
    expect(ctx.replyWithVoice).toHaveBeenCalled();
    // Should NOT have tried to inject
    expect(mockInjectInput).not.toHaveBeenCalled();
  });

  it("injection fails: replies with voice message", async () => {
    const ctx = makeCtx();
    mockInjectInput.mockResolvedValue({ found: false, reason: "no_claude_pane" });

    await handleVoice(ctx, 12345, "test-token");

    expect(mockSynthesizeSpeech).toHaveBeenCalled();
    const speechArg = mockSanitizeForTts.mock.calls[0][0];
    expect(speechArg).toContain("No Claude Code running");
    expect(ctx.replyWithVoice).toHaveBeenCalled();
    // Should NOT start watcher
    expect(mockStartInjectionWatcher).not.toHaveBeenCalled();
  });

  it("polish disabled (flag file exists): uses raw transcript", async () => {
    const ctx = makeCtx();
    // access succeeds => flag file exists => polish OFF
    mockAccess.mockResolvedValue(undefined);

    await handleVoice(ctx, 12345, "test-token");

    // polishTranscript should NOT be called
    expect(mockPolishTranscript).not.toHaveBeenCalled();
    // injectInput should be called with the raw transcript (not polished)
    const injectedText = mockInjectInput.mock.calls[0][1] as string;
    expect(injectedText).toContain("transcribed text");
  });
});
