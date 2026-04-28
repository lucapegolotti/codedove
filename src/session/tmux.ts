import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export type TmuxPane = {
  paneId: string;
  shellPid: number; // #{pane_pid} — the shell process in the pane
  command: string;
  cwd: string;
  // Full command line of the foreground child process (e.g. "node /path/to/codex --yolo"),
  // resolved by walking the shell PID's children. Used to detect CLIs (like Codex) that
  // run via a node wrapper, where #{pane_current_command} is "node" not the CLI name.
  commandLine?: string;
};

export type TmuxResult =
  | { found: true; paneId: string }
  | { found: false; reason: "no_tmux" | "no_claude_pane" | "ambiguous"; panes?: TmuxPane[] };

// Claude Code sets process.title to its version string (e.g. "2.1.47"), not "claude"
export function isClaudePane(p: TmuxPane): boolean {
  return p.command.includes("claude") || /^\d+\.\d+\.\d+/.test(p.command);
}

// Returns the start time (ms) of the claude child process inside a pane's shell.
// Used to pick the most recently started session when multiple panes share a cwd.
async function getClaudeChildStartTime(shellPid: number): Promise<number> {
  try {
    const { stdout: childOut } = await execAsync(
      `ps -A -o pid= -o ppid= | awk '$2 == ${shellPid} {print $1}'`
    );
    const childPid = childOut.trim();
    if (!childPid) return 0;
    const { stdout: startOut } = await execAsync(`ps -p ${childPid} -o lstart=`);
    return new Date(startOut.trim()).getTime();
  } catch {
    return 0;
  }
}

// Predicate for "this pane runs an agent CLI" (Claude Code or Codex). Defaults to
// matching either, but callers can pass a custom predicate to scope the search.
export function findBestPane(
  panes: TmuxPane[],
  targetCwd: string,
  isAgent: (p: TmuxPane) => boolean = (p) => isClaudePane(p) || /codex/i.test(p.command) || (p.commandLine ? /codex/i.test(p.commandLine) : false)
): TmuxPane[] {
  const agentPanes = panes.filter(isAgent);
  if (agentPanes.length === 0) return [];

  const exact = agentPanes.filter((p) => p.cwd === targetCwd);
  if (exact.length > 0) return exact;

  const parents = agentPanes.filter((p) => targetCwd.startsWith(p.cwd + "/"));
  return parents;
}

export async function listTmuxPanes(): Promise<TmuxPane[]> {
  try {
    const { stdout } = await execAsync(
      "tmux list-panes -a -F '#{pane_id} #{pane_pid} #{pane_current_command} #{pane_current_path}'"
    );
    const panes = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line): TmuxPane => {
        const parts = line.split(" ");
        const paneId = parts[0];
        const shellPid = parseInt(parts[1], 10) || 0;
        const command = parts[2];
        const cwd = parts.slice(3).join(" "); // handle spaces in paths
        return { paneId, shellPid, command, cwd };
      });

    // Enrich with full command line of each shell's child process via a single ps call.
    // This lets adapters detect CLIs that run via a node/bun wrapper (e.g. Codex), where
    // pane_current_command is "node" rather than the CLI name.
    try {
      const { stdout: psOut } = await execAsync("ps -A -o pid=,ppid=,command=");
      const childByPpid = new Map<number, string>();
      for (const line of psOut.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        const ppid = parseInt(m[2], 10);
        const cmd = m[3];
        // Keep first child encountered per ppid — fine for our purposes since panes
        // typically have one foreground child.
        if (!childByPpid.has(ppid)) childByPpid.set(ppid, cmd);
      }
      for (const pane of panes) {
        const child = childByPpid.get(pane.shellPid);
        if (child) pane.commandLine = child;
      }
    } catch {
      // ignore — commandLine stays undefined and adapters fall back to `command`
    }

    return panes;
  } catch {
    return [];
  }
}

export async function findClaudePane(targetCwd: string): Promise<TmuxResult> {
  let panes: TmuxPane[];
  try {
    panes = await listTmuxPanes();
  } catch {
    return { found: false, reason: "no_tmux" };
  }

  if (panes.length === 0) return { found: false, reason: "no_tmux" };

  const candidates = findBestPane(panes, targetCwd);

  if (candidates.length === 1) {
    return { found: true, paneId: candidates[0].paneId };
  }

  if (candidates.length > 1) {
    // Multiple panes at same cwd — pick the one with the most recently started claude process
    const withTimes = await Promise.all(
      candidates.map(async (p) => ({ pane: p, startTime: await getClaudeChildStartTime(p.shellPid) }))
    );
    const best = withTimes.reduce((a, b) => (b.startTime > a.startTime ? b : a));
    return { found: true, paneId: best.pane.paneId };
  }

  // No cwd match — fall back to any single agent pane (Claude or Codex)
  const isAgent = (p: TmuxPane) =>
    isClaudePane(p) || /codex/i.test(p.command) || (p.commandLine ? /codex/i.test(p.commandLine) : false);
  const agentPanes = panes.filter(isAgent);
  if (agentPanes.length === 0) return { found: false, reason: "no_claude_pane" };
  if (agentPanes.length > 1) return { found: false, reason: "ambiguous", panes: agentPanes };

  return { found: true, paneId: agentPanes[0].paneId };
}

export async function sendKeysToPane(paneId: string, input: string): Promise<void> {
  // Escape single quotes in input for shell safety
  const safe = input.replace(/'/g, "'\\''");
  // Send text and Enter separately with a small delay — sending them together in one
  // tmux send-keys call causes Enter to fire before Claude Code finishes processing
  // the typed text, resulting in the text appearing but not being submitted.
  await execAsync(`tmux send-keys -t '${paneId}' '${safe}'`);
  await new Promise((r) => setTimeout(r, 100));
  await execAsync(`tmux send-keys -t '${paneId}' Enter`);
}

// Send a named tmux key (e.g. "Escape", "q") without appending Enter.
export async function sendRawKeyToPane(paneId: string, key: string): Promise<void> {
  await execAsync(`tmux send-keys -t '${paneId}' '${key}'`);
}

export async function sendInterrupt(paneId: string): Promise<void> {
  // C-c must be unquoted so tmux interprets it as the Ctrl+C control sequence
  await execAsync(`tmux send-keys -t '${paneId}' C-c`);
}

export async function injectInput(
  targetCwd: string,
  input: string,
  fallbackPaneId?: string
): Promise<TmuxResult> {
  const result = await findClaudePane(targetCwd);
  if (result.found) {
    await sendKeysToPane(result.paneId, input);
    return result;
  }
  // Claude Code may still be starting up — use the known launched pane if provided
  if (fallbackPaneId) {
    await sendKeysToPane(fallbackPaneId, input);
    return { found: true, paneId: fallbackPaneId };
  }
  return result;
}

// Sanitize a string for use as a tmux window name (no dots, colons, or spaces)
function sanitizeWindowName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 30);
}

export async function launchClaudeInWindow(
  cwd: string,
  projectName: string,
  skipPermissions: boolean
): Promise<string> {
  const winName = sanitizeWindowName(projectName);
  // Create a new window and capture its pane ID
  const { stdout } = await execAsync(
    `tmux new-window -c '${cwd.replace(/'/g, "'\\''")}' -n '${winName}' -P -F '#{pane_id}'`
  );
  const paneId = stdout.trim();
  const cmd = skipPermissions
    ? "claude -c --dangerously-skip-permissions"
    : "claude -c";
  await sendKeysToPane(paneId, cmd);
  return paneId;
}

export async function killWindow(target: string): Promise<void> {
  // tmux resolves a pane or window target to the containing window
  await execAsync(`tmux kill-window -t '${target}'`);
}

export async function capturePaneContent(paneId: string): Promise<string> {
  const { stdout } = await execAsync(`tmux capture-pane -p -t '${paneId}'`);
  return stdout;
}
