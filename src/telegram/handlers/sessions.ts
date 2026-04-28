import { Context, InlineKeyboard } from "grammy";
import { readSessionLines } from "../../session/history.js";
import { listTmuxPanes } from "../../session/tmux.js";
import { adapterForPane } from "../../session/adapters/index.js";

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
  const allPanes = await listTmuxPanes();

  type ActiveSession = {
    sessionId: string;
    cwd: string;
    projectName: string;
    lastMessage: string;
    cliName: string;
  };
  const sessions: ActiveSession[] = [];
  const seenCwds = new Set<string>();

  for (const pane of allPanes) {
    if (seenCwds.has(pane.cwd)) continue;
    const adapter = adapterForPane(pane);
    if (!adapter) continue;
    seenCwds.add(pane.cwd);

    const found = await adapter.getLatestSessionFileForCwd(pane.cwd);
    if (!found) continue;

    const projectName = pane.cwd.split("/").pop() || pane.cwd;
    const lines = await readSessionLines(found.filePath).catch(() => []);
    // Use the adapter's parser for an accurate last-message preview across CLIs.
    const parsed = adapter.parseAssistantText(lines);
    const preview = (parsed.text ?? "").slice(0, 200).replace(/\n/g, " ");

    sessions.push({
      sessionId: found.sessionId,
      cwd: pane.cwd,
      projectName,
      lastMessage: preview,
      cliName: adapter.name,
    });
  }

  if (sessions.length === 0) {
    await ctx.reply("No active Claude Code or Codex sessions found in tmux.");
    return;
  }

  const keyboard = new InlineKeyboard();
  pendingSessions.clear();
  for (const s of sessions) {
    pendingSessions.set(s.sessionId, s);
    keyboard.text(s.projectName, `session:${s.sessionId}`).row();
  }

  const listLines = sessions.map((s) => {
    const preview = s.lastMessage ? `  "${s.lastMessage}"` : "  (no messages yet)";
    return `• ${s.projectName} (${s.cliName})\n${preview}`;
  });

  await ctx.reply(`Active Claude Code / Codex sessions:\n\n${listLines.join("\n\n")}`, { reply_markup: keyboard });
}
