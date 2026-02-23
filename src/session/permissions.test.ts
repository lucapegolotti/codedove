import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted runs before any imports so the mock watcher is available in vi.mock factories.
const { mockWatcher, watcherEmitter } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const emitter = new EventEmitter();
  const watcher = {
    on(event: string, handler: (...args: unknown[]) => void) {
      emitter.on(event, handler);
      return this;
    },
    close: vi.fn(),
  };
  return { mockWatcher: watcher, watcherEmitter: emitter };
});

vi.mock("chokidar", () => ({
  default: { watch: vi.fn(() => mockWatcher) },
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../logger.js", () => ({ log: vi.fn() }));

vi.mock("./jsonl.js", () => ({
  findLastToolUse: vi.fn(),
}));

import { watchPermissionRequests, respondToPermission } from "./permissions.js";
import { readFile, writeFile, mkdir } from "fs/promises";
import { findLastToolUse } from "./jsonl.js";
import { homedir } from "os";
import { join } from "path";

const CODEDOVE_DIR = join(homedir(), ".codedove");

beforeEach(() => {
  vi.clearAllMocks();
  watcherEmitter.removeAllListeners();
});

describe("respondToPermission", () => {
  it("creates the codedove directory and writes 'approve' to the correct path", async () => {
    await respondToPermission("abc12345-6789", "approve");

    expect(mkdir).toHaveBeenCalledWith(CODEDOVE_DIR, { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(
      join(CODEDOVE_DIR, "permission-response-abc12345-6789"),
      "approve",
      "utf8"
    );
  });

  it("writes 'deny' to the correct path", async () => {
    await respondToPermission("def00000-1111", "deny");

    expect(writeFile).toHaveBeenCalledWith(
      join(CODEDOVE_DIR, "permission-response-def00000-1111"),
      "deny",
      "utf8"
    );
  });

  it("uses the requestId in the filename", async () => {
    await respondToPermission("unique-id-999", "approve");

    const writtenPath = vi.mocked(writeFile).mock.calls[0][0] as string;
    expect(writtenPath).toContain("unique-id-999");
  });
});

describe("watchPermissionRequests", () => {
  it("calls onRequest with parsed permission data when a permission-request JSON is added", async () => {
    const onRequest = vi.fn().mockResolvedValue(undefined);
    const permissionData = {
      requestId: "req-12345678-abcd",
      toolName: "Bash",
      toolInput: "rm -rf /tmp/test",
    };

    vi.mocked(readFile).mockResolvedValue(JSON.stringify(permissionData));

    watchPermissionRequests(onRequest);

    const filePath = join(CODEDOVE_DIR, "permission-request-req-12345678-abcd.json");
    watcherEmitter.emit("add", filePath);

    // Allow promise chain to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(onRequest).toHaveBeenCalledWith({
      requestId: "req-12345678-abcd",
      toolName: "Bash",
      toolInput: "rm -rf /tmp/test",
      toolCommand: undefined,
      filePath,
    });
  });

  it("ignores files that do not start with 'permission-request-'", async () => {
    const onRequest = vi.fn().mockResolvedValue(undefined);

    watchPermissionRequests(onRequest);

    watcherEmitter.emit("add", join(CODEDOVE_DIR, "some-other-file.json"));
    await new Promise((r) => setTimeout(r, 10));

    expect(onRequest).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("ignores files that do not end with '.json'", async () => {
    const onRequest = vi.fn().mockResolvedValue(undefined);

    watchPermissionRequests(onRequest);

    watcherEmitter.emit("add", join(CODEDOVE_DIR, "permission-request-abc.txt"));
    await new Promise((r) => setTimeout(r, 10));

    expect(onRequest).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("calls extractToolCommand when transcriptPath is present", async () => {
    const onRequest = vi.fn().mockResolvedValue(undefined);
    const permissionData = {
      requestId: "req-99999999",
      toolName: "Bash",
      toolInput: "ls",
      transcriptPath: "/home/user/.claude/projects/test/session.jsonl",
    };

    const transcriptContent = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] },
    });

    vi.mocked(readFile).mockImplementation(async (path: any) => {
      if (typeof path === "string" && path.includes("permission-request-")) {
        return JSON.stringify(permissionData);
      }
      return transcriptContent;
    });
    vi.mocked(findLastToolUse).mockReturnValue("ls -la");

    watchPermissionRequests(onRequest);

    const filePath = join(CODEDOVE_DIR, "permission-request-req-99999999.json");
    watcherEmitter.emit("add", filePath);

    await new Promise((r) => setTimeout(r, 10));

    expect(readFile).toHaveBeenCalledWith(
      "/home/user/.claude/projects/test/session.jsonl",
      "utf8"
    );
    expect(findLastToolUse).toHaveBeenCalled();
    expect(onRequest).toHaveBeenCalledWith(
      expect.objectContaining({ toolCommand: "ls -la" })
    );
  });

  it("sets toolCommand to undefined when transcript read fails", async () => {
    const onRequest = vi.fn().mockResolvedValue(undefined);
    const permissionData = {
      requestId: "req-fail0000",
      toolName: "Bash",
      toolInput: "echo hi",
      transcriptPath: "/nonexistent/path.jsonl",
    };

    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify(permissionData))
      .mockRejectedValueOnce(new Error("ENOENT"));

    watchPermissionRequests(onRequest);

    const filePath = join(CODEDOVE_DIR, "permission-request-req-fail0000.json");
    watcherEmitter.emit("add", filePath);

    await new Promise((r) => setTimeout(r, 10));

    expect(onRequest).toHaveBeenCalledWith(
      expect.objectContaining({ toolCommand: undefined })
    );
  });

  it("returns a cleanup function that closes the watcher", () => {
    const onRequest = vi.fn().mockResolvedValue(undefined);
    const cleanup = watchPermissionRequests(onRequest);

    cleanup();

    expect(mockWatcher.close).toHaveBeenCalled();
  });
});
