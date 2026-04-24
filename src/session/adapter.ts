import type { TmuxPane } from "./tmux.js";
import type { ToolUseEntry } from "./jsonl.js";

export type LatestSessionFile = { filePath: string; sessionId: string };

export interface SessionAdapter {
  /** Short label for logs and the message prefix ("claude", "codex"). */
  name: string;

  /** Root directory watched for this CLI's transcripts. */
  projectsPath: string;

  /** Whether this adapter can detect images written by the agent (Claude only for now). */
  supportsImageDetection: boolean;

  /** Detect a tmux pane running this CLI. */
  isAgentPane(pane: TmuxPane): boolean;

  /** Find the most recent transcript file for a given working directory. */
  getLatestSessionFileForCwd(cwd: string): Promise<LatestSessionFile | null>;

  /** Extract the latest assistant text (scanning backwards). */
  parseAssistantText(lines: string[]): {
    text: string | null;
    cwd: string | null;
    model: string | undefined;
  };

  /** Detect turn completion (Claude: `result` event; Codex: `task_complete`). */
  findResultEvent(lines: string[]): boolean;

  /** Extract tool_use / exec_command entries with stable IDs. Bash-equivalent only. */
  extractToolUses(lines: string[]): ToolUseEntry[];

  /** Convert a model identifier to a short display name. */
  friendlyModelName(modelId: string | undefined): string;
}
