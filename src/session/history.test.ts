import { describe, it, expect, afterEach } from "vitest";
import { mkdir, writeFile, rm, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { parseJsonlLines, extractWaitingPrompt, listSessions, getLatestSessionFileForCwd, getAttachedSession, getSessionFilePath, readSessionLines, PROJECTS_PATH, ATTACHED_SESSION_PATH } from "./history.js";

const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  cwd: "/Users/luca/repositories/my-app",
  message: {
    content: [{ type: "text", text: "I've updated the migration file. Should I delete the old one? (y/n)" }],
  },
});

const TOOL_LINE = JSON.stringify({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Bash", input: { command: "npm install" } }],
  },
});

describe("parseJsonlLines", () => {
  it("extracts cwd from first assistant line", () => {
    const result = parseJsonlLines([ASSISTANT_LINE]);
    expect(result.cwd).toBe("/Users/luca/repositories/my-app");
  });

  it("extracts last text message", () => {
    const result = parseJsonlLines([ASSISTANT_LINE]);
    expect(result.lastMessage).toContain("updated the migration file");
  });

  it("skips malformed lines", () => {
    const result = parseJsonlLines(["not json", ASSISTANT_LINE]);
    expect(result.cwd).toBe("/Users/luca/repositories/my-app");
  });

  it("records tool calls", () => {
    const result = parseJsonlLines([TOOL_LINE]);
    expect(result.toolCalls).toContainEqual({ name: "Bash", input: { command: "npm install" } });
  });
});

describe("extractWaitingPrompt", () => {
  it("detects y/n prompt", () => {
    expect(extractWaitingPrompt("Should I delete it? (y/n)")).toBe("Should I delete it? (y/n)");
  });

  it("detects press enter", () => {
    expect(extractWaitingPrompt("Press enter to continue")).toBe("Press enter to continue");
  });

  it("detects trailing question mark", () => {
    expect(extractWaitingPrompt("Do you want me to proceed?")).toBe("Do you want me to proceed?");
  });

  it("returns null for non-waiting text", () => {
    expect(extractWaitingPrompt("I have updated the file.")).toBeNull();
  });

  it("returns null for short non-prompts", () => {
    expect(extractWaitingPrompt("Done.")).toBeNull();
  });
});

function assistantJsonl(text: string, cwd = "/tmp/proj"): string {
  return JSON.stringify({
    type: "assistant",
    cwd,
    message: { content: [{ type: "text", text }] },
  }) + "\n";
}

describe("listSessions", () => {
  let tmpProjects: string;

  afterEach(async () => {
    await rm(tmpProjects, { recursive: true, force: true });
  });

  it("returns one session per project directory", async () => {
    tmpProjects = join(tmpdir(), `cv-projects-${Date.now()}`);
    await mkdir(join(tmpProjects, "-Users-luca-repos-alpha"), { recursive: true });
    await mkdir(join(tmpProjects, "-Users-luca-repos-beta"), { recursive: true });
    await writeFile(join(tmpProjects, "-Users-luca-repos-alpha", "session1.jsonl"), assistantJsonl("Hello from A"));
    await writeFile(join(tmpProjects, "-Users-luca-repos-beta", "session2.jsonl"), assistantJsonl("Hello from B"));

    const sessions = await listSessions(20, tmpProjects);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.projectName)).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  it("deduplicates multiple sessions in same project — keeps the newest", async () => {
    tmpProjects = join(tmpdir(), `cv-projects-${Date.now()}`);
    const projDir = join(tmpProjects, "-Users-luca-repositories-my-project");
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "old-session.jsonl"), assistantJsonl("old message"));
    await new Promise((r) => setTimeout(r, 10)); // ensure distinct mtime
    await writeFile(join(projDir, "new-session.jsonl"), assistantJsonl("new message"));

    const sessions = await listSessions(20, tmpProjects);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].lastMessage).toContain("new message");
  });

  it("sorts by most recently modified", async () => {
    tmpProjects = join(tmpdir(), `cv-projects-${Date.now()}`);
    await mkdir(join(tmpProjects, "-Users-luca-repositories-alpha"), { recursive: true });
    await mkdir(join(tmpProjects, "-Users-luca-repositories-beta"), { recursive: true });
    await writeFile(join(tmpProjects, "-Users-luca-repositories-alpha", "s.jsonl"), assistantJsonl("alpha"));
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(join(tmpProjects, "-Users-luca-repositories-beta", "s.jsonl"), assistantJsonl("beta"));

    const sessions = await listSessions(20, tmpProjects);
    expect(sessions[0].projectName).toBe("beta");
    expect(sessions[1].projectName).toBe("alpha");
  });

  it("respects the limit", async () => {
    tmpProjects = join(tmpdir(), `cv-projects-${Date.now()}`);
    for (const name of ["p1", "p2", "p3"]) {
      await mkdir(join(tmpProjects, `-Users-luca-${name}`), { recursive: true });
      await writeFile(join(tmpProjects, `-Users-luca-${name}`, "s.jsonl"), assistantJsonl("msg"));
    }

    const sessions = await listSessions(2, tmpProjects);
    expect(sessions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Helper: produce a snapshot-only JSONL line (no assistant messages)
// ---------------------------------------------------------------------------
function snapshotLine(): string {
  return JSON.stringify({ type: "file-history-snapshot", messageId: "abc" }) + "\n";
}

describe("getLatestSessionFileForCwd", () => {
  // The function uses the module-level PROJECTS_PATH constant (typically
  // ~/.claude/projects). We create real files under PROJECTS_PATH using unique
  // test-id-based directory names so tests are isolated and cleaned up after each run.

  let encodedCwd: string;
  let projectDir: string;
  let fakeCwd: string;

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  function setupProjectDir(testId: string): void {
    // Use a cwd of form /cv-test-<id> — encodes to -cv-test-<id>
    // getLatestSessionFileForCwd encodes cwd by replacing "/" with "-"
    fakeCwd = `/cv-test-${testId}`;
    encodedCwd = fakeCwd.replace(/\//g, "-");
    projectDir = join(PROJECTS_PATH, encodedCwd);
  }

  it("returns the newest file even when it has only snapshot metadata (post-/clear scenario)", async () => {
    setupProjectDir(`newest-wins-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });

    // Write older assistant file
    await writeFile(join(projectDir, "session-old.jsonl"), assistantJsonl("Hello world"));
    await new Promise((r) => setTimeout(r, 20)); // ensure distinct mtime
    // Write newer snapshot-only file — this is what Claude Code writes after /clear
    await writeFile(join(projectDir, "session-new.jsonl"), snapshotLine());

    const result = await getLatestSessionFileForCwd(fakeCwd);
    expect(result).not.toBeNull();
    // newest file must be returned — it's the active session after /clear
    expect(result!.sessionId).toBe("session-new");
    expect(result!.filePath).toContain("session-new.jsonl");
  });

  it("falls back to the most-recently-modified file when no file has assistant messages", async () => {
    setupProjectDir(`fallback-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });

    await writeFile(join(projectDir, "session-a.jsonl"), snapshotLine());
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(projectDir, "session-b.jsonl"), snapshotLine());

    const result = await getLatestSessionFileForCwd(fakeCwd);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-b");
  });

  it("returns null when the project directory doesn't exist", async () => {
    // Use a cwd that has no matching project dir
    const nonExistentCwd = `/cv-test-nonexistent-${Date.now()}`;
    const result = await getLatestSessionFileForCwd(nonExistentCwd);
    expect(result).toBeNull();
  });

  it("returns the empty file (fresh session after /clear) over an older file with assistant messages", async () => {
    setupProjectDir(`clear-session-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });

    // Write older session with conversation history
    await writeFile(join(projectDir, "session-old.jsonl"), assistantJsonl("Previous response"));
    await new Promise((r) => setTimeout(r, 20)); // ensure distinct mtime
    // Write newer empty session (as created by /clear)
    await writeFile(join(projectDir, "session-new.jsonl"), "");

    const result = await getLatestSessionFileForCwd(fakeCwd);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-new");
  });

  it("when multiple files have assistant messages, returns the most recently modified one", async () => {
    setupProjectDir(`multi-assistant-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });

    await writeFile(join(projectDir, "session-first.jsonl"), assistantJsonl("First response"));
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(projectDir, "session-second.jsonl"), assistantJsonl("Second response"));
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(projectDir, "session-third.jsonl"), assistantJsonl("Third response"));

    const result = await getLatestSessionFileForCwd(fakeCwd);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-third");
  });
});

// ---------------------------------------------------------------------------
// getAttachedSession
// ---------------------------------------------------------------------------

describe("getAttachedSession", () => {
  const attachedPath = ATTACHED_SESSION_PATH;

  afterEach(async () => {
    await unlink(attachedPath).catch(() => {});
  });

  it("returns sessionId and cwd from the attached file", async () => {
    await mkdir(join(attachedPath, ".."), { recursive: true });
    await writeFile(attachedPath, "session-abc123\n/Users/luca/project", "utf8");

    const result = await getAttachedSession();

    expect(result).toEqual({ sessionId: "session-abc123", cwd: "/Users/luca/project" });
  });

  it("returns null when the file does not exist", async () => {
    await unlink(attachedPath).catch(() => {});
    const result = await getAttachedSession();
    expect(result).toBeNull();
  });

  it("returns homedir as cwd when only sessionId is in the file", async () => {
    const { homedir } = await import("os");
    await mkdir(join(attachedPath, ".."), { recursive: true });
    await writeFile(attachedPath, "session-only\n", "utf8");

    const result = await getAttachedSession();

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-only");
    expect(result!.cwd).toBe(homedir());
  });

  it("returns null when file is empty", async () => {
    await mkdir(join(attachedPath, ".."), { recursive: true });
    await writeFile(attachedPath, "", "utf8");

    const result = await getAttachedSession();
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSessionFilePath
// ---------------------------------------------------------------------------

describe("getSessionFilePath", () => {
  let tmpProjectDir: string;

  afterEach(async () => {
    if (tmpProjectDir) await rm(tmpProjectDir, { recursive: true, force: true });
  });

  it("finds a session file across project directories", async () => {
    const dirName = `-cv-test-gsfp-${Date.now()}`;
    tmpProjectDir = join(PROJECTS_PATH, dirName);
    await mkdir(tmpProjectDir, { recursive: true });
    const sessionId = `test-session-${Date.now()}`;
    await writeFile(join(tmpProjectDir, `${sessionId}.jsonl`), assistantJsonl("test"));

    const result = await getSessionFilePath(sessionId);
    expect(result).toBe(join(tmpProjectDir, `${sessionId}.jsonl`));
  });

  it("returns null when session is not found", async () => {
    const result = await getSessionFilePath("nonexistent-session-id-12345");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readSessionLines
// ---------------------------------------------------------------------------

describe("readSessionLines", () => {
  const tmpFile = join(tmpdir(), `cv-rsl-${Date.now()}.jsonl`);

  afterEach(async () => {
    await unlink(tmpFile).catch(() => {});
  });

  it("reads all lines from a JSONL file", async () => {
    const content = assistantJsonl("Line 1") + assistantJsonl("Line 2");
    await writeFile(tmpFile, content);

    const lines = await readSessionLines(tmpFile);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Line 1");
    expect(lines[1]).toContain("Line 2");
  });

  it("returns empty array for an empty file", async () => {
    await writeFile(tmpFile, "");
    const lines = await readSessionLines(tmpFile);
    expect(lines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseJsonlLines — additional coverage
// ---------------------------------------------------------------------------

describe("parseJsonlLines — additional branches", () => {
  it("uses homedir as cwd when no assistant entry has cwd", () => {
    const { homedir } = require("os");
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    const result = parseJsonlLines([line]);
    expect(result.cwd).toBe(homedir());
  });

  it("collects all text messages in allMessages", () => {
    const line1 = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
    });
    const result = parseJsonlLines([line1]);
    expect(result.allMessages).toEqual(["first", "second"]);
  });

  it("truncates lastMessage to 200 chars and replaces newlines", () => {
    const longText = "a".repeat(250) + "\nmore text";
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: longText }] },
    });
    const result = parseJsonlLines([line]);
    expect(result.lastMessage.length).toBeLessThanOrEqual(200);
    expect(result.lastMessage).not.toContain("\n");
  });

  it("handles tool_use with no input field", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "MyTool" }] },
    });
    const result = parseJsonlLines([line]);
    expect(result.toolCalls).toEqual([{ name: "MyTool", input: {} }]);
  });

  it("skips empty lines", () => {
    const result = parseJsonlLines(["", "  ", assistantJsonl("hello").trim()]);
    expect(result.allMessages).toEqual(["hello"]);
  });
});

// ---------------------------------------------------------------------------
// extractWaitingPrompt — additional branches
// ---------------------------------------------------------------------------

describe("extractWaitingPrompt — additional patterns", () => {
  it("detects [y/N] pattern", () => {
    expect(extractWaitingPrompt("Overwrite? [y/N]")).toBe("Overwrite? [y/N]");
  });

  it("detects 'confirm?' pattern", () => {
    expect(extractWaitingPrompt("Are you sure? Confirm?")).toBe("Are you sure? Confirm?");
  });

  it("detects 'provide input' pattern", () => {
    expect(extractWaitingPrompt("Please provide your input")).toBe("Please provide your input");
  });

  it("detects 'waiting for input' pattern", () => {
    expect(extractWaitingPrompt("Waiting for user input")).toBe("Waiting for user input");
  });

  it("detects trailing colon as prompt indicator", () => {
    expect(extractWaitingPrompt("Enter your name:")).toBe("Enter your name:");
  });

  it("detects trailing angle bracket as prompt indicator", () => {
    expect(extractWaitingPrompt("Enter value>")).toBe("Enter value>");
  });
});
