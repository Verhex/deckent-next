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
  expect(frozen.tasks[0]!.acceptance?.policyRevision).toBe('["atama-1-2026-10-23","business-r1"]');
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
it.each([
  ['missing', 'report-missing', ['missing-evidence']], ['invalid', 'report-invalid', ['missing-evidence']], ['oversized', 'report-invalid', ['missing-evidence']],
] as const)('R5: report status %s on a bound work task fails typed and is capped by the missing-evidence ceiling', (status, reason, ceilingReasons) => {
  const workInput = { schemaVersion: 1, task: 'Post the invoice', scope: { paths: ['erp/invoices'] }, acceptance: 'Invoice posted', model: { channelId: 'channel', modelId: 'model', auxiliaryModelIds: [] } };
  // Pure domain fixture: template compilation is admission's concern; the bound business work class has no acceptance exception.
  const { run: base } = evaluating();
  const run = runSnapshotSchema.parse({ ...base, graph: { ...base.graph, schemaVersion: 3, tasks: [{ ...base.graph.tasks[0]!, workInput }] } });
  const change = { schemaVersion: 1, patchDigest: 'a'.repeat(64), changedFiles: 1 };
  const passing = bindTaskAcceptance(run, { ...evidence(), workspaceChange: change, report: { status: 'reported' } });
  expect(inspectTaskEvaluation(run, passing)).toEqual({ evaluation: passing, conclusion: 'pass' });
  const bound = bindTaskAcceptance(run, { ...evidence(), workspaceChange: change, report: { status } });
  expect(bound.acceptance).toMatchObject({ score: 0, ceilingReasons });
  expect(inspectTaskEvaluation(run, bound)).toMatchObject({ conclusion: 'fail', notAcceptedReason: reason });
  expect(applyTaskEvaluation(run, run.revision, bound, { now: 100, timeoutMs: 1000 }).snapshot.progress[0]).toMatchObject({ phase: 'failed', notAcceptedReason: reason });
  // The report evidence is a work-task field: a needs-input exit or a non-work task carrying it is refused, never silently passed.
  expect(() => inspectTaskEvaluation(run, { ...bound, workerExit: { schemaVersion: 1, kind: 'needs-input', question: 'Which ledger?' } })).toThrow('TASK_EVALUATION_INVALID');
  const { run: plain } = evaluating();
  expect(() => inspectTaskEvaluation(plain, bindTaskAcceptance(plain, { ...evidence(), report: { status: 'missing' } }))).toThrow('TASK_EVALUATION_INVALID');
});
