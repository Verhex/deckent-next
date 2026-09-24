import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JsonObject, ModelInvocationDelta, ModelInvocationRejectionReason } from '#domain/index.js';
import type { NativeJsonHttpParsed, NativeJsonHttpStream } from '#adapters/core/provider-http-json/index.js';
import { openAiChatFinishReasonSchema, openAiChatUsageSchema, openAiChatWireObjectSchema,
  type OpenAiChatHttpLimits, type OpenAiChatTextRequest } from './contract.js';

/**
 * SSE framing costs about 60x the answer text per token (vLLM measured ~240 wire bytes per token). The profile's
 * `responseMaxBytes` keeps bounding the retained evidence prefix and the assembled result that is persisted and
 * delivered. Total wire bytes of one streamed response, within the same deadline, are bounded by a fixed multiple of it
 * plus a per-token framing allowance (4x the measured vLLM framing) for the request's completion budget, so a long
 * legitimate answer is not rejected after the provider billed it (S-STREAM decision, Jev aac0af98). The bound limits
 * bandwidth only; parser memory stays bounded by `responseMaxBytes`.
 */
export const OPENAI_CHAT_STREAM_WIRE_FACTOR = 16;
export const OPENAI_CHAT_STREAM_TOKEN_WIRE_BYTES = 1024;

const deltaSchema = z.object({ role: z.literal('assistant').optional(), content: z.string().nullable().optional(),
  reasoning: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional(),
  refusal: z.string().nullable().optional() }).passthrough();
const choiceSchema = z.object({ index: z.literal(0), delta: deltaSchema,
  finish_reason: openAiChatFinishReasonSchema.nullable().optional() }).passthrough();
const chunkSchema = z.object({ id: z.string().min(1), object: z.literal('chat.completion.chunk'),
  created: z.number().int().nonnegative().safe(), model: z.string().min(1), choices: z.array(choiceSchema).max(1),
  usage: z.unknown().optional(), system_fingerprint: z.unknown().optional() }).passthrough();

/**
 * Incremental OpenAI chat-completions SSE parser. Every `data:` event is bounded and validated like the non-streamed
 * response (model match, no tool or function calls, usage within the requested completion budget). The result is the
 * assembled `chat.completion` plus a digest of the exact wire bytes (`deckent_stream`: the native object of a streamed call
 * is assembled provenance, never the provider's verbatim body). A stream that ends without `[DONE]`, a finish
 * reason and usage is interrupted, which the invocation records as an uncertain outcome; it is never retried.
 */
export function createOpenAiChatStream(request: OpenAiChatTextRequest, limits: OpenAiChatHttpLimits): NativeJsonHttpStream {
  const hash = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true });
  let wireBytes = 0, chunks = 0, lineBytes = 0, eventBytes = 0, assembledBytes = 0;
  let line: Buffer[] = [], data: string[] = [];
  let invalid: ModelInvocationRejectionReason | null = null, doneSeen = false;
  let head: { id: string; created: number; model: string } | null = null, fingerprint: string | null = null;
  let content = '', reasoning = '', refusal = '', finish: string | null = null, usage: JsonObject | null = null;
  const fail = (reason: ModelInvocationRejectionReason) => { invalid ??= reason; };

  function event(text: string, out: ModelInvocationDelta[]): boolean {
    if (doneSeen) { fail('invalid-response'); return false; }
    if (text === '[DONE]') { doneSeen = true; return false; }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { fail('invalid-response'); return false; }
    const copied = openAiChatWireObjectSchema.safeParse(raw), parsed = copied.success ? chunkSchema.safeParse(copied.data) : undefined;
    if (!copied.success || !parsed?.success) { fail('invalid-response'); return false; }
    const chunk = parsed.data; chunks += 1;
    if (chunk.model !== request.model) { fail('model-mismatch'); return false; }
    if (!head) head = { id: chunk.id, created: chunk.created, model: chunk.model };
    else if (chunk.id !== head.id) { fail('invalid-response'); return false; }
    if (typeof chunk.system_fingerprint === 'string') fingerprint ??= chunk.system_fingerprint;
    if (chunk.usage !== undefined && chunk.usage !== null) {
      const checked = openAiChatUsageSchema.safeParse(chunk.usage);
      if (usage || !checked.success || checked.data.completion_tokens > request.max_completion_tokens) { fail('invalid-response'); return false; }
      usage = (copied.data as Record<string, unknown>)['usage'] as JsonObject;
    }
    const choice = chunk.choices[0];
    if (!choice) return false;
    const delta = choice.delta;
    // No tool calls are accepted; vLLM sends these keys as null when there is none.
    if (finish !== null || (delta['tool_calls'] ?? null) !== null || (delta['function_call'] ?? null) !== null) {
      fail('invalid-response'); return false;
    }
    const thinking = typeof delta.reasoning === 'string' ? delta.reasoning : delta.reasoning_content ?? '';
    if (thinking) { reasoning += thinking; out.push({ kind: 'reasoning', text: thinking }); }
    if (delta.content) { content += delta.content; out.push({ kind: 'text', text: delta.content }); }
    if (delta.refusal) refusal += delta.refusal;
    if (choice.finish_reason) finish = choice.finish_reason;
    assembledBytes += Buffer.byteLength(thinking, 'utf8') + Buffer.byteLength(delta.content ?? '', 'utf8') + Buffer.byteLength(delta.refusal ?? '', 'utf8');
    return assembledBytes > limits.responseMaxBytes;
  }

  function endLine(out: ModelInvocationDelta[]): boolean {
    const bytes = Buffer.concat(line, lineBytes); line = []; lineBytes = 0;
    let text: string;
    try { text = decoder.decode(bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes); } catch { fail('invalid-response'); return false; }
    if (text === '') {
      if (data.length === 0) return false;
      const payload = data.join('\n'); data = []; eventBytes = 0;
      return event(payload, out);
    }
    if (text.startsWith(':')) return false;
    const colon = text.indexOf(':'), field = colon < 0 ? text : text.slice(0, colon);
    if (field !== 'data') return false; // event, id, retry and unknown fields carry nothing for chat completions.
    const value = colon < 0 ? '' : text.slice(colon + (text[colon + 1] === ' ' ? 2 : 1));
    data.push(value); eventBytes += value.length;
    return eventBytes > limits.responseMaxBytes;
  }

  return Object.freeze({
    accept: 'text/event-stream',
    wireMaxBytes: Math.min(limits.responseMaxBytes * OPENAI_CHAT_STREAM_WIRE_FACTOR
      + request.max_completion_tokens * OPENAI_CHAT_STREAM_TOKEN_WIRE_BYTES, Number.MAX_SAFE_INTEGER),
    push(chunk: Buffer) {
      hash.update(chunk); wireBytes += chunk.byteLength;
      const out: ModelInvocationDelta[] = [];
      let limit = false, start = 0;
      if (invalid) return Object.freeze({ deltas: out, limit, rejected: invalid });
      for (let index = chunk.indexOf(0x0a); index >= 0 && !invalid && !limit; index = chunk.indexOf(0x0a, start)) {
        line.push(chunk.subarray(start, index)); lineBytes += index - start; start = index + 1;
        limit = endLine(out);
      }
      if (!invalid && !limit && start < chunk.byteLength) {
        line.push(chunk.subarray(start)); lineBytes += chunk.byteLength - start;
        limit = lineBytes > limits.responseMaxBytes;
      }
      // The first invalid chunk ends the read at once with its own reason: nothing after it is presented or parsed, and the
      // provider stops generating when the connection closes (no draining; usage is not trusted past an invalid chunk).
      return Object.freeze(invalid ? { deltas: [], limit, rejected: invalid } : { deltas: out, limit });
    },
    finish(): NativeJsonHttpParsed {
      if (invalid) return { reason: invalid };
      if (lineBytes > 0 || data.length > 0) return { reason: doneSeen ? 'invalid-response' : 'interrupted' };
      if (!doneSeen || !head || finish === null || usage === null) return { reason: 'interrupted' };
      const message = { role: 'assistant', content: content || null, ...(reasoning ? { reasoning } : {}), ...(refusal ? { refusal } : {}) };
      const native = { id: head.id, object: 'chat.completion', created: head.created, model: head.model,
        ...(fingerprint === null ? {} : { system_fingerprint: fingerprint }),
        choices: [{ index: 0, finish_reason: finish, message }], usage,
        deckent_stream: { schemaVersion: 1, chunks, wireBytes, wireSha256: hash.digest('hex') } };
      const copied = openAiChatWireObjectSchema.safeParse(native);
      if (!copied.success) return { reason: 'invalid-response' };
      if (Buffer.byteLength(JSON.stringify(copied.data), 'utf8') > limits.responseMaxBytes) return { reason: 'response-limit' };
      return { response: Object.freeze({ schemaVersion: 1 as const, native: copied.data, usage: copied.data['usage'] as JsonObject }) };
    },
  });
}
