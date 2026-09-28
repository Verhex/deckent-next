import { z } from 'zod';
import type { JsonObject, ModelInvocationRejectionReason } from '#domain/index.js';
import { checkedToolCalls, openAiChatUsageSchema, openAiChatWireObjectSchema, type OpenAiChatHttpLimits,
  type OpenAiChatTextRequest } from '#adapters/core/provider-openai-chat/index.js';
import { rememberAnthropicContent, type AnthropicContentBlock } from './continuation.js';

const count = z.number().int().nonnegative().safe();
const nullableCount = count.nullable().optional();
/** Cumulative usage of one message: the input side arrives in `message_start`, `message_delta` restates it with the final output. */
export const anthropicUsageSchema = z.object({ input_tokens: nullableCount, cache_creation_input_tokens: nullableCount,
  cache_read_input_tokens: nullableCount, output_tokens: count.optional(),
  cache_creation: z.object({ ephemeral_5m_input_tokens: count, ephemeral_1h_input_tokens: count }).passthrough().nullable().optional(),
  output_tokens_details: z.object({ thinking_tokens: count }).passthrough().nullable().optional() }).passthrough();
export type AnthropicUsage = z.infer<typeof anthropicUsageSchema>;
export const anthropicStopReasons = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded'] as const;
export const stopReasonSchema = z.enum(anthropicStopReasons);
/** Provider stop reasons in the neutral finish vocabulary. `pause_turn` belongs to server tools, which are never declared. */
const FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', model_context_window_exceeded: 'length', tool_use: 'tool_calls', refusal: 'content_filter' } as const;
export type Reject = ModelInvocationRejectionReason;

export function mergeUsage(base: AnthropicUsage | null, next: AnthropicUsage): AnthropicUsage {
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(next)) if (value !== null && value !== undefined) merged[key] = value;
  return merged as AnthropicUsage;
}

export type Assembly = Readonly<{ id: string; model: string; blocks: readonly AnthropicContentBlock[]; stopReason: string;
  usage: AnthropicUsage | null; deckent?: JsonObject }>;
type Done = { response: Readonly<{ schemaVersion: 1; native: JsonObject; usage: JsonObject }> } | { reason: Reject };

/**
 * One assembled message (streamed or not) as the neutral chat-completion shape: text and summarized thinking joined in order,
 * tool_use blocks as function calls validated against the declared tools, usage with the provider's cache classes preserved
 * under `anthropic` (`prompt_tokens` counts every input class). The result is bounded provenance, not the provider body.
 */
export function assembleAnthropicMessage(input: Assembly, request: OpenAiChatTextRequest, limits: OpenAiChatHttpLimits, scopeId: string): Done {
  const finish = (FINISH as Record<string, string | undefined>)[input.stopReason];
  const usage = input.usage;
  if (!finish || !usage || usage.output_tokens === undefined || usage.input_tokens === null || usage.input_tokens === undefined) return { reason: 'invalid-response' };
  const text = input.blocks.filter(block => block.type === 'text').map(block => String(block['text'])).join('');
  const reasoning = input.blocks.filter(block => block.type === 'thinking').map(block => String(block['thinking'])).join('');
  const uses = input.blocks.filter(block => block.type === 'tool_use');
  const calls = uses.length ? uses.map(use => ({ id: use['id'], type: 'function', function: { name: use['name'], arguments: JSON.stringify(use['input']) } })) : null;
  const checked = checkedToolCalls(calls, request);
  if (checked === 'invalid' || (finish === 'tool_calls') !== (checked !== null)) return { reason: 'invalid-response' };
  const cacheWrite = usage.cache_creation_input_tokens ?? 0, cacheRead = usage.cache_read_input_tokens ?? 0;
  const prompt = usage.input_tokens + cacheWrite + cacheRead, completion = usage.output_tokens;
  if (completion > request.max_completion_tokens) return { reason: 'invalid-response' };
  const thinking = usage.output_tokens_details?.thinking_tokens;
  const neutralUsage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
    ...(thinking === undefined ? {} : { completion_tokens_details: { reasoning_tokens: thinking } }),
    anthropic: { input_tokens: usage.input_tokens, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead,
      cache_creation: usage.cache_creation ? { ephemeral_5m_input_tokens: usage.cache_creation.ephemeral_5m_input_tokens,
        ephemeral_1h_input_tokens: usage.cache_creation.ephemeral_1h_input_tokens } : null } };
  const checkedUsage = openAiChatUsageSchema.safeParse(neutralUsage);
  if (!checkedUsage.success) return { reason: 'invalid-response' };
  const message = { role: 'assistant', content: text === '' ? null : text, ...(reasoning ? { reasoning } : {}),
    ...(checked ? { tool_calls: checked.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}) };
  const native = { id: input.id, object: 'chat.completion', model: input.model, provider: 'anthropic',
    choices: [{ index: 0, finish_reason: finish, message }], usage: neutralUsage, deckent_message: { schemaVersion: 1, stopReason: input.stopReason, ...input.deckent } };
  const copied = openAiChatWireObjectSchema.safeParse(native);
  if (!copied.success) return { reason: 'invalid-response' };
  if (Buffer.byteLength(JSON.stringify(copied.data), 'utf8') > limits.responseMaxBytes) return { reason: 'response-limit' };
  rememberAnthropicContent(scopeId, input.blocks);
  return { response: Object.freeze({ schemaVersion: 1 as const, native: copied.data, usage: copied.data['usage'] as JsonObject }) };
}
