import { describe, expect, it } from 'vitest';
import { readDecisionPolicy, validateDecisionPolicyLayers } from '#adapters/core/contract/index.js';

const policy = { schemaVersion: 1, limits: { maxCaseBytes: 16_384, maxEvidence: 8, maxOptions: 8, maxChecks: 8, maxTextBytes: 1_024 },
  thresholds: { choice: 0.8, sufficiency: 0.7 } };
describe('registered decision policy', () => {
  it('keeps absence explicit', () => { expect(readDecisionPolicy({})).toBeNull(); });
  it('reads authored thresholds', () => { expect(readDecisionPolicy({ decision: policy })?.thresholds).toEqual(policy.thresholds); });
  it('allows child narrowing but refuses threshold relaxation', () => {
    expect(() => validateDecisionPolicyLayers(policy, { ...policy, thresholds: { choice: 0.9, sufficiency: 0.8 } })).not.toThrow();
    expect(() => validateDecisionPolicyLayers(policy, { ...policy, thresholds: { choice: 0.7, sufficiency: 0.7 } })).toThrow();
  });
  it('refuses expanding a parent byte or count budget', () => {
    for (const key of Object.keys(policy.limits) as (keyof typeof policy.limits)[]) {
      expect(() => validateDecisionPolicyLayers(policy, { ...policy, limits: { ...policy.limits, [key]: policy.limits[key] + 1 } })).toThrow();
    }
  });
});
