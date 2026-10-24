import { readFileSync } from 'node:fs';
import * as http from '#adapters/core/provider-http-json/index.js';
import { afterEach, expect, it, vi } from 'vitest';
import { PROVIDER_CONNECT_KINDS, providerConnectKind, providerConnectModelPriced } from '#adapters/core/provider-connect/index.js';
import { createOpenAiChatPricedNative, lookupOpenAiCompatibleTariff } from '#adapters/core/provider-openai-chat/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, providerSpendQuoteDigest, createProviderSpendAccount, reserveProviderSpend,
  settleProviderSpend } from '#engine/index.js';
const data = (name: string) => JSON.parse(readFileSync(`src/adapters/core/provider-openai-chat/internal/${name}.json`, 'utf8'));
const COMPATIBILITY = data('request-compatibility'), PRICING = data('pricing');

// Owner rule 2026-10-23 (M5 guard): every mechanism is model-independent and parametric; a new model or vendor arrives as data.
afterEach(() => { vi.restoreAllMocks(); });

it('an Anthropic model id with no published tariff is not shown as priced; a published one is (profile.ts null-vs-undefined)', () => {
  const kind = providerConnectKind('anthropic-api')!;
  expect(PROVIDER_CONNECT_KINDS.some(row => row.id === 'anthropic-api')).toBe(true);
  expect(providerConnectModelPriced(kind, 'claude-model-with-no-tariff-row')).toBe(false);
  expect(providerConnectModelPriced(kind, 'claude-opus-5-5')).toBe(true);
});

const reference = { providerId: 'vendor', providerVersion: 1, modelId: 'model', modelVersion: 1 };
function fixture(endpoint: string, tariff: unknown, model: string) {
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
async function settleWith(tariff: unknown, endpoint: string, model: string, finishReason = 'stop') {
  vi.spyOn(http, 'sendNativeJsonHttp').mockImplementation(async (_request, options) => {
    const parsed = options!.parseResponse!(Buffer.from(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model,
      choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 } } })));
    if (!('response' in parsed)) throw new Error('fixture'); return parsed.response;
  });
  const f = fixture(endpoint, tariff, model), priced = createOpenAiChatPricedNative();
  const prepared = await priced.native.prepare(f.profile, f.definition, f.request), quote = priced.quote({ ...f, prepared });
  const response = await priced.native.send(prepared); if ('kind' in response) throw new Error('fixture');
  const measurement = priced.native.observeSpending!(prepared, response)!;
  const budget = { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 1000 };
  const reserved = reserveProviderSpend(createProviderSpendAccount(budget), budget, { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', budgetRevision: 1,
    invocationId: 'invocation', currency: 'USD', quote, quoteDigest: providerSpendQuoteDigest(quote) });
  const settled = settleProviderSpend(reserved.account, reserved.reservation, { kind: 'measured-tariff', measurement, evidenceDigest: 'b'.repeat(64) });
  return { measurement, reservation: settled.reservation };
}

it('vendor identities and per-vendor response grammar are registry data (L3/L4)', async () => {
  const vendors: string[] | undefined = COMPATIBILITY.vendors;
  expect(vendors).toEqual(expect.arrayContaining(['openai', 'deepseek', 'zai']));
  for (const row of PRICING.rows) expect(vendors).toContain(row.vendor);
  const dialects: Record<string, { finishReasons: string[] }> | undefined = COMPATIBILITY.responseDialects;
  expect(Object.keys(dialects ?? {}).sort()).toEqual(['deepseek', 'zai']);
  // Each vendor's own finish reasons are accepted on the wire, and a vendor without them refuses the same value (data decides, not a vendor branch).
  for (const [vendor, endpoint, model] of [['zai', 'https://api.z.ai/api/paas/v4/chat/completions', 'glm-4.7'],
    ['deepseek', 'https://api.deepseek.com/chat/completions', 'deepseek-flash']] as const) {
    const tariff = lookupOpenAiCompatibleTariff(endpoint, model);
    for (const reason of dialects![vendor]!.finishReasons) await expect(settleWith(tariff, endpoint, model, reason)).resolves.toBeDefined();
  }
  const openai = 'https://api.openai.com/v1/chat/completions';
  await expect(settleWith(lookupOpenAiCompatibleTariff(openai, 'chat-latest'), openai, 'chat-latest', dialects!.zai!.finishReasons[0])).rejects.toBeDefined();
  // A row names a vendor only if the registry does.
  const row = PRICING.rows.find((value: { vendor: string }) => value.vendor === 'zai');
  const endpoint = row.endpoint as string;
  expect(lookupOpenAiCompatibleTariff(endpoint, row.modelId)).toMatchObject({ vendor: 'zai' });
});
