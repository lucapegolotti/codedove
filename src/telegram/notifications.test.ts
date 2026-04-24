import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendStartupMessage, registerForNotifications, notifyResponse, notifyPermission, notifyWaiting, notifyImages, sendPing, resolveWaitingAction, friendlyModelName, notifications, notifyToolUse } from "./notifications.js";
import { WaitingType } from "../session/monitor.js";
import { splitMessage } from "./utils.js";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../session/history.js", () => ({
  getAttachedSession: vi.fn(),
  ATTACHED_SESSION_PATH: "/tmp/test-attached",
  listSessions: vi.fn(),
  getLatestSessionFileForCwd: vi.fn(),
}));

const { readFile, writeFile } = await import("fs/promises");
import { getAttachedSession } from "../session/history.js";

describe("sendStartupMessage", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("sends startup message to the saved chat ID", async () => {
    vi.mocked(readFile).mockResolvedValue("50620969" as any);
    vi.mocked(getAttachedSession).mockResolvedValue(null);
    const mockBot = { api: { sendMessage: vi.fn().mockResolvedValue({}) } } as any;

    await sendStartupMessage(mockBot);

    expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
      50620969,
      expect.stringContaining("codedove"),
      expect.anything()
    );
  });

  it("does nothing when the chat-id file does not exist", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    const mockBot = { api: { sendMessage: vi.fn() } } as any;

    await sendStartupMessage(mockBot);

    expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("does nothing when the chat-id is not a valid number", async () => {
    vi.mocked(readFile).mockResolvedValue("not-a-number" as any);
    const mockBot = { api: { sendMessage: vi.fn() } } as any;

    await sendStartupMessage(mockBot);

    expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
  });
});

describe("registerForNotifications", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("persists the chat ID to disk", async () => {
    registerForNotifications({} as any, 12345);

    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      expect.stringContaining("chat-id"),
      "12345",
      "utf8"
    );
  });
});

describe("resolveWaitingAction", () => {
  it("resolves yes/no/enter actions", () => {
    expect(resolveWaitingAction("waiting:yes")).toBe("y");
    expect(resolveWaitingAction("waiting:no")).toBe("n");
    expect(resolveWaitingAction("waiting:enter")).toBe("");
  });

  it("resolves numbered choice actions", () => {
    expect(resolveWaitingAction("waiting:choice:1")).toBe("1");
    expect(resolveWaitingAction("waiting:choice:3")).toBe("3");
  });

  it("returns null for unknown actions", () => {
    expect(resolveWaitingAction("waiting:custom")).toBeNull();
    expect(resolveWaitingAction("waiting:ignore")).toBeNull();
    expect(resolveWaitingAction("something:else")).toBeNull();
  });
});

describe("splitMessage", () => {
  it("returns a single chunk when text is under the limit", () => {
    expect(splitMessage("hello world")).toEqual(["hello world"]);
  });

  it("returns a single chunk when text equals the limit exactly", () => {
    const text = "a".repeat(4000);
    expect(splitMessage(text)).toEqual([text]);
  });

  it("splits at the last newline before the limit", () => {
    const first = "a".repeat(3990);
    const second = "b".repeat(100);
    const text = first + "\n" + second;
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(first);
    expect(chunks[1]).toBe(second);
  });

  it("hard-splits at the limit when there is no newline", () => {
    const text = "x".repeat(4500);
    const chunks = splitMessage(text);
    expect(chunks[0]).toHaveLength(4000);
    expect(chunks[1]).toHaveLength(500);
  });

  it("handles three chunks correctly", () => {
    // Two full chunks + a tail
    const chunk = "a".repeat(3999) + "\n";
    const text = chunk + chunk + "end";
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(3);
    expect(chunks[2]).toBe("end");
  });
});

// ---------------------------------------------------------------------------
// notifyResponse
// ---------------------------------------------------------------------------

describe("notifyResponse", () => {
  const chatId = 12345;
  let mockBot: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBot = { api: { sendMessage: vi.fn().mockResolvedValue({}) } };
    registerForNotifications(mockBot, chatId);
  });

  const makeState = (overrides: Partial<{ sessionId: string; text: string }> = {}) => ({
    sessionId: "session-abc",
    projectName: "myproject",
    cwd: "/proj",
    filePath: "/path/to/session.jsonl",
    text: "Hello world",
    ...overrides,
  });

  it("preserves colons and semicolons in middle of text, strips trailing colon", async () => {
    await notifyResponse(makeState({ text: "Step one; step two: done" }));

    expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
      chatId,
      expect.stringContaining("Step one; step two: done"),
      expect.anything()
    );
  });

  it("sends text unchanged when there are no semicolons", async () => {
    await notifyResponse(makeState({ text: "All good here" }));

    expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
      chatId,
      expect.stringContaining("All good here"),
      expect.anything()
    );
  });

  it("forwards responses from any session, not just the attached one", async () => {
    await notifyResponse(makeState({ sessionId: "some-other-session", text: "Hello from other session" }));

    expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
      chatId,
      expect.stringContaining("Hello from other session"),
      expect.anything()
    );
  });

  it("skips plan approval text to avoid a buttonless duplicate before notifyWaiting fires", async () => {
    await notifyResponse(makeState({ text: "❓ Claude Code needs your approval for the plan" }));

    expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// notifyPermission
// ---------------------------------------------------------------------------

describe("notifyPermission", () => {
  const chatId = 12345;
  let mockBot: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBot = { api: { sendMessage: vi.fn().mockResolvedValue({}) } };
    registerForNotifications(mockBot, chatId);
  });

  const makeReq = (overrides: Partial<{ toolName: string; toolCommand: string | undefined; requestId: string }> = {}) => ({
    requestId: "req-001",
    toolName: "Bash",
    toolInput: "{}",
    toolCommand: "npm test",
    filePath: "/path/to/session.jsonl",
    ...overrides,
  });

  it("sends message with code block when toolName is Bash and toolCommand is set", async () => {
    await notifyPermission(makeReq({ toolName: "Bash", toolCommand: "npm test" }));

    const call = mockBot.api.sendMessage.mock.calls[0];
    const text: string = call[1];
    expect(text).toContain("```");
    expect(text).toContain("npm test");
  });

  it("sends no code block when toolName is Bash but toolCommand is undefined", async () => {
    await notifyPermission(makeReq({ toolName: "Bash", toolCommand: undefined }));

    const call = mockBot.api.sendMessage.mock.calls[0];
    const text: string = call[1];
    expect(text).not.toContain("```");
  });

  it("sends no code block when toolName is Task even if toolCommand is set", async () => {
    await notifyPermission(makeReq({ toolName: "Task", toolCommand: "some command" }));

    const call = mockBot.api.sendMessage.mock.calls[0];
    const text: string = call[1];
    expect(text).not.toContain("```");
  });

  it("includes approve and deny inline keyboard buttons with the request ID", async () => {
    await notifyPermission(makeReq({ requestId: "req-123" }));

    const call = mockBot.api.sendMessage.mock.calls[0];
    const options = call[2];
    const keyboard = options?.reply_markup?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
    expect(keyboard).toBeDefined();
    const allButtons = keyboard.flat();
    const approveButton = allButtons.find((b) => b.callback_data === "perm:approve:req-123");
    const denyButton = allButtons.find((b) => b.callback_data === "perm:deny:req-123");
    expect(approveButton).toBeDefined();
    expect(denyButton).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// notifyWaiting — prompt rendering
// ---------------------------------------------------------------------------

describe("notifyWaiting prompt rendering", () => {
  const chatId = 12345;
  let mockBot: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBot = { api: { sendMessage: vi.fn().mockResolvedValue({}) } };
    registerForNotifications(mockBot, chatId);
  });

  const makeState = (prompt: string, waitingType = WaitingType.MULTIPLE_CHOICE) => ({
    sessionId: "session-abc",
    projectName: "myproject",
    cwd: "/proj",
    filePath: "/path/to/session.jsonl",
    waitingType,
    prompt,
    choices: ["Option A"],
  });

  it("sends prompt as a separate message before the header+keyboard message", async () => {
    await notifyWaiting(makeState("## My Plan\nDo the thing."));

    const calls = mockBot.api.sendMessage.mock.calls;
    expect(calls.length).toBe(2);
    // First call: prompt text with Markdown parse mode (from sendMarkdownMessage)
    expect(calls[0][1]).toBe("## My Plan\nDo the thing.");
    expect(calls[0][2]).toEqual(expect.objectContaining({ parse_mode: "Markdown" }));
    // Second call: header with keyboard
    expect(calls[1][1]).toContain("⚠️ Claude is waiting");
    expect(calls[1][2]?.reply_markup).toBeDefined();
  });

  it("sends prompt without italic wrapping or quote marks", async () => {
    await notifyWaiting(makeState("**Bold** and `code`"));

    const promptCall = mockBot.api.sendMessage.mock.calls[0];
    const text: string = promptCall[1];
    expect(text).toBe("*Bold* and `code`");
    expect(text).not.toContain('_"');
    expect(text).not.toContain('"_');
  });

  it("does not truncate prompts longer than 2000 chars", async () => {
    const longPrompt = "x".repeat(3000);
    await notifyWaiting(makeState(longPrompt));

    const promptCall = mockBot.api.sendMessage.mock.calls[0];
    expect(promptCall[1]).toBe(longPrompt);
    expect(promptCall[1].length).toBe(3000);
  });

  it("skips prompt message when prompt is empty", async () => {
    await notifyWaiting(makeState(""));

    const calls = mockBot.api.sendMessage.mock.calls;
    // Only the header+keyboard message
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toContain("⚠️ Claude is waiting");
    expect(calls[0][2]?.reply_markup).toBeDefined();
  });

  it("falls back to plain text when markdown parse fails", async () => {
    // First call (markdown) fails, second call (plain text) succeeds,
    // third call is the header+keyboard
    mockBot.api.sendMessage
      .mockRejectedValueOnce(new Error("parse error"))
      .mockResolvedValue({});

    await notifyWaiting(makeState("bad _markdown"));

    const calls = mockBot.api.sendMessage.mock.calls;
    expect(calls.length).toBe(3);
    // First: markdown attempt (failed)
    expect(calls[0][2]).toEqual(expect.objectContaining({ parse_mode: "Markdown" }));
    // Second: plain text fallback (no parse_mode)
    expect(calls[1][2]).toBeUndefined();
    // Third: header+keyboard
    expect(calls[2][1]).toContain("⚠️ Claude is waiting");
  });
});

// ---------------------------------------------------------------------------
// notifyWaiting — MULTIPLE_CHOICE
// ---------------------------------------------------------------------------

describe("notifyWaiting with MULTIPLE_CHOICE", () => {
  const chatId = 12345;
  let mockBot: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBot = { api: { sendMessage: vi.fn().mockResolvedValue({}) } };
    registerForNotifications(mockBot, chatId);
  });

  const makeState = (choices: string[]) => ({
    sessionId: "session-abc",
    projectName: "myproject",
    cwd: "/proj",
    filePath: "/path/to/session.jsonl",
    waitingType: WaitingType.MULTIPLE_CHOICE,
    prompt: "❓ Claude Code needs your approval for the plan",
    choices,
  });

  it("sends one inline button per choice with waiting:choice:N callback data", async () => {
    const choices = [
      "Yes, clear context (21% used) and bypass permissions",
      "Yes, and bypass permissions",
      "Yes, manually approve edits",
      "Type here to tell Claude what to change",
    ];

    await notifyWaiting(makeState(choices));

    const calls = mockBot.api.sendMessage.mock.calls;
    const call = calls[calls.length - 1];
    const keyboard = call[2]?.reply_markup?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
    expect(keyboard).toBeDefined();
    const allButtons = keyboard.flat();

    expect(allButtons.find((b) => b.callback_data === "waiting:choice:1")).toBeDefined();
    expect(allButtons.find((b) => b.callback_data === "waiting:choice:2")).toBeDefined();
    expect(allButtons.find((b) => b.callback_data === "waiting:choice:3")).toBeDefined();
    expect(allButtons.find((b) => b.callback_data === "waiting:choice:4")).toBeDefined();
  });

  it("truncates long choice labels to 40 chars with ellipsis", async () => {
    const longChoice = "Yes, clear context (21% used) and bypass permissions"; // > 40 chars
    await notifyWaiting(makeState([longChoice, "Short option"]));

    const calls = mockBot.api.sendMessage.mock.calls;
    const call = calls[calls.length - 1];
    const keyboard = call[2]?.reply_markup?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
    const allButtons = keyboard.flat();
    const btn1 = allButtons.find((b) => b.callback_data === "waiting:choice:1");
    expect(btn1?.text).toMatch(/…$/);
    expect(btn1?.text.length).toBeLessThanOrEqual(45); // "1. " prefix + 40 chars + "…"
  });

  it("always includes Send custom input and Ignore buttons", async () => {
    await notifyWaiting(makeState(["Option A", "Option B"]));

    const calls = mockBot.api.sendMessage.mock.calls;
    const call = calls[calls.length - 1];
    const keyboard = call[2]?.reply_markup?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
    const allButtons = keyboard.flat();
    expect(allButtons.find((b) => b.callback_data === "waiting:custom")).toBeDefined();
    expect(allButtons.find((b) => b.callback_data === "waiting:ignore")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// friendlyModelName
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// sendPing
// ---------------------------------------------------------------------------

describe("sendPing", () => {
  const chatId = 12345;
  let mockBot: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBot = { api: { sendMessage: vi.fn().mockResolvedValue({}) } };
    registerForNotifications(mockBot, chatId);
  });

  it("sends the text to the registered chat", async () => {
    await sendPing("⏳ Still working...");
    expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
      chatId,
      "⏳ Still working...",
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// notifyImages
// ---------------------------------------------------------------------------

describe("notifyImages", () => {
  const chatId = 12345;
  let mockBot: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBot = { api: { sendMessage: vi.fn().mockResolvedValue({}) } };
    registerForNotifications(mockBot, chatId);
  });

  it("sends a message with All/Part/None buttons for multiple images", async () => {
    const images = [
      { mediaType: "image/png", data: "base64data1" },
      { mediaType: "image/jpeg", data: "base64data2" },
    ];

    await notifyImages(images, "key123");

    const call = mockBot.api.sendMessage.mock.calls[0];
    expect(call[1]).toContain("2 images");
    expect(call[1]).toContain("them");
    const keyboard = call[2]?.reply_markup?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
    const allButtons = keyboard.flat();
    expect(allButtons.find((b: any) => b.callback_data === "images:send:all:key123")).toBeDefined();
    expect(allButtons.find((b: any) => b.callback_data === "images:part:key123")).toBeDefined();
    expect(allButtons.find((b: any) => b.callback_data === "images:skip:key123")).toBeDefined();
  });

  it("uses singular form for a single image", async () => {
    const images = [{ mediaType: "image/png", data: "base64data" }];

    await notifyImages(images, "key456");

    const call = mockBot.api.sendMessage.mock.calls[0];
    expect(call[1]).toContain("1 image");
    expect(call[1]).not.toContain("images");
    expect(call[1]).toContain("it");
  });
});

// ---------------------------------------------------------------------------
// notifyResponse — model suffix
// ---------------------------------------------------------------------------

describe("notifyResponse with model", () => {
  const chatId = 12345;
  let mockBot: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBot = { api: { sendMessage: vi.fn().mockResolvedValue({}) } };
    registerForNotifications(mockBot, chatId);
  });

  it("includes friendly model name in response when model is present", async () => {
    await notifyResponse({
      sessionId: "session-abc",
      projectName: "myproject",
      cwd: "/proj",
      filePath: "/path/to/session.jsonl",
      text: "Done",
      model: "claude-opus-4-6",
    });

    const call = mockBot.api.sendMessage.mock.calls[0];
    expect(call[1]).toContain("opus 4.6");
  });

  it("includes CLI label when cliName is set (codex)", async () => {
    notifications.register(mockBot as any, 123);
    mockBot.api.sendMessage.mockResolvedValue({ message_id: 10 });

    await notifications.notifyResponse({
      sessionId: "s1",
      projectName: "myproj",
      cwd: "/tmp/p",
      filePath: "/tmp/p.jsonl",
      text: "Hello",
      model: "gpt-5.4",
      cliName: "codex",
    });

    expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
      123,
      expect.stringContaining("myproj (codex gpt-5.4):"),
      expect.any(Object),
    );
  });

  it("includes CLI label when cliName is set (claude)", async () => {
    notifications.register(mockBot as any, 123);
    mockBot.api.sendMessage.mockResolvedValue({ message_id: 10 });

    await notifications.notifyResponse({
      sessionId: "s2",
      projectName: "myproj",
      cwd: "/tmp/p",
      filePath: "/tmp/p.jsonl",
      text: "Hello",
      model: "claude-opus-4-7",
      cliName: "claude",
    });

    expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
      123,
      expect.stringMatching(/myproj \(claude [^)]+\):/),
      expect.any(Object),
    );
  });

  it("falls back to model only when cliName is absent", async () => {
    notifications.register(mockBot as any, 123);
    mockBot.api.sendMessage.mockResolvedValue({ message_id: 10 });

    await notifications.notifyResponse({
      sessionId: "s3",
      projectName: "myproj",
      cwd: "/tmp/p",
      filePath: "/tmp/p.jsonl",
      text: "Hello",
      model: "claude-opus-4-7",
    });

    // Without cliName, the prefix should be (opus 4.6)-style without CLI
    const call = mockBot.api.sendMessage.mock.calls.find((c: any[]) => c[1].includes("myproj ("));
    expect(call).toBeDefined();
    expect(call[1]).not.toMatch(/myproj \(claude /);
  });
});

// ---------------------------------------------------------------------------
// sendStartupMessage — with attached session
// ---------------------------------------------------------------------------

describe("sendStartupMessage with attached session", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("includes attached session ID in the startup message", async () => {
    vi.mocked(readFile).mockResolvedValue("50620969" as any);
    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "abc12345-full-id", cwd: "/proj" });
    const mockBot = { api: { sendMessage: vi.fn().mockResolvedValue({}) } } as any;

    await sendStartupMessage(mockBot);

    const call = mockBot.api.sendMessage.mock.calls[0];
    expect(call[1]).toContain("abc12345");
  });

  it("falls back to plain text when MarkdownV2 fails", async () => {
    vi.mocked(readFile).mockResolvedValue("50620969" as any);
    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "abc12345-full-id", cwd: "/proj" });
    const mockBot = {
      api: {
        sendMessage: vi.fn()
          .mockRejectedValueOnce(new Error("parse error"))
          .mockResolvedValue({}),
      },
    } as any;

    await sendStartupMessage(mockBot);

    // First call fails (MarkdownV2), second call succeeds (plain text)
    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(2);
    const secondCall = mockBot.api.sendMessage.mock.calls[1];
    expect(secondCall[1]).toContain("abc12345");
  });
});

// ---------------------------------------------------------------------------
// notifyPermission — fallback on markdown failure
// ---------------------------------------------------------------------------

describe("notifyPermission fallback", () => {
  const chatId = 12345;
  let mockBot: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBot = { api: { sendMessage: vi.fn() } };
    registerForNotifications(mockBot, chatId);
  });

  it("falls back to sending raw toolInput when markdown message fails", async () => {
    mockBot.api.sendMessage
      .mockRejectedValueOnce(new Error("parse error"))
      .mockResolvedValueOnce({});

    await notifyPermission({
      requestId: "req-001",
      toolName: "Bash",
      toolInput: '{"command":"npm test"}',
      toolCommand: "npm test",
      filePath: "/path/to/session.jsonl",
    });

    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(2);
    const fallbackCall = mockBot.api.sendMessage.mock.calls[1];
    expect(fallbackCall[1]).toBe('{"command":"npm test"}');
  });
});

describe("friendlyModelName", () => {
  it.each([
    ["claude-opus-4-6", "opus 4.6"],
    ["claude-sonnet-4-6", "sonnet 4.6"],
    ["claude-haiku-4-5-20251001", "haiku 4.5"],
    ["claude-haiku-4-5", "haiku 4.5"],
    ["claude-opus-5-0", "opus 5.0"],
    ["claude-super-nova-5-2", "super-nova 5.2"],
    ["claude-foo-10-3-20260101", "foo 10.3"],
    ["some-other-model-7", "some-other-model 7"],
    ["claude-opus", "opus"],
    ["totally-unknown", "totally-unknown"],
  ])("%s → %s", (input, expected) => {
    expect(friendlyModelName(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// notifyToolUse
// ---------------------------------------------------------------------------

describe("notifyToolUse", () => {
  let mockBot: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBot = {
      api: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
        editMessageText: vi.fn().mockResolvedValue({}),
      },
    };
  });

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
    // sendMessage should be called 3 times total: first tool, response text, new tool
    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// message-to-session tracking
// ---------------------------------------------------------------------------

describe("message-to-session tracking", () => {
  let mockBot: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBot = {
      api: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
        editMessageText: vi.fn().mockResolvedValue({}),
      },
    };
  });

  it("tracks message_id from notifyResponse", async () => {
    notifications.register(mockBot as any, 123);
    mockBot.api.sendMessage.mockResolvedValue({ message_id: 55 });

    await notifications.notifyResponse({
      sessionId: "sess-1",
      projectName: "myproject",
      cwd: "/tmp/proj",
      filePath: "/tmp/f.jsonl",
      text: "Hello",
    });

    expect(notifications.getSessionForMessage(55)).toEqual({
      sessionId: "sess-1",
      cwd: "/tmp/proj",
    });
  });

  it("tracks message_id from notifyToolUse", async () => {
    notifications.register(mockBot as any, 123);
    mockBot.api.sendMessage.mockResolvedValue({ message_id: 66 });

    await notifications.notifyToolUse("myproject", "sess-2", [
      { id: "t1", name: "Bash", command: "ls" },
    ]);

    expect(notifications.getSessionForMessage(66)).toEqual({
      sessionId: "sess-2",
      cwd: undefined,
    });
  });

  it("returns undefined for unknown message_id", () => {
    notifications.register(mockBot as any, 123);
    expect(notifications.getSessionForMessage(999)).toBeUndefined();
  });

  it("evicts oldest entries when map exceeds 500", async () => {
    notifications.register(mockBot as any, 123);
    let msgId = 0;
    mockBot.api.sendMessage.mockImplementation(async () => ({ message_id: ++msgId }));

    for (let i = 0; i < 501; i++) {
      await notifications.notifyResponse({
        sessionId: `sess-${i}`,
        projectName: "p",
        cwd: `/tmp/${i}`,
        filePath: "/tmp/f.jsonl",
        text: "hi",
      });
    }

    expect(notifications.getSessionForMessage(1)).toBeUndefined();
    expect(notifications.getSessionForMessage(501)).toBeDefined();
  });
});
