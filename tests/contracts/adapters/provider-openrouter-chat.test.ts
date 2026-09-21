import { createLocalTls } from '../../fixtures/local-tls.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createOpenRouterPricedNative, parseOpenRouterChatDefinition } from '#adapters/core/provider-openrouter-chat/index.js';
import { fetchOpenRouterTariff, type OpenRouterMetadataObservation } from '#adapters/core/provider-openrouter-pricing/index.js';

const servers: Server[] = [];
let directory = '', certificate = '', privateKey = '';
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'deckent-openrouter-chat-')); ({ key: privateKey, caPem: certificate } = await createLocalTls(directory));
});
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } });
afterAll(async () => rm(directory, { recursive: true, force: true }));
const source = () => ({ data: { id: 'vendor/model', endpoints: [{ model_id: 'vendor/model', tag: 'provider/region', provider_name: 'Provider Display',
  context_length: 100, max_prompt_tokens: 10, max_completion_tokens: 4, status: 0, supported_parameters: ['max_completion_tokens'],
  pricing: { prompt: '0.01', completion: '0.02', request: '0', input_cache_read: '0', input_cache_write: '0', internal_reasoning: '0', discount: 0 } }] } });
async function fixture(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void) {
  const server = createServer({ key: privateKey, cert: certificate }, handler); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS'); return `https://127.0.0.1:${address.port}`;
}
function profile(origin: string, authentication: unknown = { type: 'none' }) {
  return { schemaVersion: 1, id: 'profile', version: 1, scopeId: 'scope', reference: { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 },
    bindingDigest: 'a'.repeat(64), protocol: { family: 'openrouter-chat-completions', version: 'v1' }, adapter: { id: 'openrouter-chat-http', version: 1,
      definition: { endpoint: `${origin}/chat`, authentication, tls: { caPem: certificate }, maxOutputTokens: 3, metadataEndpoint: `${origin}${metadataPath}`, endpointTag: 'provider/region', metadataLimits: { maxAgeMs: 60_000, maxResponseBytes: 64_000, timeoutMs: 1000 } } },
    allocation: { id: 'allocation', maxCalls: 2, maxInFlight: 2 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 500 } };
}
const binding = { encodingVersion: 1, provider: { id: 'provider', version: 1 }, model: { id: 'model', version: 1, nativeId: 'vendor/model',
  protocols: [{ family: 'openrouter-chat-completions', version: 'v1', capabilities: [] }] } };
const request = { model: 'vendor/model', messages: [{ role: 'user', content: 'native text' }], max_completion_tokens: 2 };
const metadataPath = '/api/v1/models/vendor/model/endpoints';
function replyMetadata(response: import('node:http').ServerResponse, body = source()) {
  response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
}
async function observation(origin: string, now = 10) { return fetchOpenRouterTariff({ endpoint: `${origin}${metadataPath}`, modelId: 'vendor/model', endpointTag: 'provider/region',
  maxAgeMs: 100, maxResponseBytes: 64_000, timeoutMs: 500, caPem: certificate }, () => now); }

it('requires bounded immutable metadata acquisition limits in the adapter definition', () => {
  const source = profile('https://fixture.invalid').adapter.definition;
  const parsed = parseOpenRouterChatDefinition(source);
  expect(parsed.metadataLimits).toEqual({ maxAgeMs: 60_000, maxResponseBytes: 64_000, timeoutMs: 1000 });
  expect(Object.isFrozen(parsed.metadataLimits)).toBe(true);
  source.metadataLimits.maxAgeMs = 1;
  expect(parsed.metadataLimits.maxAgeMs).toBe(60_000);

  const { maxAgeMs: _age, ...withoutAge } = source.metadataLimits;
  const { maxResponseBytes: _bytes, ...withoutBytes } = source.metadataLimits;
  const { timeoutMs: _timeout, ...withoutTimeout } = source.metadataLimits;
  void _age; void _bytes; void _timeout;
  for (const value of [
    { ...source, metadataLimits: withoutAge }, { ...source, metadataLimits: withoutBytes }, { ...source, metadataLimits: withoutTimeout },
    { ...source, metadataLimits: { ...source.metadataLimits, maxAgeMs: 0 } },
    { ...source, metadataLimits: { ...source.metadataLimits, timeoutMs: 1.5 } },
    { ...source, metadataLimits: { ...source.metadataLimits, maxResponseBytes: 1_048_577 } },
    { ...source, metadataLimits: { ...source.metadataLimits, acquisitionMode: 'implicit' } },
  ]) expect(() => parseOpenRouterChatDefinition(value)).toThrow(expect.objectContaining({ code: 'INVALID_PROFILE' }));
});

it('prepares without POST or credential lookup and emits one exact full-tag routing body', async () => {
  let posts = 0, credentials = 0, seen = ''; const origin = await fixture((req, res) => {
    if (req.url === metadataPath) return void replyMetadata(res); posts++; req.on('data', chunk => { seen += chunk; }); req.on('end', () => res.end('{}'));
  });
  const observed = await observation(origin), adapter = createOpenRouterPricedNative({ currentObservation: () => observed, now: () => 10,
    resolveCredential: async () => { credentials++; return 'synthetic-secret'; } });
  const prepared = await adapter.native.prepare(profile(origin), binding, request);
  expect(posts).toBe(0); expect(credentials).toBe(0);
  await adapter.native.send(prepared);
  expect(credentials).toBe(0); expect(JSON.parse(seen)).toEqual({ ...request, stream: false, provider: { only: ['provider/region'], order: ['provider/region'],
    allow_fallbacks: false, require_parameters: true, max_price: { prompt: '10000', completion: '20000', request: '0' } } });
});

it('fences changed or expired metadata before any POST and consumes each prepared token once', async () => {
  let posts = 0, now = 10; const origin = await fixture((req, res) => { if (req.url === metadataPath) return void replyMetadata(res); posts++; res.end('{}'); });
  const first = await observation(origin), changed = await observation(origin, 11); let current: OpenRouterMetadataObservation = first;
  const adapter = createOpenRouterPricedNative({ currentObservation: () => current, now: () => now });
  const prepared = await adapter.native.prepare(profile(origin), binding, request); current = changed;
  await expect(adapter.native.send(prepared)).rejects.toMatchObject({ code: 'TARIFF_CONFLICT' }); expect(posts).toBe(0);
  current = first; now = 10; const expiring = await adapter.native.prepare(profile(origin), binding, request); now = 110;
  await expect(adapter.native.send(expiring)).rejects.toMatchObject({ code: 'STALE_TARIFF' }); expect(posts).toBe(0);
  await expect(adapter.native.send(expiring)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});

it('resolves a synthetic credential only while sending and preserves provider response usage without settlement claims', async () => {
  let credentials = 0, authorization = '', chatRequests = 0; const origin = await fixture((req, res) => {
    if (req.url === metadataPath) return void replyMetadata(res); authorization = String(req.headers.authorization); chatRequests++;
    if (chatRequests === 1) return void res.end('synthetic-secret'); res.end(JSON.stringify({ id: 'completion', object: 'chat.completion', created: 1,
      model: 'vendor/model', provider_name: 'Provider Display', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'answer' } }],
      usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 } }));
  });
  const observed = await observation(origin), adapter = createOpenRouterPricedNative({ currentObservation: () => observed, now: () => 10,
    resolveCredential: async reference => { credentials++; expect(reference).toBe('SECRET_REF'); return 'synthetic-secret'; } });
  const prepared = await adapter.native.prepare(profile(origin, { type: 'bearer', credentialRef: 'SECRET_REF' }), binding, request);
  expect(credentials).toBe(0); await expect(adapter.native.send(prepared)).rejects.toMatchObject({ code: 'NATIVE_JSON_HTTP_CREDENTIAL_ECHO' });
  expect(credentials).toBe(1); const result = await adapter.native.send(await adapter.native.prepare(profile(origin, { type: 'bearer', credentialRef: 'SECRET_REF' }), binding, request));
  expect(authorization).toBe('Bearer synthetic-secret'); expect(result).toEqual({ schemaVersion: 1, native: expect.objectContaining({ provider_name: 'Provider Display' }),
    usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 } });
});

it('rejects structural profile/request violations and tags a mismatched response without another provider interpretation', async () => {
  let posts = 0; const origin = await fixture((req, res) => { if (req.url === metadataPath) return void replyMetadata(res); posts++;
    res.end(JSON.stringify({ id: 'completion', object: 'chat.completion', created: 1, model: 'other/model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'answer' } }] })); });
  const observed = await observation(origin), adapter = createOpenRouterPricedNative({ currentObservation: () => observed, now: () => 10 });
  for (const value of [{ ...request, tools: [] }, { ...request, max_tokens: 2 }, { ...request, max_completion_tokens: 4 }, { ...profile(origin), adapter: { id: 'other', version: 1, definition: {} } }]) {
    if ('model' in value) await expect(adapter.native.prepare(profile(origin), binding, value)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    else await expect(adapter.native.prepare(value, binding, request)).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
  }
  expect(posts).toBe(0); const prepared = await adapter.native.prepare(profile(origin), binding, request);
  await expect(adapter.native.send(prepared)).resolves.toMatchObject({ kind: 'rejected', evidence: { reason: 'model-mismatch' } }); expect(posts).toBe(1);
});

const chatResponse = (usage = '"cost":0.00021', extra = '') => `{"id":"completion","object":"chat.completion","created":1,"model":"vendor/model",
  "choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"answer"}}],"usage":{"prompt_tokens":12,"completion_tokens":9,"total_tokens":21${usage ? `,${usage}` : ''}}${extra ? `,${extra}` : ''}}`;
const responseWithoutUsage = () => `{"id":"completion","object":"chat.completion","created":1,"model":"vendor/model",
  "choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"answer"}}]}`;

it('captures only the successful native response as immutable provider-reported cost evidence without fetching tariff or credentials again', async () => {
  let posts = 0, metadata = 0, credentials = 0;
  const body = chatResponse('"cost":0.00021,"cost_details":{"upstream_inference_cost":99}');
  const origin = await fixture((req, res) => {
    if (req.url === metadataPath) { metadata++; return void replyMetadata(res); }
    posts++; res.end(body);
  });
  let clock = 10; const observed = await observation(origin), adapter = createOpenRouterPricedNative({ currentObservation: () => observed, now: () => clock,
    resolveCredential: async () => { credentials++; return 'synthetic-secret'; } });
  const prepared = await adapter.native.prepare(profile(origin, { type: 'bearer', credentialRef: 'SECRET_REF' }), binding, request);
  const response = await adapter.native.send(prepared);
  expect(response).toMatchObject({ schemaVersion: 1, usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21, cost: 0.00021 } });
  expect(metadata).toBe(1); expect(posts).toBe(1); expect(credentials).toBe(1);
  clock = 110; // The capture must remain usable after its send-time tariff has expired.
  const evidence = adapter.usageEvidence(prepared, response);
  expect(evidence).toEqual({ kind: 'reported', evidence: expect.objectContaining({ schemaVersion: 1, basis: 'provider-reported', currency: 'USD',
    exactChargeUsd: '0.00021', roundedChargeMinorUnits: 1, rounding: 'ceil-total', source: expect.objectContaining({ field: 'usage.cost',
      numericSource: '0.00021', generationId: 'completion', modelId: 'vendor/model', bodyDigest: expect.any(String), responseDigest: expect.any(String) }),
    context: { profileDigest: expect.stringMatching(/^[a-f0-9]{64}$/), tariffDigest: observed.tariff.tariffDigest,
      requestBodyDigest: expect.stringMatching(/^[a-f0-9]{64}$/), selectedEndpointTag: 'provider/region' },
    usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21, cost: 0.00021, cost_details: { upstream_inference_cost: 99 } } }) });
  expect(Object.isFrozen((evidence as { evidence: { usage: object } }).evidence.usage)).toBe(true);
  expect(metadata).toBe(1); expect(posts).toBe(1); expect(credentials).toBe(1);
  expect(adapter.usageEvidence(prepared, { ...response, native: { ...(response as { native: object }).native } })).toEqual(evidence);
  expect(adapter.usageEvidence(prepared, { usage: response.usage, native: response.native, schemaVersion: response.schemaVersion })).toEqual(evidence);
  clock = 10; const foreign = await createOpenRouterPricedNative({ currentObservation: () => observed, now: () => clock }).native.prepare(profile(origin), binding, request);
  await expect(Promise.resolve().then(() => adapter.usageEvidence(foreign, response))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(Promise.resolve().then(() => adapter.usageEvidence({}, response))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(Promise.resolve().then(() => adapter.usageEvidence(prepared, { ...response, usage: null }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});

it('holds invalid or missing native usage.cost values, preserves decimal precision, and never reads a nested cost', async () => {
  const replies = [
    chatResponse('"cost":0'), responseWithoutUsage(), chatResponse(''), chatResponse('"cost":null'), chatResponse('"cost":-1'), chatResponse('"cost":"0.1"'),
    chatResponse('"cost":1e-128'), chatResponse('"cost":1e-999'), chatResponse('"cost":0.0100000000000000000001'),
    chatResponse('"other": {"cost": 9}', '"cost":9'),
  ];
  let posts = 0, metadata = 0;
  const origin = await fixture((req, res) => {
    if (req.url === metadataPath) { metadata++; return void replyMetadata(res); }
    const reply = replies[posts++]; if (!reply) throw new Error('UNEXPECTED_POST'); res.end(reply);
  });
  const observed = await observation(origin), adapter = createOpenRouterPricedNative({ currentObservation: () => observed, now: () => 10 });
  const collect = async () => { const prepared = await adapter.native.prepare(profile(origin), binding, request); return [prepared, await adapter.native.send(prepared)] as const; };
  const [zeroPrepared, zero] = await collect();
  expect(adapter.usageEvidence(zeroPrepared, zero)).toMatchObject({ kind: 'reported', evidence: { exactChargeUsd: '0', roundedChargeMinorUnits: 0 } });
  const [missingUsagePrepared, missingUsage] = await collect();
  expect(adapter.usageEvidence(missingUsagePrepared, missingUsage)).toEqual({ kind: 'hold', reason: 'missing-usage' });
  for (const reason of ['missing-cost', 'invalid-cost', 'invalid-cost', 'invalid-cost'] as const) {
    const [prepared, response] = await collect(); expect(adapter.usageEvidence(prepared, response)).toEqual({ kind: 'hold', reason });
  }
  const [tinyPrepared, tiny] = await collect();
  expect(adapter.usageEvidence(tinyPrepared, tiny)).toMatchObject({ kind: 'reported', evidence: { roundedChargeMinorUnits: 1,
    source: { numericSource: '1e-128' } } });
  const [underflowPrepared, underflow] = await collect();
  expect(adapter.usageEvidence(underflowPrepared, underflow)).toEqual({ kind: 'hold', reason: 'invalid-cost' });
  const [precisePrepared, precise] = await collect();
  expect(adapter.usageEvidence(precisePrepared, precise)).toMatchObject({ kind: 'reported', evidence: { exactChargeUsd: '0.0100000000000000000001', roundedChargeMinorUnits: 2 } });
  const [nestedPrepared, nested] = await collect();
  expect(adapter.usageEvidence(nestedPrepared, nested)).toEqual({ kind: 'hold', reason: 'missing-cost' });
  expect(metadata).toBe(1); expect(posts).toBe(replies.length);
});

it('refuses evidence for pre-send tokens and a credential-echo response', async () => {
  let credentials = 0;
  const origin = await fixture((req, res) => {
    if (req.url === metadataPath) return void replyMetadata(res);
    res.end('synthetic-secret');
  });
  const observed = await observation(origin), adapter = createOpenRouterPricedNative({ currentObservation: () => observed, now: () => 10,
    resolveCredential: async () => { credentials++; return 'synthetic-secret'; } });
  const unsent = await adapter.native.prepare(profile(origin, { type: 'bearer', credentialRef: 'SECRET_REF' }), binding, request);
  await expect(Promise.resolve().then(() => adapter.usageEvidence(unsent, {}))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(adapter.native.send(unsent)).rejects.toMatchObject({ code: 'NATIVE_JSON_HTTP_CREDENTIAL_ECHO' });
  await expect(Promise.resolve().then(() => adapter.usageEvidence(unsent, {}))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(credentials).toBe(1);
});

it('does not publish reported cost from an HTTP rejection or a broken transport', async () => {
  let posts = 0;
  const origin = await fixture((req, res) => {
    if (req.url === metadataPath) return void replyMetadata(res);
    if (++posts === 1) { res.writeHead(429); res.end(chatResponse('"cost":0')); }
    else req.socket.destroy();
  });
  const observed = await observation(origin), adapter = createOpenRouterPricedNative({ currentObservation: () => observed, now: () => 10 });
  const rejected = await adapter.native.prepare(profile(origin), binding, request);
  const rejection = await adapter.native.send(rejected);
  expect(rejection).toMatchObject({ kind: 'rejected', evidence: { reason: 'http-status', body: { complete: true } } });
  expect(() => adapter.usageEvidence(rejected, rejection)).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  const interrupted = await adapter.native.prepare(profile(origin), binding, request);
  await expect(adapter.native.send(interrupted)).rejects.toMatchObject({ code: 'NATIVE_JSON_HTTP_TRANSPORT_UNKNOWN' });
  expect(() => adapter.usageEvidence(interrupted, {})).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  expect(posts).toBe(2);
});
