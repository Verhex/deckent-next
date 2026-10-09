import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseOpenRouterTariff, quoteOpenRouterText } from '#adapters/core/provider-openrouter-pricing/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

type Endpoint = { model_id: string; tag: string; provider_name: string; status: number; data_policy?: unknown; pricing: Record<string, unknown> };
type Document = { data: { id: string; endpoints: Endpoint[] } };
const retained = (): Document => JSON.parse(readFileSync(new URL('../../fixtures/openrouter-endpoints/deepseek--deepseek-v4.1-flash-endpoints.json', import.meta.url), 'utf8'));
const select = (document: Document, endpointTag = 'deepseek') => ({ modelId: document.data.id, endpointTag, fetchedAtMs: 100, expiresAtMs: 200 });
// Synthetic inventory is an explicit test input, never current provider privacy evidence.
const inventory = (document: Document, tags: string[]) => ({ data: tags.map(tag => ({ model_id: document.data.id, tag })) });
const request = (document: Document) => ({ model: document.data.id, max_tokens: 100, messages: [{ role: 'user', content: 'fixture' }] });

it('uses retained prices but selects a compliant hosted alternative instead of a synthetic training-only first party', () => {
  const document = retained(), first = document.data.endpoints.find(e => e.tag === 'deepseek')!;
  first.data_policy = { training: true, retainsPrompts: true };
  const alternative = document.data.endpoints.find(e => e.status === 0 && e.tag !== 'deepseek' && e.tag !== 'deepseek/turbo')!;
  const tariff = parseOpenRouterTariff(document, select(document), inventory(document, [alternative.tag]));
  const quote = quoteOpenRouterText(tariff, request(document), 150);
  expect(quote.provider).toMatchObject({ only: [alternative.tag], data_collection: 'deny', zdr: true, allow_fallbacks: false });
  expect((tariff.definition.endpoints as { tag: string }[]).map(e => e.tag)).toEqual([alternative.tag]);
});

it('bounds every compliant variant including unavailable expensive variants, excluding training prices', () => {
  const document = retained(), base = document.data.endpoints.find(e => e.tag === 'deepseek')!;
  document.data.endpoints = [{ ...base, data_policy: { training: true, retainsPrompts: true } },
    { ...base, tag: 'safe/us', data_policy: { training: false, retainsPrompts: false }, pricing: { prompt: '0.000001', completion: '0.000002' } },
    { ...base, tag: 'safe/expensive', status: -5, data_policy: { training: false, retainsPrompts: false }, pricing: { prompt: '0.000003', completion: '0.000004' } }];
  const tariff = parseOpenRouterTariff(document, select(document));
  const quote = quoteOpenRouterText(tariff, request(document), 150);
  expect(quote.provider.only).toEqual(['safe/expensive', 'safe/us']);
  expect(quote.provider.max_price).toMatchObject({ prompt: '3', completion: '4' });
  expect(quote.maxChargeMinorUnits).toBeGreaterThanOrEqual(Math.ceil(tariff.maxPromptTokens * 0.000003 * 100) + 1);
});

it.each([undefined, null, {}, { training: false }, { training: true, retainsPrompts: false }, { training: false, retainsPrompts: true }])(
  'refuses missing, partial or incompatible endpoint policy without an inventory: %j', policy => {
    const document = retained(); document.data.endpoints = [document.data.endpoints.find(e => e.tag === 'deepseek')!];
    if (policy === undefined) delete document.data.endpoints[0]!.data_policy; else document.data.endpoints[0]!.data_policy = policy;
    expect(() => parseOpenRouterTariff(document, select(document))).toThrow(expect.objectContaining({ code: 'PRIVACY_UNAVAILABLE' }));
  });

it('does not accept another model, bare provider slug, or contradictory policy as ZDR membership', () => {
  const document = retained(), base = document.data.endpoints.find(e => e.tag === 'deepseek')!;
  document.data.endpoints = [{ ...base, tag: 'deepseek/region' }];
  for (const data of [[{ model_id: 'other/model', tag: 'deepseek/region' }], [{ model_id: document.data.id, tag: 'deepseek' }]]) {
    expect(() => parseOpenRouterTariff(document, select(document), { data })).toThrow('PRIVACY_UNAVAILABLE');
  }
  document.data.endpoints[0]!.data_policy = { training: true, retainsPrompts: false };
  expect(() => parseOpenRouterTariff(document, select(document), inventory(document, ['deepseek/region']))).toThrow('PRIVACY_UNAVAILABLE');
});

it('carries a typed, localized privacy refusal across the composition boundary', () => {
  const document = retained(); let failure: unknown;
  try { parseOpenRouterTariff(document, select(document)); } catch (error) { failure = error; }
  const typed = queryFailure(failure);
  expect(typed.code).toBe('OPENROUTER_PRIVACY_UNAVAILABLE');
  for (const locale of ['tr', 'en'] as const) {
    const rendered = ErrorRegistry.get(typed.code, locale);
    expect(JSON.stringify(rendered)).toContain('https://openrouter.ai/settings/privacy');
  }
});
