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

/** Untrimmed answer and reasoning text of the assembled result, used to reconcile streamed deltas. */
export function openAiChatMessageFromInvocation(result: ModelInvocationResult): { content: string; reasoning: string; finish: unknown } | null {
  const choice = firstChoice(result), message = choice?.['message'];
  if (!choice || !message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const reasoning = typeof record['reasoning'] === 'string' ? record['reasoning']
    : typeof record['reasoning_content'] === 'string' ? record['reasoning_content'] : '';
  return { content: typeof record['content'] === 'string' ? record['content'] : '', reasoning, finish: choice['finish_reason'] };
}

/** Settled token usage of the result; reasoning tokens when the server reports them. */
export function openAiChatUsageFromInvocation(result: ModelInvocationResult):
  { promptTokens: number; completionTokens: number; reasoningTokens: number | null } | null {
  const usage = result.response?.usage as Record<string, unknown> | null | undefined;
  if (!usage || typeof usage['prompt_tokens'] !== 'number' || typeof usage['completion_tokens'] !== 'number') return null;
  const details = usage['completion_tokens_details'] as Record<string, unknown> | null | undefined;
  const reasoning = details && typeof details['reasoning_tokens'] === 'number' ? details['reasoning_tokens'] : null;
  return { promptTokens: usage['prompt_tokens'], completionTokens: usage['completion_tokens'], reasoningTokens: reasoning };
}
