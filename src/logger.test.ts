import { describe, it, expect, vi } from "vitest";
import { log, getLogs, clearLogs, logEmitter } from "./logger.js";

describe("logger", () => {
  it("log() adds an entry to the buffer retrievable via getLogs()", () => {
    const before = getLogs().length;
    log({ message: "test entry" });
    const after = getLogs();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1].message).toBe("test entry");
    expect(after[after.length - 1].time).toBeDefined();
  });

  it("log() includes chatId and direction when provided", () => {
    log({ chatId: 123, direction: "in", message: "incoming" });
    const logs = getLogs();
    const last = logs[logs.length - 1];
    expect(last.chatId).toBe(123);
    expect(last.direction).toBe("in");
  });

  it("clearLogs() empties the buffer", () => {
    log({ message: "will be cleared" });
    expect(getLogs().length).toBeGreaterThan(0);
    clearLogs();
    expect(getLogs().length).toBe(0);
  });

  it("logEmitter emits 'log' events", () => {
    const handler = vi.fn();
    logEmitter.on("log", handler);
    log({ message: "emit test" });
    logEmitter.off("log", handler);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ message: "emit test" })
    );
  });

  it("logEmitter emits 'clear' event on clearLogs()", () => {
    const handler = vi.fn();
    logEmitter.on("clear", handler);
    clearLogs();
    logEmitter.off("clear", handler);

    expect(handler).toHaveBeenCalled();
  });

  it("getLogs() returns a copy of the buffer (not a reference)", () => {
    clearLogs();
    log({ message: "copy test" });
    const logs1 = getLogs();
    const logs2 = getLogs();
    expect(logs1).toEqual(logs2);
    expect(logs1).not.toBe(logs2);
  });

  it("buffer does not exceed MAX_BUFFER (1000 entries)", () => {
    clearLogs();
    for (let i = 0; i < 1010; i++) {
      log({ message: `entry ${i}` });
    }
    const logs = getLogs();
    expect(logs.length).toBe(1000);
    // Oldest entries should have been shifted out
    expect(logs[0].message).toBe("entry 10");
  });
});
