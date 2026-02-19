import { query } from "@anthropic-ai/claude-agent-sdk";
import { narrate } from "./narrator.js";
import { log } from "./logger.js";
import { homedir } from "os";

const sessions = new Map<number, string>();

const SYSTEM_PROMPT = `You are a coding assistant accessed via Telegram.
When the user mentions a project by name, look for it in ${homedir()}/repositories/.
If the project directory is ambiguous, ask the user to clarify.
Keep responses concise.`;

export function getActiveSessions(): number[] {
  return [...sessions.keys()];
}

export async function runAgentTurn(chatId: number, userMessage: string): Promise<string> {
  const existingSessionId = sessions.get(chatId);

  if (!existingSessionId) {
    log({ chatId, message: "starting new session" });
  }

  let result = "";
  let capturedSessionId: string | undefined;

  for await (const message of query({
    prompt: userMessage,
    options: {
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      permissionMode: "acceptEdits",
      cwd: homedir(),
      ...(existingSessionId
        ? { resume: existingSessionId }
        : { systemPrompt: SYSTEM_PROMPT }),
    },
  })) {
    if (message.type === "system" && message.subtype === "init" && !existingSessionId) {
      capturedSessionId = message.session_id;
    }
    if (message.type === "result" && message.subtype === "success") {
      result = message.result;
    }
    if (message.type === "result" && message.subtype !== "success") {
      throw new Error(`Agent error (${message.subtype})`);
    }
  }

  if (capturedSessionId) {
    sessions.set(chatId, capturedSessionId);
    log({ chatId, message: "session established" });
  }

  return narrate(result || "The agent completed the task but produced no output.");
}
