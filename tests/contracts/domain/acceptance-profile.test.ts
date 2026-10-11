import { expect, it } from 'vitest';
import { applyTaskEvaluation, bindTaskAcceptance, inspectTaskEvaluation, runSnapshotSchema, taskEvaluationSchema } from '#domain/index.js';
import { assertRunExecution } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { graph, execution, evaluating, evidence } from './acceptance-fixture.js';

it('admission stores one profile per Run, including tasks selected through the kind binding', () => {
  const many = { ...graph, tasks: [graph.tasks[0]!, { ...graph.tasks[0]!, id: 'other' }] };
  const frozen = execution(many);
  expect(frozen.workClassProfiles).toHaveLength(1);
  expect(frozen.tasks[0]!.acceptance).toEqual(frozen.tasks[1]!.acceptance);
  expect(frozen.tasks[0]!.acceptance?.policyRevision).toBe('["worker-effort-2026-10-03","business-r1"]');
  expect(JSON.stringify(frozen.tasks[0])).not.toContain('ceilingRules');
  expect(assertRunExecution(many, JSON.parse(JSON.stringify(frozen)))).toEqual(frozen);
});
it('legacy snapshots and evaluation bytes retain absent metadata with no backfill', () => {
  const legacy = fixtureExecution(graph); const serialized = JSON.stringify(legacy);
  expect(JSON.stringify(assertRunExecution(graph, JSON.parse(serialized)))).toBe(serialized);
  const row = evidence().criteria[0]!; const criterion = { criterionId: row.criterionId, verdict: row.verdict, evidenceIds: row.evidenceIds };
  const old = { ...evidence(), criteria: [criterion] };
  const historicalBytes = JSON.stringify(taskEvaluationSchema.parse(old));
  expect(JSON.stringify(taskEvaluationSchema.parse(JSON.parse(historicalBytes)))).toBe(historicalBytes);
  expect(legacy).not.toHaveProperty('workClassProfiles');
});
it.each(['version', 'criterion', 'profile', 'effort'] as const)('reopen refuses inconsistent frozen %s', defect => {
  const snapshot = JSON.parse(JSON.stringify(execution()));
  if (defect === 'version') snapshot.workClassProfiles[0].profileVersion++;
  if (defect === 'criterion') snapshot.tasks[0].acceptance.criteria[0].criterionId = 'unrelated';
  if (defect === 'profile') snapshot.workClassProfiles = [];
  if (defect === 'effort') snapshot.tasks[0].acceptance.policyRevision = 'other-revision';
  expect(() => assertRunExecution(graph, snapshot)).toThrow();
});
it('the evaluation and resulting Task consume exactly the frozen profile, with deterministic metadata', () => {
  const { run } = evaluating(); const evaluation = bindTaskAcceptance(run, evidence());
  expect(evaluation.acceptance?.score).toBe(1);
  expect(inspectTaskEvaluation(run, evaluation).conclusion).toBe('pass');
  const applied = applyTaskEvaluation(run, run.revision, evaluation, { now: 100, timeoutMs: 1000 });
  expect(applied.snapshot.progress[0]!.phase).toBe('accepted');
  expect(applied.evaluation.acceptance).toEqual(evaluation.acceptance);
  expect(runSnapshotSchema.parse(JSON.parse(JSON.stringify(applied.snapshot)))).toEqual(applied.snapshot);
});
it.each([[], ['ext:unregistered'], ['approval-receipt']].map(types => ({ types })))('missing or unregistered evidence cannot pass: $types', ({ types }) => {
  const { run } = evaluating(); const input = { ...evidence(), criteria: [{ ...evidence().criteria[0]!, evidenceTypes: types }] };
  const bound = bindTaskAcceptance(run, input);
  expect(bound.criteria[0]!.verdict).toBe('unknown');
  expect(bound.acceptance).toMatchObject({ score: 0, ceilingReasons: ['missing-evidence'] });
  expect(inspectTaskEvaluation(run, bound).conclusion).toBe('unknown');
});
it('a forged pass above the ceiling and a mismatched profile revision are typed refusals', () => {
  const { run } = evaluating(); const absent = bindTaskAcceptance(run, { ...evidence(), criteria: [{ ...evidence().criteria[0]!, evidenceTypes: [] }] });
  expect(() => inspectTaskEvaluation(run, { ...absent, acceptance: { ...absent.acceptance!, score: 1 } })).toThrow('TASK_EVALUATION_PROFILE_MISMATCH');
  const bound = bindTaskAcceptance(run, evidence());
  expect(() => inspectTaskEvaluation(run, { ...bound, acceptance: { ...bound.acceptance!, policyRevision: 'other' } })).toThrow('TASK_EVALUATION_PROFILE_MISMATCH');
  expect(() => inspectTaskEvaluation(run, evidence())).toThrow('TASK_EVALUATION_PROFILE_MISMATCH');
});
it('profile scores never loosen unresolved-effect refusal', () => {
  const { run } = evaluating(); const uncertain = runSnapshotSchema.parse({ ...run, progress: [{ ...run.progress[0]!, unresolvedEffects: true }] });
  const bound = bindTaskAcceptance(uncertain, evidence());
  expect(bound.acceptance?.score).toBe(0);
  expect(() => inspectTaskEvaluation(uncertain, bound)).toThrow('TASK_EVALUATION_NOT_READY');
});
