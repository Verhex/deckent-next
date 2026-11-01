import { persistedString, persistedInteger } from '#domain/index.js';
import { z } from 'zod';
import type { ModelInvocationNativeResponse } from '#domain/index.js';
import { openRouterChatJsonSchema } from './contract.js';

const count = persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.looseObject({ prompt_tokens: count, completion_tokens: count, total_tokens: count });
const responseSchema = z.looseObject({ id: persistedString(z.string().min(1)), object: z.literal('chat.completion'), created: count,
  model: persistedString(z.string().min(1)), choices: z.array(z.looseObject({ index: z.literal(0), finish_reason: z.enum(['stop', 'length', 'content_filter']),
    message: z.looseObject({ role: z.literal('assistant'), content: z.string().nullable(), refusal: z.string().nullable().optional() }),
  })).length(1), usage: z.unknown().optional() });

/** Native completion validation preserves complete provider metadata; it does not turn usage into invoice proof.
 * provider_name is a display name, never the region tag. Route/meter settlement is a separate required capability.
 */
export function parseOpenRouterChatResponse(body: Buffer, modelId: string, responseMaxBytes: number):
  { response: ModelInvocationNativeResponse } | { reason: 'invalid-response' | 'model-mismatch' | 'response-limit' } {
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return { reason: 'invalid-response' }; }
  const copied = openRouterChatJsonSchema.safeParse(input), parsed = copied.success && responseSchema.safeParse(copied.data);
  if (!parsed || !parsed.success) return { reason: 'invalid-response' };
  if (parsed.data.model !== modelId) return { reason: 'model-mismatch' };
  if (Buffer.byteLength(JSON.stringify(copied.data), 'utf8') > responseMaxBytes) return { reason: 'response-limit' };
  const choice = parsed.data.choices[0]!;
  if ('tool_calls' in choice.message || 'function_call' in choice.message) return { reason: 'invalid-response' };
  if (parsed.data.usage === undefined || parsed.data.usage === null) {
    return { response: Object.freeze({ schemaVersion: 1, native: copied.data, usage: null }) };
  }
  const usageCopied = openRouterChatJsonSchema.safeParse(parsed.data.usage), usage = usageCopied.success && usageSchema.safeParse(usageCopied.data);
  if (!usage || !usage.success || BigInt(usage.data.total_tokens) < BigInt(usage.data.prompt_tokens) + BigInt(usage.data.completion_tokens)) {
    return { reason: 'invalid-response' };
  }
  return { response: Object.freeze({ schemaVersion: 1, native: copied.data, usage: usageCopied.data }) };
}
