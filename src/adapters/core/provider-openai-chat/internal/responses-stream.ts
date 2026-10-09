import { createHash } from 'node:crypto';
import type { JsonObject, ModelInvocationDelta, ModelInvocationRejectionReason } from '#domain/index.js';
import type { NativeJsonHttpParsed, NativeJsonHttpStream } from '#adapters/core/provider-http-json/index.js';
import { openAiChatWireObjectSchema, type OpenAiChatHttpLimits, type OpenAiChatTextRequest } from './contract.js';
import { parseResponsesResponse, responsesOutputItemSchema } from './responses-response.js';
import { responsesValueDigest as digest } from './responses-body.js';
import { OPENAI_CHAT_STREAM_TOKEN_WIRE_BYTES, OPENAI_CHAT_STREAM_WIRE_FACTOR } from './stream.js';

type Item = { id: string; type: string; name?: string; callId?: string; arguments: string; argumentsDone?: boolean; done?: string };
type Text = { kind: 'text' | 'reasoning' | 'refusal'; value: string; done: boolean };
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const index = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const CR = '\r'.charCodeAt(0);

/** Compare streamed observations with the complete provider output; object field order carries no meaning. */
function compareResponsesOutput(items: ReadonlyMap<number, Item>, texts: ReadonlyMap<string, Text>, output: unknown, onlyPosition?: number): boolean {
  if (!Array.isArray(output)) return false;
  for (const [position, item] of items) {
    if (onlyPosition !== undefined && position !== onlyPosition) continue;
    const final = object(output[position]);
    if (!final || final['id'] !== item.id || final['type'] !== item.type || (item.done && item.done !== digest(final))) return false;
    if (item.type === 'function_call' && (final['name'] !== item.name || final['call_id'] !== item.callId
      || typeof final['arguments'] !== 'string' || (item.argumentsDone ? final['arguments'] !== item.arguments : !final['arguments'].startsWith(item.arguments)))) return false;
  }
  for (const [location, text] of texts) {
    const [position, part] = location.split(':').map(Number), final = object(output[position!]);
    if (onlyPosition !== undefined && position !== onlyPosition) continue;
    const entries = final?.[text.kind === 'reasoning' ? 'summary' : 'content'];
    const entry = Array.isArray(entries) ? object(entries[part!]) : null;
    const value = entry?.[text.kind === 'refusal' ? 'refusal' : 'text'];
    if (typeof value !== 'string' || (text.done ? value !== text.value : !value.startsWith(text.value))) return false;
  }
  return true;
}

/** Responses has a terminal response event, no [DONE]. Interim usage never settles; later contradictions withdraw terminal usage. */
export function createResponsesStream(request: OpenAiChatTextRequest, limits: OpenAiChatHttpLimits,
  onFinalUsage?: (usage: JsonObject, tier?: unknown) => void, onWithdraw?: () => void,
  onOutput?: (items: readonly Record<string, unknown>[], message: unknown) => void): NativeJsonHttpStream {
  const hash = createHash('sha256'), items = new Map<number, Item>(), texts = new Map<string, Text>();
  let wireBytes = 0, events = 0, line = Buffer.alloc(0), data: string[] = [], eventBytes = 0, assembledBytes = 0;
  let invalid: ModelInvocationRejectionReason | null = null, terminal: NativeJsonHttpParsed | null = null, finalRaw: Record<string, unknown> | null = null;
  let head: { id: string; created: unknown } | null = null, tier: unknown = undefined, sequence = -1, reported = false, withdrawn = false;
  const fail = (reason: ModelInvocationRejectionReason = 'invalid-response') => {
    invalid ??= reason;
    if (reported && !withdrawn) { withdrawn = true; onWithdraw?.(); }
  };
  const matchItem = (event: Record<string, unknown>) => {
    const item = index(event['output_index']) ? items.get(event['output_index']) : undefined;
    return item && item.id === event['item_id'] ? item : null;
  };
  const validTool = (name: unknown) => typeof name === 'string' && request.tool_choice !== 'none' && request.tools?.some(tool => tool.function.name === name);
  const compareOutput = (output: unknown, position?: number) => compareResponsesOutput(items, texts, output, position);
  function event(payload: string, deltas: ModelInvocationDelta[]) {
    if (terminal) { fail(); return; }
    let raw: unknown;
    try { raw = JSON.parse(payload); } catch { fail(); return; }
    const copied = openAiChatWireObjectSchema.safeParse(raw);
    if (!copied.success) { fail(); return; }
    const e = copied.data as Record<string, unknown>, type = e['type'];
    if (typeof type !== 'string' || !index(e['sequence_number']) || e['sequence_number'] <= sequence) { fail(); return; }
    sequence = e['sequence_number']; events++;
    if (type === 'error' || type === 'response.failed') { fail(); return; }
    if (['response.created', 'response.in_progress', 'response.completed', 'response.incomplete'].includes(type)) {
      const r = object(e['response']);
      if (!r || typeof r['id'] !== 'string' || r['object'] !== 'response' || r['model'] !== request.model) {
        fail(r?.['model'] !== undefined && r['model'] !== request.model ? 'model-mismatch' : 'invalid-response'); return;
      }
      if (head && (r['id'] !== head.id || r['created_at'] !== head.created)) { fail(); return; }
      head ??= { id: r['id'], created: r['created_at'] };
      if (r['service_tier'] != null) {
        if (tier !== undefined && tier !== r['service_tier']) { fail(); return; }
        tier = r['service_tier'];
      }
      if (type === 'response.created' || type === 'response.in_progress') {
        if (r['status'] !== 'in_progress' || r['error'] != null) fail();
        return; // usage here is deliberately ignored.
      }
      if (r['status'] !== (type === 'response.completed' ? 'completed' : 'incomplete') || !compareOutput(r['output'])) { fail(); return; }
      const parsed = parseResponsesResponse(r, request, limits);
      if ('reason' in parsed) { fail(parsed.reason); return; }
      // Terminal usage is published only after the object and all observed deltas have passed validation.
      terminal = parsed; finalRaw = r; reported = true;
      onFinalUsage?.(parsed.response.usage!, r['service_tier']); return;
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const position = e['output_index'], item = object(e['item']);
      if (!index(position) || !item || typeof item['id'] !== 'string' || !['message', 'function_call', 'reasoning'].includes(String(item['type']))) { fail(); return; }
      const found = items.get(position);
      if (type === 'response.output_item.added') {
        if (found || position !== items.size || [...items.values()].some(value => value.id === item['id'])
          || (item['type'] === 'function_call' && (!validTool(item['name']) || typeof item['call_id'] !== 'string'))) { fail(); return; }
        items.set(position, { id: item['id'], type: String(item['type']), arguments: '',
          ...(item['type'] === 'function_call' ? { name: item['name'] as string, callId: item['call_id'] as string } : {}) });
        assembledBytes += Buffer.byteLength(JSON.stringify(items.get(position)), 'utf8');
      } else {
        if (!found || found.done || !responsesOutputItemSchema.safeParse(item).success
          || !compareOutput([...Array(position).fill(null), item], position)) { fail(); return; }
        found.done = digest(item); // retain a fixed digest, not a second copy of the entire streamed item.
      }
      return;
    }
    const item = matchItem(e);
    if (!item || item.done) { fail(); return; }
    if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
      if (item.type !== 'function_call' || item.argumentsDone) { fail(); return; }
      const value = e[type.endsWith('.delta') ? 'delta' : 'arguments'];
      if (typeof value !== 'string') { fail(); return; }
      if (type.endsWith('.done')) {
        if (value !== item.arguments || e['name'] !== undefined && e['name'] !== item.name) { fail(); return; }
        item.argumentsDone = true;
      } else { item.arguments += value; assembledBytes += Buffer.byteLength(value, 'utf8'); }
      return;
    }
    const kind = type.startsWith('response.output_text.') ? 'text' : type.startsWith('response.reasoning_summary_text.') ? 'reasoning'
      : type.startsWith('response.refusal.') ? 'refusal' : null;
    if (kind) {
      const position = kind === 'reasoning' ? e['summary_index'] : e['content_index'];
      if (!index(position) || item.type !== (kind === 'reasoning' ? 'reasoning' : 'message')) { fail(); return; }
      const location = `${e['output_index']}:${position}`, found = texts.get(location) ?? { kind, value: '', done: false };
      if (found.kind !== kind || found.done) { fail(); return; }
      const value = e[type.endsWith('.delta') ? 'delta' : kind === 'refusal' ? 'refusal' : 'text'];
      if (typeof value !== 'string' || !type.endsWith('.delta') && !type.endsWith('.done')) { fail(); return; }
      if (type.endsWith('.done')) { if (value !== found.value) { fail(); return; } found.done = true; }
      else { found.value += value; assembledBytes += Buffer.byteLength(value, 'utf8'); if (kind !== 'refusal') deltas.push({ kind, text: value }); }
      texts.set(location, found); return;
    }
    // These structural events carry no text; their part identity is checked against the final object through subsequent deltas/done.
    if (['response.content_part.added', 'response.content_part.done', 'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done'].includes(type)) {
      const part = object(e['part']), summary = type.startsWith('response.reasoning'), position = e[summary ? 'summary_index' : 'content_index'];
      if (!part || !index(position) || item.type !== (summary ? 'reasoning' : 'message')) { fail(); return; }
      const kind = summary ? 'reasoning' : part['type'] === 'output_text' ? 'text' : part['type'] === 'refusal' ? 'refusal' : null;
      const value = part[kind === 'refusal' ? 'refusal' : 'text'];
      if (!kind || typeof value !== 'string' || summary && part['type'] !== 'summary_text') { fail(); return; }
      const location = `${e['output_index']}:${position}`, found = texts.get(location);
      if (type.endsWith('.added')) {
        if (found || value !== '') { fail(); return; }
        texts.set(location, { kind, value: '', done: false }); assembledBytes += Buffer.byteLength(location, 'utf8');
      } else if (!found || found.kind !== kind || found.value !== value) fail();
      return;
    }
    fail(); // An unsupported tool/effect or event never becomes an answer.
  }
  return Object.freeze({
    accept: 'text/event-stream',
    wireMaxBytes: Math.min(Number.MAX_SAFE_INTEGER, limits.responseMaxBytes * OPENAI_CHAT_STREAM_WIRE_FACTOR + request.max_completion_tokens * OPENAI_CHAT_STREAM_TOKEN_WIRE_BYTES),
    push(chunk: Buffer) {
      hash.update(chunk); wireBytes += chunk.length;
      const deltas: ModelInvocationDelta[] = [];
      let limit = false, start = 0;
      for (let end = chunk.indexOf(10); end >= 0 && !invalid && !limit; end = chunk.indexOf(10, start)) {
        const bytes = Buffer.concat([line, chunk.subarray(start, end)]); line = Buffer.alloc(0); start = end + 1;
        if (bytes.length > limits.responseMaxBytes) { limit = true; break; }
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.at(-1) === CR ? bytes.subarray(0, -1) : bytes); } catch { fail(); break; }
        if (text === '') {
          if (data.length) { event(data.join('\n'), deltas); data = []; eventBytes = 0; }
        } else if (text.startsWith('data:')) {
          const value = text.slice(text[5] === ' ' ? 6 : 5); data.push(value); eventBytes += Buffer.byteLength(value, 'utf8');
        }
        limit = eventBytes > limits.responseMaxBytes || assembledBytes > limits.responseMaxBytes;
      }
      if (!invalid && !limit && start < chunk.length) { line = Buffer.concat([line, chunk.subarray(start)]); limit = line.length > limits.responseMaxBytes; }
      return { deltas, limit, ...(invalid ? { rejected: invalid } : {}) };
    },
    finish(): NativeJsonHttpParsed {
      if (invalid) return { reason: invalid };
      if (line.length || data.length) { if (terminal) fail(); return { reason: 'interrupted' }; }
      if (!terminal) return { reason: 'interrupted' };
      if ('reason' in terminal) return terminal;
      const native: Record<string, unknown> = { ...terminal.response.native, deckent_stream: { schemaVersion: 1, events, wireBytes, wireSha256: hash.copy().digest('hex') } };
      if (Buffer.byteLength(JSON.stringify(native), 'utf8') > limits.responseMaxBytes) return { reason: 'response-limit' };
      if (finalRaw) onOutput?.(finalRaw['output'] as Record<string, unknown>[], (native['choices'] as unknown as { message: unknown }[])[0]?.message);
      return { response: { ...terminal.response, native: openAiChatWireObjectSchema.parse(native) } };
    },
  });
}
