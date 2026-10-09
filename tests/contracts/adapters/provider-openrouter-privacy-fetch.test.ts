import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { fetchOpenRouterTariff, quoteOpenRouterText, requireOpenRouterMetadataObservation } from '#adapters/core/provider-openrouter-pricing/index.js';

// Exercise the real acquisition/parser with captured JSON, replacing only node:https I/O.
// These are transport simulations; the separate retained TLS tests remain required.
const wire = vi.hoisted(() => ({ replies: [] as { body: string; status?: number; stall?: boolean }[],
  calls: [] as { url: string; method: string; headers: Record<string, string>; agent: { options: Record<string, unknown> } }[] }));
vi.mock('node:https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>(), { EventEmitter } = await import('node:events');
  return { ...actual, request: (url: URL, options: typeof wire.calls[number], receive: (response: unknown) => void) => {
    wire.calls.push({ ...options, url: url.href });
    const reply = wire.replies.shift()!;
    const request = Object.assign(new EventEmitter(), { destroy() {}, end() {
      queueMicrotask(() => {
        if (reply.stall) return;
        const response = Object.assign(new EventEmitter(), { statusCode: reply.status ?? 200, headers: { 'content-type': 'application/json' }, complete: true, destroy() {} });
        receive(response); response.emit('data', Buffer.from(reply.body)); response.emit('end');
      });
    } });
    return request;
  } };
});
const document = () => JSON.parse(readFileSync(new URL('../../fixtures/openrouter-endpoints/deepseek--deepseek-v4.1-flash-endpoints.json', import.meta.url), 'utf8')) as
  { data: { id: string; endpoints: { tag: string; data_policy?: { training: boolean; retainsPrompts: boolean } }[] } };
const source = document(), endpoint = `https://openrouter.ai/api/v1/models/${source.data.id}/endpoints`;
const options = { endpoint, modelId: source.data.id, endpointTag: 'deepseek', maxAgeMs: 1000, maxResponseBytes: 64_000, timeoutMs: 100 };
const inventory = JSON.stringify({ data: [{ model_id: source.data.id, tag: 'deepseek', provider_name: 'DeepSeek', context_length: 1048576 }] });
beforeEach(() => { wire.calls = []; wire.replies = [{ body: JSON.stringify(document()) }, { body: inventory }]; });

it('acquires model metadata and endpoint ZDR inventory without credentials, then quotes explicit privacy controls', async () => {
  const observation = requireOpenRouterMetadataObservation(await fetchOpenRouterTariff(options, () => 100));
  expect(wire.calls.map(call => [call.url, call.method, call.headers])).toEqual([
    [endpoint, 'GET', { accept: 'application/json', 'accept-encoding': 'identity' }],
    ['https://openrouter.ai/api/v1/endpoints/zdr', 'GET', { accept: 'application/json', 'accept-encoding': 'identity' }],
  ]);
  for (const call of wire.calls) expect(call.agent.options).toMatchObject({ rejectUnauthorized: true, proxyEnv: {} });
  expect(observation).toMatchObject({ privacySourceEndpoint: 'https://openrouter.ai/api/v1/endpoints/zdr',
    privacyBodyDigest: createHash('sha256').update(inventory).digest('hex') });
  expect(quoteOpenRouterText(observation.tariff, { model: source.data.id, messages: [{ role: 'user', content: 'fixture' }], max_tokens: 100 }, 100).provider)
    .toMatchObject({ only: ['deepseek'], data_collection: 'deny', zdr: true, allow_fallbacks: false });
});

it.each([
  [{ data: [] }, 'PRIVACY_UNAVAILABLE'],
  [{ data: [{ model_id: 'other/model', tag: 'deepseek' }] }, 'PRIVACY_UNAVAILABLE'],
  [{ data: [{ model_id: source.data.id, tag: 'deepseek/nonexistent' }] }, 'PRIVACY_UNAVAILABLE'],
  [{ data: [{ tag: 'deepseek' }] }, 'INVALID_METADATA'],
] as const)('refuses missing, mismatched or malformed inventory: %j', async (body, code) => {
  wire.replies[1] = { body: JSON.stringify(body) };
  await expect(fetchOpenRouterTariff(options, () => 100)).rejects.toMatchObject({ code });
  expect(wire.calls.every(call => call.method === 'GET')).toBe(true);
});

it('refuses a synthetic training-only endpoint even when the inventory lists it', async () => {
  const training = document(); training.data.endpoints = training.data.endpoints.filter(row => row.tag === 'deepseek');
  training.data.endpoints[0]!.data_policy = { training: true, retainsPrompts: true };
  wire.replies[0] = { body: JSON.stringify(training) };
  await expect(fetchOpenRouterTariff(options, () => 100)).rejects.toMatchObject({ code: 'PRIVACY_UNAVAILABLE' });
});

it('never follows a ZDR redirect and enforces its independent bounded body limit', async () => {
  wire.replies[1] = { body: '', status: 307 };
  await expect(fetchOpenRouterTariff(options, () => 100)).rejects.toMatchObject({ code: 'METADATA_UNAVAILABLE' });
  expect(wire.calls).toHaveLength(2);
  wire.replies = [{ body: JSON.stringify(document()) }, { body: ' '.repeat(16 * 1024 * 1024 + 1) }];
  await expect(fetchOpenRouterTariff(options, () => 100)).rejects.toMatchObject({ code: 'METADATA_TOO_LARGE' });
});

it('carries the shared deadline and cancellation into the second GET', async () => {
  wire.replies[1] = { body: '', stall: true };
  await expect(fetchOpenRouterTariff({ ...options, timeoutMs: 20 }, () => 100)).rejects.toMatchObject({ code: 'METADATA_TIMEOUT' });
  const controller = new AbortController(); wire.replies = [{ body: JSON.stringify(document()) }, { body: '', stall: true }];
  const pending = fetchOpenRouterTariff(options, () => 100, controller.signal);
  await vi.waitFor(() => expect(wire.calls).toHaveLength(4)); controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'METADATA_CANCELLED' });
});
