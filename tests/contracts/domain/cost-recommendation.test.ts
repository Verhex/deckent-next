import { expect, it } from 'vitest';
import { recommendCostProfile, type CostComparisonTrial } from '#domain/index.js';
const d = (n: number) => n.toString(16).padStart(64, '0');
const policy = { axis: 'cpu-seconds' as const, maxCandidates: 2, minPairs: 3, confidence: 0.95, maxLossRisk: 0.9, maxEvidenceEntries: 100 };
const trial = (pair: number, candidate: boolean): CostComparisonTrial => ({ evidenceId: d(pair * 2 + Number(candidate) + 10), pairId: d(pair), workClass: 'purchase',
  identity: { scopeId: 's', runId: 'r', taskId: `case-${pair}-${candidate}`, attemptId: `a-${pair}-${candidate}`, generation: 1, layoutRevision: 'l' },
  profileKey: candidate ? 'candidate@1' : 'baseline@1', workloadDigest: d(pair), criterionDigest: d(1), environmentDigest: d(2), splitDigest: d(3), policyRevision: 'policy-r1',
  axis: 'cpu-seconds', cost: candidate ? 5 : 10, accepted: true, score: 1, safetyViolation: false, modelVerified: true, heldOut: true, followupComplete: true,
  criteria: [{ id: 'quality', verdict: 'pass' }], interventions: 0, rework: 0, rollbacks: 0 });
const trials = Array.from({ length: 3 }, (_, index) => [trial(index, false), trial(index, true)]).flat();
const compare = (rows = trials, overrides = {}) => recommendCostProfile({ workClass: 'purchase', baselineProfile: 'baseline@1', candidateProfile: 'candidate@1', axis: 'cpu-seconds',
  allowedProfiles: ['baseline@1', 'candidate@1'], trials: rows, policy, ...overrides });
it('proposes an explicit cost axis from sufficient paired evidence, with risk bound and no input mutation', () => {
  const before = JSON.stringify(trials), result = compare();
  expect(result).toMatchObject({ state: 'proposal', authority: 'proposal-only', evidencePairs: 3, savingFraction: 0.5 });
  expect(result.lossRiskUpper).toBeCloseTo(1 - Math.pow(0.05, 1 / 3)); expect(JSON.stringify(trials)).toBe(before);
  expect(compare([...trials, ...trials])).toEqual(result);
});
it.each(['accepted', 'score', 'safetyViolation', 'interventions', 'rework', 'rollbacks'] as const)('vetoes one quality loss even with insufficient sample size: %s', field => {
  const candidate = trial(0, true), changed = { ...candidate, [field]: field === 'accepted' ? false : field === 'safetyViolation' ? true : field === 'score' ? 0.99 : 1 };
  expect(compare([trial(0, false), changed])).toMatchObject({ state: 'quality-loss', reason: 'quality-regression', evidencePairs: 1 });
});
it('refuses small samples, strict risk bound, unknown quality, missing money/cost and a changed acceptance/environment/split', () => {
  expect(compare(trials.slice(0, 2)).reason).toBe('sample-size');
  expect(compare(trials, { policy: { ...policy, maxLossRisk: 0.01 } }).reason).toBe('risk-bound');
  for (const change of [{ accepted: null }, { interventions: null }, { modelVerified: false }, { heldOut: false }, { followupComplete: false }, { cost: null }]) {
    expect(compare(trials.map(row => row.profileKey === 'candidate@1' ? { ...row, ...change } : row)).state).toBe('insufficient-evidence');
  }
  for (const field of ['criterionDigest', 'environmentDigest', 'splitDigest', 'policyRevision'] as const) {
    const rows = trials.map(row => row.profileKey === 'candidate@1' ? { ...row, [field]: field === 'policyRevision' ? 'other' : d(99) } : row);
    expect(compare(rows).reason).toBe('unmatched-evidence');
  }
});
it('does not promote unregistered profiles, conflicting replay, omitted pairs or equal/higher costs', () => {
  expect(compare(trials, { allowedProfiles: ['baseline@1'] }).reason).toBe('unregistered-profile');
  expect(compare([...trials, { ...trials[0]!, cost: 4 }]).reason).toBe('evidence-conflict');
  expect(compare(trials.slice(1)).reason).toBe('unmatched-evidence');
  expect(compare(trials.map(row => ({ ...row, cost: 10 }))).state).toBe('no-savings');
});
it('vetoes one criterion loss even if overall score/acceptance stay equal, and rejects repeated attempts under new evidence ids', () => {
  const rows = trials.map(row => row.profileKey === 'candidate@1' ? { ...row, criteria: [{ id: 'quality', verdict: 'fail' as const }] } : row);
  expect(compare(rows).state).toBe('quality-loss');
  expect(compare([...trials, { ...trials[0]!, evidenceId: d(99), pairId: d(99) }]).reason).toBe('evidence-conflict');
});
