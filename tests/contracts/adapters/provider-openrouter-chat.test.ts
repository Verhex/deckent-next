import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createOpenRouterPricedNative, parseOpenRouterChatDefinition } from '#adapters/core/provider-openrouter-chat/index.js';
import { fetchOpenRouterTariff, type OpenRouterMetadataObservation } from '#adapters/core/provider-openrouter-pricing/index.js';

const execute = promisify(execFile), servers: Server[] = [];
let directory = '', certificate = '', privateKey = '';
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'deckent-openrouter-chat-')); const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-keyout', key, '-out', cert,
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']); [privateKey, certificate] = await Promise.all([readFile(key, 'utf8'), readFile(cert, 'utf8')]);
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
