import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ModelInvocationDelta } from '#domain/index.js';
import type { NativeJsonHttpParsed, NativeJsonHttpStream } from '#adapters/core/provider-http-json/index.js';
import { OPENAI_CHAT_MAX_TOOL_CALLS, openAiChatWireObjectSchema, type OpenAiChatHttpLimits, type OpenAiChatTextRequest } from '#adapters/core/provider-openai-chat/index.js';
import { anthropicUsageSchema, assembleAnthropicMessage, mergeUsage, stopReasonSchema, type AnthropicUsage, type Reject } from './assemble.js';
import type { AnthropicContentBlock, AnthropicContinuationScope } from './continuation.js';

/**
 * Wire bound for one streamed response: a fixed multiple of the retained-result bound plus a per-token framing allowance.
 * The allowance is the OpenAI/vLLM figure (1024 B per completion token), taken here as a HYPOTHESIS: Anthropic's own SSE framing
 * cost per token was not measured on a live stream in this lane (no API key); the fake-server fixture measured well below it.
 */
export const ANTHROPIC_STREAM_WIRE_FACTOR = 16;
export const ANTHROPIC_STREAM_TOKEN_WIRE_BYTES = 1024;

const start = z.object({ type: z.literal('message_start'), message: z.object({ id: z.string().min(1), type: z.literal('message'), role: z.literal('assistant'),
  model: z.string().min(1), usage: anthropicUsageSchema }).passthrough() }).passthrough();
const startBlock = z.discriminatedUnion('type', [z.object({ type: z.literal('text') }).passthrough(), z.object({ type: z.literal('thinking') }).passthrough(),
  z.object({ type: z.literal('redacted_thinking'), data: z.string() }).passthrough(),
  z.object({ type: z.literal('tool_use'), id: z.string().min(1).max(256), name: z.string() }).passthrough()]);
const blockStart = z.object({ type: z.literal('content_block_start'), index: z.number().int().nonnegative(), content_block: startBlock }).passthrough();
const delta = z.discriminatedUnion('type', [z.object({ type: z.literal('text_delta'), text: z.string() }).passthrough(),
  z.object({ type: z.literal('thinking_delta'), thinking: z.string() }).passthrough(),
  z.object({ type: z.literal('signature_delta'), signature: z.string() }).passthrough(),
  z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }).passthrough()]);
const blockDelta = z.object({ type: z.literal('content_block_delta'), index: z.number().int().nonnegative(), delta }).passthrough();
const blockStop = z.object({ type: z.literal('content_block_stop'), index: z.number().int().nonnegative() }).passthrough();
const messageDelta = z.object({ type: z.literal('message_delta'), delta: z.object({ stop_reason: stopReasonSchema.nullable() }).passthrough(),
  usage: anthropicUsageSchema }).passthrough();
const simple = z.object({ type: z.enum(['message_stop', 'ping', 'error']) }).passthrough();
type Open = { type: string; index: number; text: string; signature: string; json: string; id: string; name: string; data: string };

/**
 * Incremental Messages SSE parser. Events dispatch on the JSON `type` (an `event:` line naming another type is invalid), blocks
 * must open in index order and only accept their own delta kind, tool input is the concatenated `input_json_delta` text parsed at
 * block stop (a provider defect if malformed: unlike OpenAI's raw arguments it is never model-authored text), and usage is
 * cumulative. A mid-stream `error` event (HTTP 200 already sent, for example `overloaded_error`) ends the read as `interrupted`,
 * an uncertain outcome that is never retried; usage past it is not trusted. Without `message_stop` the stream is interrupted.
 */
export function createAnthropicMessagesStream(request: OpenAiChatTextRequest, limits: OpenAiChatHttpLimits, memory: AnthropicContinuationScope): NativeJsonHttpStream {
  const hash = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true });
  let wireBytes = 0, events = 0, lineBytes = 0, eventBytes = 0, assembledBytes = 0;
  let line: Buffer[] = [], data: string[] = [], eventName: string | null = null;
  let invalid: Reject | null = null, stopped = false, errored = false;
  let head: { id: string; model: string } | null = null, usage: AnthropicUsage | null = null, stopReason: string | null = null;
  const blocks: AnthropicContentBlock[] = [];
  let current: Open | null = null, toolBlocks = 0;
  const fail = (reason: Reject) => { invalid ??= reason; return false; };

  function event(text: string, name: string | null, out: ModelInvocationDelta[]): boolean {
    if (stopped) return fail('invalid-response');
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return fail('invalid-response'); }
    const copied = openAiChatWireObjectSchema.safeParse(raw);
    const type = copied.success ? (copied.data as { type?: unknown }).type : undefined;
    if (!copied.success || typeof type !== 'string' || (name !== null && name !== type)) return fail('invalid-response');
    events += 1;
    if (type === 'ping') return false;
    // The provider ended its own stream: bytes are no longer parsed; finish() reports the uncertain outcome (never `rejected` with
    // complete evidence, which the evidence contract forbids for `interrupted`).
    if (type === 'error') { errored = true; return false; }
    if (type === 'message_start') {
      const parsed = start.safeParse(copied.data);
      if (!parsed.success || head) return fail('invalid-response');
      if (parsed.data.message.model !== request.model) return fail('model-mismatch');
      head = { id: parsed.data.message.id, model: parsed.data.message.model }; usage = mergeUsage(null, parsed.data.message.usage); return false;
    }
    if (!head) return fail('invalid-response');
    if (type === 'content_block_start') {
      const parsed = blockStart.safeParse(copied.data);
      if (!parsed.success || current || parsed.data.index !== blocks.length) return fail('invalid-response');
      const opened = parsed.data.content_block;
      if (opened.type === 'tool_use') {
        if (!request.tools || request.tool_choice === 'none' || ++toolBlocks > OPENAI_CHAT_MAX_TOOL_CALLS
          || !request.tools.some(tool => tool.function.name === opened['name'])) return fail('invalid-response');
      }
      current = { type: opened.type, index: parsed.data.index, text: '', signature: '', json: '', id: String(opened['id'] ?? ''), name: String(opened['name'] ?? ''),
        data: String(opened['data'] ?? '') };
      return false;
    }
    if (type === 'content_block_delta') {
      const parsed = blockDelta.safeParse(copied.data);
      if (!parsed.success || !current || current.index !== parsed.data.index) return fail('invalid-response');
      const change = parsed.data.delta, kind = current.type;
      if (change.type === 'text_delta' && kind === 'text') { current.text += change.text; if (change.text) out.push({ kind: 'text', text: change.text }); assembledBytes += Buffer.byteLength(change.text, 'utf8'); }
      else if (change.type === 'thinking_delta' && kind === 'thinking') { current.text += change.thinking; if (change.thinking) out.push({ kind: 'reasoning', text: change.thinking }); assembledBytes += Buffer.byteLength(change.thinking, 'utf8'); }
      else if (change.type === 'signature_delta' && kind === 'thinking') current.signature += change.signature;
      else if (change.type === 'input_json_delta' && kind === 'tool_use') { current.json += change.partial_json; assembledBytes += Buffer.byteLength(change.partial_json, 'utf8'); }
      else return fail('invalid-response');
      return assembledBytes > limits.responseMaxBytes;
    }
    if (type === 'content_block_stop') {
      const parsed = blockStop.safeParse(copied.data);
      if (!parsed.success || !current || current.index !== parsed.data.index) return fail('invalid-response');
      const open = current; current = null;
      if (open.type === 'text') blocks.push({ type: 'text', text: open.text });
      else if (open.type === 'thinking') blocks.push({ type: 'thinking', thinking: open.text, signature: open.signature });
      else if (open.type === 'redacted_thinking') blocks.push({ type: 'redacted_thinking', data: open.data });
      else {
        let input: unknown;
        try { input = JSON.parse(open.json === '' ? '{}' : open.json); } catch { return fail('invalid-response'); }
        if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('invalid-response');
        blocks.push({ type: 'tool_use', id: open.id, name: open.name, input });
      }
      return false;
    }
    if (type === 'message_delta') {
      const parsed = messageDelta.safeParse(copied.data);
      if (!parsed.success || current || stopReason !== null || parsed.data.delta.stop_reason === null) return fail('invalid-response');
      stopReason = parsed.data.delta.stop_reason; usage = mergeUsage(usage, parsed.data.usage); return false;
    }
    if (type === 'message_stop' && simple.safeParse(copied.data).success && !current && stopReason !== null) { stopped = true; return false; }
    return fail('invalid-response'); // unknown event types (server tools, future kinds) are never assembled silently.
  }

  function endLine(out: ModelInvocationDelta[]): boolean {
    const bytes = Buffer.concat(line, lineBytes); line = []; lineBytes = 0;
    let text: string;
    try { text = decoder.decode(bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes); } catch { return fail('invalid-response'); }
    if (text === '') {
      const name = eventName; eventName = null;
      if (data.length === 0) return false;
      const payload = data.join('\n'); data = []; eventBytes = 0;
      return event(payload, name, out);
    }
    if (text.startsWith(':')) return false;
    const colon = text.indexOf(':'), field = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? '' : text.slice(colon + (text[colon + 1] === ' ' ? 2 : 1));
    if (field === 'event') { eventName = value; return false; }
    if (field !== 'data') return false; // id and retry carry nothing for Messages.
    data.push(value); eventBytes += value.length;
    return eventBytes > limits.responseMaxBytes;
  }

  return Object.freeze({
    accept: 'text/event-stream',
    wireMaxBytes: Math.min(limits.responseMaxBytes * ANTHROPIC_STREAM_WIRE_FACTOR + request.max_completion_tokens * ANTHROPIC_STREAM_TOKEN_WIRE_BYTES, Number.MAX_SAFE_INTEGER),
    push(chunk: Buffer) {
      hash.update(chunk); wireBytes += chunk.byteLength;
      const out: ModelInvocationDelta[] = [];
      let limit = false, from = 0;
      if (invalid) return Object.freeze({ deltas: out, limit, rejected: invalid });
      if (errored) return Object.freeze({ deltas: out, limit });
      for (let index = chunk.indexOf(0x0a); index >= 0 && !invalid && !limit && !errored; index = chunk.indexOf(0x0a, from)) {
        line.push(chunk.subarray(from, index)); lineBytes += index - from; from = index + 1;
        limit = endLine(out);
      }
      if (!invalid && !limit && !errored && from < chunk.byteLength) {
        line.push(chunk.subarray(from)); lineBytes += chunk.byteLength - from;
        limit = lineBytes > limits.responseMaxBytes;
      }
      // Nothing after the first invalid event is presented or parsed; closing the connection stops generation (no draining).
      // Deltas of events that were valid and precede it in this same read are still presented: the observer must not depend on TCP segmentation.
      return Object.freeze({ deltas: out, limit, ...(invalid ? { rejected: invalid } : {}) });
    },
    finish(): NativeJsonHttpParsed {
      if (invalid) return { reason: invalid };
      if (errored) return { reason: 'interrupted' };
      if (lineBytes > 0 || data.length > 0 || current) return { reason: stopped ? 'invalid-response' : 'interrupted' };
      if (!stopped || !head || stopReason === null) return { reason: 'interrupted' };
      return assembleAnthropicMessage({ id: head.id, model: head.model, blocks, stopReason, usage,
        deckent: { stream: { schemaVersion: 1, events, wireBytes, wireSha256: hash.digest('hex') } } }, request, limits, memory);
    },
  });
}
