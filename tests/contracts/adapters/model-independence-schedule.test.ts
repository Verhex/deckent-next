import * as http from '#adapters/core/provider-http-json/index.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createOpenAiChatPricedNative, lookupOpenAiCompatibleTariff } from '#adapters/core/provider-openai-chat/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, providerSpendQuoteDigest, createProviderSpendAccount, reserveProviderSpend,
  settleProviderSpend, parseProviderSpendReservation } from '#engine/index.js';

// Owner rule 2026-10-23 (M5 guard, L1/L2): the upper-bound label and the governed reduction follow the tariff row's `schedule` field. The packaged catalog
// carries that field on DeepSeek rows only, so this file gives a Z.ai row the schedule (a data change) and expects the same behaviour with no code branch.
vi.mock('../../../src/adapters/core/provider-openai-chat/internal/pricing.json', async importOriginal => {
  const original = (await importOriginal()) as { default: { rows: { modelId: string; vendor: string }[] } };
  return { default: { ...original.default, rows: original.default.rows.map(row => row.vendor === 'zai' && row.modelId === 'glm-4.7' ? { ...row, schedule: 'provider-tier-required' } : row) } };
});
afterEach(() => { vi.restoreAllMocks(); });
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

// A reservation may carry a governed settle-reduction only when it is a scheduled measured upper bound (the parser asks isProviderSpendUpperBound).
function governedReductionAllowed(reservation: object): boolean {
  const reconciliation = { commandId: 'reconcile', budgetRevision: 1, resolution: 'settle', exactMinorUnits: '0.001', evidenceKind: 'provider-usage',
    evidenceDigest: 'c'.repeat(64), receiptDigest: 'd'.repeat(64) };
  try { parseProviderSpendReservation({ ...reservation, schemaVersion: 3, reconciliation }); return true; } catch { return false; }
}
it('a scheduled row of any vendor settles as an upper bound and is eligible for the governed reduction (L1/L2)', async () => {
  const endpoint = 'https://api.z.ai/api/paas/v4/chat/completions', tariff = lookupOpenAiCompatibleTariff(endpoint, 'glm-4.7')!;
  expect(tariff).toMatchObject({ vendor: 'zai', schedule: 'provider-tier-required' });
  const scheduled = await settleWith(tariff, endpoint, 'glm-4.7');
  expect(scheduled.measurement).toMatchObject({ basis: 'measured-tariff', source: { tier: 'upper-bound' } });
  expect(governedReductionAllowed(scheduled.reservation)).toBe(true);
  // Control: an unscheduled row of the same vendor stays an ordinary measured settlement.
  const plain = await settleWith(lookupOpenAiCompatibleTariff(endpoint, 'glm-5.3'), endpoint, 'glm-5.3');
  expect(plain.measurement).toMatchObject({ basis: 'measured-tariff', source: { tier: null } });
  expect(governedReductionAllowed(plain.reservation)).toBe(false);
});
