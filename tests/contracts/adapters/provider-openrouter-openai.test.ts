import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createLocalTls } from '../../fixtures/local-tls.js';
import { createOpenRouterOpenAiPricedNative } from '#adapters/core/provider-openrouter-chat/index.js';
import { fetchOpenRouterTariff } from '#adapters/core/provider-openrouter-pricing/index.js';
import { classifyProviderRejection, createProviderSpendAccount, modelInvocationProfileDigest, modelInvocationRequestDigest,
  providerSpendQuoteDigest, reserveProviderSpend, settleProviderSpend } from '#engine/index.js';

let directory = '', caPem = '', key = '';
const servers: Server[] = [], model = 'vendor/model', tag = 'provider/region';
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'deckent-openrouter-v5-')); ({ caPem, key } = await createLocalTls(directory)); });
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read text', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: '__cost__' };
const cost = '0.01000000000000000001', exactCents = '1.000000000000000001';
const json = (value: unknown) => JSON.stringify(value).replace('"__cost__"', cost);
const chunk = (choice: object | null, extra: object = {}) => `data: ${json({ id: 'generation', object: 'chat.completion.chunk', created: 1, model,
  choices: choice ? [{ index: 0, ...choice }] : [], ...extra })}\n\n`;
const finish = chunk({ delta: {}, finish_reason: 'stop' });
const final = chunk({ delta: { role: 'assistant', content: '' }, finish_reason: 'stop' }, { usage });
const content = chunk({ delta: { content: 'ok' }, finish_reason: null });
async function fixture(answer: string, streamed: boolean, status = 200, requestMaxBytes = 4096, responseMaxBytes = 4096,
  retained?: { document: { data: { id: string } }; tag: string }) {
  let sent = '', metadataGets = 0, posts = 0;
  const model = retained?.document.data.id ?? 'vendor/model', tag = retained?.tag ?? 'provider/region', metadataPath = `/api/v1/models/${model}/endpoints`;
  const metadata = retained?.document ?? { data: { id: model, endpoints: [{ model_id: model, tag, provider_name: 'Vendor', context_length: 100,
    max_prompt_tokens: 100, max_completion_tokens: 10, status: 0, supported_parameters: ['max_tokens', 'tools', 'tool_choice'],
    // W9-PROVIDER-ERRORS: tool_choice needs the endpoint's explicit supports_tool_choice (unknown refuses; provider-openrouter-pricing).
    supports_tool_choice: { auto: true, none: true, required: true },
    pricing: { prompt: '0.01', completion: '0.02', request: '0', input_cache_read: '0', input_cache_write: '0', internal_reasoning: '0' } }] } };
  const server = createServer({ ca: caPem, cert: caPem, key }, (req, res) => {
    if (req.url === '/api/v1/endpoints/zdr') { res.writeHead(200, { 'content-type': 'application/json' });
      const data = (metadata as { data: { endpoints: { model_id: string; tag: string }[] } }).data.endpoints;
      res.end(JSON.stringify({ data: data.filter(e => e.tag === tag || e.tag.startsWith(`${tag}/`)).map(e => ({ model_id: e.model_id, tag: e.tag })) })); return; }
    if (req.url === metadataPath) { metadataGets++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(metadata)); return; }
    posts++;
    req.setEncoding('utf8'); req.on('data', text => { sent += text; }); req.on('end', () => {
      res.writeHead(status, { 'content-type': streamed && status === 200 ? 'text/event-stream' : 'application/json' }); res.end(answer);
    });
  }); servers.push(server); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('fixture'); const origin = `https://127.0.0.1:${addr.port}`;
  const observed = await fetchOpenRouterTariff({ endpoint: `${origin}${metadataPath}`, modelId: model, endpointTag: tag, maxAgeMs: 1000,
    maxResponseBytes: retained ? 131072 : 4096, timeoutMs: 1000, caPem }, () => 10);
  const reference = { providerId: 'vendor', providerVersion: 1, modelId: 'model', modelVersion: 1 };
  const profile = { schemaVersion: 1, id: 'p', version: 1, scopeId: 'scope', reference, bindingDigest: 'a'.repeat(64),
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 5,
      definition: { endpoint: `${origin}/chat`, authentication: { type: 'none' }, tls: { caPem }, maxOutputTokens: 10,
        dialect: { tokenLimitField: 'max_tokens', streamUsage: 'omit', toolChoice: ['auto', 'none', 'required'], finalUsageChoice: 'repeat-finish' },
        tariff: { kind: 'openrouter-endpoint', version: 1, currency: 'USD', metadataEndpoint: `${origin}${metadataPath}`, endpointTag: tag,
          metadataLimits: { maxAgeMs: 1000, maxResponseBytes: 4096, timeoutMs: 1000 } } } },
    allocation: { id: 'p', maxCalls: 2, maxInFlight: 1 }, limits: { requestMaxBytes, responseMaxBytes, timeoutMs: 1000 } };
  const definition = { encodingVersion: 1, provider: { id: 'vendor', version: 1 }, model: { id: 'model', version: 1, nativeId: model,
    protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [{ id: 'tool-calls', version: 1, state: 'supported' }] }] } };
  const request = { model, messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 10, tools, tool_choice: 'auto',
    ...(streamed ? { stream: true, stream_options: { include_usage: true } } : {}) };
  const command = { schemaVersion: 1, commandId: 'call', scopeId: 'scope', reference, catalogRevision: 'c',
    expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: 'a'.repeat(64) }, nativeRequest: request };
  const priced = createOpenRouterOpenAiPricedNative({ currentObservation: () => observed, now: () => 10 });
  const prepare = () => priced.native.prepare(profile as never, definition as never, request);
  const prepared = requestMaxBytes < 1000 ? null : await prepare();
  const quote = prepared && priced.quote({ profile, definition, command, requestDigest: modelInvocationRequestDigest(command),
    profileDigest: modelInvocationProfileDigest(profile as never), prepared } as never);
  const budget = { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: Math.max(1000, quote?.maxChargeMinorUnits ?? 0) };
  const reserved = quote && reserveProviderSpend(createProviderSpendAccount(budget), budget, { schemaVersion: 1, scopeId: 'scope', invocationId: 'call',
    budgetId: 'budget', budgetRevision: 1, currency: 'USD', quote, quoteDigest: providerSpendQuoteDigest(quote) });
  return { priced, prepared, quote, reserved, prepare, counts: () => [metadataGets, posts], seen: () => JSON.parse(sent || '{}') as Record<string, unknown> };
}

it.each([
  ['sonnet-endpoints.json', 'anthropic'], ['sol-endpoints.json', 'openai'],
  ['z-ai--glm-5.3-endpoints.json', 'z-ai'], ['deepseek--deepseek-v4.1-flash-endpoints.json', 'deepseek'],
])('passes retained %s through local TLS metadata → v5 reservation → routed POST → final cost settlement', async (file, tag) => {
  const document = JSON.parse(readFileSync(new URL(`../../fixtures/openrouter-endpoints/${file}`, import.meta.url), 'utf8')) as { data: { id: string } };
  const answer = json({ id: 'generation', object: 'chat.completion', created: 1, model: document.data.id,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fixture' } }], usage });
  const f = await fixture(answer, false, 200, 4096, 4096, { document, tag });
  expect(f.counts()).toEqual([1, 0]); // Acquisition only; reserve/prepare add no network access.
  const response = await f.priced.native.send(f.prepared);
  if ('kind' in response) throw new Error(JSON.stringify(response));
  expect(f.counts()).toEqual([1, 1]);
  expect(f.seen()).toMatchObject({ model: document.data.id, tools, modalities: ['text'],
    plugins: expect.arrayContaining([{ id: 'web', enabled: false }]), provider: { only: (document as { data: { endpoints: { tag: string }[] } }).data.endpoints.filter(e => e.tag === tag || e.tag.startsWith(`${tag}/`)).map(e => e.tag).sort(), data_collection: 'deny', zdr: true, allow_fallbacks: false, require_parameters: true } });
  const measurement = f.priced.native.observeSpending!(f.prepared, response)!;
  expect(measurement).toMatchObject({ basis: 'provider-reported', exactMinorUnits: exactCents, source: { numericSource: cost } });
  expect(settleProviderSpend(f.reserved!.account, f.reserved!.reservation, { kind: 'provider-reported', measurement: measurement as never,
    evidenceDigest: 'b'.repeat(64) }).account).toMatchObject({ settledExactMinorUnits: exactCents, reservedMinorUnits: 0, frozen: false });
});

it.each([false, true])('reserves tools and stream=%s, settles raw usage.cost as provider-reported, sends pinned routing and max_tokens', async streamed => {
  const answer = streamed ? content + finish + final + 'data: [DONE]\n\n' : json({ id: 'generation', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage });
  const f = await fixture(answer, streamed), deltas: unknown[] = [];
  expect(f.reserved!.account.reservedMinorUnits).toBe(f.quote!.maxChargeMinorUnits);
  const response = await f.priced.native.send(f.prepared, undefined, delta => { deltas.push(delta); });
  if ('kind' in response) throw new Error(JSON.stringify(response));
  const measurement = f.priced.native.observeSpending!(f.prepared, response)!;
  expect(measurement).toMatchObject({ basis: 'provider-reported', exactMinorUnits: exactCents, source: { numericSource: cost } });
  expect(settleProviderSpend(f.reserved!.account, f.reserved!.reservation, { kind: 'provider-reported', measurement: measurement as never,
    evidenceDigest: 'b'.repeat(64) }).account).toMatchObject({ reservedMinorUnits: 0, settledExactMinorUnits: exactCents, frozen: false });
  expect(f.seen()).toMatchObject({ max_tokens: 10, tools, modalities: ['text'], plugins: expect.arrayContaining([
    { id: 'web', enabled: false }, { id: 'file-parser', enabled: false }, { id: 'fusion', enabled: false },
  ]), provider: { only: [tag], data_collection: 'deny', zdr: true, allow_fallbacks: false, require_parameters: true } }); // the default metadata has one endpoint under the tag
  expect((f.seen()['plugins'] as { enabled: boolean }[]).every(plugin => plugin.enabled === false)).toBe(true);
  expect(f.seen()).not.toHaveProperty('max_completion_tokens'); expect(f.seen()).not.toHaveProperty('stream_options');
  if (streamed) expect(deltas).toEqual([{ kind: 'text', text: 'ok' }]);
});

it.each([
  ['cut before final usage', content + finish, 'interrupted', false],
  ['interim then finish cut', chunk({ delta: { content: 'ok' }, finish_reason: null }, { usage }) + finish, 'interrupted', false],
  ['interim then finish done', chunk({ delta: { content: 'ok' }, finish_reason: null }, { usage }) + finish + 'data: [DONE]\n\n', 'invalid-response', false],
  ['final then clean cut', content + finish + final, 'interrupted', true],
  ['final then conflicting tier', content + chunk({ delta: {}, finish_reason: 'stop' }, { service_tier: 'default' }) + final
    + chunk(null, { service_tier: 'priority' }), 'invalid-response', false],
  ['final then content', content + finish + final + chunk({ delta: { content: 'contradiction' } }), 'invalid-response', false],
  ['final then invalid trailer', content + finish + final + 'data: [DONE]\n\ndata: nope\n\n', 'invalid-response', false],
  ['repeat finish with different reason', content + finish + chunk({ delta: { content: '' }, finish_reason: 'length' }, { usage }), 'invalid-response', false],
] as const)('%s preserves final-only and contradiction withdrawal', async (_label, wire, reason, measured) => {
  const f = await fixture(wire, true), response = await f.priced.native.send(f.prepared);
  expect(response).toMatchObject({ kind: 'rejected', evidence: { reason } });
  const measurement = f.priced.native.observePartialSpending!(f.prepared, 'c'.repeat(64));
  expect(measurement !== null).toBe(measured);
  const settled = settleProviderSpend(f.reserved!.account, f.reserved!.reservation, measurement
    ? { kind: 'provider-reported', measurement: measurement as never, evidenceDigest: 'd'.repeat(64) }
    : { kind: 'hold', reason: 'missing-usage', evidenceDigest: 'd'.repeat(64) } as never);
  expect(settled.account.reservedMinorUnits).toBe(measured ? 0 : f.quote!.maxChargeMinorUnits);
});

it.each(['account', 'api_key', 'openrouter_in_flight_budget'])('402 limit_source=%s maps to the existing typed spend-limit refusal', async limitSource => {
  const f = await fixture(json({ error: { code: 402, message: 'exhausted', metadata: { limit_source: limitSource } } }), true, 402);
  const response = await f.priced.native.send(f.prepared);
  expect(response).toMatchObject({ kind: 'rejected', evidence: { httpStatus: 402, reason: 'http-status' } });
  if (!('kind' in response) || response.kind !== 'rejected') throw new Error('fixture');
  expect(classifyProviderRejection({ ...response.evidence, body: { data: Buffer.from(response.evidence.body.data, 'base64').toString() } })).toBe('spend-limit');
  expect(f.priced.native.observePartialSpending!(f.prepared, 'c'.repeat(64))).toBeNull();
});

it('routing bytes are included in request limits before any send', async () => {
  const f = await fixture('', true, 200, 64);
  await expect(f.prepare()).rejects.toMatchObject({ code: 'OPENAI_CHAT_REQUEST_TOO_LARGE' }); expect(f.seen()).toEqual({});
});

it.each([false, true])('accepts a declared tool call from the shared transport, stream=%s', async streamed => {
  const call = { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } };
  const toolChunk = chunk({ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null });
  const toolFinish = chunk({ delta: {}, finish_reason: 'tool_calls' });
  const toolFinal = chunk({ delta: { content: '', role: 'assistant' }, finish_reason: 'tool_calls' }, { usage });
  const answer = streamed ? toolChunk + toolFinish + toolFinal + 'data: [DONE]\n\n' : json({ id: 'generation', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [call] } }], usage });
  const f = await fixture(answer, streamed), response = await f.priced.native.send(f.prepared);
  expect(response).toMatchObject({ native: { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [call] } }] } });
  if ('kind' in response) throw new Error('fixture');
  expect(f.priced.native.observeSpending!(f.prepared, response)).toMatchObject({ basis: 'provider-reported', exactMinorUnits: exactCents });
});

it('withdraws a contradicted final cost even when refusal evidence is retention-capped', async () => {
  const wire = content + finish + final + chunk({ delta: { content: 'contradiction' } });
  const f = await fixture(wire, true, 200, 4096, 512), response = await f.priced.native.send(f.prepared);
  expect(response).toMatchObject({ kind: 'rejected', evidence: { reason: 'response-limit', body: { complete: false } } });
  expect(f.priced.native.observePartialSpending!(f.prepared, 'c'.repeat(64))).toBeNull();
});
