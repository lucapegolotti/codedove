import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./history.js", () => ({
  ATTACHED_SESSION_PATH: "/tmp/test-attached",
  getLatestSessionFileForCwd: vi.fn(),
}));

vi.mock("./monitor.js", () => ({
  watchForResponse: vi.fn().mockReturnValue(() => {}),
  getFileSize: vi.fn().mockResolvedValue(100),
}));

vi.mock("../telegram/notifications.js", () => ({
  notifyResponse: vi.fn(),
  notifyImages: vi.fn(),
  sendPing: vi.fn(),
}));

vi.mock("../logger.js", () => ({ log: vi.fn() }));

vi.mock("fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { WatcherManager } from "./watcher-manager.js";
import { getLatestSessionFileForCwd } from "./history.js";
import { watchForResponse, getFileSize } from "./monitor.js";
import { notifyResponse, notifyImages, sendPing } from "../telegram/notifications.js";
import { writeFile } from "fs/promises";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WatcherManager", () => {
  function createManager() {
    const pendingImages = new Map();
    return new WatcherManager(pendingImages);
  }

  describe("constructor", () => {
    it("starts with isActive = false", () => {
      const manager = createManager();
      expect(manager.isActive).toBe(false);
    });
  });

  describe("clear", () => {
    it("stops the active watcher", async () => {
      const manager = createManager();
      const stopFn = vi.fn();
      vi.mocked(watchForResponse).mockReturnValue(stopFn);
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/session.jsonl",
        sessionId: "session-abc",
      });

      await manager.startInjectionWatcher(
        { sessionId: "session-abc", cwd: "/tmp/project" },
        123
      );

      expect(manager.isActive).toBe(true);

      manager.clear();

      expect(stopFn).toHaveBeenCalled();
      expect(manager.isActive).toBe(false);
    });
  });

  describe("stopAndFlush", () => {
    it("calls stop and fires onComplete callback", async () => {
      const manager = createManager();
      const stopFn = vi.fn();
      vi.mocked(watchForResponse).mockReturnValue(stopFn);
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/session.jsonl",
        sessionId: "session-abc",
      });

      let completeCalled = false;
      await manager.startInjectionWatcher(
        { sessionId: "session-abc", cwd: "/tmp/project" },
        123,
        undefined,
        () => { completeCalled = true; }
      );

      manager.stopAndFlush();

      expect(stopFn).toHaveBeenCalled();
      expect(completeCalled).toBe(true);
      expect(manager.isActive).toBe(false);
    });

    it("is a no-op when no active watcher exists", () => {
      const manager = createManager();
      // Should not throw
      manager.stopAndFlush();
      expect(manager.isActive).toBe(false);
    });
  });

  describe("snapshotBaseline", () => {
    it("returns filePath, sessionId, and size from latest session", async () => {
      const manager = createManager();
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/session.jsonl",
        sessionId: "session-abc",
      });
      vi.mocked(getFileSize).mockResolvedValue(500);

      const result = await manager.snapshotBaseline("/tmp/project");

      expect(result).toEqual({
        filePath: "/tmp/session.jsonl",
        sessionId: "session-abc",
        size: 500,
      });
      expect(getLatestSessionFileForCwd).toHaveBeenCalledWith("/tmp/project");
      expect(getFileSize).toHaveBeenCalledWith("/tmp/session.jsonl");
    });

    it("returns null when no session exists", async () => {
      const manager = createManager();
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue(null);

      const result = await manager.snapshotBaseline("/tmp/project");

      expect(result).toBeNull();
    });
  });

  describe("startInjectionWatcher", () => {
    it("calls stopAndFlush on previous watcher before starting new one", async () => {
      const manager = createManager();
      const stopFn1 = vi.fn();
      const stopFn2 = vi.fn();
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/session.jsonl",
        sessionId: "session-abc",
      });
      vi.mocked(watchForResponse)
        .mockReturnValueOnce(stopFn1)
        .mockReturnValueOnce(stopFn2);

      let firstComplete = false;
      await manager.startInjectionWatcher(
        { sessionId: "session-abc", cwd: "/tmp/project" },
        123,
        undefined,
        () => { firstComplete = true; }
      );

      // Start a second watcher — should stop+flush the first
      await manager.startInjectionWatcher(
        { sessionId: "session-abc", cwd: "/tmp/project" },
        123
      );

      expect(stopFn1).toHaveBeenCalled();
      expect(firstComplete).toBe(true);
    });

    it("calls onComplete when no session file exists", async () => {
      const manager = createManager();
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue(null);

      let completeCalled = false;
      await manager.startInjectionWatcher(
        { sessionId: "session-abc", cwd: "/tmp/project" },
        123,
        undefined,
        () => { completeCalled = true; }
      );

      expect(completeCalled).toBe(true);
      expect(watchForResponse).not.toHaveBeenCalled();
    });

    it("uses preBaseline when provided instead of looking up session", async () => {
      const manager = createManager();
      vi.mocked(watchForResponse).mockReturnValue(vi.fn());

      const preBaseline = {
        filePath: "/tmp/pre-session.jsonl",
        sessionId: "pre-session-id",
        size: 200,
      };

      await manager.startInjectionWatcher(
        { sessionId: "pre-session-id", cwd: "/tmp/project" },
        123,
        undefined,
        undefined,
        preBaseline
      );

      // Should not call getLatestSessionFileForCwd since preBaseline is provided
      expect(getLatestSessionFileForCwd).not.toHaveBeenCalled();
      expect(watchForResponse).toHaveBeenCalledWith(
        "/tmp/pre-session.jsonl",
        200,
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function)
      );
    });

    it("sets isActive to true after starting", async () => {
      const manager = createManager();
      vi.mocked(watchForResponse).mockReturnValue(vi.fn());
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/session.jsonl",
        sessionId: "session-abc",
      });

      await manager.startInjectionWatcher(
        { sessionId: "session-abc", cwd: "/tmp/project" },
        123
      );

      expect(manager.isActive).toBe(true);
    });
  });

  describe("generation counter", () => {
    it("increments generation to prevent stale polls from previous injections", async () => {
      const manager = createManager();
      vi.mocked(watchForResponse).mockReturnValue(vi.fn());
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/session.jsonl",
        sessionId: "session-abc",
      });

      // Start first watcher
      await manager.startInjectionWatcher(
        { sessionId: "session-abc", cwd: "/tmp/project" },
        123
      );

      // Start second watcher — generation should increment, preventing old polls
      await manager.startInjectionWatcher(
        { sessionId: "session-abc", cwd: "/tmp/project" },
        123
      );

      // The fact that watchForResponse was called twice shows second watcher started
      expect(watchForResponse).toHaveBeenCalledTimes(2);
    });
  });

  describe("startInjectionWatcher with no preBaseline", () => {
    it("looks up the latest session when no preBaseline is provided", async () => {
      const manager = createManager();
      vi.mocked(watchForResponse).mockReturnValue(vi.fn());
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/looked-up.jsonl",
        sessionId: "looked-up-id",
      });
      vi.mocked(getFileSize).mockResolvedValue(300);

      await manager.startInjectionWatcher(
        { sessionId: "looked-up-id", cwd: "/tmp/project" },
        123
      );

      expect(getLatestSessionFileForCwd).toHaveBeenCalledWith("/tmp/project");
      expect(watchForResponse).toHaveBeenCalledWith(
        "/tmp/looked-up.jsonl",
        300,
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function)
      );
    });
  });

  describe("watchForResponse callback wiring", () => {
    it("wrappedOnResponse invokes the custom onResponse and marks responseDelivered", async () => {
      const manager = createManager();
      let capturedOnResponse: any;
      let capturedOnComplete: any;
      let capturedOnPing: any;
      let capturedOnImages: any;

      vi.mocked(watchForResponse).mockImplementation(
        (_file, _base, onResp, onPing, onComp, onImg) => {
          capturedOnResponse = onResp;
          capturedOnPing = onPing;
          capturedOnComplete = onComp;
          capturedOnImages = onImg;
          return vi.fn();
        }
      );
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/session.jsonl",
        sessionId: "session-abc",
      });
      vi.mocked(getFileSize).mockResolvedValue(100);

      const customOnResponse = vi.fn();
      let completeCalled = false;

      await manager.startInjectionWatcher(
        { sessionId: "session-abc", cwd: "/tmp/project" },
        123,
        customOnResponse,
        () => { completeCalled = true; }
      );

      // Invoke the wrappedOnResponse
      const state = { sessionId: "s", projectName: "p", cwd: "/c", filePath: "/f", text: "t" };
      await capturedOnResponse(state);
      expect(customOnResponse).toHaveBeenCalledWith(state);

      // Invoke onPing
      capturedOnPing();
      expect(sendPing).toHaveBeenCalledWith("⏳ Still working...");

      // Invoke onComplete — since response was delivered, should NOT send "Done" ping
      capturedOnComplete();
      expect(completeCalled).toBe(true);
      // sendPing was called once for the ping, should not be called again for "Done"
      expect(vi.mocked(sendPing)).toHaveBeenCalledTimes(1);
    });

    it("onComplete sends Done ping when no response was delivered", async () => {
      const manager = createManager();
      let capturedOnComplete: any;

      vi.mocked(watchForResponse).mockImplementation(
        (_file, _base, _onResp, _onPing, onComp) => {
          capturedOnComplete = onComp;
          return vi.fn();
        }
      );
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/session.jsonl",
        sessionId: "session-abc",
      });
      vi.mocked(getFileSize).mockResolvedValue(100);

      await manager.startInjectionWatcher(
        { sessionId: "session-abc", cwd: "/tmp/project" },
        123
      );

      // Complete without any response
      capturedOnComplete();
      expect(sendPing).toHaveBeenCalledWith("✅ Done.");
    });

    it("onImages callback stores images in pendingImages and notifies", async () => {
      const pendingImages = new Map();
      const manager = new WatcherManager(pendingImages);
      let capturedOnImages: any;

      vi.mocked(watchForResponse).mockImplementation(
        (_file, _base, _onResp, _onPing, _onComp, onImg) => {
          capturedOnImages = onImg;
          return vi.fn();
        }
      );
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/session.jsonl",
        sessionId: "session-abc",
      });
      vi.mocked(getFileSize).mockResolvedValue(100);

      await manager.startInjectionWatcher(
        { sessionId: "session-abc", cwd: "/tmp/project" },
        123
      );

      const images = [{ mediaType: "image/png", data: "base64" }];
      await capturedOnImages(images);

      expect(pendingImages.size).toBe(1);
      expect(notifyImages).toHaveBeenCalledWith(images, expect.any(String));
    });

    it("wrappedOnResponse uses default notifyResponse when no custom onResponse", async () => {
      const manager = createManager();
      let capturedOnResponse: any;

      vi.mocked(watchForResponse).mockImplementation(
        (_file, _base, onResp) => {
          capturedOnResponse = onResp;
          return vi.fn();
        }
      );
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/session.jsonl",
        sessionId: "session-abc",
      });
      vi.mocked(getFileSize).mockResolvedValue(100);

      await manager.startInjectionWatcher(
        { sessionId: "session-abc", cwd: "/tmp/project" },
        123
        // no custom onResponse
      );

      const state = { sessionId: "s", projectName: "p", cwd: "/c", filePath: "/f", text: "t" };
      await capturedOnResponse(state);
      expect(notifyResponse).toHaveBeenCalledWith(state);
    });
  });

  describe("session rotation detection", () => {
    it("updates attached session file when sessionId rotates", async () => {
      const manager = createManager();
      vi.mocked(watchForResponse).mockReturnValue(vi.fn());
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/new-session.jsonl",
        sessionId: "new-session-id",
      });
      vi.mocked(getFileSize).mockResolvedValue(0);

      await manager.startInjectionWatcher(
        { sessionId: "old-session-id", cwd: "/tmp/project" },
        123
      );

      // sessionId rotated: old-session-id -> new-session-id
      expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
        "/tmp/test-attached",
        "new-session-id\n/tmp/project",
        "utf8"
      );
    });
  });

  describe("pollForPostCompactionSession", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("detects new session and restarts watcher", async () => {
      vi.useFakeTimers();
      const manager = createManager();
      const oldStop = vi.fn();
      const newStop = vi.fn();

      vi.mocked(watchForResponse)
        .mockReturnValueOnce(oldStop)
        .mockReturnValueOnce(newStop);

      // Initial: returns old session
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/old-session.jsonl",
        sessionId: "old-session",
      });
      vi.mocked(getFileSize).mockResolvedValue(100);

      let completeCalled = false;
      await manager.startInjectionWatcher(
        { sessionId: "old-session", cwd: "/tmp/project" },
        123,
        undefined,
        () => { completeCalled = true; }
      );

      // Now simulate pollForPostCompactionSession finding a new session
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/new-session.jsonl",
        sessionId: "new-session",
      });

      // Advance timers to trigger the poll (3s interval)
      await vi.advanceTimersByTimeAsync(3_500);

      // Old watcher should have been stopped, new one started
      expect(oldStop).toHaveBeenCalled();
      expect(watchForResponse).toHaveBeenCalledTimes(2);
      expect(watchForResponse).toHaveBeenLastCalledWith(
        "/tmp/new-session.jsonl",
        0,
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );
    });

    it("invokes the onPing and onComplete callbacks passed to restarted watcher", async () => {
      vi.useFakeTimers();
      const manager = createManager();
      const oldStop = vi.fn();

      // Capture the callbacks passed to watchForResponse
      let capturedOnPing: (() => void) | undefined;
      let capturedOnComplete: (() => void) | undefined;

      vi.mocked(watchForResponse)
        .mockReturnValueOnce(oldStop) // initial watcher
        .mockImplementationOnce((_file, _base, _onResp, onPing, onComplete) => {
          capturedOnPing = onPing;
          capturedOnComplete = onComplete;
          return vi.fn();
        });

      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/old-session.jsonl",
        sessionId: "old-session",
      });
      vi.mocked(getFileSize).mockResolvedValue(100);

      let completeCalled = false;
      await manager.startInjectionWatcher(
        { sessionId: "old-session", cwd: "/tmp/project" },
        123,
        undefined,
        () => { completeCalled = true; }
      );

      // Poll finds a new session
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/new-session.jsonl",
        sessionId: "new-session",
      });

      await vi.advanceTimersByTimeAsync(3_500);

      // The restarted watcher's onComplete should fire the original onComplete
      expect(capturedOnComplete).toBeDefined();
      capturedOnComplete!();
      expect(completeCalled).toBe(true);

      // The restarted watcher's onPing should not throw
      expect(capturedOnPing).toBeDefined();
      capturedOnPing!(); // just ensure it doesn't throw
    });

    it("calls onComplete when poll times out without finding new session", async () => {
      vi.useFakeTimers();
      const manager = createManager();
      vi.mocked(watchForResponse).mockReturnValue(vi.fn());

      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/same-session.jsonl",
        sessionId: "same-session",
      });
      vi.mocked(getFileSize).mockResolvedValue(100);

      let completeCalled = false;
      await manager.startInjectionWatcher(
        { sessionId: "same-session", cwd: "/tmp/project" },
        123,
        undefined,
        () => { completeCalled = true; }
      );

      // Poll never finds a different file — keep returning the same one
      // Advance past the 60s deadline (20 polls * 3s = 60s, plus buffer)
      for (let i = 0; i < 22; i++) {
        await vi.advanceTimersByTimeAsync(3_100);
      }

      expect(completeCalled).toBe(true);
    });

    it("does nothing when generation changes (aborts stale poll)", async () => {
      vi.useFakeTimers();
      const manager = createManager();
      vi.mocked(watchForResponse).mockReturnValue(vi.fn());

      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/session.jsonl",
        sessionId: "session-abc",
      });
      vi.mocked(getFileSize).mockResolvedValue(100);

      // Start first watcher (starts poll with generation=1)
      await manager.startInjectionWatcher(
        { sessionId: "session-abc", cwd: "/tmp/project" },
        123
      );

      // Start second watcher (increments generation to 2, aborting poll from first)
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/session2.jsonl",
        sessionId: "session-def",
      });

      await manager.startInjectionWatcher(
        { sessionId: "session-def", cwd: "/tmp/project" },
        123
      );

      // Now advance timers — the first poll should NOT restart a watcher
      // because its generation is stale
      vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({
        filePath: "/tmp/session3.jsonl",
        sessionId: "session-ghi",
      });

      await vi.advanceTimersByTimeAsync(3_500);

      // Only 3 calls: initial injection #1 + initial injection #2 + poll restart from #2
      // The old poll from injection #1 should have been aborted
      // (We verify indirectly: watchForResponse should be called at most 3 times)
      expect(watchForResponse).toHaveBeenCalledTimes(3);
    });
  });
});
