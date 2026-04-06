import { log } from "../logger.js";
import { listTmuxPanes, isClaudePane } from "./tmux.js";
import { getLatestSessionFileForCwd } from "./history.js";
import { watchForResponse, getFileSize } from "./monitor.js";
import { notifyResponse, notifyToolUse } from "../telegram/notifications.js";

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
    // Re-fetch latest session file in case of rotation during pause
    const latest = await getLatestSessionFileForCwd(cwd);
    const filePath = latest?.filePath ?? entry.filePath;
    await this.startWatcher(entry.cwd, filePath);
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
    let allPanes;
    try {
      allPanes = await listTmuxPanes();
    } catch (err) {
      log({ message: `stream discovery error: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
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

    const projectName = cwd.split("/").pop() || cwd;

    const stop = watchForResponse(
      filePath,
      baseline,
      notifyResponse,
      undefined,
      onComplete,
      undefined,
      async (tools) => { await notifyToolUse(projectName, sessionId, tools); }
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
