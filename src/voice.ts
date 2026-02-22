import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

let openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  return (openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
}

let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  return (anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
}

export async function transcribeAudio(audioBuffer: Buffer, filename: string): Promise<string> {
  const file = new File([new Uint8Array(audioBuffer)], filename, { type: "audio/ogg" });
  const transcription = await getOpenAI().audio.transcriptions.create({
    file,
    model: "whisper-1",
  });
  return transcription.text;
}

/** Sanitize text for TTS playback — strip trailing colons that cause
 *  robotic pronunciation artifacts in OpenAI TTS. */
export function sanitizeForTts(text: string): string {
  return text.replace(/:$/m, "");
}

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const response = await getOpenAI().audio.speech.create({
    model: "tts-1",
    voice: "nova",
    input: text,
  });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function polishTranscript(transcript: string): Promise<string> {
  const response = await getAnthropic().messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `Clean up this voice transcription into a clear, well-formed message or command. Fix grammar, remove filler words, keep it concise. Return only the cleaned text with no explanation:\n\n${transcript}`,
      },
    ],
  });
  const block = response.content[0];
  return block.type === "text" ? block.text : transcript;
}
