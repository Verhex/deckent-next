import { expect, it } from 'vitest';
import { workerReportEvidence, workerReportRefusal, workerReportEvidenceSchema, TASK_NOT_ACCEPTED_REASONS, taskProgressSchema } from '#domain/index.js';
// PRE-7 goal 2: an acceptance check the worker reports as not run keeps refusing the task, under its own observed reason. It is never
// labelled an environment defect (a worker claim is not proof, Law 1); only Deckent's own preflight evidence carries that label.
const check = (checkId: string, outcome: string, role = 'acceptance') => ({ command: 'npm test', outcome, checkId, role });
const refusal = (...checks: unknown[]) => workerReportRefusal(workerReportEvidence({ schemaVersion: 1, kind: 'native-worker-report', status: 'reported',
  report: { schemaVersion: 1, summary: 's', changedFiles: [], checks, openIssues: [] } } as Parameters<typeof workerReportEvidence>[0]));

it('the last outcome per acceptance check decides: not-run gets acceptance-check-not-run, failed and unknown stay declared-check-not-passed', () => {
  expect(refusal(check('lint', 'not-run'))).toBe('acceptance-check-not-run');
  expect(refusal(check('lint', 'failed'), check('lint', 'not-run'))).toBe('acceptance-check-not-run');
  expect(refusal(check('lint', 'not-run'), check('lint', 'passed'))).toBeNull();
  // `unknown`: the check ran and its outcome could not be read (truncated, killed); it is a not-passed result of a run, not a not-run.
  expect(refusal(check('lint', 'unknown'))).toBe('declared-check-not-passed');
  // A check that ran and did not pass outranks one that could not run: the work itself is shown as not passing.
  expect(refusal(check('lint', 'not-run'), check('test', 'failed'))).toBe('declared-check-not-passed');
  expect(refusal(check('lint', 'not-run'), check('test', 'unknown'))).toBe('declared-check-not-passed');
  expect(refusal({ command: 'x', outcome: 'not-run', role: 'acceptance' })).toBe('acceptance-check-not-run');
});

it('negative: exploratory and untyped not-run checks stay claims; the stored evidence and task reason vocabularies are additive', () => {
  expect(refusal(check('lint', 'not-run', 'exploratory'))).toBeNull();
  expect(refusal({ command: 'x', outcome: 'not-run' })).toBeNull();
  expect(workerReportEvidenceSchema.parse({ status: 'reported', acceptanceChecks: 'not-run' })).toEqual({ status: 'reported', acceptanceChecks: 'not-run' });
  expect(workerReportEvidenceSchema.safeParse({ status: 'missing', acceptanceChecks: 'not-run' }).success).toBe(false);
  expect(TASK_NOT_ACCEPTED_REASONS).toContain('acceptance-check-not-run');
  expect(taskProgressSchema.parse({ taskId: 't', phase: 'failed', unresolvedEffects: false, eligibility: { kind: 'immediate' }, notAcceptedReason: 'acceptance-check-not-run' }).notAcceptedReason).toBe('acceptance-check-not-run');
});
