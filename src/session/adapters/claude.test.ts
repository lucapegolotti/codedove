import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter } from "./claude.js";

describe("ClaudeCodeAdapter", () => {
  const adapter = new ClaudeCodeAdapter();

  it("has name 'claude'", () => {
    expect(adapter.name).toBe("claude");
  });

  it("supports image detection", () => {
    expect(adapter.supportsImageDetection).toBe(true);
  });

  it("projectsPath points to ~/.claude/projects", () => {
    expect(adapter.projectsPath).toMatch(/\.claude\/projects$/);
  });

  it("isAgentPane detects Claude by command", () => {
    expect(adapter.isAgentPane({ paneId: "%1", shellPid: 1, command: "claude", cwd: "/tmp" })).toBe(true);
    expect(adapter.isAgentPane({ paneId: "%1", shellPid: 1, command: "2.1.47", cwd: "/tmp" })).toBe(true);
    expect(adapter.isAgentPane({ paneId: "%1", shellPid: 1, command: "zsh", cwd: "/tmp" })).toBe(false);
  });

  it("parseAssistantText returns text block", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        cwd: "/tmp/p",
        message: { model: "claude-opus-4-7", content: [{ type: "text", text: "hello" }] },
      }),
    ];
    const result = adapter.parseAssistantText(lines);
    expect(result.text).toBe("hello");
    expect(result.cwd).toBe("/tmp/p");
    expect(result.model).toBe("claude-opus-4-7");
  });

  it("findResultEvent detects result event", () => {
    expect(adapter.findResultEvent([JSON.stringify({ type: "result" })])).toBe(true);
    expect(adapter.findResultEvent([JSON.stringify({ type: "assistant" })])).toBe(false);
  });

  it("extractToolUses returns Bash entries", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    ];
    const tools = adapter.extractToolUses(lines);
    expect(tools).toEqual([{ id: "t1", name: "Bash", command: "ls" }]);
  });

  it("friendlyModelName strips claude- prefix", () => {
    expect(adapter.friendlyModelName("claude-opus-4-7")).toMatch(/opus/);
  });
});
