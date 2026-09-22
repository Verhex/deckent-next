import type { ModelInvocationResult } from '#engine/index.js';

/** Best-effort assistant text from OpenAI-shaped native response. */
export function extractOpenAiChatTextFromInvocation(result: ModelInvocationResult): string | null {
  const native = result.response?.native;
  if (!native || typeof native !== 'object') return null;
  const choices = (native as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown })?.message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content !== 'string' || !content.trim()) return null;
  return content.trim();
}
