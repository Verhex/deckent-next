import { expect, it } from 'vitest';
import { createOpenRouterTariffCache, parseOpenRouterTariff, type OpenRouterMetadataObservation } from '#adapters/core/provider-openrouter-pricing/index.js';

// Cache-port proof only. This synthetic acquisition result is not trusted TLS/metadata evidence.
it('read-only tariff inspection never acquires or joins a pending acquisition, and preserves identity and freshness', async () => {
  const options = { endpoint: 'https://provider.invalid/api/v1/models/vendor/model/endpoints', modelId: 'vendor/model',
    endpointTag: 'provider/region', maxAgeMs: 100, maxResponseBytes: 64000, timeoutMs: 500 };
  const tariff = parseOpenRouterTariff({ data: { id: 'vendor/model', endpoints: [{ model_id: 'vendor/model', tag: 'provider/region',
    provider_name: 'Fixture', status: 0, context_length: 10, max_prompt_tokens: 3, max_completion_tokens: 4,
    data_policy: { training: false, retainsPrompts: false }, supported_parameters: ['max_tokens'],
    pricing: { prompt: '0', completion: '0', request: '0', input_cache_read: '0', input_cache_write: '0', internal_reasoning: '0' } }] } },
  { modelId: options.modelId, endpointTag: options.endpointTag, fetchedAtMs: 100, expiresAtMs: 200 });
  const observation: OpenRouterMetadataObservation = { schemaVersion: 1, sourceEndpoint: options.endpoint, sourceBodyDigest: 'a'.repeat(64),
    receivedBytes: 10, observedAtMs: 100, tariff };
  let acquired = 0, release!: (observation: OpenRouterMetadataObservation) => void;
  const cache = createOpenRouterTariffCache(async () => { acquired++; return new Promise(resolve => { release = resolve; }); });
  expect(cache.peek(options, 100)).toBeNull(); expect(acquired).toBe(0); expect(cache.size()).toBe(0);
  const pending = cache.get(options, () => 100);
  expect(cache.peek(options, 100)).toBeNull(); expect(acquired).toBe(1); expect(cache.size()).toBe(0);
  release(observation); expect(await pending).toBe(observation);
  expect(cache.peek(options, 100)).toBe(observation); expect(cache.peek(options, 199)).toBe(observation);
  for (const now of [99, 200, NaN]) expect(cache.peek(options, now)).toBeNull();
  for (const changed of [{ endpoint: 'https://other.invalid' }, { modelId: 'other/model' }, { endpointTag: 'provider/other' },
    { caPem: 'other-ca' }, { maxAgeMs: 101 }, { maxResponseBytes: 64001 }, { timeoutMs: 501 }]) {
    expect(cache.peek({ ...options, ...changed }, 150)).toBeNull();
  }
  expect(cache.size()).toBe(1); expect(acquired).toBe(1); expect(cache.peek(options, 150)).toBe(observation);
});
