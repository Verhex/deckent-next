import { expect, it } from 'vitest';
import { createResponsesStream } from '#adapters/core/provider-openai-chat/index.js';
import type { ModelInvocationDelta } from '#domain/index.js';
import { responsesFixture, responsesFinal, responsesCreated, responsesUsage, textItem, callItem, reasoningItem, event } from '../support/openai-responses.js';

const limits = { responseMaxBytes: 8192, timeoutMs: 2000, requestMaxBytes: 8192 };
const reasoning = { ...reasoningItem(), content: [{ type: 'reasoning_text', text: 'Synthetic reasoning' }], status: 'completed' };
const secondCall = { ...callItem(), id: 'fc_2', call_id: 'call_2', arguments: '{"path":"b.ts"}' };
const outputs = [
  ['message', [reasoning, textItem()]],
  ['two function calls', [reasoning, callItem(), secondCall]],
] as const;

/** Synthetic SSE: complete observations plus a separately emitted terminal object. No customer content. */
function parse(done: readonly Record<string, unknown>[], final: readonly Record<string, unknown>[], split = false) {
  const request = responsesFixture('http://127.0.0.1:1/v1/responses').request;
  const usage: unknown[] = [], retained: unknown[] = [], withdrawn: number[] = [], deltas: ModelInvocationDelta[] = [];
  const stream = createResponsesStream(request as never, limits, value => usage.push(value), () => withdrawn.push(1), value => retained.push(value));
  let sequence = 1;
  const wire = [responsesCreated()];
  for (const [output_index, item] of done.entries()) {
    wire.push(event('response.output_item.added', sequence++, { output_index, item }));
    if (item['type'] === 'reasoning' || item['type'] === 'message') {
      const summary = item['type'] === 'reasoning', kind = summary ? 'reasoning_summary_text' : 'output_text';
      const entries = item[summary ? 'summary' : 'content'] as { text: string }[];
      const position = summary ? 'summary_index' : 'content_index';
      for (const [part, entry] of entries.entries()) {
        wire.push(event(`response.${kind}.delta`, sequence++, { output_index, item_id: item['id'], [position]: part, delta: entry.text }));
        wire.push(event(`response.${kind}.done`, sequence++, { output_index, item_id: item['id'], [position]: part, text: entry.text }));
      }
    } else {
      wire.push(event('response.function_call_arguments.delta', sequence++, { output_index, item_id: item['id'], delta: item['arguments'] }));
      wire.push(event('response.function_call_arguments.done', sequence++, { output_index, item_id: item['id'], arguments: item['arguments'] }));
    }
    wire.push(event('response.output_item.done', sequence++, { output_index, item }));
  }
  wire.push(event('response.completed', sequence, { response: responsesFinal([...final]) }));
  const bytes = Buffer.from(wire.join(''));
  for (const chunk of split ? [...bytes].map(byte => Buffer.from([byte])) : [bytes]) deltas.push(...stream.push(chunk).deltas);
  return { result: stream.finish(), usage, retained, withdrawn, deltas };
}

it.each(outputs)('accepts a changed opaque reasoning blob with %s and retains only the final value', (_name, output) => {
  const final = [{ ...reasoning, encrypted_content: 'final-opaque-reasoning' }, ...output.slice(1)];
  for (const split of [false, true]) {
    const parsed = parse(output, final, split);
    expect(parsed.result).toHaveProperty('response');
    expect(parsed.usage).toEqual([{ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
      prompt_tokens_details: responsesUsage().input_tokens_details, completion_tokens_details: responsesUsage().output_tokens_details }]);
    expect(parsed.withdrawn).toEqual([]);
    expect(parsed.retained).toEqual([final]);
    expect(parsed.deltas).toEqual([{ kind: 'reasoning', text: 'Plan' }, ...(_name === 'message' ? [{ kind: 'text', text: 'ok' }] : [])]);
    expect(JSON.stringify(parsed.result)).not.toContain('final-opaque-reasoning');
    expect(JSON.stringify(parsed.result)).not.toContain(reasoning.encrypted_content);
  }
});

it.each([
  ['summary', { summary: [{ type: 'summary_text', text: 'Changed' }] }],
  ['id', { id: 'rs_changed' }],
  ['type', { type: 'message' }],
  ['content', { content: [{ type: 'reasoning_text', text: 'Changed' }] }],
  ['status', { status: 'incomplete' }],
  ['extra field', { provider_metadata: 'changed' }],
  ['nested encrypted_content', { summary: [{ type: 'summary_text', text: 'Plan', encrypted_content: 'nested' }] }],
  ['invalid opaque blob', { encrypted_content: 42 }],
])('rejects a changed reasoning %s despite a different opaque blob', (_name, patch) => {
  const parsed = parse([reasoning, textItem()], [{ ...reasoning, encrypted_content: 'final-opaque-reasoning', ...patch }, textItem()]);
  expect(parsed.result).toEqual({ reason: 'invalid-response' });
  expect(parsed.usage).toEqual([]); expect(parsed.retained).toEqual([]);
});

it.each([
  ['message text', textItem(), { content: textItem('changed').content }],
  ['message annotations', textItem(), { content: [{ ...textItem().content[0], annotations: [{ type: 'url_citation', url: 'https://example.test' }] }] }],
  ['message id', textItem(), { id: 'msg_changed' }],
  ['message role', textItem(), { role: 'user' }],
  ['message encrypted_content', { ...textItem(), encrypted_content: 'original' }, { encrypted_content: 'changed' }],
  ['function name', callItem(), { name: 'write_file' }],
  ['function call_id', callItem(), { call_id: 'call_changed' }],
  ['function arguments', callItem(), { arguments: '{}' }],
  ['function id', callItem(), { id: 'fc_changed' }],
  ['function status', callItem(), { status: 'incomplete' }],
  ['function encrypted_content', { ...callItem(), encrypted_content: 'original' }, { encrypted_content: 'changed' }],
])('rejects changed %s while permitting only the reasoning blob difference', (_name, item, patch) => {
  const parsed = parse([reasoning, item], [{ ...reasoning, encrypted_content: 'final-opaque-reasoning' }, { ...item, ...patch }]);
  expect(parsed.result).toEqual({ reason: 'invalid-response' });
  expect(parsed.usage).toEqual([]); expect(parsed.retained).toEqual([]);
});

it('compares every reasoning field independent of object key order', () => {
  const reordered = Object.fromEntries(Object.entries(reasoning).reverse());
  expect(parse([reasoning, callItem()], [reordered, callItem()]).result).toHaveProperty('response');
});
