import { homedir } from "os";
import type { SessionAdapter, LatestSessionFile } from "../adapter.js";
import type { TmuxPane } from "../tmux.js";
import type { ToolUseEntry } from "../jsonl.js";

const CODEX_PROJECTS_PATH = `${homedir()}/.codex/sessions`;
const COMMAND_TRUNCATE_LIMIT = 60;

export class CodexAdapter implements SessionAdapter {
  name = "codex";
  projectsPath = CODEX_PROJECTS_PATH;
  supportsImageDetection = false;

  isAgentPane(pane: TmuxPane): boolean {
    return /codex/i.test(pane.command);
  }

  async getLatestSessionFileForCwd(_cwd: string): Promise<LatestSessionFile | null> {
    // Implemented in Task 4.
    return null;
  }

  parseAssistantText(lines: string[]): {
    text: string | null;
    cwd: string | null;
    model: string | undefined;
  } {
    // Walk backwards to find the latest agent_message, collecting cwd/model
    // from the most recent turn_context. Stop at user_message boundary.
    let text: string | null = null;
    let cwd: string | null = null;
    let model: string | undefined;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "event_msg") {
          const p = entry.payload;
          if (p?.type === "user_message") {
            // crossed a user turn boundary before finding a fresh agent_message
            if (text === null) break;
          }
          if (p?.type === "agent_message" && text === null && typeof p.message === "string") {
            text = p.message;
          }
        }
        if (entry.type === "turn_context" && (cwd === null || model === undefined)) {
          const p = entry.payload;
          if (typeof p?.cwd === "string" && cwd === null) cwd = p.cwd;
          if (typeof p?.model === "string" && model === undefined) model = p.model;
        }
      } catch {
        continue;
      }
    }

    return { text, cwd, model };
  }

  findResultEvent(lines: string[]): boolean {
    return lines.some((line) => {
      try {
        const entry = JSON.parse(line);
        return entry.type === "event_msg" && entry.payload?.type === "task_complete";
      } catch {
        return false;
      }
    });
  }

  extractToolUses(lines: string[]): ToolUseEntry[] {
    const result: ToolUseEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "event_msg") continue;
        const p = entry.payload;
        if (p?.type !== "exec_command_end") continue;
        if (typeof p.call_id !== "string") continue;
        const cmd = pickCommandString(p.command);
        const truncated =
          cmd.length > COMMAND_TRUNCATE_LIMIT
            ? cmd.slice(0, COMMAND_TRUNCATE_LIMIT - 3) + "..."
            : cmd;
        result.push({ id: p.call_id, name: "Bash", command: truncated });
      } catch {
        continue;
      }
    }
    return result;
  }

  friendlyModelName(modelId: string | undefined): string {
    return modelId ?? "codex";
  }
}

// Codex's command is usually ["/bin/zsh", "-lc", "<actual command>"]. The actual
// command is the last element. If the array doesn't match that pattern, fall back
// to joining all tokens.
function pickCommandString(command: unknown): string {
  if (!Array.isArray(command)) return "";
  const lcIndex = command.indexOf("-lc");
  if (lcIndex !== -1 && lcIndex < command.length - 1) {
    const payload = command[lcIndex + 1];
    if (typeof payload === "string") return payload;
  }
  return command.filter((t) => typeof t === "string").join(" ");
}
