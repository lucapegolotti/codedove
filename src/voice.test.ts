import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mock for the Anthropic messages.create function so we can control it per-test
// without fighting the module-level singleton in voice.ts.
const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  // Must use a real function (not an arrow function) so it can be called with `new`
  function MockAnthropic() {
    return { messages: { create: mockCreate } };
  }
  return { default: MockAnthropic };
});

// Shared mocks for OpenAI audio methods
const mockTranscriptionCreate = vi.fn();
const mockSpeechCreate = vi.fn();

vi.mock("openai", () => {
  function MockOpenAI() {
    return {
      audio: {
        transcriptions: { create: mockTranscriptionCreate },
        speech: { create: mockSpeechCreate },
      },
    };
  }
  return { default: MockOpenAI };
});

import { polishTranscript, sanitizeForTts, transcribeAudio, synthesizeSpeech } from "./voice.js";

beforeEach(() => vi.clearAllMocks());

describe("polishTranscript", () => {
  it("returns cleaned text from the model response", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Run the test suite." }],
    });

    const result = await polishTranscript("uh run the uh tests please");
    expect(result).toBe("Run the test suite.");
  });

  it("passes the raw transcript in the user message content", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Install dependencies." }],
    });

    await polishTranscript("install the things");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining("install the things"),
          }),
        ]),
      })
    );
  });

  it("falls back to raw transcript when model returns a non-text block", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
    });

    const result = await polishTranscript("some raw input");
    expect(result).toBe("some raw input");
  });
});

describe("sanitizeForTts", () => {
  it("strips trailing colon", () => {
    expect(sanitizeForTts("Here is the result:")).toBe("Here is the result");
  });

  it("preserves mid-text colons and semicolons", () => {
    expect(sanitizeForTts("step one; step two: done")).toBe("step one; step two: done");
  });

  it("leaves text without trailing colon unchanged", () => {
    expect(sanitizeForTts("all good here")).toBe("all good here");
  });
});

describe("transcribeAudio", () => {
  it("returns transcription text from OpenAI", async () => {
    mockTranscriptionCreate.mockResolvedValue({ text: "hello world" });

    const result = await transcribeAudio(Buffer.from("audio-data"), "voice.ogg");
    expect(result).toBe("hello world");
  });

  it("passes correct filename and model", async () => {
    mockTranscriptionCreate.mockResolvedValue({ text: "test" });

    await transcribeAudio(Buffer.from("data"), "recording.ogg");
    expect(mockTranscriptionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "whisper-1",
        file: expect.any(File),
      })
    );
    const callArg = mockTranscriptionCreate.mock.calls[0][0];
    expect(callArg.file.name).toBe("recording.ogg");
  });
});

describe("synthesizeSpeech", () => {
  it("returns Buffer from speech API", async () => {
    const fakeArrayBuffer = new ArrayBuffer(4);
    new Uint8Array(fakeArrayBuffer).set([1, 2, 3, 4]);
    mockSpeechCreate.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(fakeArrayBuffer),
    });

    const result = await synthesizeSpeech("Hello there");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("passes correct model and voice", async () => {
    mockSpeechCreate.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    await synthesizeSpeech("Some text");
    expect(mockSpeechCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "tts-1",
        voice: "nova",
        input: "Some text",
      })
    );
  });
});
