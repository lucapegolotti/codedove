# Multi-Session Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream responses from all active Claude Code tmux sessions to Telegram continuously, not just the attached session.

**Architecture:** A new `SessionStreamManager` maintains one `watchForResponse` per active Claude Code tmux session. It discovers sessions by polling tmux panes every 30s and restarts watchers when they complete. The existing `WatcherManager` handles injection flow and coordinates with `SessionStreamManager` via `pause(cwd)`/`resume(cwd)`.

**Tech Stack:** TypeScript, chokidar (via existing `watchForResponse`), grammy (existing Telegram bot)

---

### Task 1: Remove attached-session filter from notifyResponse

**Files:**
- Modify: `src/telegram/notifications.ts:71-86`
- Modify: `src/telegram/notifications.test.ts`

- [ ] **Step 1: Update the test to expect all sessions are forwarded**

In `src/telegram/notifications.test.ts`, find the test that verifies `notifyResponse` skips non-attached sessions. Change it to verify that responses from any session are forwarded. Also remove any test that mocks `getAttachedSession` to filter responses.

Find the relevant test and replace the attached-session filtering behavior: `notifyResponse` should send the message regardless of which session it comes from. The `getAttachedSession` import can be removed from the test.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/telegram/notifications.test.ts -v`
Expected: FAIL — the test expects no filtering but the code still filters.

- [ ] **Step 3: Remove the filter from notifyResponse**

In `src/telegram/notifications.ts`, remove lines 75-76:

```typescript
const attached = await getAttachedSession().catch(() => null);
if (!attached || attached.sessionId !== state.sessionId) return;
```

Also remove the `getAttachedSession` import if no longer used elsewhere in the file (check `sendStartupMessage` — it still uses it, so keep the import).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/telegram/notifications.test.ts -v`
Expected: PASS

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: All tests pass. Some `watcher-manager` tests mock `notifyResponse` — those should still work since we only removed the filter, not the function signature.

- [ ] **Step 6: Commit**

```bash
git add src/telegram/notifications.ts src/telegram/notifications.test.ts
git commit -m "feat: stream responses from all sessions, not just attached"
```

---

### Task 2: Create SessionStreamManager

**Files:**
- Create: `src/session/stream-manager.ts`
- Create: `src/session/stream-manager.test.ts`

- [ ] **Step 1: Write the tests**

Create `src/session/stream-manager.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/session/stream-manager.test.ts -v`
Expected: FAIL — module `./stream-manager.js` does not exist.

- [ ] **Step 3: Implement SessionStreamManager**

Create `src/session/stream-manager.ts`:

```typescript
import { log } from "../logger.js";
import { listTmuxPanes, isClaudePane } from "./tmux.js";
import { getLatestSessionFileForCwd } from "./history.js";
import { watchForResponse, getFileSize } from "./monitor.js";
import { notifyResponse } from "../telegram/notifications.js";

const DISCOVERY_INTERVAL = 30_000;

type StreamEntry = {
  cwd: string;
  filePath: string;
  sessionId: string;
  stop: () => void;
  paused: boolean;
};

export class SessionStreamManager {
  private streams = new Map<string, StreamEntry>();
  private discoveryId: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    await this.discover();
    this.discoveryId = setInterval(() => void this.discover(), DISCOVERY_INTERVAL);
  }

  pause(cwd: string): void {
    const entry = this.streams.get(cwd);
    if (!entry) return;
    entry.paused = true;
    entry.stop();
    log({ message: `stream paused for ${cwd}` });
  }

  async resume(cwd: string): Promise<void> {
    const entry = this.streams.get(cwd);
    if (!entry) return;
    entry.paused = false;
    await this.startWatcher(entry.cwd, entry.filePath);
    log({ message: `stream resumed for ${cwd}` });
  }

  stop(): void {
    if (this.discoveryId) {
      clearInterval(this.discoveryId);
      this.discoveryId = null;
    }
    for (const entry of this.streams.values()) {
      entry.stop();
    }
    this.streams.clear();
  }

  private async discover(): Promise<void> {
    const allPanes = await listTmuxPanes();
    const claudePanes = allPanes.filter(isClaudePane);

    // Deduplicate by cwd
    const activeCwds = new Set<string>();
    for (const pane of claudePanes) {
      activeCwds.add(pane.cwd);
    }

    // Start watchers for new sessions
    for (const cwd of activeCwds) {
      if (this.streams.has(cwd)) continue;

      const latest = await getLatestSessionFileForCwd(cwd);
      if (!latest) continue;

      await this.startWatcher(cwd, latest.filePath);
    }

    // Remove watchers for sessions whose tmux pane is gone
    for (const [cwd, entry] of this.streams) {
      if (!activeCwds.has(cwd)) {
        entry.stop();
        this.streams.delete(cwd);
        log({ message: `stream removed for ${cwd} (pane gone)` });
      }
    }
  }

  private async startWatcher(cwd: string, filePath: string): Promise<void> {
    const sessionId = filePath.split("/").pop()!.replace(".jsonl", "");
    const baseline = await getFileSize(filePath);

    const onComplete = async () => {
      const entry = this.streams.get(cwd);
      if (!entry || entry.paused) return;

      // Restart from current EOF
      const latest = await getLatestSessionFileForCwd(cwd);
      if (!latest) return;

      await this.startWatcher(cwd, latest.filePath);
    };

    const stop = watchForResponse(
      filePath,
      baseline,
      notifyResponse,
      undefined,
      onComplete,
    );

    this.streams.set(cwd, { cwd, filePath, sessionId, stop, paused: false });
  }
}

let _instance: SessionStreamManager | null = null;

export function getStreamManager(): SessionStreamManager | null {
  return _instance;
}

export function setStreamManager(manager: SessionStreamManager): void {
  _instance = manager;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/session/stream-manager.test.ts -v`
Expected: PASS

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/session/stream-manager.ts src/session/stream-manager.test.ts
git commit -m "feat: add SessionStreamManager for multi-session streaming"
```

---

### Task 3: Wire SessionStreamManager into index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add SessionStreamManager to bot startup**

In `src/index.ts`, import and start the `SessionStreamManager`:

```typescript
import { SessionStreamManager, setStreamManager } from "./session/stream-manager.js";
```

After the `stopPermissionWatcher` line (before the SIGINT handler), add:

```typescript
const streamManager = new SessionStreamManager();
setStreamManager(streamManager);
void streamManager.start();
```

Update the SIGINT/SIGTERM handlers to call `streamManager.stop()`:

```typescript
process.on("SIGINT", () => {
  stopMonitor();
  stopPermissionWatcher();
  streamManager.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopMonitor();
  stopPermissionWatcher();
  streamManager.stop();
  process.exit(0);
});
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/session/stream-manager.ts
git commit -m "feat: wire SessionStreamManager into bot lifecycle"
```

---

### Task 4: Add pause/resume coordination to injection flow

**Files:**
- Modify: `src/telegram/handlers/text.ts:182-219`

- [ ] **Step 1: Add pause/resume calls to processTextTurn**

In `src/telegram/handlers/text.ts`, import `getStreamManager`:

```typescript
import { getStreamManager } from "../../session/stream-manager.js";
```

In `processTextTurn`, after the interrupt block (line ~196, after the `await new Promise((r) => setTimeout(r, 600))`) and before the `if (!attached)` check, add the pause call:

```typescript
  // Pause stream watcher so injection watcher handles this session exclusively
  getStreamManager()?.pause(attached.cwd);
```

Modify the `startInjectionWatcher` call at the bottom of `processTextTurn` (line 219) to resume streaming on completion:

Change:
```typescript
await watcherManager.startInjectionWatcher(attached, chatId, undefined, () => clearInterval(typingInterval), preBaseline);
```

To:
```typescript
await watcherManager.startInjectionWatcher(attached, chatId, undefined, () => {
  clearInterval(typingInterval);
  void getStreamManager()?.resume(attached.cwd);
}, preBaseline);
```

- [ ] **Step 6: Do the same for fetchAndOfferImages**

In the `fetchAndOfferImages` function, add pause before injection (after the interrupt block around line 48) and resume in the onComplete. The existing `startInjectionWatcher` call at line 101 passes `() => clearInterval(typingInterval)` as onComplete. Change it to:

```typescript
await watcherManager.startInjectionWatcher(
  attached,
  chatId,
  onResponse,
  () => {
    clearInterval(typingInterval);
    void getStreamManager()?.resume(attached.cwd);
  },
  preBaseline
);
```

And add the pause before the injection (after line 48):

```typescript
getStreamManager()?.pause(attached.cwd);
```

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/telegram/handlers/text.ts src/session/stream-manager.ts src/session/stream-manager.test.ts
git commit -m "feat: pause/resume stream watchers during injection"
```

---

### Task 5: Integration test

**Files:**
- Create or modify: `src/session/scenario.test.ts`

- [ ] **Step 1: Write a scenario test for multi-session streaming**

Add a new test to `src/session/scenario.test.ts` that verifies:
1. `SessionStreamManager` starts a watcher when a JSONL file exists for a tmux cwd
2. When assistant text is appended, the `onResponse` callback fires
3. The watcher restarts after completion

This test should use the real filesystem (like existing scenario tests) — create a temp JSONL file, start the manager with a mocked `listTmuxPanes` that returns a pane for that cwd, append JSONL content, and verify the response callback fires.

Since `SessionStreamManager` calls `listTmuxPanes` internally and we can't easily mock it in a real-filesystem scenario test, write this as a focused integration test in a new describe block. Mock only `listTmuxPanes` and `isClaudePane` (via `vi.mock`), and use real files for everything else.

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/session/scenario.test.ts -v`
Expected: PASS

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/session/scenario.test.ts
git commit -m "test: add integration test for multi-session streaming"
```

---

### Task 6: Manual verification and cleanup

- [ ] **Step 1: Run the full test suite one final time**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Verify the bot starts cleanly**

Start the bot briefly to confirm no import errors or startup crashes:

Run: `timeout 5 npx tsx src/index.ts 2>&1 || true`
Expected: "codedove bot running" appears in output, no errors.

- [ ] **Step 3: Commit any remaining changes**

If there are any unstaged changes, commit them.
