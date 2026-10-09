import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseOpenRouterTariff as parseTariff, quoteOpenRouterText } from '#adapters/core/provider-openrouter-pricing/index.js';

interface Endpoint {
  model_id: string; tag: string; status: number; provider_name: string; context_length: number;
  max_prompt_tokens: number | null; max_completion_tokens: number | null; supported_parameters: string[];
  pricing: Record<string, unknown>;
}
interface Metadata { data: { id: string; endpoints: Endpoint[] } }
// Synthetic ZDR membership isolates pricing tests; retained documents are unchanged vendor snapshots.
const parseOpenRouterTariff = (document: Metadata, selected: Parameters<typeof parseTariff>[1]) => parseTariff(document, selected,
  { data: document.data.endpoints.filter(e => e.tag === selected.endpointTag || !selected.endpointTag.includes('/') && e.tag.startsWith(`${selected.endpointTag}/`))
    .map(e => ({ model_id: e.model_id, tag: e.tag })) });

const retained = (file: string) => JSON.parse(readFileSync(new URL(`../../fixtures/openrouter-endpoints/${file}`, import.meta.url), 'utf8')) as Metadata;
const fixtures = [
  { file: 'sonnet-endpoints.json', tag: 'anthropic', output: 128000, cents: 728 },
  { file: 'sol-endpoints.json', tag: 'openai', output: 128000, cents: 6131 },
  { file: 'z-ai--glm-5.3-endpoints.json', tag: 'z-ai', output: 131072, cents: 205 },
  { file: 'deepseek--deepseek-v4.1-flash-endpoints.json', tag: 'deepseek', output: 393216, cents: 80 },
];
const selection = (modelId: string, endpointTag: string) => ({ modelId, endpointTag, fetchedAtMs: 100, expiresAtMs: 200 });
const request = (model: string, max_tokens: number) => ({ model, messages: [{ role: 'user', content: 'fixture only' }], max_tokens });

// Independent fixture oracle: integer femtodollars, total-rounded charges for every endpoint's
// base/conditional scenario. No adapter arithmetic/helper/routing maxima are used here.
const unit = 10n ** 15n;
function units(value: unknown): bigint {
  if (value === undefined) return 0n;
  if (typeof value !== 'string' || !/^\d+(\.\d{1,15})?$/.test(value)) throw new Error('oracle rate');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * unit + BigInt(fraction.padEnd(15, '0'));
}
const maximum = (...values: bigint[]) => values.reduce((a, b) => a > b ? a : b);
function scenarioCents(endpoint: Endpoint, prices: Record<string, unknown>, output: number): bigint {
  const prompt = BigInt(Math.min(endpoint.max_prompt_tokens ?? endpoint.context_length, endpoint.context_length));
  const input = maximum(units(prices['prompt']), units(prices['input_cache_read']));
  const write = maximum(units(prices['input_cache_write']), units(prices['input_cache_write_1h']));
  const charge = prompt * (input + write) + BigInt(output) * (units(prices['completion']) + units(prices['internal_reasoning'])) + units(prices['request']);
  return (charge * 100n + unit - 1n) / unit;
}
function trueMaximum(endpoints: Endpoint[], output: number) {
  return maximum(...endpoints.flatMap(endpoint => {
    const overrides = endpoint.pricing['overrides'] as Record<string, unknown>[] | undefined;
    // Full inheritance for each branch, plus overlapping later-per-key overrides.
    const rows = [endpoint.pricing, ...(overrides ?? []).map(row => ({ ...endpoint.pricing, ...row }))];
    let cumulative = endpoint.pricing;
    for (const row of overrides ?? []) { cumulative = { ...cumulative, ...row }; rows.push(cumulative); }
    return rows.map(row => scenarioCents(endpoint, row, output));
  }));
}

it.each(fixtures)('admits retained $file / $tag and reserves the independently pinned $cents cents', row => {
  const document = retained(row.file), tariff = parseOpenRouterTariff(document, selection(document.data.id, row.tag));
  const quote = quoteOpenRouterText(tariff, request(document.data.id, row.output), 150);
  expect(quote.maxChargeMinorUnits).toBe(row.cents);
  expect(quote.provider).toMatchObject({ only: document.data.endpoints.filter(e => e.tag === row.tag || e.tag.startsWith(`${row.tag}/`)).map(e => e.tag).sort(), allow_fallbacks: false, require_parameters: true });
  expect(tariff.unpricedDimensions).toEqual([]);
});

const allRoutes = fixtures.flatMap(({ file }) => {
  const document = retained(file);
  const tags = new Set(document.data.endpoints.map(endpoint => endpoint.tag.split('/')[0]!));
  return [...tags].filter(tag => document.data.endpoints.some(endpoint => endpoint.status === 0 && endpoint.tag.split('/')[0] === tag))
    .map(tag => ({ file, tag }));
});
it.each(allRoutes)('bounds every retained region/variant/conditional scenario for $file / $tag', ({ file, tag }) => {
  const document = retained(file), endpoints = document.data.endpoints.filter(endpoint => endpoint.tag === tag || endpoint.tag.startsWith(`${tag}/`));
  const tariff = parseOpenRouterTariff(document, selection(document.data.id, tag));
  const input = request(document.data.id, tariff.maxCompletionTokens);
  const { max_tokens, ...rest } = input;
  const quote = quoteOpenRouterText(tariff, tariff.supportedParameters.includes('max_tokens') ? input : { ...rest, max_completion_tokens: max_tokens }, 150);
  expect(BigInt(quote.maxChargeMinorUnits)).toBeGreaterThanOrEqual(trueMaximum(endpoints, tariff.maxCompletionTokens));
  expect(tariff.maxPromptTokens).toBe(Math.max(...endpoints.map(endpoint => Math.min(endpoint.max_prompt_tokens ?? endpoint.context_length, endpoint.context_length))));
});

const synthetic = () => {
  const document = retained('sol-endpoints.json');
  document.data.endpoints = document.data.endpoints.filter(endpoint => endpoint.tag === 'openai');
  return document;
};
it.each(['prompt', 'completion', 'request', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'internal_reasoning'])(
'refuses a truly unpriced reachable %s before POST preparation', dimension => {
  const document = synthetic(); document.data.endpoints[0]!.pricing[dimension] = null;
  const tariff = parseOpenRouterTariff(document, selection(document.data.id, 'openai'));
  expect(tariff.unpricedDimensions).toContain(dimension);
  expect(() => quoteOpenRouterText(tariff, request(document.data.id, 100), 150)).toThrow(expect.objectContaining({ code: 'INCOMPLETE_PRICING' }));
});

it('bounds disjoint price maxima, unavailable variants, conditional request fees and cache-write-1h with exact decimals', () => {
  const document = synthetic(), base = document.data.endpoints[0]!;
  base.pricing = { prompt: '0.00000001', completion: '0.00000002', request: '0.01', input_cache_read: '0.000000001',
    input_cache_write: '0.00000003', input_cache_write_1h: '0.00000004', overrides: [{ utc_days: ['monday'], request: '0.02' }] };
  document.data.endpoints.push({ ...base, tag: 'openai/expensive', status: -5, max_prompt_tokens: 1000000,
    pricing: { prompt: '0.000000001', completion: '0.00000001', input_cache_read: '0.00000002',
      overrides: [{ min_prompt_tokens: 272000, input_cache_write_1h: '0.00000005', internal_reasoning: '0.00000003' }] } });
  const tariff = parseOpenRouterTariff(document, selection(document.data.id, 'openai'));
  const quote = quoteOpenRouterText(tariff, request(document.data.id, 100000), 150);
  // 1M × max input 2e-8 + 1M × max write 5e-8 + 100K × (2e-8 + 3e-8) + request .02 = 11 cents after independent per-dimension ceilings.
  expect(quote.maxChargeMinorUnits).toBe(11);
  expect(quote.provider.max_price).toEqual({ prompt: '0.01', completion: '0.02', request: '0.02' });
  expect(BigInt(quote.maxChargeMinorUnits)).toBeGreaterThanOrEqual(trueMaximum(document.data.endpoints, 100000));
});

it('refuses unpriced override dimensions and unrecognized reachable SKUs without discarding them', () => {
  const document = synthetic(); document.data.endpoints[0]!.pricing['overrides'] = [{ min_prompt_tokens: 1, request: null }];
  expect(() => quoteOpenRouterText(parseOpenRouterTariff(document, selection(document.data.id, 'openai')), request(document.data.id, 100), 150))
    .toThrow(expect.objectContaining({ code: 'INCOMPLETE_PRICING' }));
  document.data.endpoints[0]!.pricing = { prompt: '0', completion: '0', future_server_fee: null };
  expect(() => parseOpenRouterTariff(document, selection(document.data.id, 'openai'))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PRICING' }));
});

it('does not let caller requests enable online variants, plugins, media or paid server tools', () => {
  const document = synthetic(), tariff = parseOpenRouterTariff(document, selection(document.data.id, 'openai'));
  for (const extra of [{ web_search_options: {} }, { plugins: [{ id: 'web' }] }, { modalities: ['image'] },
    { tools: [{ type: 'openrouter:web_search' }] }, { tools: [{ type: 'web_search' }] }, { model: `${document.data.id}:online` }]) {
    expect(() => quoteOpenRouterText(tariff, { ...request(document.data.id, 100), ...extra }, 150)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  }
});
