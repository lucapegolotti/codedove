import { Box, Text, useApp, useInput } from "ink";
import { useState, useEffect, useRef } from "react";
import type { Bot } from "grammy";
import { StatusBar } from "./StatusBar.js";
import { KeyBar } from "./KeyBar.js";
import { LogPane } from "./LogPane.js";
import { SessionPane } from "./SessionPane.js";
import { createBot } from "../telegram/bot.js";
import { clearLogs } from "../logger.js";
import { sendStartupMessage } from "../telegram/notifications.js";
import { isHookInstalled, installHook } from "../hooks/install.js";

type Status = "running" | "stopped";
type HookStatus = "unknown" | "installed" | "missing" | "installing";
type Props = { token: string };

export function Dashboard({ token }: Props) {
  const { exit } = useApp();
  const [status, setStatus] = useState<Status>("stopped");
  const [hookStatus, setHookStatus] = useState<HookStatus>("unknown");
  const botRef = useRef<Bot | null>(null);

  function start() {
    if (botRef.current) return;
    const bot = createBot(token);
    bot.catch(() => setStatus("stopped"));
    botRef.current = bot;
    bot.start({ onStart: () => {
      setStatus("running");
      sendStartupMessage(bot).catch(() => {});
    }}).catch(() => setStatus("stopped"));
  }

  async function stop() {
    if (!botRef.current) return;
    await botRef.current.stop();
    botRef.current = null;
    setStatus("stopped");
  }

  useEffect(() => {
    start();
    isHookInstalled().then((installed) => setHookStatus(installed ? "installed" : "missing"));
    return () => { stop(); };
  }, []);

  useInput((input) => {
    if (input === "q") stop().then(() => exit()).catch(() => exit());
    if (input === "s" && status === "stopped") start();
    if (input === "x" && status === "running") stop();
    if (input === "r") stop().then(() => start()).catch(() => {});
    if (input === "c") clearLogs();
    if (input === "i" && hookStatus === "missing") {
      setHookStatus("installing");
      installHook()
        .then(() => setHookStatus("installed"))
        .catch(() => setHookStatus("missing"));
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar status={status} />
      {hookStatus === "missing" && (
        <Box paddingX={1} backgroundColor="yellow">
          <Text color="black">⚠ Claude Code stop hook not installed — voice narration will be delayed.  [i] install</Text>
        </Box>
      )}
      {hookStatus === "installing" && (
        <Box paddingX={1}>
          <Text color="yellow">Installing Claude Code stop hook…</Text>
        </Box>
      )}
      {hookStatus === "installed" && (
        <Box paddingX={1}>
          <Text color="green">✓ Claude Code stop hook installed</Text>
        </Box>
      )}
      <Box flexGrow={1} borderStyle="single">
        <LogPane />
        <Box borderStyle="single" width={24}>
          <SessionPane />
        </Box>
      </Box>
      <KeyBar status={status} hookStatus={hookStatus} />
    </Box>
  );
}
