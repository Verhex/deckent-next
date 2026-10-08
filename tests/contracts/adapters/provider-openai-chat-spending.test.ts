import * as http from '#adapters/core/provider-http-json/index.js';
import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createOpenAiChatPricedNative, lookupOpenAiCompatibleTariff, quoteOpenAiChatOperatorTariff } from '#adapters/core/provider-openai-chat/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, providerSpendQuoteDigest, createProviderSpendAccount, reserveProviderSpend, settleProviderSpend } from '#engine/index.js';
const servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
const reference = { providerId: 'vendor', providerVersion: 1, modelId: 'model', modelVersion: 1 };
function fixture(endpoint: string, tariff: unknown, model = 'chat-latest') {
  const request = { model, messages: [{ role: 'user' as const, content: 'hello' }], max_completion_tokens: 10 };
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: 'a'.repeat(64),
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 4,
      definition: { endpoint, maxOutputTokens: 10, authentication: { type: 'none' }, tariff } },
    allocation: { id: 'allocation', maxCalls: 1, maxInFlight: 1 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 2000 } };
  const definition = { encodingVersion: 1, provider: { id: 'vendor', version: 1 }, model: { id: 'model', version: 1, nativeId: model,
    protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] } };
  const command = { schemaVersion: 1 as const, commandId: 'call', scopeId: 'scope', reference, catalogRevision: 'catalog',
    expectedBinding: { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: 'a'.repeat(64) }, nativeRequest: request };
  return { profile, definition, request, command, requestDigest: modelInvocationRequestDigest(command), profileDigest: modelInvocationProfileDigest(profile), prepared: {} };
}
const free = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 };
it('reserves verified vendor maximums and refuses unverified remote, forged price and mismatched model rows', () => {
  for (const [endpoint, model] of [['https://api.openai.com/v1/chat/completions', 'chat-latest'],
    ['https://api.z.ai/api/paas/v4/chat/completions', 'glm-4.7'], ['https://api.deepseek.com/chat/completions', 'deepseek-flash']]) {
    const tariff = lookupOpenAiCompatibleTariff(endpoint!, model!)!;
    expect(tariff.source.retrievedAt).toBe('2026-10-08');
    expect(quoteOpenAiChatOperatorTariff(fixture(endpoint!, tariff, model!))).toMatchObject({ maxChargeMinorUnits: expect.any(Number) });
    expect(quoteOpenAiChatOperatorTariff(fixture(endpoint!, tariff, model!)).maxChargeMinorUnits).toBeGreaterThan(0);
    expect(() => quoteOpenAiChatOperatorTariff(fixture(endpoint!, { ...tariff, usdPerMTok: { ...tariff.usdPerMTok, input: '0' } }, model!))).toThrow('PROVIDER_SPEND_TARIFF_UNVERIFIED');
  }
  expect(() => quoteOpenAiChatOperatorTariff(fixture('https://unverified.example/chat', free))).toThrow('PROVIDER_SPEND_TARIFF_UNVERIFIED');
  expect(quoteOpenAiChatOperatorTariff(fixture('http://127.0.0.1:1234/chat', free)).maxChargeMinorUnits).toBe(0);
  expect(lookupOpenAiCompatibleTariff('https://api.openai.com/v1/chat/completions', 'invented')).toBeNull();
});
it('settles actual usage including cached tokens at a declared non-zero tariff without retaining a secret extension', async () => {
  const server = createServer((request, response) => { request.resume(); response.end(JSON.stringify({ id: 'completion', object: 'chat.completion', created: 1, model: 'chat-latest',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 }, secret: 'sk-canary-do-not-retain' } })); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
  const f = fixture(`http://127.0.0.1:${address.port}/chat`, { kind: 'operator-static', version: 2, currency: 'USD', inputMinorUnitsPerMillionTokens: 200,
    cachedInputMinorUnitsPerMillionTokens: 50, outputMinorUnitsPerMillionTokens: 1000 });
  const priced = createOpenAiChatPricedNative(), prepared = await priced.native.prepare(f.profile, f.definition, f.request), quote = priced.quote({ ...f, prepared });
  const response = await priced.native.send(prepared); if ('kind' in response) throw new Error('response');
  const measurement = priced.native.observeSpending!(prepared, response)!;
  expect(measurement).toMatchObject({ basis: 'measured-tariff', exactMinorUnits: '0.024' });
  expect(JSON.stringify(measurement)).not.toContain('sk-canary');
  const budget = { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 100 };
  const reserved = reserveProviderSpend(createProviderSpendAccount(budget), budget, { schemaVersion: 1, scopeId: 'scope', invocationId: 'call',
    budgetId: 'budget', budgetRevision: 1, currency: 'USD', quote, quoteDigest: providerSpendQuoteDigest(quote) });
  const settled = settleProviderSpend(reserved.account, reserved.reservation, { kind: 'measured-tariff', measurement, evidenceDigest: 'a'.repeat(64) });
  expect(settled.account).toMatchObject({ reservedMinorUnits: 0, settledExactMinorUnits: '0.024' });
  expect(priced.native.observeSpending!(prepared, { ...response, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })).toBeNull();
});

it.each([
  ['https://api.openai.com/v1/chat/completions', 'chat-latest', '0.062'],
  ['https://api.z.ai/api/paas/v4/chat/completions', 'glm-4.7', '0.00624'],
  ['https://api.deepseek.com/chat/completions', 'deepseek-flash', '0.003024'],
  ['https://api.deepseek.com/chat/completions', 'deepseek-v4-pro', '0.012056'],
] as const)('matches verified tariff usage for %s; scheduled rates carry upper-bound', async (endpoint, model, exact) => {
  vi.spyOn(http, 'sendNativeJsonHttp').mockImplementation(async (_request, options) => {
    const parsed = options!.parseResponse!(Buffer.from(JSON.stringify({ id: 'completion', object: 'chat.completion', created: 1, model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 } } })));
    if (!('response' in parsed)) throw new Error('fixture'); return parsed.response;
  });
  const f = fixture(endpoint, lookupOpenAiCompatibleTariff(endpoint, model), model), priced = createOpenAiChatPricedNative();
  const prepared = await priced.native.prepare(f.profile, f.definition, f.request), quote = priced.quote({ ...f, prepared });
  const response = await priced.native.send(prepared); if ('kind' in response) throw new Error('fixture');
  const measurement = priced.native.observeSpending!(prepared, response);
  if (model.startsWith('deepseek-')) expect(measurement?.basis === 'measured-tariff' && measurement.source.tier).toBe('upper-bound');
  expect(measurement).toMatchObject({ basis: 'measured-tariff', exactMinorUnits: exact, source: { tariffDigest: quote.pricing.digest,
    dimensions: [{ field: 'input', tokens: 60 }, { field: 'cached-input', tokens: 40 }, { field: 'output', tokens: 10 }] } });
  const budget = { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 1000 };
  const reserved = reserveProviderSpend(createProviderSpendAccount(budget), budget, { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', budgetRevision: 1,
    invocationId: 'invocation', currency: 'USD', quote, quoteDigest: providerSpendQuoteDigest(quote) });
  expect(settleProviderSpend(reserved.account, reserved.reservation, { kind: 'measured-tariff', measurement, evidenceDigest: 'b'.repeat(64) }).account)
    .toMatchObject({ reservedMinorUnits: 0, settledExactMinorUnits: exact });
});

it('accepts exact fractional-cent operator rates and reserves the dearest cache class', () => {
  const tariff = { kind: 'operator-static', version: 2, currency: 'USD', inputMinorUnitsPerMillionTokens: '0.5',
    cachedInputMinorUnitsPerMillionTokens: '10.25', outputMinorUnitsPerMillionTokens: 0 };
  const f = fixture('https://operator.example/chat', tariff), quote = quoteOpenAiChatOperatorTariff(f);
  expect(quote.maxChargeMinorUnits).toBeGreaterThan(0);
  expect(quote.meter.evidence).toMatchObject({ calculation: { usdPerMTok: { input: '0.005', cachedInput: '0.1025', output: '0' } } });
  expect(() => quoteOpenAiChatOperatorTariff(fixture('https://operator.example/chat', { ...tariff, inputMinorUnitsPerMillionTokens: 0.1 }))).toThrow('OPENAI_CHAT_DEFINITION_INVALID');
});

it.each([
  ['gpt-6-astra', '0.119'], ['gpt-6.1-sol', '0.0234'], ['gpt-6-luna', '0.00119'],
] as const)('prices %s cache writes exclusively and reserves dearest Chat processing/context rates', async (model, exact) => {
  const endpoint = 'https://api.openai.com/v1/chat/completions';
  const f = fixture(endpoint, lookupOpenAiCompatibleTariff(endpoint, model), model), priced = createOpenAiChatPricedNative();
  let serviceTier = 'default', written: unknown = 20, prompt = 100;
  vi.spyOn(http, 'sendNativeJsonHttp').mockImplementation(async (_request, options) => {
    const parsed = options!.parseResponse!(Buffer.from(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model, service_tier: serviceTier,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: prompt, completion_tokens: 10, total_tokens: prompt + 10,
        prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: written }, completion_tokens_details: { reasoning_tokens: 5 } } })));
    if (!('response' in parsed)) throw new Error('fixture'); return parsed.response;
  });
  const observe = async () => {
    const prepared = await priced.native.prepare(f.profile, f.definition, f.request), quote = priced.quote({ ...f, prepared });
    const response = await priced.native.send(prepared); if ('kind' in response) throw new Error('fixture');
    return { measurement: priced.native.observeSpending!(prepared, response), quote };
  };
  const first = await observe();
  expect(first.measurement).toMatchObject({ exactMinorUnits: exact, source: { tier: 0, serviceTier: 'default', cacheSplit: 'reported',
    dimensions: [{ field: 'input', tokens: 40 }, { field: 'cached-input', tokens: 40 }, { field: 'cache-write', tokens: 20 }, { field: 'output', tokens: 10 }] } });
  const budget = { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 1000 };
  const reserved = reserveProviderSpend(createProviderSpendAccount(budget), budget, { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', budgetRevision: 1,
    invocationId: 'tiered', currency: 'USD', quote: first.quote, quoteDigest: providerSpendQuoteDigest(first.quote) });
  expect(settleProviderSpend(reserved.account, reserved.reservation, { kind: 'measured-tariff', measurement: first.measurement, evidenceDigest: 'b'.repeat(64) }).account)
    .toMatchObject({ reservedMinorUnits: 0, settledExactMinorUnits: exact, frozen: false });
  const tariff = lookupOpenAiCompatibleTariff(endpoint, model)!;
  if (tariff.version !== 2) throw new Error('fixture');
  expect(first.quote.meter.evidence).toMatchObject({ calculation: { usdPerMTok: tariff.processingTiers.find(t => t.serviceTier === 'priority')!.longContextUsdPerMTok } });
  for (serviceTier of ['flex', 'priority', 'fast']) {
    expect((await observe()).measurement).toMatchObject({ source: { serviceTier: serviceTier === 'fast' ? 'priority' : serviceTier } });
  }
  for (written of [undefined, -1, 61, 0.5, '20']) expect((await observe()).measurement).toBeNull();
  written = 20; serviceTier = 'unknown'; expect((await observe()).measurement).toBeNull();
  serviceTier = 'default'; prompt = 272000; expect((await observe()).measurement).toMatchObject({ source: { tier: 0 } });
  prompt = 272001; expect((await observe()).measurement).toMatchObject({ source: { tier: 1 } });
});

it('records a verified remote free GLM tariff as measured-tariff zero, never as legacy zero', async () => {
  const endpoint = 'https://api.z.ai/api/paas/v4/chat/completions', model = 'glm-4.7-flash';
  const tariff = lookupOpenAiCompatibleTariff(endpoint, model)!;
  const f = fixture(endpoint, tariff, model), priced = createOpenAiChatPricedNative();
  vi.spyOn(http, 'sendNativeJsonHttp').mockImplementation(async (_request, options) => {
    const parsed = options!.parseResponse!(Buffer.from(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })));
    if (!('response' in parsed)) throw new Error('fixture'); return parsed.response;
  });
  const prepared = await priced.native.prepare(f.profile, f.definition, f.request), quote = priced.quote({ ...f, prepared });
  const response = await priced.native.send(prepared); if ('kind' in response) throw new Error('fixture');
  expect(quote).toMatchObject({ maxChargeMinorUnits: 0, pricing: { id: 'openai-compatible-published-tariff', definition: { kind: 'vendor-published' } } });
  expect(priced.native.observeSpending!(prepared, response)).toMatchObject({ basis: 'measured-tariff', exactMinorUnits: '0', source: { tariffDigest: quote.pricing.digest } });
});

it.each([
  ['https://api.openai.com/v1/chat/completions', 'gpt-6.1-sol', '0.0234', 0],
  ['https://api.deepseek.com/chat/completions', 'deepseek-flash', '0.003024', 'upper-bound'],
] as const)('settles a cut stream for %s only from its final usage and service tier, never interim or missing usage', async (endpoint, model, exact, tier) => {
  const f = fixture(endpoint, lookupOpenAiCompatibleTariff(endpoint, model), model), priced = createOpenAiChatPricedNative();
  Object.assign(f.request, { stream: true, stream_options: { include_usage: true } });
  f.requestDigest = modelInvocationRequestDigest(f.command);
  const chunk = (body: object) => Buffer.from(`data: ${JSON.stringify({ id: 's', object: 'chat.completion.chunk', created: 1, model, service_tier: 'default', ...body })}\n\n`);
  const finishChunk = chunk({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] });
  const usageChunk = chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
    prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 } } });
  // none: cut before any usage; final: finish then usage-only chunk (OpenAI include_usage), cut before [DONE];
  // interim: the same usage before the finish chunk is never final (Astra 2459/2462 R1), so the tiered/upper-bound path holds.
  let shape: 'none' | 'final' | 'interim' = 'none';
  vi.spyOn(http, 'sendNativeJsonHttp').mockImplementation(async (_request, options) => {
    if (shape === 'final') { options!.stream!.push(finishChunk); options!.stream!.push(usageChunk); }
    if (shape === 'interim') { options!.stream!.push(usageChunk); options!.stream!.push(finishChunk); }
    throw new Error('fixture-interrupted');
  });
  for (shape of ['none', 'final', 'interim'] as const) {
    const prepared = await priced.native.prepare(f.profile, f.definition, f.request); priced.quote({ ...f, prepared });
    await expect(priced.native.send(prepared)).rejects.toThrow('fixture-interrupted');
    const measurement = priced.native.observePartialSpending!(prepared, 'c'.repeat(64));
    if (shape !== 'final') expect(measurement).toBeNull();
    else expect(measurement).toMatchObject({ basis: 'measured-tariff', exactMinorUnits: exact, source: { tier } });
  }
});

// Astra 2459 R1 + 2462 R1: a stream settles only from the provider's final usage, the usage carried by the finish chunk itself (DeepSeek/Z.ai)
// or by a later usage-only chunk (OpenAI include_usage). A usage chunk before the finish reason is interim: a later finish marker never
// promotes it to a final count, whether the stream is cut (unknown, held) or reaches [DONE] (invalid response, held).
const interimThenFinish = [{ delta: { role: 'assistant', content: 'par' }, usage: true }, { delta: { content: 'tial' } }, { delta: {}, finish: 'stop', usage: null }];
it.each([
  ['interim usage before any finish reason', [{ delta: { role: 'assistant', content: 'par' } }, { usage: true, delta: { content: 'tial' } }], '', 'interrupted', false],
  ['interim usage, more content, then a finish chunk with usage null', interimThenFinish, '', 'interrupted', false],
  ['interim usage, then finish and [DONE] without a final usage', interimThenFinish, 'data: [DONE]\n\n', 'invalid-response', false],
  ['usage in the finish chunk', [{ delta: { role: 'assistant', content: 'partial' } }, { usage: true, delta: {}, finish: 'stop' }], '', 'interrupted', true],
  ['usage-only chunk after the finish chunk', [{ delta: { role: 'assistant', content: 'partial' } }, { delta: {}, finish: 'stop' }, { usage: true }], '', 'interrupted', true],
] as const)('a stream with %s', async (_name, chunks, tail, reason, final) => {
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
  const wire = (chunks as readonly { delta?: object; finish?: string; usage?: true | null }[]).map(chunk => `data: ${JSON.stringify({ id: 'chunk', object: 'chat.completion.chunk', created: 1, model: 'chat-latest',
    choices: chunk.delta ? [{ index: 0, delta: chunk.delta, finish_reason: chunk.finish ?? null }] : [],
    ...(chunk.usage === undefined ? {} : { usage: chunk.usage === null ? null : usage }) })}\n\n`).join('') + tail;
  const server = createServer((request, response) => { request.resume(); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(wire); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
  const base = fixture(`http://127.0.0.1:${address.port}/chat`, { kind: 'operator-static', version: 2, currency: 'USD', inputMinorUnitsPerMillionTokens: 200,
    cachedInputMinorUnitsPerMillionTokens: 50, outputMinorUnitsPerMillionTokens: 1000 });
  const request = { ...base.request, stream: true, stream_options: { include_usage: true as const } }, command = { ...base.command, nativeRequest: request };
  const f = { ...base, request, command, requestDigest: modelInvocationRequestDigest(command) };
  const priced = createOpenAiChatPricedNative(), prepared = await priced.native.prepare(f.profile, f.definition, f.request);
  priced.quote({ ...f, prepared });
  const result = await priced.native.send(prepared);
  expect(result).toMatchObject({ kind: 'rejected', evidence: { reason, body: { complete: reason !== 'interrupted' } } });
  if (!('kind' in result)) throw new Error('expected a rejected stream');
  const measured = priced.native.observePartialSpending!(prepared, result.evidence.body.digest);
  if (final) expect(measured).toMatchObject({ basis: 'measured-tariff', exactMinorUnits: '0.03' });
  else expect(measured).toBeNull();
});
