import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM = `You are a friendly assistant relaying what a coding agent just did.
Given the agent's response, write a concise conversational reply in 1-3 sentences of plain text.
No markdown, no code blocks, no bullet points. Natural language, like you're texting.
If the agent completed a task, describe what it did. If it needs more info, relay the question clearly.`;

export async function narrate(agentResult: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    system: SYSTEM,
    messages: [{ role: "user", content: agentResult }],
  });
  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected narrator response type");
  return block.text;
}
