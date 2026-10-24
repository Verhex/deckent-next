import { describe, expect, it } from 'vitest';
import { composeCatalogEvolutionRegistry, nearestRankMicro, wilsonIntervalMicro, ATTRIBUTABLE_FAILURE_CAUSES, NON_ATTRIBUTABLE_FAILURE_CAUSES, FAILURE_CAUSES } from '#domain/index.js';
import seed from '../../../assets/catalog-evolution/registry.json' with { type: 'json' };

// S8-2 (S8-DESIGN §4, §6, §10): the pure statistics of catalog evolution. Expected Wilson bounds are independent literals (z = 1.96, computed
// with 50-digit decimal arithmetic outside the product, then the lower bound floored and the upper ceiled to micro-units) and the design's own
// glossary examples: 18 of 20 ≈ 69.9 % (just under the 0.70 seed), 19 of 20 ≈ 76 %, 1 of 10 upper ≈ 40 %.
const Z = 1_960_000;
describe('Wilson score interval in integer micro-units', () => {
  it.each([[18, 20, 698961, 972135], [19, 20, 763864, 991119], [1, 10, 17875, 404157], [5, 20, 111860, 468706], [3, 6, 187612, 812388], [4, 5, 375528, 963777],
    [20, 20, 838869, 1000000], [0, 10, 0, 277541], [1, 1, 206543, 1000000]])('%i of %i → [%i, %i]', (s, n, lower, upper) => {
    expect(wilsonIntervalMicro(s, n, Z)).toEqual({ lowerMicro: lower, upperMicro: upper });
  });
  it('the glossary thresholds: 18/20 stays below the 0.70 promote seed, 19/20 clears it; 1/10 and 5/20 fall under the 0.50 redesign seed', () => {
    expect(wilsonIntervalMicro(18, 20, Z)!.lowerMicro).toBeLessThan(700000); expect(wilsonIntervalMicro(19, 20, Z)!.lowerMicro).toBeGreaterThanOrEqual(700000);
    expect(wilsonIntervalMicro(1, 10, Z)!.upperMicro).toBeLessThan(500000); expect(wilsonIntervalMicro(5, 20, Z)!.upperMicro).toBeLessThan(500000);
  });
  it('no counted outcome has no interval; out-of-range input is refused, never clamped', () => {
    expect(wilsonIntervalMicro(0, 0, Z)).toBeNull();
    for (const [s, n, z] of [[3, 2, Z], [-1, 2, Z], [1.5, 2, Z], [1, 2, 0]] as const) expect(() => wilsonIntervalMicro(s, n, z)).toThrow(RangeError);
  });
  it('is byte-reproducible: integers only, the same answer every call', () => {
    const first = wilsonIntervalMicro(37, 50, Z)!;
    expect(Number.isInteger(first.lowerMicro) && Number.isInteger(first.upperMicro)).toBe(true);
    expect(JSON.stringify(wilsonIntervalMicro(37, 50, Z))).toBe(JSON.stringify(first));
  });
});
describe('nearest-rank order statistic', () => {
  it('takes the value at rank ⌈p·N⌉ of the ascending values (hand-computed)', () => {
    expect(nearestRankMicro([40, 10, 30, 20], 500000)).toBe(20); expect(nearestRankMicro([40, 10, 30, 20], 900000)).toBe(40);
    expect(nearestRankMicro([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 900000)).toBe(9); expect(nearestRankMicro([7], 500000)).toBe(7); expect(nearestRankMicro([], 500000)).toBeNull();
  });
});
describe('failure attribution sets', () => {
  it('only criteria, the worker report and a person rejecting count; every other cause and `unattributed` is its own bucket', () => {
    expect([...ATTRIBUTABLE_FAILURE_CAUSES]).toEqual(['criteria-failed', 'worker-report-failed', 'human-rejected']);
    expect([...NON_ATTRIBUTABLE_FAILURE_CAUSES]).toEqual(['infra', 'model', 'dependency', 'policy', 'operator', 'unattributed']);
    expect([...ATTRIBUTABLE_FAILURE_CAUSES, ...NON_ATTRIBUTABLE_FAILURE_CAUSES].sort()).toEqual([...FAILURE_CAUSES].sort());
  });
});
describe('registry catalog-evolution v1', () => {
  it('the Core seed parses with every rule and the registry provisional (K-F S8: nothing is measured yet)', () => {
    const registry = composeCatalogEvolutionRegistry();
    expect(registry).toMatchObject({ schemaVersion: 1, status: 'provisional', stats: { zMicro: Z, windowTasks: 50, windowMaxDays: 30, excludeUnknownEvidence: true },
      pass: { passPageRows: 200, maxKeysPerPass: 64 } });
    expect(registry.rules.map(rule => [rule.kind, rule.status])).toEqual([['promote-agent', 'provisional'], ['redesign-agent', 'provisional'], ['revise-agent', 'provisional'],
      ['propose-agent', 'provisional'], ['propose-skill', 'provisional']]);
  });
  it('an overlay lowers a resource bound and replaces a rule row by a newer version; a person may mark it calibrated', () => {
    const registry = composeCatalogEvolutionRegistry({ revision: 'site-1', stats: { windowTasks: 20, windowMaxDays: 60 },
      rules: [{ id: 'redesign-agent', version: 2, kind: 'redesign-agent', status: 'calibrated', params: { minSamples: 12, upperBoundMicro: 450000 } }] });
    expect(registry.revision).toBe('site-1'); expect(registry.stats).toMatchObject({ windowTasks: 20, windowMaxDays: 60, readRowsMax: 5000 });
    expect(registry.rules.find(rule => rule.id === 'redesign-agent')).toMatchObject({ version: 2, status: 'calibrated' });
  });
  it.each([
    ['a widened resource bound', { revision: 'x', stats: { readRowsMax: 5001 } }], ['a widened pass bound', { revision: 'x', pass: { maxKeysPerPass: 65 } }],
    ['a rule row without a newer version', { revision: 'x', rules: [{ id: 'promote-agent', version: 1, kind: 'promote-agent', status: 'calibrated', params: seed.rules[0]!.params }] }],
    ['a rule row of another kind', { revision: 'x', rules: [{ id: 'promote-agent', version: 2, kind: 'propose-agent', status: 'provisional', params: { minTasks: 1 } }] }],
    ['an unknown rule id', { revision: 'x', rules: [{ id: 'new-rule', version: 1, kind: 'propose-agent', status: 'provisional', params: { minTasks: 1 } }] }],
    ['an unknown field', { revision: 'x', thresholds: {} }], ['a fractional threshold', { revision: 'x', stats: { zMicro: 1.96 } }],
  ])('N34: %s → CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE, never a default', (_name, overlay) => {
    expect(() => composeCatalogEvolutionRegistry(overlay)).toThrow(expect.objectContaining({ code: 'CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE' }));
  });
  it('N34: a missing or corrupt seed is unavailable too', () => {
    for (const broken of [null, {}, { ...seed, schemaVersion: 2 }, { ...seed, rules: [...seed.rules, seed.rules[0]] }])
      expect(() => composeCatalogEvolutionRegistry(undefined, broken)).toThrow(expect.objectContaining({ code: 'CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE' }));
  });
});
