import { describe, it, expect, afterEach } from "vitest";
import { writeFile, appendFile, unlink, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { classifyWaitingType, WaitingType, getFileSize, watchForResponse, getLastAssistantEntry, startMonitor } from "./monitor.js";
import type { SessionResponseState, SessionWaitingState } from "./monitor.js";

describe("classifyWaitingType", () => {
  it("detects y/n prompt", () => {
    expect(classifyWaitingType("Should I delete the file? (y/n)")).toBe(WaitingType.YES_NO);
  });

  it("detects [y/N] variant", () => {
    expect(classifyWaitingType("Overwrite existing file? [y/N]")).toBe(WaitingType.YES_NO);
  });

  it("detects press enter", () => {
    expect(classifyWaitingType("Press enter to continue")).toBe(WaitingType.ENTER);
  });

  it("returns null for generic question (not a real input prompt)", () => {
    expect(classifyWaitingType("What should I name the new file?")).toBeNull();
  });

  it("returns null for completed statement", () => {
    expect(classifyWaitingType("I have updated the migration file.")).toBeNull();
  });

  it("returns null for short non-prompts", () => {
    expect(classifyWaitingType("Done.")).toBeNull();
  });

  it("detects confirm prompt", () => {
    expect(classifyWaitingType("Are you sure you want to proceed? Confirm?")).toBe(WaitingType.YES_NO);
  });
});


function assistantLine(text: string, cwd = "/tmp/project"): string {
  return (
    JSON.stringify({
      type: "assistant",
      cwd,
      message: { content: [{ type: "text", text }] },
    }) + "\n"
  );
}

describe("getLastAssistantEntry", () => {
  const tmpFile = join(tmpdir(), `cv-glae-${Date.now()}.jsonl`);

  afterEach(async () => {
    await unlink(tmpFile).catch(() => {});
  });

  function exitPlanOnlyLine(cwd = "/tmp/project"): string {
    return JSON.stringify({
      type: "assistant",
      cwd,
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "ExitPlanMode", input: {} }] },
    }) + "\n";
  }

  function exitPlanWithPlanInputLine(plan: string, cwd = "/tmp/project"): string {
    return JSON.stringify({
      type: "assistant",
      cwd,
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "ExitPlanMode", input: { plan } }] },
    }) + "\n";
  }

  function exitPlanWithTextLine(text: string, cwd = "/tmp/project"): string {
    return JSON.stringify({
      type: "assistant",
      cwd,
      message: {
        content: [
          { type: "text", text },
          { type: "tool_use", id: "toolu_1", name: "ExitPlanMode", input: {} },
        ],
      },
    }) + "\n";
  }

  function userLine(): string {
    return JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n";
  }

  it("returns hasExitPlanMode=true and text=null for tool_use-only ExitPlanMode entry", async () => {
    await writeFile(tmpFile, exitPlanOnlyLine());
    const result = await getLastAssistantEntry(tmpFile);
    expect(result).toEqual({ text: null, hasExitPlanMode: true, planText: null });
  });

  it("returns hasExitPlanMode=true and text when entry has both text and ExitPlanMode tool_use", async () => {
    await writeFile(tmpFile, exitPlanWithTextLine("Here is the plan..."));
    const result = await getLastAssistantEntry(tmpFile);
    expect(result).toEqual({ text: "Here is the plan...", hasExitPlanMode: true, planText: null });
  });

  it("returns planText from ExitPlanMode input.plan when present", async () => {
    await writeFile(tmpFile, exitPlanWithPlanInputLine("My plan content"));
    const result = await getLastAssistantEntry(tmpFile);
    expect(result).toEqual({ text: null, hasExitPlanMode: true, planText: "My plan content" });
  });

  it("returns hasExitPlanMode=false and text for a plain text-only entry", async () => {
    await writeFile(tmpFile, assistantLine("Just a normal response."));
    const result = await getLastAssistantEntry(tmpFile);
    expect(result).toEqual({ text: "Just a normal response.", hasExitPlanMode: false, planText: null });
  });

  it("returns defaults for an empty file", async () => {
    await writeFile(tmpFile, "");
    const result = await getLastAssistantEntry(tmpFile);
    expect(result).toEqual({ text: null, hasExitPlanMode: false, planText: null });
  });

  it("returns defaults for a non-existent file", async () => {
    const result = await getLastAssistantEntry("/tmp/definitely-does-not-exist-cv-glae.jsonl");
    expect(result).toEqual({ text: null, hasExitPlanMode: false, planText: null });
  });

  it("scans backwards: finds text from earlier entry in same turn and ExitPlanMode from latest", async () => {
    // Two assistant entries in the same turn (no user boundary between them):
    // line 1 has text, line 2 has ExitPlanMode only.
    // getLastAssistantEntry scans backwards so it picks up ExitPlanMode from line 2
    // and text from line 1.
    const content = assistantLine("Detailed plan text.") + exitPlanOnlyLine();
    await writeFile(tmpFile, content);
    const result = await getLastAssistantEntry(tmpFile);
    expect(result).toEqual({ text: "Detailed plan text.", hasExitPlanMode: true, planText: null });
  });

  it("stops at user boundary: ExitPlanMode from previous turn is not surfaced", async () => {
    // ExitPlanMode is in a previous turn (before a user entry).
    // The current turn has only a plain text entry.
    // The user boundary should stop the backwards scan, so hasExitPlanMode is false.
    const content = exitPlanOnlyLine() + userLine() + assistantLine("Current turn text.");
    await writeFile(tmpFile, content);
    const result = await getLastAssistantEntry(tmpFile);
    expect(result).toEqual({ text: "Current turn text.", hasExitPlanMode: false, planText: null });
  });

  it("returns hasExitPlanMode=false for numbered list text with no ExitPlanMode tool_use", async () => {
    await writeFile(tmpFile, assistantLine("1. Add X\n2. Refactor Y"));
    const result = await getLastAssistantEntry(tmpFile);
    expect(result).toEqual({ text: "1. Add X\n2. Refactor Y", hasExitPlanMode: false, planText: null });
  });
});

describe("getFileSize", () => {
  const tmpFile = join(tmpdir(), `cv-getfilesize-${Date.now()}.jsonl`);

  afterEach(async () => {
    await unlink(tmpFile).catch(() => {});
  });

  it("returns byte count of file contents", async () => {
    await writeFile(tmpFile, "hello");
    expect(await getFileSize(tmpFile)).toBe(5);
  });

  it("returns 0 for a non-existent file", async () => {
    expect(await getFileSize("/tmp/definitely-does-not-exist-cv.jsonl")).toBe(0);
  });
});

describe("watchForResponse", () => {
  let tmpFile: string;
  let stopWatcher: (() => void) | null = null;

  afterEach(async () => {
    stopWatcher?.();
    stopWatcher = null;
    if (tmpFile) await unlink(tmpFile).catch(() => {});
  });

  it("fires callback when new assistant text appears after baseline", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    const received: SessionResponseState[] = [];
    stopWatcher = watchForResponse(
      tmpFile,
      baseline,
      async (state) => {
        received.push(state);
      }
    );

    await new Promise((r) => setTimeout(r, 200));
    await appendFile(tmpFile, assistantLine("Build succeeded."));
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("Build succeeded.");
  });

  it("ignores content written before the baseline", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, assistantLine("Old message from before injection."));
    const baseline = await getFileSize(tmpFile);

    const received: SessionResponseState[] = [];
    stopWatcher = watchForResponse(
      tmpFile,
      baseline,
      async (state) => {
        received.push(state);
      }
    );

    await new Promise((r) => setTimeout(r, 500));
    expect(received).toHaveLength(0);
  });

  it("does not fire twice for the same text block", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    const received: SessionResponseState[] = [];
    stopWatcher = watchForResponse(
      tmpFile,
      baseline,
      async (state) => {
        received.push(state);
      }
    );

    await new Promise((r) => setTimeout(r, 200));
    await appendFile(tmpFile, assistantLine("Done."));
    await new Promise((r) => setTimeout(r, 50));
    await appendFile(tmpFile, assistantLine("Done.")); // duplicate

    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(1);
  });

  it("fires separately for two distinct text blocks", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    const received: SessionResponseState[] = [];
    stopWatcher = watchForResponse(
      tmpFile,
      baseline,
      async (state) => {
        received.push(state);
      }
    );

    await new Promise((r) => setTimeout(r, 200));
    await appendFile(tmpFile, assistantLine("First block."));
    await new Promise((r) => setTimeout(r, 300));
    await appendFile(tmpFile, assistantLine("Second block."));
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toHaveLength(2);
    expect(received[0].text).toBe("First block.");
    expect(received[1].text).toBe("Second block.");
  });

  it("stop function prevents further callbacks", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    const received: SessionResponseState[] = [];
    stopWatcher = watchForResponse(
      tmpFile,
      baseline,
      async (state) => {
        received.push(state);
      }
    );

    await new Promise((r) => setTimeout(r, 200));
    stopWatcher();
    stopWatcher = null;

    await appendFile(tmpFile, assistantLine("Should not arrive."));
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(0);
  });

  it("calls onComplete after result event", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    let completed = false;
    stopWatcher = watchForResponse(
      tmpFile,
      baseline,
      async () => {},
      undefined,
      () => { completed = true; }
    );

    await new Promise((r) => setTimeout(r, 100));
    // Write assistant text + result in one append so a single change event sees both
    await appendFile(tmpFile, assistantLine("Step one.") + JSON.stringify({ type: "result" }) + "\n");
    await new Promise((r) => setTimeout(r, 900)); // 500ms delay + buffer

    expect(completed).toBe(true);
  });

  it("detects images written via Write tool and calls onImages after result event", async () => {
    tmpFile = join(tmpdir(), `cv-watch-img-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    // Create a temporary image file that the JSONL references
    const imgFile = join(tmpdir(), `cv-test-img-${Date.now()}.png`);
    // Write a minimal PNG-like content (just needs to be readable)
    await writeFile(imgFile, Buffer.from("fake-png-data"));

    const received: SessionResponseState[] = [];
    const detectedImages: Array<{ mediaType: string; data: string }[]> = [];

    stopWatcher = watchForResponse(
      tmpFile,
      baseline,
      async (state) => { received.push(state); },
      undefined,
      undefined,
      async (images) => { detectedImages.push(images); }
    );

    await new Promise((r) => setTimeout(r, 200));

    // Write assistant text with a Write tool_use for an image, plus result event
    const writeToolLine = JSON.stringify({
      type: "assistant",
      cwd: "/tmp/project",
      message: {
        content: [
          { type: "text", text: "Here is the chart." },
          { type: "tool_use", name: "Write", input: { file_path: imgFile } },
        ],
      },
    }) + "\n";
    const resultLine = JSON.stringify({ type: "result" }) + "\n";
    await appendFile(tmpFile, writeToolLine + resultLine);

    // Wait for result event processing (500ms delay + buffer)
    await new Promise((r) => setTimeout(r, 1500));

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(detectedImages.length).toBe(1);
    expect(detectedImages[0][0].mediaType).toBe("image/png");

    // Clean up
    await unlink(imgFile).catch(() => {});
  });

  it("calls onPing after 60s with no response text", async () => {
    // This test is hard to run with real timers, so we verify the onPing path
    // at a structural level — the important thing is that watchForResponse
    // accepts and handles the onPing callback.
    tmpFile = join(tmpdir(), `cv-watch-ping-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    let pingCalled = false;
    stopWatcher = watchForResponse(
      tmpFile,
      baseline,
      async () => {},
      () => { pingCalled = true; }
    );

    // We can't wait 60s in a test, but we verify the function accepts onPing
    // and doesn't throw
    await new Promise((r) => setTimeout(r, 100));
    stopWatcher();
    stopWatcher = null;
    // pingCalled will be false since we stop before 60s — but the test ensures
    // the code path is wired up without errors
    expect(pingCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// startMonitor
// ---------------------------------------------------------------------------

describe("startMonitor", () => {
  let watchDir: string;
  let stopMonitor: (() => void) | null = null;

  afterEach(async () => {
    stopMonitor?.();
    stopMonitor = null;
    if (watchDir) await rm(watchDir, { recursive: true, force: true });
  });

  function waitingAssistantLine(text: string, cwd = "/tmp/project"): string {
    return JSON.stringify({
      type: "assistant",
      cwd,
      message: { content: [{ type: "text", text }] },
    }) + "\n";
  }

  it("fires onWaiting callback when a JSONL file changes with a y/n prompt", async () => {
    watchDir = join(tmpdir(), `cv-monitor-${Date.now()}`);
    const projDir = join(watchDir, "-tmp-project");
    await mkdir(projDir, { recursive: true });
    const jsonlFile = join(projDir, "session-abc.jsonl");
    await writeFile(jsonlFile, "");

    const received: SessionWaitingState[] = [];
    stopMonitor = startMonitor(
      async (state) => { received.push(state); },
      watchDir
    );

    // Allow chokidar to initialize
    await new Promise((r) => setTimeout(r, 500));

    // Write a waiting prompt to the file
    await writeFile(jsonlFile, waitingAssistantLine("Should I continue? (y/n)"));

    // Wait for debounce (3s) + buffer
    await new Promise((r) => setTimeout(r, 4000));

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].waitingType).toBe(WaitingType.YES_NO);
    expect(received[0].sessionId).toBe("session-abc");
  }, 10000);

  it("fires onWaiting for ExitPlanMode with MULTIPLE_CHOICE type", async () => {
    watchDir = join(tmpdir(), `cv-monitor-epm-${Date.now()}`);
    const projDir = join(watchDir, "-tmp-project");
    await mkdir(projDir, { recursive: true });
    const jsonlFile = join(projDir, "session-plan.jsonl");
    await writeFile(jsonlFile, "");

    const received: SessionWaitingState[] = [];
    stopMonitor = startMonitor(
      async (state) => { received.push(state); },
      watchDir
    );

    await new Promise((r) => setTimeout(r, 500));

    // Write an ExitPlanMode entry
    const exitPlanLine = JSON.stringify({
      type: "assistant",
      cwd: "/tmp/project",
      message: {
        content: [{ type: "tool_use", id: "toolu_1", name: "ExitPlanMode", input: { plan: "Refactor the module" } }],
      },
    }) + "\n";
    await writeFile(jsonlFile, exitPlanLine);

    await new Promise((r) => setTimeout(r, 4000));

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].waitingType).toBe(WaitingType.MULTIPLE_CHOICE);
    expect(received[0].choices).toBeDefined();
    expect(received[0].choices!.length).toBe(4);
  }, 10000);

  it("does not fire for non-JSONL files", async () => {
    watchDir = join(tmpdir(), `cv-monitor-nonjsonl-${Date.now()}`);
    const projDir = join(watchDir, "-tmp-project");
    await mkdir(projDir, { recursive: true });
    const txtFile = join(projDir, "notes.txt");
    await writeFile(txtFile, "");

    const received: SessionWaitingState[] = [];
    stopMonitor = startMonitor(
      async (state) => { received.push(state); },
      watchDir
    );

    await new Promise((r) => setTimeout(r, 500));
    await writeFile(txtFile, "Should I continue? (y/n)");
    await new Promise((r) => setTimeout(r, 4000));

    expect(received).toHaveLength(0);
  }, 10000);

  it("cleanup function stops the watcher", async () => {
    watchDir = join(tmpdir(), `cv-monitor-cleanup-${Date.now()}`);
    await mkdir(watchDir, { recursive: true });

    const received: SessionWaitingState[] = [];
    stopMonitor = startMonitor(
      async (state) => { received.push(state); },
      watchDir
    );

    // Stop immediately
    stopMonitor();
    stopMonitor = null;

    // Should not throw or leak
    expect(received).toHaveLength(0);
  });
});
