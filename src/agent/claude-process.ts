/**
 * Manages Claude Code turns via the Agent SDK V1 query() API.
 *
 * Each sendMessage() call spawns a per-turn subprocess with `resume` to
 * continue the conversation. The V1 API is used instead of V2 because
 * it supports the `cwd` option for setting the working directory.
 *
 * JSONL transcripts are persisted by default (persistSession: true).
 */

import {
  query as sdkQuery,
  type SDKMessage,
  type Options as SDKOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";

export type ClaudeProcessOptions = {
  cwd: string;
  model?: string;
  /** Called when Claude requests tool permission. Return allow/deny. */
  onPermission?: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;
  /** Called for each assistant message (text block). */
  onAssistantText?: (text: string, model?: string) => Promise<void>;
  /** Called when the turn completes (result event). */
  onComplete?: (result: { text: string; durationMs: number; costUsd: number }) => void;
  /** Called when compaction starts. */
  onCompactStart?: () => void;
  /** Called when compaction completes. */
  onCompactEnd?: () => void;
};

export class ClaudeProcess {
  private options: ClaudeProcessOptions;
  private _sessionId: string | null = null;
  private closed = false;
  private activeClose: (() => void) | null = null;

  constructor(options: ClaudeProcessOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.activeClose !== null && !this.closed;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  /**
   * Send a user message and process the full turn.
   *
   * Spawns a Claude Code subprocess via query(). If a sessionId is already
   * known (from a previous turn), the session is resumed so Claude sees
   * the full conversation history.
   *
   * Resolves when the turn completes (result event received).
   */
  async sendMessage(text: string): Promise<void> {
    if (this.closed) throw new Error("Process is closed");

    const canUseTool: CanUseTool | undefined = this.options.onPermission
      ? async (toolName, input, _opts) => {
          return this.options.onPermission!(toolName, input);
        }
      : undefined;

    const opts: SDKOptions = {
      cwd: this.options.cwd,
      model: this.options.model ?? "claude-sonnet-4-6",
      canUseTool,
      env: { ...process.env, CLAUDECODE: undefined },
    };

    if (this._sessionId) {
      opts.resume = this._sessionId;
    }

    const q = sdkQuery({ prompt: text, options: opts });
    this.activeClose = () => q.close();

    try {
      for await (const msg of q) {
        if (this.closed) break;
        this.captureSessionId(msg);
        await this.handleMessage(msg);
      }
    } catch (err) {
      if (!this.closed) {
        log({ message: `ClaudeProcess query error: ${err instanceof Error ? err.message : String(err)}` });
      }
    } finally {
      this.activeClose = null;
    }
  }

  /** Attach to an existing session (e.g. from the attached-session file). */
  setSessionId(sessionId: string): void {
    this._sessionId = sessionId;
  }

  /** Close the active query and prevent further messages. */
  close(): void {
    this.closed = true;
    this.activeClose?.();
    this.activeClose = null;
  }

  /** Extract session_id from any message that carries it. */
  private captureSessionId(msg: SDKMessage): void {
    if (this._sessionId) return;
    if ("session_id" in msg && typeof msg.session_id === "string") {
      this._sessionId = msg.session_id;
    }
  }

  private async handleMessage(msg: SDKMessage): Promise<void> {
    switch (msg.type) {
      case "assistant": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type === "text" && block.text?.trim()) {
            await this.options.onAssistantText?.(
              block.text,
              (msg.message as Record<string, unknown>)?.model as string | undefined,
            );
          }
        }
        break;
      }

      case "result": {
        const resultText = "result" in msg && typeof msg.result === "string" ? msg.result : "";
        this.options.onComplete?.({
          text: resultText,
          durationMs: "duration_ms" in msg ? (msg.duration_ms as number) : 0,
          costUsd: "total_cost_usd" in msg ? (msg.total_cost_usd as number) : 0,
        });
        break;
      }

      case "system": {
        if ("subtype" in msg) {
          if (msg.subtype === "status" && "status" in msg) {
            if (msg.status === "compacting") {
              this.options.onCompactStart?.();
            } else if (msg.status === null) {
              this.options.onCompactEnd?.();
            }
          }
        }
        break;
      }
    }
  }
}
