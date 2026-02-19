import { describe, it, expect } from "vitest";
import { classifyWaitingType, WaitingType } from "./monitor.js";

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

  it("detects question prompt", () => {
    expect(classifyWaitingType("What should I name the new file?")).toBe(WaitingType.QUESTION);
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
