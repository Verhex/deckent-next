import { expect, it } from 'vitest';
import { OpenRouterPricingError, parseOpenRouterTariff, quoteOpenRouterText } from '#adapters/core/provider-openrouter-pricing/index.js';

const selection = { modelId: 'vendor/model', endpointTag: 'provider/region', fetchedAtMs: 100, expiresAtMs: 200 };
function metadata(options: { readonly tag?: string; readonly modelId?: string; readonly endpointModelId?: string; readonly status?: number;
  readonly prompt?: unknown; readonly completion?: unknown; readonly cache?: unknown; readonly cacheWrite?: unknown; readonly reasoning?: unknown; readonly request?: unknown;
  readonly extraPricing?: Record<string, unknown>; readonly supported?: readonly string[]; readonly maxPrompt?: number | null;
  readonly maxCompletion?: number | null; readonly endpoints?: readonly Record<string, unknown>[]; readonly omitPricing?: readonly string[];
  readonly extraEndpoint?: Record<string, unknown> } = {}) {
  const pricing = { prompt: options.prompt ?? '0.01', completion: options.completion ?? '0.02', input_cache_read: options.cache ?? '0.001',
    input_cache_write: options.cacheWrite ?? '0', internal_reasoning: options.reasoning ?? '0', request: options.request ?? '0', discount: 0,
    ...(options.extraPricing ?? {}) } as Record<string, unknown>;
  for (const key of options.omitPricing ?? []) delete pricing[key];
  const endpoint = { model_id: options.endpointModelId ?? 'vendor/model', tag: options.tag ?? 'provider/region', provider_name: 'Provider', data_policy: { training: false, retainsPrompts: false },
    context_length: 10, max_prompt_tokens: options.maxPrompt === undefined ? 3 : options.maxPrompt,
    max_completion_tokens: options.maxCompletion === undefined ? 4 : options.maxCompletion, status: options.status ?? 0,
    supports_tool_choice: { auto: true, none: true, required: true }, supported_parameters: options.supported ?? ['max_tokens'], pricing, ...(options.extraEndpoint ?? {}) };
  return { data: { id: options.modelId ?? 'vendor/model', endpoints: options.endpoints ?? [endpoint] } };
}
function quoteRequest(extra: Record<string, unknown> = {}) {
  return { model: 'vendor/model', messages: [{ role: 'user', content: 'bounded text fixture' }], max_tokens: 2, ...extra };
}
function tariff(options: Parameters<typeof metadata>[0] = {}) { return parseOpenRouterTariff(metadata(options), selection); }
function error(code: string) { return expect.objectContaining({ code }) as unknown as OpenRouterPricingError; }

it('selects one exact provider/region endpoint and quotes independently rounded cents from token and request rates', () => {
  const parsed = tariff({ request: '0.005' });
  const result = quoteOpenRouterText(parsed, quoteRequest(), 150);
  expect(result).toEqual({ schemaVersion: 2, currency: 'USD', maxChargeMinorUnits: 8, metadataDigest: parsed.metadataDigest, tariffDigest: parsed.tariffDigest,
    maxPromptTokens: 3, maxCompletionTokens: 2, requestControls: expect.objectContaining({ modalities: ['text'] }), provider: { only: ['provider/region'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true,
      max_price: { prompt: '10000', completion: '20000', request: '0.005' } } });
  expect(parsed.pricedDimensions).toEqual(['completion', 'input_cache_read', 'input_cache_write', 'internal_reasoning', 'prompt', 'request']);
});

it.each(['none', 'required'] as const)('refuses tool_choice %s when any selected route variant denies it, and binds support into the tariff digest', choice => {
  const source = metadata({ supported: ['max_tokens', 'tools', 'tool_choice'] });
  const endpoint = source.data.endpoints[0]!;
  const request = quoteRequest({ tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }], tool_choice: choice });
  const allowed = parseOpenRouterTariff(source, { ...selection, endpointTag: 'provider' });
  expect(quoteOpenRouterText(allowed, request, 150).maxChargeMinorUnits).toBeGreaterThan(0);
  const changed = metadata({ endpoints: [endpoint, { ...endpoint, tag: 'provider/second', supports_tool_choice: { auto: true, none: choice !== 'none', required: choice !== 'required' } }] });
  const denied = parseOpenRouterTariff(changed, { ...selection, endpointTag: 'provider' });
  expect(denied.tariffDigest).not.toBe(allowed.tariffDigest);
  expect(() => quoteOpenRouterText(denied, request, 150)).toThrow(error('INVALID_REQUEST'));
  const unknown = metadata({ supported: ['max_tokens', 'tools', 'tool_choice'], extraEndpoint: { supports_tool_choice: undefined } });
  delete (unknown.data.endpoints[0] as { supports_tool_choice?: unknown }).supports_tool_choice;
  expect(() => quoteOpenRouterText(parseOpenRouterTariff(unknown, selection), request, 150)).toThrow(error('INVALID_REQUEST'));
});

it('rounds tiny dimension charges independently while explicitly zero dimensions add no cents', () => {
  const parsed = tariff({ prompt: '0.000000001', completion: '0.000000001', cache: '0', maxPrompt: null, maxCompletion: null });
  const result = quoteOpenRouterText(parsed, quoteRequest({ max_tokens: 1 }), 150);
  expect(result).toMatchObject({ maxPromptTokens: 10, maxCompletionTokens: 1, maxChargeMinorUnits: 2,
    provider: { max_price: { prompt: '0.001', completion: '0.001', request: '0' } } });
  expect(parsed.unpricedDimensions).toEqual([]);
  const allPositive = tariff({ prompt: '0.000001', completion: '0.000001', cache: '0.000001',
    cacheWrite: '0.000001', reasoning: '0.000001', request: '0.000001' });
  expect(quoteOpenRouterText(allPositive, quoteRequest(), 150).maxChargeMinorUnits).toBe(5);
});

it('refuses an explicitly unpriced request fee even with a routing cap', () => {
  const parsed = tariff({ extraPricing: { request: null } });
  expect(parsed.unpricedDimensions).toEqual(['request']);
  expect(() => quoteOpenRouterText(parsed, quoteRequest(), 150)).toThrow(error('INCOMPLETE_PRICING'));
});

it('rejects overflow in the sum even when every rounded dimension fits a safe integer', () => {
  const parsed = tariff({ prompt: '30023997515803.30', completion: '0', cache: '0', request: '0.02' });
  expect(() => quoteOpenRouterText(parsed, quoteRequest(), 150)).toThrow(error('AMOUNT_OVERFLOW'));
});

it('records absent optional SKUs as included and distinguishes explicit zero prices', () => {
  const incomplete = tariff({ omitPricing: ['input_cache_write'] });
  expect(incomplete.unpricedDimensions).toEqual([]);
  expect(incomplete.includedDimensions).toContain('input_cache_write');
  expect(quoteOpenRouterText(incomplete, quoteRequest(), 150).maxChargeMinorUnits).toBeGreaterThan(0);
  const declaredZero = tariff({ cacheWrite: '0' });
  expect(declaredZero.pricedDimensions).toContain('input_cache_write');
  expect(quoteOpenRouterText(declaredZero, quoteRequest(), 150).maxChargeMinorUnits).toBeGreaterThan(0);
});

it('separates complete source metadata evidence from selected tariff identity and freshness', () => {
  const baseline = parseOpenRouterTariff(metadata({ request: '0.005', extraEndpoint: { latency_last_30m: 10 } }), selection);
  const latencyChanged = parseOpenRouterTariff(metadata({ request: '0.005', extraEndpoint: { latency_last_30m: 99 } }), selection);
  const rateChanged = parseOpenRouterTariff(metadata({ request: '0.006', extraEndpoint: { latency_last_30m: 10 } }), selection);
  const freshnessChanged = parseOpenRouterTariff(metadata({ request: '0.005', extraEndpoint: { latency_last_30m: 10 } }), { ...selection, expiresAtMs: 201 });
  expect(latencyChanged.metadataDigest).not.toBe(baseline.metadataDigest); expect(latencyChanged.tariffDigest).toBe(baseline.tariffDigest);
  expect(rateChanged.tariffDigest).not.toBe(baseline.tariffDigest); expect(freshnessChanged.tariffDigest).not.toBe(baseline.tariffDigest);
  expect(quoteOpenRouterText(baseline, quoteRequest(), 150).provider.max_price).toEqual({ prompt: '10000', completion: '20000', request: '0.005' });
});

it('bounds every provider variant for a bare slug and pins a full region slug exactly', () => {
  const base = metadata({ endpoints: [
    { ...metadata().data.endpoints[0]!, tag: 'provider' }, { ...metadata().data.endpoints[0]!, tag: 'provider/region', pricing: { prompt: '0.1', completion: '0.2' } },
  ] });
  const parsed = parseOpenRouterTariff(base, { ...selection, endpointTag: 'provider' });
  expect(quoteOpenRouterText(parsed, quoteRequest(), 150).provider.max_price.prompt).toBe('100000');
  expect(quoteOpenRouterText(parseOpenRouterTariff(base, selection), quoteRequest(), 150).provider.only).toEqual(['provider/region']);
  expect(() => parseOpenRouterTariff(metadata({ tag: 'provider/region-extra' }), selection)).toThrow(error('ENDPOINT_AMBIGUOUS'));
});

it('rejects unavailable or mismatched endpoint identity and malformed pricing metadata even at zero', () => {
  expect(() => tariff({ status: 1 })).toThrow(error('ENDPOINT_UNAVAILABLE'));
  expect(() => tariff({ endpointModelId: 'other/model' })).toThrow(error('ENDPOINT_UNAVAILABLE'));
  expect(() => parseOpenRouterTariff(metadata({ modelId: 'other/model' }), selection)).toThrow(error('INVALID_METADATA'));
  expect(() => tariff({ prompt: 0 })).toThrow(error('INVALID_METADATA'));
  expect(quoteOpenRouterText(tariff({ extraPricing: { image: '0.000001', web_search: null } }), quoteRequest(), 150).maxChargeMinorUnits).toBeGreaterThan(0);
  expect(() => tariff({ extraPricing: { unrecognized: '0' } })).toThrow(error('UNSUPPORTED_PRICING'));
  expect(() => tariff({ extraPricing: { overrides: [{ conditions: { region: 'x' }, pricing: { prompt: '0.1' } }] } })).toThrow(error('UNSUPPORTED_PRICING'));
  for (const key of ['constructor', 'toString', '__proto__']) {
    const document = JSON.parse(JSON.stringify(metadata())) as { data: { endpoints: Array<{ pricing: Record<string, unknown> }> } };
    document.data.endpoints[0]!.pricing = JSON.parse(`{"prompt":"0.01","completion":"0.02","discount":0,"${key}":"0"}`) as Record<string, unknown>;
    expect(() => parseOpenRouterTariff(document, selection)).toThrow(error('UNSUPPORTED_PRICING'));
  }
});

it('rejects stale or future tariffs, arithmetic overflow, and fabricated tariff objects', () => {
  const parsed = tariff();
  expect(() => quoteOpenRouterText(parsed, quoteRequest(), 99)).toThrow(error('STALE_TARIFF'));
  expect(() => quoteOpenRouterText(parsed, quoteRequest(), 200)).toThrow(error('STALE_TARIFF'));
  expect(() => quoteOpenRouterText(tariff({ prompt: '90071992547410', completion: '0', cache: '0' }), quoteRequest(), 150)).toThrow(error('AMOUNT_OVERFLOW'));
  expect(() => quoteOpenRouterText({ ...parsed }, quoteRequest(), 150)).toThrow(error('INVALID_METADATA'));
});

it('allows exactly one supported native completion cap and rejects unsupported or non-text request fields', () => {
  const maxTokens = tariff({ supported: ['max_tokens'] });
  expect(quoteOpenRouterText(maxTokens, quoteRequest(), 150).maxCompletionTokens).toBe(2);
  expect(() => quoteOpenRouterText(maxTokens, quoteRequest({ max_completion_tokens: 2 }), 150)).toThrow(error('INVALID_REQUEST'));
  const maxCompletion = tariff({ supported: ['max_completion_tokens'] });
  expect(quoteOpenRouterText(maxCompletion, { model: 'vendor/model', messages: [{ role: 'user', content: 'bounded text fixture' }], max_completion_tokens: 2 }, 150).maxCompletionTokens).toBe(2);
  expect(() => quoteOpenRouterText(maxCompletion, { ...quoteRequest(), max_completion_tokens: 2 }, 150)).toThrow(error('INVALID_REQUEST'));
  for (const input of [{ ...quoteRequest(), tools: [] }, { ...quoteRequest(), images: [] }, { ...quoteRequest(), temperature: 0 },
    { ...quoteRequest(), max_tokens: 2, max_completion_tokens: 2 }, { ...quoteRequest(), messages: [{ role: 'user', content: null }] }]) {
    expect(() => quoteOpenRouterText(maxTokens, input, 150)).toThrow(error('INVALID_REQUEST'));
  }
});

it('copies selection identity and does not let later caller mutation alter a tariff', () => {
  const mutable = { ...selection }, parsed = parseOpenRouterTariff(metadata(), mutable);
  mutable.endpointTag = 'forged/region'; mutable.expiresAtMs = 999;
  expect(parsed.selection).toEqual(selection); expect(Object.isFrozen(parsed.selection)).toBe(true);
  expect(quoteOpenRouterText(parsed, quoteRequest(), 150).provider.only).toEqual(['provider/region']);
});

it('reserves the full published prompt bound for tool definitions, tool history and stream framing', () => {
  const parsed = tariff({ supported: ['max_tokens', 'tools', 'tool_choice'] });
  const baseline = quoteOpenRouterText(parsed, quoteRequest(), 150);
  const tools = [{ type: 'function', function: { name: 'read_file', description: 'x'.repeat(4096), parameters: { type: 'object' } } }];
  const request = quoteRequest({ tools, tool_choice: 'auto', stream: true, stream_options: { include_usage: true }, messages: [
    { role: 'user', content: 'hi' }, { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'data' },
  ] });
  expect(quoteOpenRouterText(parsed, request, 150)).toEqual(baseline);
  expect(() => quoteOpenRouterText(tariff(), request, 150)).toThrow(error('INVALID_REQUEST'));
});
