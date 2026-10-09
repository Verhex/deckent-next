import * as http from '#adapters/core/provider-http-json/index.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createOpenAiChatPricedNative, createOpenAiChatNativePort, createResponsesStream, openAiChatMessageFromInvocation,
  openAiChatUsageFromInvocation, mapOpenAiErrorResponse, openAiProviderRefusal } from '#adapters/core/provider-openai-chat/index.js';
import { lookupOpenAiCompatibleTariff } from '#adapters/core/provider-openai-chat/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, createProviderSpendAccount, reserveProviderSpend,
  settleProviderSpend, providerSpendQuoteDigest, createModelInvocationResponseEvidence } from '#engine/index.js';
import { t } from '#platform/index.js';
import type { ModelInvocationDelta } from '#domain/index.js';
import { RESPONSES_MODEL, responsesFixture, responsesFinal, responsesUsage, responsesCreated, textItem, callItem, reasoningItem, toolStream, event } from '../support/openai-responses.js';

afterEach(() => { vi.restoreAllMocks(); });
/** Synthetic transport receipt: the real native/quote/parser contracts, no socket, key or paid provider call. */
async function fixture(body: string, status = 200, stream = true) {
  const sent: Record<string, unknown>[] = [];
  vi.spyOn(http, 'sendNativeJsonHttp').mockImplementation(async (request, options) => {
    sent.push(JSON.parse(request.body));
    const reject = (reason: 'http-status' | 'invalid-response' | 'model-mismatch' | 'response-limit' | 'interrupted') => ({ kind: 'rejected' as const,
      evidence: createModelInvocationResponseEvidence(request.adapter, reason, status, Buffer.from(body), reason !== 'interrupted') });
    if (status !== 200) return reject('http-status');
    if (stream) {
      const pushed = options.stream!.push(Buffer.from(body));
      for (const delta of pushed.deltas) options.onDelta?.(delta);
      if (pushed.rejected) return reject(pushed.rejected);
      if (pushed.limit) return reject('response-limit');
      const parsed = options.stream!.finish(); return 'reason' in parsed ? reject(parsed.reason) : parsed.response;
    }
    const parsed = options.parseResponse!(Buffer.from(body)); return 'reason' in parsed ? reject(parsed.reason) : parsed.response;
  });
  return { endpoint: 'http://127.0.0.1:1/v1/responses', sent };
}
const invocation = (response: unknown) => ({ response }) as never;
const limits = { responseMaxBytes: 8192, timeoutMs: 2000, requestMaxBytes: 8192 };
function parse(parts: string[], request = responsesFixture('http://127.0.0.1:1/v1/responses').request, split = false) {
  const final: unknown[] = [], withdrawn: number[] = [], deltas: ModelInvocationDelta[] = [];
  const stream = createResponsesStream(request as never, limits, (usage, tier) => final.push({ usage, tier }), () => withdrawn.push(1));
  for (const part of parts) for (const chunk of split ? [...Buffer.from(part)].map(byte => Buffer.from([byte])) : [Buffer.from(part)]) deltas.push(...stream.push(chunk).deltas);
  return { result: stream.finish(), final, withdrawn, deltas, stream };
}
it('sends Responses tools/reasoning/store:false; streams a tool turn, replays opaque reasoning only for the exact scope/profile/prefix', async () => {
  const host = await fixture(toolStream().join('')), f = responsesFixture(host.endpoint), priced = createOpenAiChatPricedNative();
  const prepared = await priced.native.prepare(f.profile, f.definition, f.request), deltas: ModelInvocationDelta[] = [];
  const result = await priced.native.send(prepared, undefined, delta => deltas.push(delta));
  expect('kind' in result).toBe(false);
  expect(host.sent[0]).toMatchObject({ store: false, reasoning: { effort: 'medium' }, max_output_tokens: 32,
    tools: [{ type: 'function', name: 'read_file', strict: false }], input: [{ role: 'user', content: 'read a.ts' }] });
  for (const absent of ['messages', 'reasoning_effort', 'max_completion_tokens', 'stream_options', 'previous_response_id', 'conversation']) expect(host.sent[0]).not.toHaveProperty(absent);
  expect(deltas).toEqual([{ kind: 'reasoning', text: 'Plan' }]);
  expect(openAiChatMessageFromInvocation(invocation(result))).toMatchObject({ finish: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' }] });
  expect(openAiChatUsageFromInvocation(invocation(result))).toEqual({ promptTokens: 100, completionTokens: 10, reasoningTokens: 6 });
  expect(JSON.stringify(result)).not.toContain('opaque-reasoning-canary');
  const messages = [...f.request.messages, { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'file content' }];
  const continuationRequest = { ...f.request, messages, max_completion_tokens: 1 };
  const continuation = await priced.native.prepare(f.profile, f.definition, continuationRequest);
  const input = JSON.parse((continuation as { body: string }).body).input;
  expect(input).toContainEqual(expect.objectContaining({ type: 'reasoning', encrypted_content: 'opaque-reasoning-canary' }));
  expect(input).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: 'file content' });
  const command = { ...f.command, commandId: 'follow', nativeRequest: continuationRequest };
  const quote = priced.quote({ ...f, command, prepared: continuation, profileDigest: modelInvocationProfileDigest(f.profile), requestDigest: modelInvocationRequestDigest(command) } as never);
  expect(quote.meter.evidence).toMatchObject({ calculation: { reasoningInputTokensUpperBound: 32 } });
  const calculation = quote.meter.evidence['calculation'] as { inputBound: number };
  expect(calculation.inputBound).toBeGreaterThanOrEqual(Buffer.byteLength((continuation as { body: string }).body) + 32);
  const foreign = await priced.native.prepare({ ...f.profile, scopeId: 'foreign' }, f.definition, { ...f.request, messages });
  expect((foreign as { body: string }).body).not.toContain('opaque-reasoning-canary');
  const changed = await priced.native.prepare(f.profile, f.definition, { ...f.request, messages: [{ role: 'user', content: 'different' }, ...messages.slice(1)] });
  expect((changed as { body: string }).body).not.toContain('opaque-reasoning-canary');
});
it('normalizes text and typed refusals, incomplete output and provider failure without yielding incomplete tool calls', async () => {
  const host = await fixture(JSON.stringify(responsesFinal()), 200, false), f = responsesFixture(host.endpoint, false), native = createOpenAiChatNativePort();
  const token = await native.prepare(f.profile, f.definition, { ...f.request, reasoning_effort: 'high', service_tier: 'flex' });
  const result = await native.send(token);
  expect(openAiChatMessageFromInvocation(invocation(result))).toMatchObject({ content: 'ok', finish: 'stop' });
  expect(host.sent[0]).toMatchObject({ reasoning: { effort: 'high' }, service_tier: 'flex' });
  const refusal = responsesFinal([{ ...textItem(), content: [{ type: 'refusal', refusal: 'Cannot assist.' }] }]);
  const parsed = parse([responsesCreated(), event('response.completed', 1, { response: refusal })]).result;
  expect('response' in parsed && openAiProviderRefusal(parsed.response)).toEqual({ kind: 'provider-refusal', message: 'Cannot assist.' });
  expect(parse([responsesCreated(), event('response.incomplete', 1, { response: responsesFinal([textItem('partial')], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) })]).result)
    .toMatchObject({ response: { native: { choices: [{ finish_reason: 'length' }] } } });
  expect(parse([responsesCreated(), event('response.incomplete', 1, { response: responsesFinal([callItem()], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) })]).result)
    .toMatchObject({ reason: 'invalid-response' });
  expect(parse([responsesCreated(), event('response.failed', 1, { response: responsesFinal([], { status: 'failed', error: { code: 'server_error', message: 'failed' } }) })]).final).toEqual([]);
});
it('parses CRLF, comments, UTF-8 split boundaries and multiline SSE without depending on TCP segmentation', () => {
  const final = responsesFinal([textItem('İ🙂')]), parts = [
    ': keepalive\r\n\r\n' + responsesCreated().replaceAll('\n', '\r\n'),
    event('response.output_item.added', 1, { output_index: 0, item: { ...textItem(''), status: 'in_progress' } }),
    event('response.output_text.delta', 2, { output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'İ🙂' }),
    event('response.output_text.done', 3, { output_index: 0, item_id: 'msg_1', content_index: 0, text: 'İ🙂' }),
    `data: ${JSON.stringify({ type: 'response.completed', sequence_number: 4, response: final }, null, 2).split('\n').join('\ndata: ')}\n\n`,
  ];
  const split = parse(parts, undefined, true), combined = parse([parts.join('')]);
  expect(split.deltas).toEqual(combined.deltas); expect(split.final).toEqual(combined.final);
  expect(split.result).toMatchObject({ response: { native: { choices: [{ message: { content: 'İ🙂' } }] } } });
});
it('settles input/cache/output/reasoning once under the existing reservation; only terminal usage measures a cut stream', async () => {
  const host = await fixture(event('response.completed', 1, { response: responsesFinal() })), f = responsesFixture(host.endpoint), priced = createOpenAiChatPricedNative();
  const prepared = await priced.native.prepare(f.profile, f.definition, f.request);
  const quote = priced.quote({ ...f, prepared, profileDigest: modelInvocationProfileDigest(f.profile), requestDigest: modelInvocationRequestDigest(f.command) } as never);
  const result = await priced.native.send(prepared); if ('kind' in result) throw new Error('response');
  const measurement = priced.native.observeSpending!(prepared, result)!;
  expect(measurement).toMatchObject({ exactMinorUnits: '0.024', source: { dimensions: [
    { field: 'input', tokens: 60 }, { field: 'cached-input', tokens: 40 }, { field: 'output', tokens: 4 }, { field: 'reasoning', tokens: 6 }] } });
  const budget = { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 100 };
  const reserved = reserveProviderSpend(createProviderSpendAccount(budget), budget, { schemaVersion: 1, scopeId: 'scope', invocationId: 'call',
    budgetId: 'budget', budgetRevision: 1, currency: 'USD', quote, quoteDigest: providerSpendQuoteDigest(quote) });
  expect(settleProviderSpend(reserved.account, reserved.reservation, { kind: 'measured-tariff', measurement, evidenceDigest: 'a'.repeat(64) }).account)
    .toMatchObject({ reservedMinorUnits: 0, settledExactMinorUnits: '0.024' });
  const interim = parse([responsesCreated({ usage: responsesUsage() })]);
  expect(interim.final).toEqual([]); expect(interim.result).toEqual({ reason: 'interrupted' });
  const terminal = parse([event('response.completed', 1, { response: responsesFinal() })]);
  expect(terminal.final).toHaveLength(1); expect(terminal.withdrawn).toEqual([]);
  terminal.stream.push(Buffer.from('data: broken\n\n'));
  expect(terminal.withdrawn).toEqual([1]);
});
it.each([
  ['duplicate terminal', event('response.completed', 2, { response: responsesFinal() })],
  ['tier contradiction', event('response.in_progress', 2, { response: responsesFinal([], { status: 'in_progress', service_tier: 'priority' }) })],
  ['unknown event', event('response.unknown', 2, {})],
  ['provider error', event('error', 2, { code: 'server_error', message: 'failed' })],
  ['truncated trailing event', 'data: {'],
])('withdraws final usage after %s', (_name, bad) => {
  const parsed = parse([event('response.completed', 1, { response: responsesFinal() }), bad]);
  expect(parsed.final).toHaveLength(1); expect(parsed.withdrawn).toEqual([1]); expect(parsed.result).toHaveProperty('reason');
});
it('refuses missing/inconsistent usage, undeclared tools, none-choice calls, changed output and identity; never promotes an interim count', () => {
  const base = responsesFixture('http://127.0.0.1:1/v1/responses').request;
  for (const response of [responsesFinal([], { usage: null }), responsesFinal([callItem('write_file')]), responsesFinal([], { model: 'foreign' }),
    responsesFinal([], { usage: { ...responsesUsage(), output_tokens_details: { reasoning_tokens: 11 } } }),
    responsesFinal([], { usage: { ...responsesUsage(), input_tokens_details: { cached_tokens: 101 } } })]) {
    expect(parse([responsesCreated({ usage: responsesUsage() }), event('response.completed', 1, { response })]).final).toEqual([]);
  }
  expect(parse(toolStream(), { ...base, tool_choice: 'none' }).result).toMatchObject({ reason: 'invalid-response' });
  expect(parse(toolStream().slice(0, -1)).result).toMatchObject({ reason: 'interrupted' });
  const changed = toolStream(); changed[changed.length - 1] = event('response.completed', 11, { response: responsesFinal([reasoningItem(), { ...callItem(), arguments: '{}' }]) });
  expect(parse(changed).final).toEqual([]);
});
it('HTTP 400 retains error evidence, shows bounded typed vendor details and TR/EN next steps, with no usage measurement', async () => {
  const message = 'Function tools with reasoning_effort are not supported in /v1/chat/completions. Use /v1/responses.';
  const body = JSON.stringify({ error: { message, type: 'invalid_request_error', param: 'reasoning_effort' } });
  const host = await fixture(body, 400, false), f = responsesFixture(host.endpoint), priced = createOpenAiChatPricedNative();
  const prepared = await priced.native.prepare(f.profile, f.definition, f.request), result = await priced.native.send(prepared);
  expect(result).toMatchObject({ kind: 'rejected', evidence: { httpStatus: 400, reason: 'http-status', adapter: { version: 6 } } });
  if (!('kind' in result)) throw new Error('rejection');
  expect(mapOpenAiErrorResponse(400, result.evidence.body.data)).toMatchObject({ kind: 'invalid-request', message, param: 'reasoning_effort' });
  expect(priced.native.observePartialSpending!(prepared, result.evidence.body.digest)).toBeNull();
  const tr = t('tui.openai.badRequest', { message }, 'tr'), en = t('tui.openai.badRequest', { message }, 'en');
  expect(tr).toContain('Güncel protokole geç'); expect(tr).toContain(message); expect(tr).not.toContain('The model round ended without an answer');
  expect(en).toContain('Switch to the current protocol');
  expect(mapOpenAiErrorResponse(400, Buffer.from('bad').toString('base64'))?.message).toBeNull();
  expect(mapOpenAiErrorResponse(401, Buffer.from(body).toString('base64'))).toBeNull();
  expect(mapOpenAiErrorResponse(400, Buffer.from(JSON.stringify({ error: { message: 'x'.repeat(3000) } })).toString('base64'))?.message).toHaveLength(1024);
  expect(mapOpenAiErrorResponse(400, Buffer.from(JSON.stringify({ error: { message: 'x\u001b[31m\ny\u0085z' } })).toString('base64'))?.message).toBe('x [31m y z');
});
it('fails effort/profile/tools/size validation before send and preserves legacy dialect versions', async () => {
  const f = responsesFixture('http://127.0.0.1:1/v1/responses'), native = createOpenAiChatNativePort();
  await expect(native.prepare(f.profile, f.definition, { ...f.request, reasoning_effort: 'none' })).rejects.toThrow('OPENAI_CHAT_REQUEST_INVALID');
  await expect(native.prepare({ ...f.profile, adapter: { ...f.profile.adapter, version: 5 } }, f.definition, f.request)).rejects.toThrow('OPENAI_CHAT_DEFINITION_INVALID');
  await expect(native.prepare(f.profile, { ...f.definition, model: { ...f.definition.model, protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] } }, f.request)).rejects.toThrow('OPENAI_CHAT_REQUEST_INVALID');
  await expect(native.prepare({ ...f.profile, limits: { ...f.profile.limits, requestMaxBytes: 10 } }, f.definition, f.request)).rejects.toThrow('OPENAI_CHAT_REQUEST_TOO_LARGE');
  const bounded = createResponsesStream(f.request as never, { ...limits, responseMaxBytes: 16 });
  expect(bounded.push(Buffer.from('data: ' + 'x'.repeat(100))).limit).toBe(true);
  expect(RESPONSES_MODEL).toBe(f.request.model);
});
it.each([['default', '0.0229'], ['flex', '0.01145'], ['fast', '0.0458'], ['priority', '0.0458']])(
  'prices reported cache writes, cached reads and reasoning at the actual %s tier', async (service_tier, exactMinorUnits) => {
    const usage = { ...responsesUsage(), input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 } };
    await fixture(event('response.completed', 1, { response: responsesFinal(undefined, { usage, service_tier }) }));
    const f = responsesFixture('https://api.openai.com/v1/responses'), priced = createOpenAiChatPricedNative();
    const profile = { ...f.profile, adapter: { ...f.profile.adapter, definition: { ...f.profile.adapter.definition,
      tariff: lookupOpenAiCompatibleTariff('https://api.openai.com/v1/responses', RESPONSES_MODEL)! } } };
    const prepared = await priced.native.prepare(profile, f.definition, f.request);
    priced.quote({ ...f, profile, prepared, profileDigest: modelInvocationProfileDigest(profile), requestDigest: modelInvocationRequestDigest(f.command) } as never);
    const result = await priced.native.send(prepared); if ('kind' in result) throw new Error('response');
    expect(priced.native.observeSpending!(prepared, result)).toMatchObject({ exactMinorUnits, source: { serviceTier: service_tier === 'fast' ? 'priority' : service_tier,
      dimensions: [{ field: 'input', tokens: 50 }, { field: 'cached-input', tokens: 40 }, { field: 'cache-write', tokens: 10 }, { field: 'output', tokens: 4 }, { field: 'reasoning', tokens: 6 }] } });
  });
it.each([
  ['missing cache-write count', { usage: { ...responsesUsage(), input_tokens_details: { cached_tokens: 40 } } }],
  ['unknown processing tariff', { service_tier: 'unknown-tier' }],
])('keeps %s unmeasured instead of guessing zero or a tariff', async (_name, patch) => {
  await fixture(event('response.completed', 1, { response: responsesFinal(undefined, patch) }));
  const f = responsesFixture('https://api.openai.com/v1/responses'), priced = createOpenAiChatPricedNative();
  const profile = { ...f.profile, adapter: { ...f.profile.adapter, definition: { ...f.profile.adapter.definition,
    tariff: lookupOpenAiCompatibleTariff('https://api.openai.com/v1/responses', RESPONSES_MODEL)! } } };
  const prepared = await priced.native.prepare(profile, f.definition, f.request);
  priced.quote({ ...f, profile, prepared, profileDigest: modelInvocationProfileDigest(profile), requestDigest: modelInvocationRequestDigest(f.command) } as never);
  const result = await priced.native.send(prepared); if ('kind' in result) throw new Error('response');
  expect(priced.native.observeSpending!(prepared, result)).toBeNull();
});
