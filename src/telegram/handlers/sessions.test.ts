import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { timeAgo } from "./sessions.js";

describe("timeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for 0 seconds ago", () => {
    const now = new Date("2026-02-23T12:00:00Z");
    expect(timeAgo(now)).toBe("just now");
  });

  it("returns 'just now' for negative diff (future date)", () => {
    const future = new Date("2026-02-23T12:00:10Z");
    expect(timeAgo(future)).toBe("just now");
  });

  it("returns seconds ago for 30s", () => {
    const date = new Date("2026-02-23T11:59:30Z");
    expect(timeAgo(date)).toBe("30s ago");
  });

  it("returns minutes ago for 90s (1m)", () => {
    const date = new Date("2026-02-23T11:58:30Z");
    expect(timeAgo(date)).toBe("1m ago");
  });

  it("returns minutes ago for 3599s (59m)", () => {
    const date = new Date(Date.now() - 3599 * 1000);
    expect(timeAgo(date)).toBe("59m ago");
  });

  it("returns hours ago for 3600s (1h)", () => {
    const date = new Date(Date.now() - 3600 * 1000);
    expect(timeAgo(date)).toBe("1h ago");
  });

  it("returns hours ago for 86399s (23h)", () => {
    const date = new Date(Date.now() - 86399 * 1000);
    expect(timeAgo(date)).toBe("23h ago");
  });

  it("returns days ago for 86400s (1d)", () => {
    const date = new Date(Date.now() - 86400 * 1000);
    expect(timeAgo(date)).toBe("1d ago");
  });

  it("returns days ago for 172800s (2d)", () => {
    const date = new Date(Date.now() - 172800 * 1000);
    expect(timeAgo(date)).toBe("2d ago");
  });
});
