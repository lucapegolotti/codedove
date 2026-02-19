import OpenAI from "openai";

let openai: OpenAI | null = null;
function getClient(): OpenAI {
  return (openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
}

export async function transcribeAudio(audioBuffer: Buffer, filename: string): Promise<string> {
  const file = new File([new Uint8Array(audioBuffer)], filename, { type: "audio/ogg" });
  const transcription = await getClient().audio.transcriptions.create({
    file,
    model: "whisper-1",
  });
  return transcription.text;
}

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const response = await getClient().audio.speech.create({
    model: "tts-1",
    voice: "nova",
    input: text,
  });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
