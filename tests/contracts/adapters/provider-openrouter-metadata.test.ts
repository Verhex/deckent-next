import { createLocalTls } from '../../fixtures/local-tls.js';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { fetchOpenRouterTariff, quoteOpenRouterText, type OpenRouterPricingError } from '#adapters/core/provider-openrouter-pricing/index.js';

const servers: Server[] = [];
let directory = '', certificate = '', privateKey = '';
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'deckent-openrouter-metadata-'));
  ({ key: privateKey, caPem: certificate } = await createLocalTls(directory));
});
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
afterAll(async () => rm(directory, { recursive: true, force: true }));
async function fixture(handler: Parameters<typeof createServer>[1]) {
  const server = createServer({ key: privateKey, cert: certificate }, handler); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  return `https://127.0.0.1:${address.port}/api/v1/models/vendor/model/endpoints`;
}
const metadata = (pricing: Record<string, unknown> = {
  prompt: '0.000001', completion: '0.000002', request: '0', input_cache_read: '0', input_cache_write: '0', internal_reasoning: '0',
}) => ({ data: { id: 'vendor/model', authoritative: { revision: 'source-revision' }, endpoints: [{ model_id: 'vendor/model',
  tag: 'provider/region', provider_name: 'Provider', context_length: 4096, max_prompt_tokens: 1000, max_completion_tokens: 100,
  status: 0, supported_parameters: ['max_completion_tokens'], pricing }] } });
const options = (endpoint: string, overrides: Record<string, unknown> = {}) => ({ endpoint, modelId: 'vendor/model', endpointTag: 'provider/region',
  maxAgeMs: 1000, maxResponseBytes: 64_000, timeoutMs: 500, caPem: certificate, ...overrides });

it('fetches the exact TLS metadata path without auth or proxy and quotes only fully declared dimensions', async () => {
  const source = metadata(), body = Buffer.from(JSON.stringify(source)); let seen: { method?: string; url?: string; authorization?: string } = {};
  const endpoint = await fixture((req, res) => { seen = { method: req.method, url: req.url, authorization: req.headers.authorization };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); });
  const prior = process.env['HTTPS_PROXY']; process.env['HTTPS_PROXY'] = 'http://127.0.0.1:1';
  try {
    const observation = await fetchOpenRouterTariff(options(endpoint), () => 10);
    expect(seen).toEqual({ method: 'GET', url: '/api/v1/models/vendor/model/endpoints', authorization: undefined });
    expect(observation).toMatchObject({ schemaVersion: 1, sourceEndpoint: endpoint, receivedBytes: body.length, observedAtMs: 10,
      tariff: { metadata: source, pricedDimensions: ['completion', 'input_cache_read', 'input_cache_write', 'internal_reasoning', 'prompt', 'request'],
        unpricedDimensions: [] } });
    expect(observation.sourceBodyDigest).toBe(createHash('sha256').update(body).digest('hex'));
    source.data.authoritative.revision = 'mutated-after-fetch';
    expect((observation.tariff.metadata['data'] as { authoritative: { revision: string } }).authoritative.revision).toBe('source-revision');
    expect(quoteOpenRouterText(observation.tariff, { model: 'vendor/model', messages: [{ role: 'user', content: 'x' }],
      max_completion_tokens: 10 }, 10)).toMatchObject({ currency: 'USD', provider: { only: ['provider/region'], allow_fallbacks: false } });
    const incompleteBody = JSON.stringify(metadata({ prompt: '0.1', completion: '0.2' }));
    servers[0]!.removeAllListeners('request'); servers[0]!.on('request', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(incompleteBody);
    });
    const incomplete = await fetchOpenRouterTariff(options(endpoint), () => 20);
    expect(() => quoteOpenRouterText(incomplete.tariff, { model: 'vendor/model', messages: [{ role: 'user', content: 'x' }],
      max_completion_tokens: 10 }, 20)).toThrow('INCOMPLETE_PRICING');
  } finally { if (prior === undefined) delete process.env['HTTPS_PROXY']; else process.env['HTTPS_PROXY'] = prior; }
});

it('fails closed on untrusted TLS, redirects, forbidden responses, and never follows a redirect', async () => {
  let targetRequests = 0;
  const target = await fixture((_req, res) => { targetRequests++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(metadata())); });
  let mode: 'redirect' | 'forbidden' = 'redirect';
  const endpoint = await fixture((_req, res) => { if (mode === 'redirect') { res.writeHead(307, { location: target }); res.end(); }
    else { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{}'); } });
  const untrusted: Record<string, unknown> = options(endpoint); delete untrusted['caPem'];
  await expect(fetchOpenRouterTariff(untrusted as ReturnType<typeof options>, () => 1)).rejects.toMatchObject({ code: 'METADATA_UNAVAILABLE' } satisfies Partial<OpenRouterPricingError>);
  await expect(fetchOpenRouterTariff(options(endpoint), () => 1)).rejects.toMatchObject({ code: 'METADATA_UNAVAILABLE' } satisfies Partial<OpenRouterPricingError>);
  expect(targetRequests).toBe(0); mode = 'forbidden';
  await expect(fetchOpenRouterTariff(options(endpoint), () => 1)).rejects.toMatchObject({ code: 'METADATA_UNAVAILABLE' } satisfies Partial<OpenRouterPricingError>);
});

it('rejects malformed JSON, invalid UTF-8, strict metadata failures, and oversized bodies', async () => {
  const bodies = [Buffer.from('{'), Buffer.from([0xff]), Buffer.from(JSON.stringify({ data: { id: 'vendor/model', endpoints: [{}] } }))];
  let turn = 0; const endpoint = await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(bodies[turn++]!); });
  for (let index = 0; index < bodies.length; index++) {
    await expect(fetchOpenRouterTariff(options(endpoint), () => 1)).rejects.toMatchObject({ code: 'INVALID_METADATA' } satisfies Partial<OpenRouterPricingError>);
  }
  servers[0]!.removeAllListeners('request'); servers[0]!.on('request', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(metadata()));
  });
  await expect(fetchOpenRouterTariff(options(endpoint, { maxResponseBytes: 8 }), () => 1))
    .rejects.toMatchObject({ code: 'METADATA_TOO_LARGE' } satisfies Partial<OpenRouterPricingError>);
});

it('bounds timeout and cancellation across streaming and rejects a response completed after expiry', async () => {
  let mode: 'stall' | 'stream' | 'complete' = 'stall', release!: () => void, observeStream!: () => void;
  const streamObserved = new Promise<void>(resolve => { observeStream = resolve; });
  const endpoint = await fixture((_req, res) => {
    if (mode === 'stall') return;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'stream') { res.write('{"data":'); observeStream(); return; }
    res.end(JSON.stringify(metadata())); release?.();
  });
  await expect(fetchOpenRouterTariff(options(endpoint, { timeoutMs: 20 }), () => 1)).rejects.toMatchObject({ code: 'METADATA_TIMEOUT' } satisfies Partial<OpenRouterPricingError>);
  const pre = new AbortController(); pre.abort();
  await expect(fetchOpenRouterTariff(options(endpoint), () => 1, pre.signal)).rejects.toMatchObject({ code: 'METADATA_CANCELLED' } satisfies Partial<OpenRouterPricingError>);
  mode = 'stream'; const controller = new AbortController(), streaming = fetchOpenRouterTariff(options(endpoint), () => 1, controller.signal);
  await streamObserved; controller.abort();
  await expect(streaming).rejects.toMatchObject({ code: 'METADATA_CANCELLED' } satisfies Partial<OpenRouterPricingError>);
  mode = 'complete'; let clock = 10; const finished = new Promise<void>(resolve => { release = resolve; });
  const expiring = fetchOpenRouterTariff(options(endpoint, { maxAgeMs: 1 }), () => clock++);
  await finished; await expect(expiring).rejects.toMatchObject({ code: 'STALE_TARIFF' } satisfies Partial<OpenRouterPricingError>);
});
