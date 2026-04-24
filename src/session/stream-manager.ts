import { log } from "../logger.js";
import { listTmuxPanes } from "./tmux.js";
import { watchForResponse, getFileSize } from "./monitor.js";
import { notifyResponse, notifyToolUse } from "../telegram/notifications.js";
import type { SessionAdapter } from "./adapter.js";
import { adapters as defaultAdapters } from "./adapters/index.js";

const DISCOVERY_INTERVAL = 30_000;

type StreamEntry = {
  cwd: string;
  filePath: string;
  sessionId: string;
  stop: () => void;
  paused: boolean;
  adapter: SessionAdapter;
};

export class SessionStreamManager {
  private streams = new Map<string, StreamEntry>();
  private discoveryId: ReturnType<typeof setInterval> | null = null;
  private adapters: SessionAdapter[];

  constructor(adapters: SessionAdapter[] = defaultAdapters) {
    this.adapters = adapters;
  }

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
    const latest = await entry.adapter.getLatestSessionFileForCwd(cwd);
    const filePath = latest?.filePath ?? entry.filePath;
    await this.startWatcher(entry.cwd, filePath, entry.adapter);
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

    // Pair each pane with its adapter (if any)
    const paneAdapters = new Map<string, SessionAdapter>();
    for (const pane of allPanes) {
      const adapter = this.pickAdapter(pane);
      if (adapter) paneAdapters.set(pane.cwd, adapter);
    }

    // Start watchers for new sessions
    for (const [cwd, adapter] of paneAdapters) {
      if (this.streams.has(cwd)) continue;

      const latest = await adapter.getLatestSessionFileForCwd(cwd);
      if (!latest) continue;

      await this.startWatcher(cwd, latest.filePath, adapter);
    }

    // Remove watchers for sessions whose tmux pane is gone
    for (const [cwd, entry] of this.streams) {
      if (!paneAdapters.has(cwd)) {
        entry.stop();
        this.streams.delete(cwd);
        log({ message: `stream removed for ${cwd} (pane gone)` });
      }
    }
  }

  private pickAdapter(pane: import("./tmux.js").TmuxPane): SessionAdapter | null {
    for (const adapter of this.adapters) {
      if (adapter.isAgentPane(pane)) return adapter;
    }
    return null;
  }

  private async startWatcher(cwd: string, filePath: string, adapter: SessionAdapter): Promise<void> {
    const sessionId = filePath.split("/").pop()!.replace(".jsonl", "");
    const baseline = await getFileSize(filePath);

    const onComplete = async () => {
      const entry = this.streams.get(cwd);
      if (!entry || entry.paused) return;

      // Restart from current EOF
      const latest = await entry.adapter.getLatestSessionFileForCwd(cwd);
      if (!latest) return;

      await this.startWatcher(cwd, latest.filePath, entry.adapter);
    };

    const projectName = cwd.split("/").pop() || cwd;

    const stop = watchForResponse(
      filePath,
      baseline,
      notifyResponse,
      undefined,
      onComplete,
      undefined,
      async (tools) => { await notifyToolUse(projectName, sessionId, tools); },
      adapter
    );

    this.streams.set(cwd, { cwd, filePath, sessionId, stop, paused: false, adapter });
  }
}

let _instance: SessionStreamManager | null = null;

export function getStreamManager(): SessionStreamManager | null {
  return _instance;
}

export function setStreamManager(manager: SessionStreamManager): void {
  _instance = manager;
}
