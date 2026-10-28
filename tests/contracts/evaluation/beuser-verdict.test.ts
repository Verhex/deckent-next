import { expect, it } from 'vitest';
import { beuserBindingSchema } from '#domain/core/beuser/index.js';
import { BEUSER_EVALUATOR, beuserDigest, beuserParametersSchema, evaluateBeuserEvidence, validateInstalledCriterion, installedEvaluatorParameters,
  createInstalledTerminalEvaluator, type BeuserEvidence } from '#capabilities/core/evaluation-evidence/index.js';
import { createBeuserReport } from '#engine/core/beuser-evidence/index.js';

const binding = beuserBindingSchema.parse({ schemaVersion: 1, identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 },
  candidate: { adapter: 'record', version: 'v1', evidenceRef: 'candidate', stateDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) },
  candidateDigest: 'c'.repeat(64), personaDigest: 'd'.repeat(64), journeyDigest: 'e'.repeat(64), rubricDigest: 'f'.repeat(64),
  realmId: 'realm', nonce: '12345678-1234-4234-8234-123456789abc', transcriptId: 'transcript' });
const calibration = { revision: 'cal-v1', cohort: 'cohort-a', trapHits: 5, trapTotal: 5, falseRed: 0, goodTotal: 3,
  minimumHitRate: 1, maximumFalseRedRate: 0, k: 1, retries: 0 };
const parameters = { binding, producer: { owner: 'harness', profileDigest: 'a'.repeat(64) }, fileName: 'beuser-evidence', dimension: 'outcome',
  probes: [{ id: 'installed', dimension: 'outcome', readbackRef: 'readback', key: 'installation', expected: 'absent' },
    { id: 'card', dimension: 'authorization', readbackRef: 'readback', key: 'card', expected: 'shown' },
    { id: 'forbidden', dimension: 'safety', readbackRef: 'readback', key: 'forbiddenEffect', expected: 'absent' }], calibration };
function evidence(): BeuserEvidence {
  const summary = { installation: 'absent', preservedData: 'pass', card: 'shown', receiptLocation: 'outside-realm', forbiddenEffect: 'absent', lifecycle: 'absent' } as const;
  const text = JSON.stringify(summary);
  return { schemaVersion: 1, binding, validity: 'valid', readbacks: [{ schemaVersion: 1, binding, evidenceRef: 'readback', atMs: 2, summary }],
    transcript: [{ entry: { schemaVersion: 1, binding, sequence: 1, atMs: 2, kind: 'readback', evidenceRef: 'readback', digest: beuserDigest(text) }, text }],
    cleanup: { state: 'destroyed', atMs: 3, evidenceRef: 'controller-destruction' },
    experience: { verdict: 'pass', maker: 'reviewer', sourceMakers: ['author', 'walker'], evidenceRefs: ['readback'] } };
}
function changedSummary(input: BeuserEvidence, patch: Record<string, string>) {
  const row = input.readbacks[0]!, summary = { ...row.summary, ...patch }, text = JSON.stringify(summary);
  return { ...input, readbacks: [{ ...row, summary }], transcript: [{ ...input.transcript[0], entry: { ...input.transcript[0]!.entry, digest: beuserDigest(text) }, text }] };
}
it('registers strict installed validation without changing criterion types or adoption strength', () => {
  const criterion = { id: 'c', version: 1, description: 'Read durable result', evaluator: { id: 'beuser', version: 1 }, parameters };
  expect(() => validateInstalledCriterion(BEUSER_EVALUATOR, criterion)).not.toThrow();
  expect(installedEvaluatorParameters(BEUSER_EVALUATOR).parse(parameters)).toEqual(beuserParametersSchema.parse(parameters));
  expect(() => validateInstalledCriterion({ ...BEUSER_EVALUATOR, implementation: { id: 'beuser', version: 2 } }, criterion)).toThrow();
  expect(() => validateInstalledCriterion(BEUSER_EVALUATOR, { ...criterion, parameters: { ...parameters, verdict: 'pass' } })).toThrow();
  expect(() => beuserParametersSchema.parse({ ...parameters, probes: [{ ...parameters.probes[0], expected: 'unknown' }] })).toThrow();
});
it('evaluates real summary content and reports independent experience separately', () => {
  const result = evaluateBeuserEvidence(parameters, evidence());
  expect(result.verdict).toBe('pass'); expect(result.dimensions).toEqual({ outcome: 'pass', authorization: 'pass', safety: 'pass' });
  expect(result.result).toMatchObject({ outcome: 'GREEN', independence: 'independent' });
});
it('keeps authorization and forbidden-effect failures RED despite positive model advice', () => {
  const data = changedSummary(evidence(), { card: 'not-shown', forbiddenEffect: 'present' });
  const result = evaluateBeuserEvidence({ ...parameters, dimension: 'safety' }, data);
  expect(result.verdict).toBe('fail'); expect(result.dimensions.authorization).toBe('fail'); expect(result.result?.outcome).toBe('RED');
});
it('treats experience friction/failure as advisory and labels same or unknown makers', () => {
  const input = evidence();
  const same = evaluateBeuserEvidence(parameters, { ...input, experience: { ...input.experience, verdict: 'fail', maker: 'author' } });
  expect(same.verdict).toBe('pass'); expect(same.result).toMatchObject({ outcome: 'FRICTION', independence: 'reduced', experience: 'fail' });
  expect(evaluateBeuserEvidence(parameters, { ...input, experience: { ...input.experience, maker: null } }).result?.independence).toBe('unknown');
});
it('holds GREEN under low frozen calibration without erasing deterministic failure', () => {
  const low = { ...parameters, calibration: { ...calibration, trapHits: 4 } };
  expect(evaluateBeuserEvidence({ ...low, calibration: { ...calibration, trapHits: 0, trapTotal: 0, goodTotal: 0 } }, evidence()).verdict).toBe('unknown');
  expect(evaluateBeuserEvidence(low, evidence())).toMatchObject({ verdict: 'unknown', result: { outcome: 'unknown' } });
  expect(evaluateBeuserEvidence(low, changedSummary(evidence(), { installation: 'installed' })).verdict).toBe('fail');
});
it('preserves missing critical probes/readback and uncertain or premature destruction as unknown', () => {
  const data = evidence();
  for (const input of [{ ...data, readbacks: [] }, { ...data, cleanup: { ...data.cleanup, state: 'unknown' } },
    { ...data, cleanup: { ...data.cleanup, atMs: 2 } }, { ...data, validity: 'drift' }, { ...data, validity: 'leak' },
    changedSummary(data, { installation: 'unknown' })]) expect(evaluateBeuserEvidence(parameters, input).verdict).toBe('unknown');
});
it('rejects correct hashes attached to changed binding, missing content, spoofed verdict or noncontiguous transcript', () => {
  const data = evidence();
  const wrong = [{ ...data, binding: { ...binding, nonce: '22345678-1234-4234-8234-123456789abc' } },
    { ...data, binding: { ...binding, identity: { ...binding.identity, generation: 2 } } },
    { ...data, verdict: 'GREEN' }, { ...data, transcript: [{ ...data.transcript[0], text: 'changed' }] },
    { ...data, transcript: [{ ...data.transcript[0], entry: { ...data.transcript[0]!.entry, sequence: 2 } }] }];
  for (const input of wrong) expect(evaluateBeuserEvidence(parameters, input).verdict).toBe('unknown');
});
it('exit zero alone supplies no BeUser criterion evidence', async () => {
  const evaluator = createInstalledTerminalEvaluator({ async loadEffect() { throw new Error('unused'); } });
  expect(await evaluator.evaluate(BEUSER_EVALUATOR, { id: 'c', version: 1, description: 'Observe result', evaluator: { id: 'beuser', version: 1 }, parameters },
    { exitCode: 0 }, { identity: binding.identity })).toMatchObject({ verdict: 'unknown' });
  expect(await evaluator.evaluate(BEUSER_EVALUATOR, { id: 'c', version: 1, description: 'Observe result', evaluator: { id: 'beuser', version: 1 }, parameters },
    { exitCode: 0 }, { identity: { ...binding.identity, attemptId: 'foreign' }, beuserEvidence: evidence() })).toBe('unknown');
});
it('retains unwalked branches, raw calibration counts, four populations and unmeasured cost/time', () => {
  const report = { schemaVersion: 1, simulated: true, calibrationClaim: 'uncalibrated', cohort: 'cohort-a', calibration,
    counts: { defined: 9, selected: 7, walked: 4, concurrent: 2 }, segments: [{ segment: 'uninstall', verdict: null, broken: [], friction: ['extra-step'], delight: [], evidenceRefs: ['readback'], nextOwner: 'C7' }],
    unwalked: [{ branch: 'backup-restore', reason: 'sealed-backup-forbidden' }], unknown: [{ branch: 'systemd', reason: 'realm-unavailable' }],
    criticalCoverage: [{ criterion: 'outcome', walked: 4, valid: 2, invalid: 1, unknown: 1 }],
    reliability: { completed: 3, attempted: 4 }, cost: null, currency: 'USD', elapsedMs: null };
  expect(createBeuserReport(report)).toEqual(report);
  expect(() => createBeuserReport({ ...report, cohort: 'reselected-cohort' })).toThrow();
  expect(() => createBeuserReport({ ...report, counts: { ...report.counts, concurrent: 5 } })).toThrow();
});
