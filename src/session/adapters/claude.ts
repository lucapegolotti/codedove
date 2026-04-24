import type { SessionAdapter, LatestSessionFile } from "../adapter.js";
import type { TmuxPane } from "../tmux.js";
import { isClaudePane } from "../tmux.js";
import { PROJECTS_PATH, getLatestSessionFileForCwd } from "../history.js";
import {
  parseAssistantText,
  findResultEvent,
  extractToolUses,
  type ToolUseEntry,
} from "../jsonl.js";
import { friendlyModelName } from "../../telegram/notifications.js";

export class ClaudeCodeAdapter implements SessionAdapter {
  name = "claude";
  projectsPath = PROJECTS_PATH;
  supportsImageDetection = true;

  isAgentPane(pane: TmuxPane): boolean {
    return isClaudePane(pane);
  }

  async getLatestSessionFileForCwd(cwd: string): Promise<LatestSessionFile | null> {
    return getLatestSessionFileForCwd(cwd);
  }

  parseAssistantText(lines: string[]) {
    return parseAssistantText(lines);
  }

  findResultEvent(lines: string[]): boolean {
    return findResultEvent(lines);
  }

  extractToolUses(lines: string[]): ToolUseEntry[] {
    return extractToolUses(lines);
  }

  friendlyModelName(modelId: string | undefined): string {
    if (!modelId) return "claude";
    return friendlyModelName(modelId);
  }
}
