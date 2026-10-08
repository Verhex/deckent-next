import { describe, expect, it } from 'vitest';
import { anthropicPublishedTariff, anthropicSettledCharge } from '#adapters/core/provider-anthropic-messages/index.js';
const tariff = anthropicPublishedTariff('claude-haiku-5-5')!;
const usage = (input: number, read = 0, five = 0, hour = 0, output = 0, split = true) => ({
  prompt_tokens: input + read + five + hour, completion_tokens: output, total_tokens: input + read + five + hour + output,
  anthropic: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: five + hour,
    ...(split ? { cache_creation: { ephemeral_5m_input_tokens: five, ephemeral_1h_input_tokens: hour } } : {}) },
});
describe('Haiku 5.5 exact settlement', () => {
  it.each([
    [usage(100_000), '1', null], [usage(100_001), '5.00005', 100_000],
    [usage(0, 100_000), '0.1', null], [usage(0, 100_001), '0.500005', 100_000],
    [usage(0, 0, 100_000), '1.25', null], [usage(0, 0, 100_001), '6.2500625', 100_000],
    [usage(0, 0, 0, 100_000), '2', null], [usage(0, 0, 0, 100_001), '10.0001', 100_000],
    [usage(1, 99_999, 0, 0, 2), '0.100109', null],
    [usage(1, 100_000, 0, 0, 2), '0.50055', 100_000],
    [usage(0, 0, 100_000, 0, 0, false), '2', null],
    [usage(0, 0, 100_001, 0, 0, false), '10.0001', 100_000],
  ])('prices reported classes and boundary %#', (value, exact, tier) => {
    expect(anthropicSettledCharge(tariff, value)).toMatchObject({ exactMinorUnits: exact, tier });
  });
  it('does not double count thinking, and refuses inconsistent cache splits', () => {
    expect(anthropicSettledCharge(tariff, { ...usage(0, 0, 0, 0, 100), completion_tokens_details: { reasoning_tokens: 80 } }).exactMinorUnits).toBe('0.005');
    const invalid = usage(0, 0, 4); invalid.anthropic.cache_creation!.ephemeral_1h_input_tokens = 1;
    expect(() => anthropicSettledCharge(tariff, invalid)).toThrow('PROVIDER_SPEND_INVALID');
  });
  it('retains only allowlisted financial dimensions', () => {
    const charge = anthropicSettledCharge(tariff, { ...usage(1, 2, 3, 4, 5), secret: 'sk-secret-canary' });
    expect(JSON.stringify(charge)).not.toContain('sk-secret-canary');
    expect(charge.dimensions.map(d => d.tokens)).toEqual([1, 2, 3, 4, 5]);
  });
});

it('records a missing cache split as unsplit usage, rather than inventing 1h token counts', () => {
  expect(anthropicSettledCharge(tariff, usage(0, 0, 10, 0, 0, false))).toMatchObject({ cacheSplit: 'dearest',
    dimensions: expect.arrayContaining([{ field: 'cache-write-unsplit', tokens: 10, usdPerMillionTokens: '0.2' }]) });
});
