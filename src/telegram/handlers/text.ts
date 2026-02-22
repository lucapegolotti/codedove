import { Context } from "grammy";
import { SessionManager } from "../../agent/session-manager.js";
import { injectInput, findClaudePane, sendInterrupt } from "../../session/tmux.js";
import { log } from "../../logger.js";
import { ATTACHED_SESSION_PATH, getAttachedSession, listSessions, getLatestSessionFileForCwd } from "../../session/history.js";
import { watchForResponse, getFileSize } from "../../session/monitor.js";
import { notifyResponse, notifyImages, sendPing } from "../notifications.js";
import { sendMarkdownReply } from "../utils.js";
import { launchedPaneId } from "./sessions.js";
import type { SessionResponseState, DetectedImage } from "../../session/monitor.js";
import { pendingImages, pendingImageCount, clearPendingImageCount } from "./callbacks/index.js";
import { InputFile } from "grammy";
import { writeFile, mkdir, readFile } from "fs/promises";
import { homedir } from "os";
import { WatcherManager } from "../../session/watcher-manager.js";
import { notifications } from "../notifications.js";

// Singleton watcher manager — used in tmux mode
export const watcherManager = new WatcherManager(pendingImages);

// SDK session manager — initialized via initSdkMode()
let sessionManager: SessionManager | null = null;

/**
 * Initialize SDK mode. Call from index.ts after loading config.
 * When SDK mode is active, processTextTurn uses the Agent SDK instead of tmux.
 */
export function initSdkMode(config: { useAgentSdk: boolean; model?: string }): void {
  if (!config.useAgentSdk) return;

  sessionManager = new SessionManager({
    useAgentSdk: true,
    model: config.model,
    callbacks: {
      onAssistantText: async (text, model) => {
        const attached = sessionManager?.attached;
        const projectName = attached ? attached.cwd.split("/").pop() ?? "" : "";
        await notifications.sendSdkResponse(text, projectName, model);
      },
      onComplete: (result) => {
        log({ message: `SDK turn complete: ${result.durationMs}ms, $${result.costUsd.toFixed(4)}` });
      },
    },
  });
}

/** Get the session manager (for commands.ts, etc.) */
export function getSessionManager(): SessionManager | null {
  return sessionManager;
}

// Re-export for backwards compatibility with existing consumers
export const snapshotBaseline = (cwd: string) => watcherManager.snapshotBaseline(cwd);
export const startInjectionWatcher = (
  attached: { sessionId: string; cwd: string },
  chatId: number,
  onResponse?: (state: SessionResponseState) => Promise<void>,
  onComplete?: () => void,
  preBaseline?: { filePath: string; sessionId: string; size: number } | null
) => watcherManager.startInjectionWatcher(attached, chatId, onResponse, onComplete, preBaseline);
export function clearActiveWatcher(): void { watcherManager.clear(); }

// Ask Claude Code for image files it created and offer them via the image picker.
// Used by the /images command.
export async function fetchAndOfferImages(cwd: string): Promise<void> {
  const result = await (await import("../../session/tmux.js")).injectInput(
    cwd,
    "List only the absolute file paths of image files you created in this session, one per line. Reply with ONLY the paths, nothing else."
  );
  if (!result.found) return;

  const latest = await getLatestSessionFileForCwd(cwd);
  if (!latest) return;
  const baseline = await getFileSize(latest.filePath);

  await new Promise<void>((resolve) => {
    const stop = watchForResponse(
      latest.filePath,
      baseline,
      async (state) => {
        stop();
        const paths = state.text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^\/\S+\.(png|jpg|jpeg|gif|webp)$/i.test(l));

        const images: DetectedImage[] = [];
        for (const p of paths) {
          try {
            const buf = await readFile(p);
            const ext = p.split(".").pop()!.toLowerCase();
            const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
              : ext === "gif" ? "image/gif"
              : ext === "webp" ? "image/webp"
              : "image/png";
            images.push({ mediaType, data: buf.toString("base64") });
          } catch { /* file not found — skip */ }
        }

        if (images.length > 0) {
          const key = `${Date.now()}`;
          pendingImages.set(key, images);
          await notifyImages(images, key);
        } else {
          await (await import("../notifications.js")).sendPing("No image files found.");
        }
        resolve();
      },
      undefined,
      () => resolve()
    );
    setTimeout(resolve, 30_000);
  });
}

export async function ensureSession(
  ctx: Context,
  chatId: number
): Promise<{ sessionId: string; cwd: string } | null> {
  // SDK mode: use SessionManager.autoAttach
  if (sessionManager?.isSdkMode) {
    const attached = await sessionManager.autoAttach();
    if (attached) {
      // If we just auto-attached, notify the user
      const prev = sessionManager.attached;
      if (!prev || prev.sessionId !== attached.sessionId) {
        const projectName = attached.cwd.split("/").pop() ?? "";
        await ctx.reply(`Auto-attached to \`${projectName}\`.`, { parse_mode: "Markdown" });
      }
      return attached;
    }
    return null;
  }

  // tmux mode: existing logic
  const existing = await getAttachedSession();
  if (existing) return existing;

  const recent = await listSessions(1);
  if (recent.length === 0) return null;

  const s = recent[0];
  await mkdir(`${homedir()}/.codewhispr`, { recursive: true });
  await writeFile(ATTACHED_SESSION_PATH, `${s.sessionId}\n${s.cwd}`, "utf8");
  await ctx.reply(`Auto-attached to \`${s.projectName}\`.`, { parse_mode: "Markdown" });
  return { sessionId: s.sessionId, cwd: s.cwd };
}

export async function processTextTurn(ctx: Context, chatId: number, text: string): Promise<void> {
  // Handle "Part" image count reply
  if (pendingImageCount) {
    const parsed = parseInt(text.trim(), 10);
    if (!isNaN(parsed) && parsed >= 1) {
      const { key, max } = pendingImageCount;
      clearPendingImageCount();
      const n = Math.min(parsed, max);
      const images = pendingImages.get(key);
      if (images) {
        pendingImages.delete(key);
        // Shuffle and pick n at random
        const shuffled = [...images].sort(() => Math.random() - 0.5).slice(0, n);
        for (const img of shuffled) {
          const buf = Buffer.from(img.data, "base64");
          const ext = img.mediaType.split("/")[1] ?? "jpg";
          const file = new InputFile(buf, `image.${ext}`);
          await ctx.replyWithPhoto(file).catch(async () => {
            await ctx.replyWithDocument(file).catch(() => {});
          });
        }
      }
      return;
    }
    // Not a number — fall through to normal message handling
    clearPendingImageCount();
  }

  const attached = await ensureSession(ctx, chatId);

  // SDK mode: send message via Agent SDK — blocks until turn completes
  if (sessionManager?.isSdkMode) {
    if (!attached) {
      await sendMarkdownReply(ctx, "No session found. Use /sessions to pick one.");
      return;
    }

    // Interrupt current turn if the SDK is actively processing
    if (sessionManager.isActive) {
      log({ message: `Interrupting SDK turn for new message` });
      await sessionManager.interrupt();
    }

    await ctx.replyWithChatAction("typing");
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);

    try {
      const result = await sessionManager.sendMessage(text);
      if (!result.injected && "reason" in result) {
        await sendMarkdownReply(ctx, result.reason);
      }
    } finally {
      clearInterval(typingInterval);
    }
    return;
  }

  // tmux mode: existing flow
  if (watcherManager.isActive && attached) {
    const pane = await findClaudePane(attached.cwd);
    if (pane.found) {
      log({ message: `Interrupting Claude Code (Ctrl+C) for new message` });
      watcherManager.stopAndFlush();
      await sendInterrupt(pane.paneId);
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  if (!attached) {
    await sendMarkdownReply(ctx, "No session attached. Use /sessions to pick one.");
    return;
  }

  const preBaseline = await watcherManager.snapshotBaseline(attached.cwd);

  log({ chatId, message: `inject: ${text.slice(0, 80)}` });
  const result = await injectInput(attached.cwd, text, launchedPaneId);

  if (!result.found) {
    const msg = "No Claude Code running at this session. Start it, or use /sessions to switch.";
    log({ chatId, direction: "out", message: msg });
    await sendMarkdownReply(ctx, msg);
    return;
  }

  await ctx.replyWithChatAction("typing");
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);
  await watcherManager.startInjectionWatcher(attached, chatId, undefined, () => clearInterval(typingInterval), preBaseline);
}
