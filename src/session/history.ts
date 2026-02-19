import { createReadStream } from "fs";
import { createInterface } from "readline";
import { readdir, readFile, stat } from "fs/promises";
import { homedir } from "os";

export const PROJECTS_PATH = `${homedir()}/.claude/projects`;
export const ATTACHED_SESSION_PATH = `${homedir()}/.claude-voice/attached`;

export type SessionInfo = {
  sessionId: string;
  cwd: string;
  projectName: string;
  lastMessage: string;
  mtime: Date;
};

export type ToolCall = {
  name: string;
  input: Record<string, unknown>;
};

export type ParsedSession = {
  cwd: string;
  lastMessage: string;
  toolCalls: ToolCall[];
  allMessages: string[];
};

const WAITING_PATTERNS = [
  /press\s+enter/i,
  /\(y\/n\)/i,
  /\[y\/N\]/i,
  /confirm\?/i,
  /provide\s+(your\s+)?input/i,
  /waiting\s+for\s+(user\s+)?input/i,
];

export function extractWaitingPrompt(text: string): string | null {
  const trimmed = text.trim();
  const endsWithQuestion = /\?\s*$/.test(trimmed);
  const endsWithPrompt = /[>:]\s*$/.test(trimmed);
  const matchesPattern = WAITING_PATTERNS.some((p) => p.test(trimmed));

  if (matchesPattern || endsWithQuestion || endsWithPrompt) {
    return trimmed;
  }
  return null;
}

export function parseJsonlLines(lines: string[]): ParsedSession {
  let cwd = homedir();
  let lastMessage = "";
  const toolCalls: ToolCall[] = [];
  const allMessages: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "assistant") {
        if (entry.cwd && cwd === homedir()) cwd = entry.cwd;
        const content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> =
          entry.message?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text) {
            lastMessage = block.text.slice(0, 200).replace(/\n/g, " ");
            allMessages.push(block.text);
          }
          if (block.type === "tool_use" && block.name) {
            toolCalls.push({ name: block.name, input: block.input ?? {} });
          }
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  return { cwd, lastMessage, toolCalls, allMessages };
}

export async function readSessionLines(filePath: string): Promise<string[]> {
  const lines: string[] = [];
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lines.push(line);
    }
  } finally {
    rl.close();
  }
  return lines;
}

export async function listSessions(limit = 5): Promise<SessionInfo[]> {
  const results: SessionInfo[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(PROJECTS_PATH);
  } catch {
    return [];
  }

  for (const dir of projectDirs) {
    const dirPath = `${PROJECTS_PATH}/${dir}`;
    let files: string[];
    try {
      files = (await readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      const filePath = `${dirPath}/${file}`;

      let mtime: Date;
      try {
        mtime = (await stat(filePath)).mtime;
      } catch {
        continue;
      }

      const encoded = dir.replace(/^-/, "").replace(/-/g, "/");
      const projectName = encoded.split("/").pop() || dir;

      const lines = await readSessionLines(filePath).catch(() => []);
      const parsed = parseJsonlLines(lines);

      results.push({
        sessionId,
        cwd: parsed.cwd,
        projectName,
        lastMessage: parsed.lastMessage,
        mtime,
      });
    }
  }

  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results.slice(0, limit);
}

export async function getAttachedSession(): Promise<{ sessionId: string; cwd: string } | null> {
  try {
    const content = await readFile(ATTACHED_SESSION_PATH, "utf8");
    const [sessionId, cwd] = content.trim().split("\n");
    if (!sessionId) return null;
    return { sessionId, cwd: cwd || homedir() };
  } catch {
    return null;
  }
}

export async function getSessionFilePath(sessionId: string): Promise<string | null> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(PROJECTS_PATH);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = `${PROJECTS_PATH}/${dir}/${sessionId}.jsonl`;
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
