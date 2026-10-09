import * as http from '#adapters/core/provider-http-json/index.js';
import { afterEach, expect, it, vi } from 'vitest';
import { PROVIDER_CONNECT_KINDS, connectionAdapter, providerConnectKind, providerConnectModelPriced, readProviderConnectSeed } from '#adapters/core/provider-connect/index.js';
import { createOpenAiChatPricedNative, lookupOpenAiCompatibleTariff } from '#adapters/core/provider-openai-chat/index.js';
import { createProviderSpendAccount, modelInvocationProfileDigest, modelInvocationRequestDigest, providerSpendQuoteDigest, reserveProviderSpend,
  settleProviderSpend } from '#engine/index.js';

// Stage 1 (T4-B models.connect x SPEND-SETTLEMENT): the profile's adapter part carries the verified published row for exactly this endpoint and
// model, so the spend authority prices it; a remote model without a row is refused before any write; a loopback server keeps the zero tariff.
afterEach(() => { vi.restoreAllMocks(); });
const openai = providerConnectKind('openai-api')!;
const input = (endpoint: string, nativeId: string) => ({ endpoint, credentialRef: 'DECKENT_OPENAI_KEY', nativeId, maxOutputTokens: 64, currency: 'USD' });

it('a priced model connects with the verified row; the profile reserves and settles exactly under a budget', async () => {
  const endpoint = 'https://api.openai.com/v1/chat/completions', built = connectionAdapter(openai, input(endpoint, 'chat-latest'));
  expect(built.tariff).toBe('published');
  expect((built.adapter.definition as { tariff: unknown }).tariff).toEqual(lookupOpenAiCompatibleTariff(endpoint, 'chat-latest'));
  const reference = { providerId: 'openai-api', providerVersion: 1, modelId: 'chat-latest', modelVersion: 1 };
  const profile = { schemaVersion: 1 as const, id: 'p', version: 1, scopeId: 'scope', reference, bindingDigest: 'a'.repeat(64), protocol: built.protocol, adapter: built.adapter,
    allocation: { id: 'p', maxCalls: null, maxInFlight: 1 }, limits: { requestMaxBytes: 65_536, responseMaxBytes: 65_536, timeoutMs: 2_000 } };
  const definition = { encodingVersion: 1, provider: { id: 'openai-api', version: 1 }, model: { id: 'chat-latest', version: 1, nativeId: 'chat-latest',
    protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] } };
  const request = { model: 'chat-latest', messages: [{ role: 'user' as const, content: 'hello' }], max_completion_tokens: 10 };
  const command = { schemaVersion: 1 as const, commandId: 'call', scopeId: 'scope', reference, catalogRevision: 'catalog',
    expectedBinding: { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: 'a'.repeat(64) }, nativeRequest: request };
  vi.spyOn(http, 'sendNativeJsonHttp').mockImplementation(async (sent, options) => {
    // The v5 dialect reaches the wire (OpenAI: max_completion_tokens), and the call goes to the priced endpoint.
    expect(String((sent as { definition: { endpoint: string } }).definition.endpoint)).toBe(endpoint);
    const parsed = options!.parseResponse!(Buffer.from(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: 'chat-latest',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 } } })));
    if (!('response' in parsed)) throw new Error('fixture'); return parsed.response;
  });
  const priced = createOpenAiChatPricedNative({ resolveCredential: async () => 'sk-test' } as never);
  const prepared = await priced.native.prepare(profile as never, definition as never, request);
  const quote = priced.quote({ profile, definition, command, requestDigest: modelInvocationRequestDigest(command), profileDigest: modelInvocationProfileDigest(profile as never), prepared } as never);
  expect(quote.pricing).toMatchObject({ id: 'openai-compatible-published-tariff' }); expect(quote.maxChargeMinorUnits).toBeGreaterThan(0);
  const response = await priced.native.send(prepared); if ('kind' in response) throw new Error('fixture');
  const measurement = priced.native.observeSpending!(prepared, response)!;
  // 60 input x $5 + 40 cached x $0.50 + 10 output x $30 per MTok = 0.062 cents.
  expect(measurement).toMatchObject({ basis: 'measured-tariff', exactMinorUnits: '0.062' });
  const budget = { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 500 };
  const reserved = reserveProviderSpend(createProviderSpendAccount(budget), budget, { schemaVersion: 1, scopeId: 'scope', invocationId: 'call', budgetId: 'budget',
    budgetRevision: 1, currency: 'USD', quote, quoteDigest: providerSpendQuoteDigest(quote) });
  expect(reserved.account.reservedMinorUnits).toBe(quote.maxChargeMinorUnits);
  expect(settleProviderSpend(reserved.account, reserved.reservation, { kind: 'measured-tariff', measurement, evidenceDigest: 'b'.repeat(64) }).account)
    .toMatchObject({ reservedMinorUnits: 0, settledExactMinorUnits: '0.062', frozen: false });
});

it('an unpriced remote model is refused (MODEL_CONNECT_TARIFF_UNVERIFIED); a loopback server keeps the zero tariff (negative)', () => {
  expect(() => connectionAdapter(openai, input('https://api.openai.com/v1/chat/completions', 'unpriced-model'))).toThrow('MODEL_CONNECT_TARIFF_UNVERIFIED');
  // An exact match only: the same model id at another remote address has no row.
  expect(() => connectionAdapter(openai, input('https://proxy.example.com/v1/chat/completions', 'chat-latest'))).toThrow('MODEL_CONNECT_TARIFF_UNVERIFIED');
  const local = connectionAdapter(providerConnectKind('local-openai')!, { ...input('http://127.0.0.1:8000/v1/chat/completions', 'qwen'), credentialRef: null });
  expect(local.tariff).toBe('unmetered');
  expect((local.adapter.definition as { tariff: unknown }).tariff).toMatchObject({ kind: 'operator-static', version: 1, inputMinorUnitsPerMillionTokens: 0 });
});

it('the shipped seeds: exactly the models with a verified row (or a published Anthropic tariff) are connectable with a price', async () => {
  const table: Record<string, Record<string, boolean>> = {};
  for (const kind of PROVIDER_CONNECT_KINDS) {
    if (!kind.connect?.seed) continue;
    const seed = await readProviderConnectSeed(kind.connect.seed);
    table[kind.id] = Object.fromEntries(seed.providers.flatMap(provider => provider.models.map(model => [model.nativeId, providerConnectModelPriced(kind, model.nativeId)])));
  }
  // Verified pricing snapshot (2026-10-08); CNY-only China rows remain locked.
  expect(table['openai-api']).toEqual({ 'gpt-6-astra': true, 'gpt-6.1-sol': true, 'gpt-6-luna': true });
  expect(table['deepseek-api']).toEqual({ 'deepseek-flash': true, 'deepseek-v4-pro': true });
  expect(table['zai-api']).toEqual({ 'glm-5.3': true, 'glm-4.7-flash': true });
  expect(table['zai-cn-api']).toEqual({ 'glm-5.3': false, 'glm-4.7-flash': false, 'glm-4.6': false });
  expect(Object.values(table['anthropic-api']!).every(Boolean)).toBe(true);
});

it('new Anthropic connections wire the same-origin token counter and the seed declares its capability', async () => {
  const kind = providerConnectKind('anthropic-api')!;
  const endpoint = 'https://api.anthropic.com/v1/messages';
  const built = connectionAdapter(kind, { ...input(endpoint, 'claude-sonnet-5-5'), credentialRef: 'DECKENT_ANTHROPIC_KEY' });
  expect(built.adapter.definition['tokenCountEndpoint']).toBe('https://api.anthropic.com/v1/messages/count_tokens');
  const seed = await readProviderConnectSeed('anthropic-api');
  for (const model of seed.providers.flatMap(provider => provider.models)) {
    expect(model.protocols[0]!.capabilities).toContainEqual({ id: 'token-count', version: 1, state: 'supported' });
  }
});
