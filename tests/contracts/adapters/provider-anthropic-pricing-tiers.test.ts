import { describe, expect, it } from 'vitest';
import { anthropicMaxChargeMinorUnits, anthropicPublishedTariff, anthropicReportedPromptTokens, anthropicTariffRates, anthropicTariffSchema,
  createAnthropicMessagesPricedNative, parseAnthropicMessagesDefinition, ANTHROPIC_PUBLISHED_TARIFFS } from '#adapters/core/provider-anthropic-messages/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, providerSpendEvidenceDigest } from '#engine/index.js';

/**
 * HAIKU55-CATALOG (2026-10-08): prompt-length tiers in the published tariff. Prices from platform.claude.com/docs/en/about-claude/pricing
 * read 2026-10-08: Claude Haiku 5.5 $0.10 / 0.125 / 0.20 / 0.01 / 0.50 per MTok for prompts up to 100,000 tokens, $0.50 / 0.625 / 1 / 0.05 /
 * 2.50 over that. Every other current model is flat and keeps its v1 tariff bytes.
 */
const HAIKU = 'claude-haiku-5-5', OVERHEAD = 2048, THRESHOLD = 100_000;
const LOWER = { input: '0.1', cacheWrite5m: '0.125', cacheWrite1h: '0.2', cacheRead: '0.01', output: '0.5' };
const UPPER = { input: '0.5', cacheWrite5m: '0.625', cacheWrite1h: '1', cacheRead: '0.05', output: '2.5' };
const SOURCE = { url: 'https://platform.claude.com/docs/en/about-claude/pricing', retrievedAt: '2026-09-28' };

describe('pricing registry v2', () => {
  it('ships Haiku 5.5 as a v2 tiered tariff and keeps every flat row a byte-identical v1 tariff', () => {
    expect(ANTHROPIC_PUBLISHED_TARIFFS.map(row => row.modelId)).toEqual(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', HAIKU, 'claude-haiku-4-5-20251001']);
    expect(anthropicPublishedTariff(HAIKU)).toEqual({ kind: 'anthropic-published', version: 2, currency: 'USD', modelId: HAIKU, usdPerMTok: LOWER,
      source: { ...SOURCE, retrievedAt: '2026-10-08' }, promptTokenBasis: 'input+cache-write+cache-read', promptTiers: [{ aboveTokens: THRESHOLD, usdPerMTok: UPPER }] });
    // The v1 objects (key order included) as they were before the registry moved to v2: same digest, so copied profiles stay equal.
    const before = { 'claude-fable-5-1': { input: '10', cacheWrite5m: '12.5', cacheWrite1h: '20', cacheRead: '0.25', output: '50' },
      'claude-opus-5-5': { input: '4', cacheWrite5m: '5', cacheWrite1h: '8', cacheRead: '0.2', output: '20' },
      'claude-sonnet-5-5': { input: '2', cacheWrite5m: '2.5', cacheWrite1h: '4', cacheRead: '0.1', output: '10' },
      'claude-haiku-4-5-20251001': { input: '1', cacheWrite5m: '1.25', cacheWrite1h: '2', cacheRead: '0.1', output: '5' } };
    for (const [modelId, usdPerMTok] of Object.entries(before)) {
      // Sonnet 5.5's cache read was corrected to 0.05x of input from the pricing page read 2026-10-08 (its own source date).
      const source = modelId === 'claude-sonnet-5-5' ? { ...SOURCE, retrievedAt: '2026-10-08' } : SOURCE;
      const v1 = { kind: 'anthropic-published', version: 1, currency: 'USD', modelId, usdPerMTok, source };
      expect(JSON.stringify(anthropicPublishedTariff(modelId)), modelId).toBe(JSON.stringify(v1));
      expect(providerSpendEvidenceDigest(anthropicPublishedTariff(modelId)), modelId).toBe(providerSpendEvidenceDigest(v1));
    }
  });

  it('still parses a stored v1 profile tariff unchanged, and refuses malformed tier tables', () => {
    const v1 = { kind: 'anthropic-published', version: 1, currency: 'USD', modelId: 'claude-opus-5-5',
      usdPerMTok: { input: '4', cacheWrite5m: '5', cacheWrite1h: '8', cacheRead: '0.2', output: '20' }, source: SOURCE };
    const definition = { endpoint: 'https://api.anthropic.com/v1/messages', maxOutputTokens: 4096,
      authentication: { type: 'header', name: 'x-api-key', credentialRef: 'ANTHROPIC_API_KEY' }, tariff: v1 };
    expect(JSON.stringify(parseAnthropicMessagesDefinition(definition).tariff)).toBe(JSON.stringify(v1));
    expect(parseAnthropicMessagesDefinition({ ...definition, tariff: anthropicPublishedTariff(HAIKU) }).tariff).toEqual(anthropicPublishedTariff(HAIKU));
    const tiered = structuredClone(anthropicPublishedTariff(HAIKU)) as Record<string, unknown> & { promptTiers: Record<string, unknown>[] };
    const refused: [string, (value: typeof tiered) => unknown][] = [
      ['v1 carrying tiers', value => ({ ...value, version: 1 })],
      ['v2 without tiers', value => ({ ...value, promptTiers: [] })],
      ['v2 without a counting basis', value => { const copy: Record<string, unknown> = { ...value }; delete copy['promptTokenBasis']; return copy; }],
      ['unknown counting basis', value => ({ ...value, promptTokenBasis: 'input-only' })],
      ['a later tier cheaper than the one before', value => ({ ...value, promptTiers: [{ aboveTokens: THRESHOLD, usdPerMTok: { ...UPPER, cacheRead: '0.001' } }] })],
      ['thresholds not ascending', value => ({ ...value, promptTiers: [value.promptTiers[0], { aboveTokens: THRESHOLD, usdPerMTok: UPPER }] })],
      ['a zero threshold', value => ({ ...value, promptTiers: [{ aboveTokens: 0, usdPerMTok: UPPER }] })],
    ];
    for (const [name, mutate] of refused) expect(anthropicTariffSchema.safeParse(mutate(tiered)).success, name).toBe(false);
  });
});

describe('tier selection', () => {
  const haiku = anthropicPublishedTariff(HAIKU)!;
  it('prices exactly the documented boundary: up to 100,000 prompt tokens is the lower tier, one more is the upper, unknown is the upper', () => {
    expect(anthropicTariffRates(haiku, 0)).toEqual({ rates: LOWER, aboveTokens: null });
    expect(anthropicTariffRates(haiku, THRESHOLD)).toEqual({ rates: LOWER, aboveTokens: null });
    expect(anthropicTariffRates(haiku, THRESHOLD + 1)).toEqual({ rates: UPPER, aboveTokens: THRESHOLD });
    expect(anthropicTariffRates(haiku, null)).toEqual({ rates: UPPER, aboveTokens: THRESHOLD });
    // A flat tariff has one rate set whatever the prompt size.
    const opus = anthropicPublishedTariff('claude-opus-5-5')!;
    for (const size of [0, THRESHOLD + 1, 900_000, null]) expect(anthropicTariffRates(opus, size)).toEqual({ rates: opus.usdPerMTok, aboveTokens: null });
  });

  it('reserves at the tier of the proven prompt bound (body bytes + overhead), on both sides of the threshold', () => {
    const atBound = THRESHOLD - OVERHEAD, maxTokens = 128_000;
    // 100,000 x $0.10 + 128,000 x $0.50 = $0.074 -> 8 cents; with the 1h cache write ($0.20): $0.084 -> 9 cents.
    expect(anthropicMaxChargeMinorUnits(haiku, 'none', atBound, maxTokens)).toBe(8);
    expect(anthropicMaxChargeMinorUnits(haiku, '1h', atBound, maxTokens)).toBe(9);
    // One byte more: the bound may exceed 100,000 tokens, so every class pays the upper tier, output included.
    // 100,001 x $0.50 + 128,000 x $2.50 = $0.3700005 -> 38 cents; 1h: 100,001 x $1 + $0.32 = $0.420001 -> 43 cents.
    expect(anthropicMaxChargeMinorUnits(haiku, 'none', atBound + 1, maxTokens)).toBe(38);
    expect(anthropicMaxChargeMinorUnits(haiku, '1h', atBound + 1, maxTokens)).toBe(43);
    // Never under-reserves: the upper-tier bound at the threshold is never below what any real prompt up to that bound costs.
    for (const bytes of [0, 1000, atBound, atBound + 1, 500_000]) {
      const lowerPriced = anthropicMaxChargeMinorUnits({ ...haiku, version: 1, usdPerMTok: LOWER } as never, 'none', bytes, maxTokens);
      expect(anthropicMaxChargeMinorUnits(haiku, 'none', bytes, maxTokens)).toBeGreaterThanOrEqual(lowerPriced);
    }
    // Flat models are unchanged (values pinned in provider-anthropic-messages.test.ts as well).
    expect(anthropicMaxChargeMinorUnits(anthropicPublishedTariff('claude-opus-5-5')!, '1h', 1_000_000, 128_000)).toBe(1058);
  });

  it('settles at the tier of the provider-reported prompt: input + cache writes + cache reads', () => {
    const reported = (input: number | null, write: number | null, read: number | null) =>
      anthropicReportedPromptTokens({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read });
    expect(reported(100_000, 0, 0)).toBe(THRESHOLD);
    expect(anthropicTariffRates(haiku, reported(100_000, 0, 0)).aboveTokens).toBeNull();
    // Mostly cached prompt: only 1 uncached token, yet the prompt is over 100,000 tokens and pays the upper tier.
    expect(reported(1, 40_000, 60_000)).toBe(THRESHOLD + 1);
    expect(anthropicTariffRates(haiku, reported(1, 40_000, 60_000))).toEqual({ rates: UPPER, aboveTokens: THRESHOLD });
    expect(reported(5, null, null)).toBe(5);
    expect(reported(null, 10, 10)).toBeNull();
    expect(anthropicTariffRates(haiku, reported(null, 10, 10)).aboveTokens).toBe(THRESHOLD);
  });
});

describe('quote of a prepared Haiku 5.5 request', () => {
  const endpoint = 'https://127.0.0.1:9/v1/messages', limits = { requestMaxBytes: 1_048_576, responseMaxBytes: 65_536, timeoutMs: 3000 };
  const reference = { providerId: 'anthropic', providerVersion: 1, modelId: 'haiku', modelVersion: 1 };
  const binding = { encodingVersion: 1, provider: { id: 'anthropic', version: 1 }, model: { id: 'haiku', version: 1, nativeId: HAIKU,
    protocols: [{ family: 'anthropic-messages', version: '2023-06-01', capabilities: [] }] } };
  const stored = (modelId: string) => ({ schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: 'a'.repeat(64),
    protocol: { family: 'anthropic-messages', version: '2023-06-01' }, adapter: { id: 'anthropic-messages-http', version: 2,
      definition: { endpoint, maxOutputTokens: 256, authentication: { type: 'header', name: 'x-api-key', credentialRef: 'ANTHROPIC_API_KEY' },
        tariff: anthropicPublishedTariff(modelId) } },
    allocation: { id: 'allocation', maxCalls: 1, maxInFlight: 1 }, limits });
  async function quote(text: string) {
    const priced = createAnthropicMessagesPricedNative({ resolveCredential: async () => 'sk-ant-test' }), profile = stored(HAIKU);
    const request = { model: HAIKU, messages: [{ role: 'user' as const, content: text }], max_completion_tokens: 256, stream: true, stream_options: { include_usage: true } };
    const command = { schemaVersion: 1 as const, commandId: 'command', scopeId: 'scope', reference, catalogRevision: 'catalog',
      expectedBinding: { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: 'a'.repeat(64) }, nativeRequest: request };
    const token = await priced.native.prepare(profile, binding, request);
    return priced.quote({ command, requestDigest: modelInvocationRequestDigest(command), profile, profileDigest: modelInvocationProfileDigest(profile),
      definition: binding, prepared: token } as never);
  }

  it('records the selected tier in the reservation evidence and prices the whole call at it', async () => {
    const short = await quote('hi'), long = await quote('x'.repeat(THRESHOLD));
    expect(short).toMatchObject({ pricing: { version: 2, definition: { modelId: HAIKU } },
      meter: { evidence: { calculation: { promptTier: { basis: 'input+cache-write+cache-read', aboveTokens: null } } } } });
    expect(long).toMatchObject({ pricing: { version: 2 }, meter: { evidence: { calculation: { promptTier: { aboveTokens: THRESHOLD } } } } });
    const bound = (value: typeof long) => (value.meter.evidence as { calculation: { inputBoundTokens: number } }).calculation.inputBoundTokens;
    expect(bound(long)).toBeGreaterThan(THRESHOLD);
    // $0.50 / $2.50 per MTok in cents: (tokens x 5 + output x 25) / 100,000, ceiled once.
    expect(long.maxChargeMinorUnits).toBe(Math.ceil((bound(long) * 5 + 256 * 25) / 100_000));
    expect(short.maxChargeMinorUnits).toBe(Math.ceil((bound(short) * 1 + 256 * 5) / 1_000_000));
  });
});
