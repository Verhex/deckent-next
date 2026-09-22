import type { ModelInvocationResult } from '#engine/index.js';

function firstChoice(result: ModelInvocationResult): Record<string, unknown> | null {
  const native = result.response?.native;
  if (!native || typeof native !== 'object') return null;
  const choices = (native as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0];
  return choice && typeof choice === 'object' ? choice as Record<string, unknown> : null;
}

/** Assistant text from an OpenAI-shaped native response; reasoning fields are never treated as the answer. */
export function extractOpenAiChatTextFromInvocation(result: ModelInvocationResult): string | null {
  const message = firstChoice(result)?.['message'];
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content !== 'string' || !content.trim()) return null;
  return content.trim();
}

/** True when the completion budget ended the turn (e.g. a reasoning model spent it before answering). */
export function openAiChatStoppedAtLength(result: ModelInvocationResult): boolean {
  return firstChoice(result)?.['finish_reason'] === 'length';
}
