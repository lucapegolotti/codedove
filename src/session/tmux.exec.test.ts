/**
 * Tests for tmux functions that rely on execAsync (child_process.exec).
 * Separated from tmux.test.ts which tests pure functions without mocking.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  exec: vi.fn(),
}));

// promisify(exec) wraps exec into a promise — we need to control what exec does.
// Since the module uses `promisify(exec)`, we mock exec to call the callback.
import { exec } from "child_process";
import {
  isClaudePane,
  listTmuxPanes,
  sendKeysToPane,
  sendRawKeyToPane,
  sendInterrupt,
  injectInput,
  findClaudePane,
  launchClaudeInWindow,
  killWindow,
  capturePaneContent,
  type TmuxPane,
} from "./tmux.js";

function mockExecSuccess(stdout: string) {
  vi.mocked(exec).mockImplementation((_cmd: any, callback: any) => {
    callback(null, { stdout, stderr: "" });
    return {} as any;
  });
}

function mockExecSequence(results: Array<{ stdout: string } | { error: Error }>) {
  let callIndex = 0;
  vi.mocked(exec).mockImplementation((_cmd: any, callback: any) => {
    const result = results[callIndex++] ?? { error: new Error("no more mocks") };
    if ("error" in result) {
      callback(result.error, { stdout: "", stderr: "" });
    } else {
      callback(null, { stdout: result.stdout, stderr: "" });
    }
    return {} as any;
  });
}

function mockExecFailure(error: Error) {
  vi.mocked(exec).mockImplementation((_cmd: any, callback: any) => {
    callback(error, { stdout: "", stderr: "" });
    return {} as any;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isClaudePane", () => {
  it("returns true for pane with 'claude' command", () => {
    const pane: TmuxPane = { paneId: "%1", shellPid: 100, command: "claude", cwd: "/tmp" };
    expect(isClaudePane(pane)).toBe(true);
  });

  it("returns true for pane with version string command", () => {
    const pane: TmuxPane = { paneId: "%1", shellPid: 100, command: "2.1.47", cwd: "/tmp" };
    expect(isClaudePane(pane)).toBe(true);
  });

  it("returns false for non-claude command", () => {
    const pane: TmuxPane = { paneId: "%1", shellPid: 100, command: "bash", cwd: "/tmp" };
    expect(isClaudePane(pane)).toBe(false);
  });

  it("returns true for command containing 'claude' substring", () => {
    const pane: TmuxPane = { paneId: "%1", shellPid: 100, command: "node claude-code", cwd: "/tmp" };
    expect(isClaudePane(pane)).toBe(true);
  });

  it("returns false for numeric non-version string", () => {
    const pane: TmuxPane = { paneId: "%1", shellPid: 100, command: "node", cwd: "/tmp" };
    expect(isClaudePane(pane)).toBe(false);
  });
});

describe("listTmuxPanes", () => {
  it("parses tmux output into TmuxPane array", async () => {
    mockExecSuccess(
      "%1 100 claude /Users/luca/project\n%2 200 bash /Users/luca/other\n"
    );

    const panes = await listTmuxPanes();

    expect(panes).toEqual([
      { paneId: "%1", shellPid: 100, command: "claude", cwd: "/Users/luca/project" },
      { paneId: "%2", shellPid: 200, command: "bash", cwd: "/Users/luca/other" },
    ]);
  });

  it("handles paths with spaces", async () => {
    mockExecSuccess("%1 100 claude /Users/luca/my project folder\n");

    const panes = await listTmuxPanes();

    expect(panes).toEqual([
      { paneId: "%1", shellPid: 100, command: "claude", cwd: "/Users/luca/my project folder" },
    ]);
  });

  it("returns empty array when tmux is not running", async () => {
    mockExecFailure(new Error("no server running"));

    const panes = await listTmuxPanes();

    expect(panes).toEqual([]);
  });

  it("returns empty array for empty output", async () => {
    mockExecSuccess("");

    const panes = await listTmuxPanes();

    expect(panes).toEqual([]);
  });
});

describe("sendKeysToPane", () => {
  it("sends text and Enter as separate tmux commands", async () => {
    mockExecSuccess("");

    await sendKeysToPane("%1", "hello world");

    expect(exec).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(exec).mock.calls[0][0] as string;
    expect(firstCall).toContain("tmux send-keys");
    expect(firstCall).toContain("%1");
    expect(firstCall).toContain("hello world");

    const secondCall = vi.mocked(exec).mock.calls[1][0] as string;
    expect(secondCall).toContain("Enter");
  });

  it("escapes single quotes in input", async () => {
    mockExecSuccess("");

    await sendKeysToPane("%1", "it's a test");

    const firstCall = vi.mocked(exec).mock.calls[0][0] as string;
    expect(firstCall).toContain("it'\\''s a test");
  });
});

describe("sendRawKeyToPane", () => {
  it("sends a raw key without Enter", async () => {
    mockExecSuccess("");

    await sendRawKeyToPane("%1", "Escape");

    expect(exec).toHaveBeenCalledTimes(1);
    const cmd = vi.mocked(exec).mock.calls[0][0] as string;
    expect(cmd).toContain("tmux send-keys");
    expect(cmd).toContain("Escape");
  });
});

describe("sendInterrupt", () => {
  it("sends C-c to the pane", async () => {
    mockExecSuccess("");

    await sendInterrupt("%5");

    expect(exec).toHaveBeenCalledTimes(1);
    const cmd = vi.mocked(exec).mock.calls[0][0] as string;
    expect(cmd).toContain("tmux send-keys");
    expect(cmd).toContain("%5");
    expect(cmd).toContain("C-c");
  });
});

describe("findClaudePane", () => {
  it("returns found with paneId when a single claude pane matches", async () => {
    mockExecSuccess("%1 100 claude /Users/luca/project\n");

    const result = await findClaudePane("/Users/luca/project");

    expect(result).toEqual({ found: true, paneId: "%1" });
  });

  it("returns no_tmux when listTmuxPanes returns empty", async () => {
    mockExecFailure(new Error("no server running"));

    const result = await findClaudePane("/tmp");

    expect(result).toEqual({ found: false, reason: "no_tmux" });
  });

  it("returns no_claude_pane when no claude panes exist", async () => {
    mockExecSuccess("%1 100 bash /Users/luca/project\n%2 200 vim /Users/luca/other\n");

    const result = await findClaudePane("/Users/luca/project");

    expect(result).toEqual({ found: false, reason: "no_claude_pane" });
  });

  it("returns ambiguous when multiple claude panes exist with no cwd match", async () => {
    mockExecSuccess(
      "%1 100 claude /Users/luca/alpha\n%2 200 claude /Users/luca/beta\n"
    );

    const result = await findClaudePane("/Users/luca/gamma");

    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toBe("ambiguous");
      expect(result.panes).toHaveLength(2);
    }
  });

  it("returns the single claude pane as fallback when no cwd matches", async () => {
    mockExecSuccess(
      "%1 100 bash /Users/luca/project\n%2 200 claude /Users/luca/other\n"
    );

    const result = await findClaudePane("/Users/luca/nomatch");

    expect(result).toEqual({ found: true, paneId: "%2" });
  });
});

describe("injectInput", () => {
  it("sends keys to found pane and returns result", async () => {
    // listTmuxPanes call + sendKeysToPane (2 calls: text + Enter)
    mockExecSequence([
      { stdout: "%1 100 claude /Users/luca/project\n" },
      { stdout: "" }, // sendKeysToPane text
      { stdout: "" }, // sendKeysToPane Enter
    ]);

    const result = await injectInput("/Users/luca/project", "test input");

    expect(result).toEqual({ found: true, paneId: "%1" });
  });

  it("uses fallback pane when no claude pane found", async () => {
    // listTmuxPanes returns no panes (error)
    mockExecSequence([
      { error: new Error("no server") },
      { stdout: "" }, // sendKeysToPane text
      { stdout: "" }, // sendKeysToPane Enter
    ]);

    const result = await injectInput("/tmp", "test", "%fallback");

    expect(result).toEqual({ found: true, paneId: "%fallback" });
  });

  it("returns not found when no pane and no fallback", async () => {
    mockExecFailure(new Error("no server"));

    const result = await injectInput("/tmp", "test");

    expect(result).toEqual({ found: false, reason: "no_tmux" });
  });
});

describe("launchClaudeInWindow", () => {
  it("creates a tmux window and sends 'claude -c' command", async () => {
    // new-window returns paneId, then sendKeysToPane (text + Enter)
    mockExecSequence([
      { stdout: "%42\n" },
      { stdout: "" }, // sendKeysToPane text
      { stdout: "" }, // sendKeysToPane Enter
    ]);

    const paneId = await launchClaudeInWindow("/Users/luca/project", "my-project", false);

    expect(paneId).toBe("%42");
    const newWindowCmd = vi.mocked(exec).mock.calls[0][0] as string;
    expect(newWindowCmd).toContain("tmux new-window");
    expect(newWindowCmd).toContain("/Users/luca/project");
    expect(newWindowCmd).toContain("my-project");

    // sendKeysToPane sends "claude -c"
    const sendKeysCmd = vi.mocked(exec).mock.calls[1][0] as string;
    expect(sendKeysCmd).toContain("claude -c");
  });

  it("sends 'claude -c --dangerously-skip-permissions' when skipPermissions is true", async () => {
    mockExecSequence([
      { stdout: "%10\n" },
      { stdout: "" },
      { stdout: "" },
    ]);

    await launchClaudeInWindow("/tmp/proj", "proj", true);

    const sendKeysCmd = vi.mocked(exec).mock.calls[1][0] as string;
    expect(sendKeysCmd).toContain("claude -c --dangerously-skip-permissions");
  });

  it("sanitizes project name for window name (no dots/colons/spaces)", async () => {
    mockExecSequence([
      { stdout: "%5\n" },
      { stdout: "" },
      { stdout: "" },
    ]);

    await launchClaudeInWindow("/tmp", "my.project:name with spaces", false);

    const newWindowCmd = vi.mocked(exec).mock.calls[0][0] as string;
    // Dots, colons, and spaces should be replaced with hyphens
    expect(newWindowCmd).toContain("my-project-name-with-spaces");
    expect(newWindowCmd).not.toContain(".");
  });
});

describe("killWindow", () => {
  it("runs tmux kill-window with the given target", async () => {
    mockExecSuccess("");

    await killWindow("%42");

    expect(exec).toHaveBeenCalledTimes(1);
    const cmd = vi.mocked(exec).mock.calls[0][0] as string;
    expect(cmd).toContain("tmux kill-window");
    expect(cmd).toContain("%42");
  });
});

describe("capturePaneContent", () => {
  it("runs tmux capture-pane and returns stdout", async () => {
    mockExecSuccess("line 1\nline 2\nline 3\n");

    const content = await capturePaneContent("%7");

    expect(content).toBe("line 1\nline 2\nline 3\n");
    const cmd = vi.mocked(exec).mock.calls[0][0] as string;
    expect(cmd).toContain("tmux capture-pane");
    expect(cmd).toContain("%7");
  });
});

describe("findClaudePane with multiple candidates (getClaudeChildStartTime)", () => {
  it("picks the pane with the most recently started claude child process", async () => {
    // Two claude panes at the same cwd — triggers getClaudeChildStartTime for each
    mockExecSequence([
      // listTmuxPanes
      { stdout: "%1 100 claude /Users/luca/project\n%2 200 claude /Users/luca/project\n" },
      // getClaudeChildStartTime for pane %1 (shellPid=100):
      //   ps -A -o pid= -o ppid= | awk  → returns child pid
      { stdout: "101\n" },
      //   ps -p 101 -o lstart=  → returns start time
      { stdout: "Mon Jan  1 12:00:00 2024\n" },
      // getClaudeChildStartTime for pane %2 (shellPid=200):
      { stdout: "201\n" },
      { stdout: "Tue Jan  2 12:00:00 2024\n" },  // newer
    ]);

    const result = await findClaudePane("/Users/luca/project");

    expect(result).toEqual({ found: true, paneId: "%2" });
  });

  it("falls back gracefully when getClaudeChildStartTime fails for one pane", async () => {
    mockExecSequence([
      // listTmuxPanes
      { stdout: "%1 100 claude /Users/luca/project\n%2 200 claude /Users/luca/project\n" },
      // getClaudeChildStartTime for pane %1: no child found
      { stdout: "\n" },
      // getClaudeChildStartTime for pane %2:
      { stdout: "201\n" },
      { stdout: "Tue Jan  2 12:00:00 2024\n" },
    ]);

    const result = await findClaudePane("/Users/luca/project");

    // Pane %2 has a valid start time, %1 returns 0
    expect(result).toEqual({ found: true, paneId: "%2" });
  });

  it("handles getClaudeChildStartTime error by returning 0", async () => {
    mockExecSequence([
      // listTmuxPanes
      { stdout: "%1 100 claude /Users/luca/project\n%2 200 claude /Users/luca/project\n" },
      // getClaudeChildStartTime for %1: error
      { error: new Error("ps failed") },
      // getClaudeChildStartTime for %2:
      { stdout: "201\n" },
      { stdout: "Mon Jan  1 12:00:00 2024\n" },
    ]);

    const result = await findClaudePane("/Users/luca/project");

    expect(result).toEqual({ found: true, paneId: "%2" });
  });
});
