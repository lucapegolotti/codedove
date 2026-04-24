import { describe, it, expect } from "vitest";
import { CodexAdapter } from "./codex.js";
import { mkdtemp, mkdir, writeFile, utimes } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("CodexAdapter parsing", () => {
  const adapter = new CodexAdapter();

  describe("parseAssistantText", () => {
    it("returns the latest agent_message", () => {
      const lines = [
        JSON.stringify({
          type: "turn_context",
          payload: { cwd: "/tmp/proj", model: "gpt-5.4" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "First update", phase: "commentary" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "Final answer", phase: "final" },
        }),
      ];
      const result = adapter.parseAssistantText(lines);
      expect(result.text).toBe("Final answer");
      expect(result.cwd).toBe("/tmp/proj");
      expect(result.model).toBe("gpt-5.4");
    });

    it("handles commentary-only messages", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "still working", phase: "commentary" },
        }),
      ];
      const result = adapter.parseAssistantText(lines);
      expect(result.text).toBe("still working");
    });

    it("returns null text when no agent_message present", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_started" },
        }),
      ];
      const result = adapter.parseAssistantText(lines);
      expect(result.text).toBeNull();
    });

    it("stops at user_message boundary", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "old reply" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "new question" },
        }),
      ];
      const result = adapter.parseAssistantText(lines);
      expect(result.text).toBeNull();
    });
  });

  describe("findResultEvent", () => {
    it("detects task_complete", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "t1" },
        }),
      ];
      expect(adapter.findResultEvent(lines)).toBe(true);
    });

    it("returns false without task_complete", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "hi" },
        }),
      ];
      expect(adapter.findResultEvent(lines)).toBe(false);
    });
  });

  describe("extractToolUses", () => {
    it("returns Bash entries from exec_command_end, preferring the actual shell payload", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "exec_command_end",
            call_id: "call_ABC",
            command: ["/bin/zsh", "-lc", "pwd"],
            exit_code: 0,
          },
        }),
      ];
      const tools = adapter.extractToolUses(lines);
      expect(tools).toEqual([{ id: "call_ABC", name: "Bash", command: "pwd" }]);
    });

    it("truncates long commands", () => {
      const longCmd = "a".repeat(100);
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "exec_command_end",
            call_id: "c1",
            command: ["/bin/zsh", "-lc", longCmd],
            exit_code: 0,
          },
        }),
      ];
      const tools = adapter.extractToolUses(lines);
      expect(tools[0].command).toBe("a".repeat(57) + "...");
    });

    it("skips non-exec events", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "hi" },
        }),
      ];
      expect(adapter.extractToolUses(lines)).toEqual([]);
    });

    it("falls back to joined command array if no -lc pattern", () => {
      const lines = [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "exec_command_end",
            call_id: "c2",
            command: ["ls", "/tmp"],
            exit_code: 0,
          },
        }),
      ];
      const tools = adapter.extractToolUses(lines);
      expect(tools[0].command).toBe("ls /tmp");
    });
  });

  describe("friendlyModelName", () => {
    it("returns model ID as-is", () => {
      expect(adapter.friendlyModelName("gpt-5.4")).toBe("gpt-5.4");
    });

    it("falls back to 'codex' when undefined", () => {
      expect(adapter.friendlyModelName(undefined)).toBe("codex");
    });
  });
});

describe("CodexAdapter session discovery", () => {
  it("finds the newest rollout file matching cwd across date subdirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-adapter-"));
    const adapter = new CodexAdapter();
    (adapter as any).projectsPath = root;

    const now = new Date();
    const yyyy = now.getUTCFullYear().toString();
    const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
    const dd = now.getUTCDate().toString().padStart(2, "0");
    const yesterday = new Date(now.getTime() - 86_400_000);
    const yyyy2 = yesterday.getUTCFullYear().toString();
    const mm2 = (yesterday.getUTCMonth() + 1).toString().padStart(2, "0");
    const dd2 = yesterday.getUTCDate().toString().padStart(2, "0");

    const day1 = join(root, yyyy2, mm2, dd2);
    const day2 = join(root, yyyy, mm, dd);
    await mkdir(day1, { recursive: true });
    await mkdir(day2, { recursive: true });

    const oldFile = join(day1, "rollout-2026-04-20T10-00-00-aaa-bbb-ccc-ddd-000000000001.jsonl");
    const newFile = join(day2, "rollout-2026-04-23T10-00-00-aaa-bbb-ccc-ddd-000000000002.jsonl");
    const otherCwdFile = join(day2, "rollout-2026-04-23T11-00-00-aaa-bbb-ccc-ddd-000000000003.jsonl");

    await writeFile(
      oldFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/target" } }) + "\n"
    );
    await writeFile(
      newFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/target" } }) + "\n"
    );
    await writeFile(
      otherCwdFile,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/other" } }) + "\n"
    );

    const nowMs = Date.now();
    await utimes(oldFile, new Date(nowMs - 10_000), new Date(nowMs - 10_000));
    await utimes(newFile, new Date(nowMs), new Date(nowMs));
    await utimes(otherCwdFile, new Date(nowMs + 5_000), new Date(nowMs + 5_000));

    const result = await adapter.getLatestSessionFileForCwd("/tmp/target");
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe(newFile);
    expect(result!.sessionId).toBe("aaa-bbb-ccc-ddd-000000000002");
  });

  it("returns null when no matching cwd is found", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-adapter-"));
    const adapter = new CodexAdapter();
    (adapter as any).projectsPath = root;

    const result = await adapter.getLatestSessionFileForCwd("/tmp/nonexistent");
    expect(result).toBeNull();
  });
});
