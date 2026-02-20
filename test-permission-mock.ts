#!/usr/bin/env tsx
/**
 * Mock test for the permission hook flow.
 * Simulates the full cycle without needing actual Claude Code or Telegram:
 *
 *   1. Runs the installed hook script with fake JSON input
 *   2. The script writes a permission-request-*.json file
 *   3. We poll the bot log until the notification line appears
 *   4. We simulate a Telegram "approve" by writing the response file
 *   5. We capture the hook script exit code and verify it is 0 (approve)
 *
 * Usage:  tsx test-permission-mock.ts [approve|deny]
 */

import { spawn } from "child_process";
import { readFile, writeFile, mkdir, readdir, unlink } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const CLAUDE_VOICE_DIR = join(homedir(), ".claude-voice");
const HOOK_SCRIPT = join(homedir(), ".claude/hooks/claude-voice-permission.sh");
const BOT_LOG = join(CLAUDE_VOICE_DIR, "bot.log");
const CURRENT_JSONL = "/Users/luca/.claude/projects/-Users-luca-repositories-claude-voice/ea80932f-9eb4-4f26-b1ed-ee2168208c8c.jsonl";

const action = (process.argv[2] as "approve" | "deny") ?? "approve";

const FAKE_INPUT = JSON.stringify({
  session_id: "test-session-mock",
  transcript_path: CURRENT_JSONL,
  cwd: "/Users/luca/repositories/claude-voice",
  hook_event_name: "Notification",
  message: "Claude needs your permission to use Bash",
  notification_type: "permission_prompt",
});

async function getLogSize(): Promise<number> {
  try {
    const { size } = await import("fs").then((fs) =>
      new Promise<{ size: number }>((res, rej) =>
        fs.stat(BOT_LOG, (e, s) => (e ? rej(e) : res(s)))
      )
    );
    return size;
  } catch {
    return 0;
  }
}

async function waitForLogLine(marker: string, baselineSize: number, timeoutMs = 15000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const content = await readFile(BOT_LOG, "utf8");
      const newContent = content.slice(baselineSize);
      const line = newContent.split("\n").find((l) => l.includes(marker));
      if (line) return line;
    } catch { /* retry */ }
  }
  return null;
}

async function findRequestFile(): Promise<string | null> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const files = await readdir(CLAUDE_VOICE_DIR);
      const req = files.find((f) => f.startsWith("permission-request-") && f.endsWith(".json"));
      if (req) return join(CLAUDE_VOICE_DIR, req);
    } catch { /* retry */ }
  }
  return null;
}

async function main() {
  console.log(`\n=== Permission Hook Mock Test (action: ${action}) ===\n`);

  // Snapshot log size before starting
  const baselineSize = await getLogSize();
  console.log(`[1] Bot log baseline: ${baselineSize} bytes`);

  // Run the hook script with fake input
  console.log("[2] Spawning hook script...");
  const hook = spawn("bash", [HOOK_SCRIPT], { stdio: ["pipe", "inherit", "inherit"] });
  hook.stdin!.write(FAKE_INPUT);
  hook.stdin!.end();

  let exitCode: number | null = null;
  hook.on("exit", (code) => { exitCode = code; });

  // Wait for the request file to appear
  console.log("[3] Waiting for permission-request-*.json...");
  const reqFile = await findRequestFile();
  if (!reqFile) {
    console.error("FAIL: request file never appeared");
    hook.kill();
    process.exit(1);
  }
  // Wait briefly for the write to complete before reading
  await new Promise((r) => setTimeout(r, 300));
  const reqData = JSON.parse(await readFile(reqFile, "utf8"));
  console.log(`     requestId: ${reqData.requestId}`);
  console.log(`     toolName:  ${reqData.toolName}`);
  console.log(`     toolInput: ${reqData.toolInput}`);
  console.log(`     transcriptPath: ${reqData.transcriptPath || "(none)"}`);

  // Wait for the bot notification log line (5s timeout; bot may not be running in unit-test mode)
  console.log("[4] Waiting for bot to log permission notification (5s)...");
  const logLine = await waitForLogLine(`permission notification:`, baselineSize, 5000);
  if (logLine) {
    console.log(`     ✓ ${logLine.trim()}`);
  } else {
    console.log("     (no bot notification — is the bot running?)");
  }

  // Simulate user tapping the button by writing the response file
  await new Promise((r) => setTimeout(r, 500));
  const responsePath = join(CLAUDE_VOICE_DIR, `permission-response-${reqData.requestId}`);
  console.log(`[5] Writing response: ${action}`);
  await writeFile(responsePath, action, "utf8");

  // Wait for the hook script to exit
  console.log("[6] Waiting for hook script to exit...");
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (exitCode !== null) { clearInterval(check); resolve(); }
    }, 100);
    setTimeout(() => { clearInterval(check); resolve(); }, 10000);
  });

  if (exitCode === null) {
    console.error("FAIL: hook script did not exit within 10s after response was written");
    hook.kill();
    process.exit(1);
  }

  const expectedCode = action === "approve" ? 0 : 2;
  if (exitCode === expectedCode) {
    console.log(`\n✅ PASS: hook exited with code ${exitCode} (expected ${expectedCode})`);
  } else {
    console.error(`\n❌ FAIL: hook exited with code ${exitCode} (expected ${expectedCode})`);
    process.exit(1);
  }

  // Show what the bot would have notified
  console.log("\n[7] Checking bot log for permission response...");
  const respLine = await waitForLogLine(`permission response:`, baselineSize, 5000);
  if (respLine) console.log(`     ✓ ${respLine.trim()}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
