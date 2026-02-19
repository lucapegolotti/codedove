import { describe, it, expect } from "vitest";
import { parseJsonlLines, extractWaitingPrompt } from "./history.js";

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
