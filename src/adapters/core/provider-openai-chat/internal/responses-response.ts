import { z } from 'zod';
import type { JsonObject } from '#domain/index.js';
import type { NativeJsonHttpParsed } from '#adapters/core/provider-http-json/index.js';
import { openAiChatWireObjectSchema, type OpenAiChatHttpLimits, type OpenAiChatTextRequest } from './contract.js';
import { checkedToolCalls } from './tool-calls.js';

const count = z.number().int().nonnegative().safe();
const usageSchema = z.object({ input_tokens: count, output_tokens: count, total_tokens: count,
  input_tokens_details: z.object({ cached_tokens: count, cache_write_tokens: count.optional() }).passthrough(),
  output_tokens_details: z.object({ reasoning_tokens: count }).passthrough() }).passthrough()
  .refine(u => u.total_tokens === u.input_tokens + u.output_tokens && u.input_tokens_details.cached_tokens <= u.input_tokens
    && (u.input_tokens_details.cache_write_tokens ?? 0) <= u.input_tokens - u.input_tokens_details.cached_tokens
    && u.output_tokens_details.reasoning_tokens <= u.output_tokens);
const part = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output_text'), text: z.string() }).passthrough(),
  z.object({ type: z.literal('refusal'), refusal: z.string() }).passthrough(),
]);
export const responsesOutputItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), id: z.string().min(1), role: z.literal('assistant'), content: z.array(part),
    status: z.enum(['completed', 'in_progress', 'incomplete']).optional() }).passthrough(),
  z.object({ type: z.literal('function_call'), id: z.string().min(1), call_id: z.string().min(1), name: z.string().min(1), arguments: z.string(),
    status: z.enum(['completed', 'in_progress', 'incomplete']).optional() }).passthrough(),
  z.object({ type: z.literal('reasoning'), id: z.string().min(1), encrypted_content: z.string().nullable().optional(),
    summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() }).passthrough()) }).passthrough(),
]);
const responseSchema = z.object({ id: z.string().min(1), object: z.literal('response'), created_at: count, model: z.string().min(1),
  status: z.enum(['completed', 'incomplete', 'failed']), output: z.array(responsesOutputItemSchema),
  usage: usageSchema.nullable(), error: z.unknown().optional(), incomplete_details: z.unknown().optional(),
  service_tier: z.string().optional().nullable() }).passthrough();

/** Validate the final provider object, then project onto the existing typed facade. Reasoning is a subset of output, never charged twice. */
export function parseResponsesResponse(raw: unknown, request: OpenAiChatTextRequest, limits: OpenAiChatHttpLimits): NativeJsonHttpParsed {
  const copied = openAiChatWireObjectSchema.safeParse(raw), parsed = copied.success && responseSchema.safeParse(copied.data);
  if (!parsed || !parsed.success) return { reason: 'invalid-response' };
  const value = parsed.data;
  if (value.model !== request.model) return { reason: 'model-mismatch' };
  if (value.status === 'failed' || value.error != null || value.usage === null || value.usage.output_tokens > request.max_completion_tokens) return { reason: 'invalid-response' };
  if (new Set(value.output.map(item => item.id)).size !== value.output.length) return { reason: 'invalid-response' };
  let content = '', refusal = '', reasoning = '';
  const calls = [];
  for (const item of value.output) {
    if (item.type === 'message') for (const entry of item.content) {
      if (entry.type === 'output_text') content += entry.text; else refusal += entry.refusal;
    }
    else if (item.type === 'reasoning') reasoning += item.summary.map(entry => entry.text).join('');
    else calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    if (value.status === 'completed' && 'status' in item && item.status !== undefined && item.status !== 'completed') return { reason: 'invalid-response' };
  }
  const checked = checkedToolCalls(calls.length ? calls : null, request);
  if (checked === 'invalid' || (refusal && calls.length)) return { reason: 'invalid-response' };
  const incomplete = value.incomplete_details as { reason?: unknown } | null | undefined;
  if (value.status === 'incomplete' && (calls.length || !['max_output_tokens', 'content_filter'].includes(String(incomplete?.reason)))) return { reason: 'invalid-response' };
  if (value.status === 'completed' && value.incomplete_details != null) return { reason: 'invalid-response' };
  const finish = refusal || incomplete?.reason === 'content_filter' ? 'content_filter'
    : value.status === 'incomplete' ? 'length' : calls.length ? 'tool_calls' : 'stop';
  const u = value.usage;
  const usage = { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens, total_tokens: u.total_tokens,
    prompt_tokens_details: u.input_tokens_details, completion_tokens_details: u.output_tokens_details };
  const message = { role: 'assistant', content: content || null, ...(reasoning ? { reasoning } : {}), ...(refusal ? { refusal } : {}), ...(calls.length ? { tool_calls: calls } : {}) };
  const native = { id: value.id, object: 'chat.completion', created: value.created_at, model: value.model,
    service_tier: value.service_tier ?? null, choices: [{ index: 0, finish_reason: finish, message }], usage,
    // Explicit wire provenance and typed refusal; opaque encrypted content stays behind the continuation boundary.
    deckent_responses: { schemaVersion: 1, status: value.status, refusal: refusal ? { kind: 'provider-refusal', message: refusal } : null } };
  const normalized = openAiChatWireObjectSchema.safeParse(native);
  if (!normalized.success) return { reason: 'invalid-response' };
  if (Buffer.byteLength(JSON.stringify(normalized.data), 'utf8') > limits.responseMaxBytes) return { reason: 'response-limit' };
  return { response: { schemaVersion: 1, native: normalized.data, usage: normalized.data['usage'] as JsonObject } };
}
