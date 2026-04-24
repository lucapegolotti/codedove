import type { SessionAdapter } from "../adapter.js";
import type { TmuxPane } from "../tmux.js";
import { ClaudeCodeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";

export const adapters: SessionAdapter[] = [
  new ClaudeCodeAdapter(),
  new CodexAdapter(),
];

/** Pick the first adapter that recognises this pane, or null. */
export function adapterForPane(pane: TmuxPane): SessionAdapter | null {
  for (const adapter of adapters) {
    if (adapter.isAgentPane(pane)) return adapter;
  }
  return null;
}

/** Pick an adapter for a cwd by trying each one's getLatestSessionFileForCwd. */
export async function adapterForCwd(cwd: string): Promise<{ adapter: SessionAdapter; file: { filePath: string; sessionId: string } } | null> {
  for (const adapter of adapters) {
    const file = await adapter.getLatestSessionFileForCwd(cwd);
    if (file) return { adapter, file };
  }
  return null;
}
