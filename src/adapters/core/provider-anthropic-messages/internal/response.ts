import { z } from 'zod';
import type { NativeJsonHttpParsed } from '#adapters/core/provider-http-json/index.js';
import { openAiChatWireObjectSchema, type OpenAiChatHttpLimits, type OpenAiChatTextRequest } from '#adapters/core/provider-openai-chat/index.js';
import type { AnthropicContinuationScope } from './continuation.js';
import { anthropicUsageSchema, assembleAnthropicMessage, stopReasonSchema } from './assemble.js';

const block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
  z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string() }).passthrough(),
  z.object({ type: z.literal('redacted_thinking'), data: z.string() }).passthrough(),
  z.object({ type: z.literal('tool_use'), id: z.string().min(1).max(256), name: z.string(), input: z.record(z.string(), z.unknown()) }).passthrough(),
]);
const responseSchema = z.object({ id: z.string().min(1), type: z.literal('message'), role: z.literal('assistant'), model: z.string().min(1),
  content: z.array(block), stop_reason: stopReasonSchema, usage: anthropicUsageSchema }).passthrough();

/** Non-streamed Messages response (compaction and other one-shot calls) with the same validation as the assembled stream. */
export function parseAnthropicMessageResponse(body: Buffer, request: OpenAiChatTextRequest, limits: OpenAiChatHttpLimits, memory: AnthropicContinuationScope): NativeJsonHttpParsed {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return { reason: 'invalid-response' }; }
  const copied = openAiChatWireObjectSchema.safeParse(raw), parsed = copied.success && responseSchema.safeParse(copied.data);
  if (!parsed || !parsed.success) return { reason: 'invalid-response' };
  if (parsed.data.model !== request.model) return { reason: 'model-mismatch' };
  if (Buffer.byteLength(JSON.stringify(copied.data), 'utf8') > limits.responseMaxBytes) return { reason: 'response-limit' };
  return assembleAnthropicMessage({ id: parsed.data.id, model: parsed.data.model, blocks: parsed.data.content, stopReason: parsed.data.stop_reason,
    usage: parsed.data.usage }, request, limits, memory);
}
