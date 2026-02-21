import { Context, InlineKeyboard } from "grammy";
import { getLatestSessionFileForCwd, parseJsonlLines, readSessionLines } from "../../session/history.js";
import { listTmuxPanes, isClaudePane } from "../../session/tmux.js";

export const pendingSessions = new Map<string, { sessionId: string; cwd: string; projectName: string }>();

export let launchedPaneId: string | undefined;

export function setLaunchedPaneId(id: string | undefined): void {
  launchedPaneId = id;
}

export function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds <= 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export async function sendSessionPicker(ctx: Context): Promise<void> {
  // Only show sessions that have a Claude Code process actively running in tmux
  const allPanes = await listTmuxPanes();
  const claudePanes = allPanes.filter(isClaudePane);

  if (claudePanes.length === 0) {
    await ctx.reply("No active Claude Code sessions found in tmux.");
    return;
  }

  // Deduplicate by cwd — if multiple panes share a cwd, keep the first one
  const seenCwds = new Set<string>();
  const uniquePanes = claudePanes.filter((p) => {
    if (seenCwds.has(p.cwd)) return false;
    seenCwds.add(p.cwd);
    return true;
  });

  // For each pane, find the latest session JSONL and read its metadata
  type ActiveSession = { sessionId: string; cwd: string; projectName: string; lastMessage: string };
  const sessions: ActiveSession[] = [];

  for (const pane of uniquePanes) {
    const found = await getLatestSessionFileForCwd(pane.cwd);
    if (!found) continue;

    const projectName = pane.cwd.split("/").pop() || pane.cwd;
    const lines = await readSessionLines(found.filePath).catch(() => []);
    const parsed = parseJsonlLines(lines);

    sessions.push({
      sessionId: found.sessionId,
      cwd: pane.cwd,
      projectName,
      lastMessage: parsed.lastMessage,
    });
  }

  if (sessions.length === 0) {
    await ctx.reply("No active Claude Code sessions found in tmux.");
    return;
  }

  const keyboard = new InlineKeyboard();
  pendingSessions.clear();
  for (const s of sessions) {
    pendingSessions.set(s.sessionId, s);
    keyboard.text(s.projectName, `session:${s.sessionId}`).row();
  }

  const lines = sessions.map((s) => {
    const preview = s.lastMessage ? `  "${s.lastMessage}"` : "  (no messages yet)";
    return `• ${s.projectName}\n${preview}`;
  });

  await ctx.reply(`Active Claude Code sessions:\n\n${lines.join("\n\n")}`, { reply_markup: keyboard });
}
