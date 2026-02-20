import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";

const HOOK_SCRIPT_PATH = join(homedir(), ".claude", "hooks", "claude-voice-stop.sh");
const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

const HOOK_SCRIPT = `#!/bin/bash
# Signals claude-voice bot that Claude has finished a turn.
# Appends a result event to the session JSONL so the bot's watcher
# can fire the voice narration without relying on a silence timeout.

INPUT=$(cat)

STOP_HOOK_ACTIVE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stop_hook_active', False))" 2>/dev/null)
if [ "$STOP_HOOK_ACTIVE" = "True" ]; then
  exit 0
fi

TRANSCRIPT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('transcript_path', ''))" 2>/dev/null)
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  echo '{"type":"result","source":"stop-hook"}' >> "$TRANSCRIPT"
fi

exit 0
`;

export async function isHookInstalled(): Promise<boolean> {
  try {
    const raw = await readFile(CLAUDE_SETTINGS_PATH, "utf8");
    const settings = JSON.parse(raw);
    const stopGroups: { hooks?: { command?: string }[] }[] = settings?.hooks?.Stop ?? [];
    return stopGroups.some((group) =>
      group.hooks?.some((h) => h.command?.includes("claude-voice-stop"))
    );
  } catch {
    return false;
  }
}

export async function installHook(): Promise<void> {
  // Write the hook script
  await mkdir(dirname(HOOK_SCRIPT_PATH), { recursive: true });
  await writeFile(HOOK_SCRIPT_PATH, HOOK_SCRIPT, { mode: 0o755 });

  // Update ~/.claude/settings.json
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(CLAUDE_SETTINGS_PATH, "utf8"));
  } catch {
    // File may not exist yet
  }

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;
  if (!hooks.Stop) hooks.Stop = [];

  const stopGroups = hooks.Stop as { matcher?: string; hooks: { type: string; command: string }[] }[];
  const alreadyInstalled = stopGroups.some((g) =>
    g.hooks?.some((h) => h.command?.includes("claude-voice-stop"))
  );

  if (!alreadyInstalled) {
    if (stopGroups.length > 0) {
      // Add to the existing first group alongside other Stop hooks
      stopGroups[0].hooks.push({ type: "command", command: HOOK_SCRIPT_PATH });
    } else {
      stopGroups.push({ matcher: "", hooks: [{ type: "command", command: HOOK_SCRIPT_PATH }] });
    }
  }

  await mkdir(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  await writeFile(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
