/**
 * Consolidates session attachment and message routing.
 *
 * In SDK mode, messages are sent via ClaudeProcess (Agent SDK query()).
 * In tmux mode (fallback), messages are injected via tmux send-keys.
 */

import { writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { ClaudeProcess, type ClaudeProcessOptions } from "./claude-process.js";
import { getAttachedSession, ATTACHED_SESSION_PATH, listSessions } from "../session/history.js";
import { injectInput, findClaudePane, sendInterrupt } from "../session/tmux.js";
import { log } from "../logger.js";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

export type SessionManagerCallbacks = {
  /** Called for each assistant text block during SDK mode. */
  onAssistantText?: (text: string, model?: string) => Promise<void>;
  /** Called when a turn completes (SDK mode). */
  onComplete?: (result: { text: string; durationMs: number; costUsd: number }) => void;
  /** Called when Claude requests tool permission (SDK mode). */
  onPermission?: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;
  /** Called when compaction starts (SDK mode). */
  onCompactStart?: () => void;
  /** Called when compaction completes (SDK mode). */
  onCompactEnd?: () => void;
};

export class SessionManager {
  private activeProcess: ClaudeProcess | null = null;
  private _attached: { sessionId: string; cwd: string } | null = null;
  private useAgentSdk: boolean;
  private model: string;
  private callbacks: SessionManagerCallbacks;

  constructor(opts: {
    useAgentSdk: boolean;
    model?: string;
    callbacks?: SessionManagerCallbacks;
  }) {
    this.useAgentSdk = opts.useAgentSdk;
    this.model = opts.model ?? "claude-sonnet-4-6";
    this.callbacks = opts.callbacks ?? {};
  }

  get attached(): { sessionId: string; cwd: string } | null {
    return this._attached;
  }

  get isActive(): boolean {
    return this.activeProcess?.isRunning ?? false;
  }

  get isSdkMode(): boolean {
    return this.useAgentSdk;
  }

  /** Load the attached session from disk. */
  async load(): Promise<{ sessionId: string; cwd: string } | null> {
    this._attached = await getAttachedSession();
    return this._attached;
  }

  /** Attach to a session by ID and cwd, persisting to disk. */
  async attach(sessionId: string, cwd: string): Promise<void> {
    // Close any existing SDK process
    this.closeProcess();

    this._attached = { sessionId, cwd };
    await mkdir(`${homedir()}/.codewhispr`, { recursive: true });
    await writeFile(ATTACHED_SESSION_PATH, `${sessionId}\n${cwd}`, "utf8");

    if (this.useAgentSdk) {
      this.activeProcess = new ClaudeProcess({
        cwd,
        model: this.model,
        onPermission: this.callbacks.onPermission,
        onAssistantText: this.callbacks.onAssistantText,
        onComplete: this.callbacks.onComplete,
        onCompactStart: this.callbacks.onCompactStart,
        onCompactEnd: this.callbacks.onCompactEnd,
      });
      this.activeProcess.setSessionId(sessionId);
    }
  }

  /** Detach from the current session. */
  async detach(): Promise<void> {
    this.closeProcess();
    this._attached = null;
    try {
      const { unlink } = await import("fs/promises");
      await unlink(ATTACHED_SESSION_PATH);
    } catch { /* file may not exist */ }
  }

  /** Auto-attach to the most recent session if none is attached. */
  async autoAttach(): Promise<{ sessionId: string; cwd: string } | null> {
    const existing = await this.load();
    if (existing) return existing;

    const recent = await listSessions(1);
    if (recent.length === 0) return null;

    const s = recent[0];
    await this.attach(s.sessionId, s.cwd);
    return this._attached;
  }

  /**
   * Send a message via the appropriate mode.
   *
   * SDK mode: sends via ClaudeProcess.sendMessage() — fires callbacks inline.
   * tmux mode: injects via tmux send-keys, returns injection result.
   *
   * Returns { injected: true } on success, or { injected: false, reason } on failure.
   */
  async sendMessage(
    text: string,
    fallbackPaneId?: string
  ): Promise<{ injected: true } | { injected: false; reason: string }> {
    if (!this._attached) {
      return { injected: false, reason: "No session attached. Use /sessions to pick one." };
    }

    if (this.useAgentSdk) {
      return this.sendViaSdk(text);
    }
    return this.sendViaTmux(text, fallbackPaneId);
  }

  /** Interrupt the current turn (Ctrl+C for tmux, close for SDK). */
  async interrupt(): Promise<void> {
    if (this.useAgentSdk) {
      this.activeProcess?.close();
      // Re-create the process for the next turn
      if (this._attached) {
        this.activeProcess = new ClaudeProcess({
          cwd: this._attached.cwd,
          model: this.model,
          onPermission: this.callbacks.onPermission,
          onAssistantText: this.callbacks.onAssistantText,
          onComplete: this.callbacks.onComplete,
          onCompactStart: this.callbacks.onCompactStart,
          onCompactEnd: this.callbacks.onCompactEnd,
        });
        this.activeProcess.setSessionId(this._attached.sessionId);
      }
      return;
    }

    // tmux mode: send Ctrl+C
    if (!this._attached) return;
    const pane = await findClaudePane(this._attached.cwd);
    if (pane.found) {
      await sendInterrupt(pane.paneId);
    }
  }

  /** Update the model for future turns. */
  setModel(model: string): void {
    this.model = model;
  }

  private async sendViaSdk(text: string): Promise<{ injected: true } | { injected: false; reason: string }> {
    if (!this._attached) {
      return { injected: false, reason: "No session attached." };
    }

    // Ensure we have a process ready
    if (!this.activeProcess) {
      this.activeProcess = new ClaudeProcess({
        cwd: this._attached.cwd,
        model: this.model,
        onPermission: this.callbacks.onPermission,
        onAssistantText: this.callbacks.onAssistantText,
        onComplete: this.callbacks.onComplete,
        onCompactStart: this.callbacks.onCompactStart,
        onCompactEnd: this.callbacks.onCompactEnd,
      });
      this.activeProcess.setSessionId(this._attached.sessionId);
    }

    try {
      await this.activeProcess.sendMessage(text);

      // Update session ID if it changed (new session created)
      const newId = this.activeProcess.sessionId;
      if (newId && newId !== this._attached.sessionId) {
        this._attached.sessionId = newId;
        await writeFile(ATTACHED_SESSION_PATH, `${newId}\n${this._attached.cwd}`, "utf8");
      }

      return { injected: true };
    } catch (err) {
      log({ message: `SDK sendMessage error: ${err instanceof Error ? err.message : String(err)}` });
      return { injected: false, reason: "Failed to send message via SDK." };
    }
  }

  private async sendViaTmux(
    text: string,
    fallbackPaneId?: string
  ): Promise<{ injected: true } | { injected: false; reason: string }> {
    if (!this._attached) {
      return { injected: false, reason: "No session attached." };
    }

    const result = await injectInput(this._attached.cwd, text, fallbackPaneId);
    if (result.found) {
      return { injected: true };
    }
    return { injected: false, reason: "No Claude Code running at this session. Start it, or use /sessions to switch." };
  }

  private closeProcess(): void {
    this.activeProcess?.close();
    this.activeProcess = null;
  }
}
