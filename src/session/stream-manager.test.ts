import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./tmux.js", () => ({
  listTmuxPanes: vi.fn().mockResolvedValue([]),
  isClaudePane: vi.fn((p: any) => p.command.includes("claude")),
}));

vi.mock("./history.js", () => ({
  getLatestSessionFileForCwd: vi.fn().mockResolvedValue(null),
}));

vi.mock("./monitor.js", () => ({
  watchForResponse: vi.fn().mockReturnValue(() => {}),
  getFileSize: vi.fn().mockResolvedValue(0),
}));

vi.mock("../telegram/notifications.js", () => ({
  notifyResponse: vi.fn(),
  notifyToolUse: vi.fn(),
}));

vi.mock("../logger.js", () => ({ log: vi.fn() }));

import { SessionStreamManager, getStreamManager, setStreamManager } from "./stream-manager.js";
import { listTmuxPanes } from "./tmux.js";
import { getLatestSessionFileForCwd } from "./history.js";
import { watchForResponse, getFileSize } from "./monitor.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionStreamManager", () => {
  function claudePane(cwd: string) {
    return { paneId: "%1", shellPid: 123, command: "claude", cwd };
  }

  describe("start", () => {
    it("discovers tmux sessions and starts watchers on start", async () => {
      vi.mocked(listTmuxPanes).mockResolvedValue([claudePane("/tmp/projectA")]);
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/a.jsonl",
        sessionId: "session-a",
      });
      vi.mocked(getFileSize).mockResolvedValue(500);

      const manager = new SessionStreamManager();
      await manager.start();

      expect(watchForResponse).toHaveBeenCalledWith(
        "/tmp/a.jsonl",
        500,
        expect.any(Function),
        undefined,
        expect.any(Function),
        undefined,
        expect.any(Function),
      );

      manager.stop();
    });

    it("does not start duplicate watchers for same cwd", async () => {
      vi.mocked(listTmuxPanes).mockResolvedValue([
        claudePane("/tmp/projectA"),
        claudePane("/tmp/projectA"),
      ]);
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/a.jsonl",
        sessionId: "session-a",
      });
      vi.mocked(getFileSize).mockResolvedValue(500);

      const manager = new SessionStreamManager();
      await manager.start();

      expect(watchForResponse).toHaveBeenCalledTimes(1);

      manager.stop();
    });
  });

  describe("discovery loop", () => {
    it("discovers new sessions on poll interval", async () => {
      vi.mocked(listTmuxPanes).mockResolvedValue([]);

      const manager = new SessionStreamManager();
      await manager.start();

      expect(watchForResponse).not.toHaveBeenCalled();

      // New session appears
      vi.mocked(listTmuxPanes).mockResolvedValue([claudePane("/tmp/projectB")]);
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/b.jsonl",
        sessionId: "session-b",
      });
      vi.mocked(getFileSize).mockResolvedValue(100);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(watchForResponse).toHaveBeenCalledTimes(1);

      manager.stop();
    });

    it("removes watchers when tmux pane disappears", async () => {
      const stopFn = vi.fn();
      vi.mocked(watchForResponse).mockReturnValue(stopFn);
      vi.mocked(listTmuxPanes).mockResolvedValue([claudePane("/tmp/projectA")]);
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/a.jsonl",
        sessionId: "session-a",
      });
      vi.mocked(getFileSize).mockResolvedValue(500);

      const manager = new SessionStreamManager();
      await manager.start();

      // Pane disappears
      vi.mocked(listTmuxPanes).mockResolvedValue([]);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(stopFn).toHaveBeenCalled();

      manager.stop();
    });
  });

  describe("pause and resume", () => {
    it("pause stops the stream watcher for a cwd", async () => {
      const stopFn = vi.fn();
      vi.mocked(watchForResponse).mockReturnValue(stopFn);
      vi.mocked(listTmuxPanes).mockResolvedValue([claudePane("/tmp/projectA")]);
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/a.jsonl",
        sessionId: "session-a",
      });
      vi.mocked(getFileSize).mockResolvedValue(500);

      const manager = new SessionStreamManager();
      await manager.start();

      manager.pause("/tmp/projectA");

      expect(stopFn).toHaveBeenCalled();

      manager.stop();
    });

    it("resume restarts the watcher from current EOF", async () => {
      const stopFn = vi.fn();
      vi.mocked(watchForResponse).mockReturnValue(stopFn);
      vi.mocked(listTmuxPanes).mockResolvedValue([claudePane("/tmp/projectA")]);
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/a.jsonl",
        sessionId: "session-a",
      });
      vi.mocked(getFileSize).mockResolvedValue(500);

      const manager = new SessionStreamManager();
      await manager.start();

      expect(watchForResponse).toHaveBeenCalledTimes(1);

      manager.pause("/tmp/projectA");

      // Resume — should start a new watcher
      vi.mocked(getFileSize).mockResolvedValue(800);
      await manager.resume("/tmp/projectA");

      expect(watchForResponse).toHaveBeenCalledTimes(2);
      // Second call should use new baseline of 800
      expect(watchForResponse).toHaveBeenLastCalledWith(
        "/tmp/a.jsonl",
        800,
        expect.any(Function),
        undefined,
        expect.any(Function),
        undefined,
        expect.any(Function),
      );

      manager.stop();
    });

    it("pause is a no-op for unknown cwd", () => {
      const manager = new SessionStreamManager();
      // Should not throw
      manager.pause("/tmp/unknown");
      manager.stop();
    });
  });

  describe("watcher restart on completion", () => {
    it("restarts watcher from EOF when onComplete fires", async () => {
      let capturedOnComplete: (() => void) | undefined;
      vi.mocked(watchForResponse).mockImplementation(
        (_file, _base, _onResp, _onPing, onComp) => {
          capturedOnComplete = onComp;
          return vi.fn();
        }
      );
      vi.mocked(listTmuxPanes).mockResolvedValue([claudePane("/tmp/projectA")]);
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/a.jsonl",
        sessionId: "session-a",
      });
      vi.mocked(getFileSize).mockResolvedValue(500);

      const manager = new SessionStreamManager();
      await manager.start();

      expect(watchForResponse).toHaveBeenCalledTimes(1);

      // Simulate watcher completing (result event or timeout)
      vi.mocked(getFileSize).mockResolvedValue(900);
      await capturedOnComplete!();

      expect(watchForResponse).toHaveBeenCalledTimes(2);
      expect(watchForResponse).toHaveBeenLastCalledWith(
        "/tmp/a.jsonl",
        900,
        expect.any(Function),
        undefined,
        expect.any(Function),
        undefined,
        expect.any(Function),
      );

      manager.stop();
    });

    it("does not restart if session was paused", async () => {
      let capturedOnComplete: (() => void) | undefined;
      vi.mocked(watchForResponse).mockImplementation(
        (_file, _base, _onResp, _onPing, onComp) => {
          capturedOnComplete = onComp;
          return vi.fn();
        }
      );
      vi.mocked(listTmuxPanes).mockResolvedValue([claudePane("/tmp/projectA")]);
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/a.jsonl",
        sessionId: "session-a",
      });
      vi.mocked(getFileSize).mockResolvedValue(500);

      const manager = new SessionStreamManager();
      await manager.start();

      manager.pause("/tmp/projectA");

      // onComplete fires after pause — should NOT restart
      await capturedOnComplete!();

      // Still only 1 call (the initial start)
      expect(watchForResponse).toHaveBeenCalledTimes(1);

      manager.stop();
    });
  });

  describe("singleton accessor", () => {
    it("getStreamManager returns null by default", () => {
      expect(getStreamManager()).toBeNull();
    });

    it("setStreamManager stores and getStreamManager retrieves", () => {
      const manager = new SessionStreamManager();
      setStreamManager(manager);
      expect(getStreamManager()).toBe(manager);
      setStreamManager(null as any);
    });
  });

  describe("stop", () => {
    it("stops all watchers and the discovery interval", async () => {
      const stopFn = vi.fn();
      vi.mocked(watchForResponse).mockReturnValue(stopFn);
      vi.mocked(listTmuxPanes).mockResolvedValue([
        claudePane("/tmp/projectA"),
        claudePane("/tmp/projectB"),
      ]);
      vi.mocked(getLatestSessionFileForCwd).mockImplementation(async (cwd: string) => ({
        filePath: `${cwd}/session.jsonl`,
        sessionId: `session-${cwd}`,
      }));
      vi.mocked(getFileSize).mockResolvedValue(0);

      const manager = new SessionStreamManager();
      await manager.start();

      manager.stop();

      expect(stopFn).toHaveBeenCalledTimes(2);

      // Discovery loop should not fire after stop
      vi.mocked(listTmuxPanes).mockResolvedValue([claudePane("/tmp/projectC")]);
      await vi.advanceTimersByTimeAsync(30_000);
      // No new watchers started
      expect(watchForResponse).toHaveBeenCalledTimes(2);
    });
  });
});
