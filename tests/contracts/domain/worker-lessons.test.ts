import { expect, it } from 'vitest';
import { readWorkerFinalReport, workerFinalReportSchema, workerReportEvidence, workerReportEvidenceSchema, workerReportLimits, workerReportRefusal, TASK_NOT_ACCEPTED_REASONS,
  taskProgressSchema } from '#domain/index.js';
import { notAcceptedLabel } from '#surfaces/core/monitor/index.js';

// S4B-2 (S4B-DESIGN §4.4, owner S-M1..S-M14 2026-10-23): the optional bounded `lessons` claim of the worker report. Limits are registry data; an incomplete or
// oversized claim is refused typed (never coerced); an old report without the field stays valid.
const base = { schemaVersion: 1, summary: 'Done', changedFiles: [], checks: [], openIssues: [] };
const lesson = { kind: 'lesson', title: 'Masraf merkezi', body: 'Boş geçilemez.', cause: 'Alan boştu', correction: 'Onaya gönder' };
const fact = { kind: 'fact', title: 'Not', body: 'Tek satır.' };
const line = (report: unknown) => JSON.stringify({ schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report });
const text = (n: number) => 'a'.repeat(n);

it('an old report without lessons stays valid; facts and complete lessons are accepted up to the registry count', () => {
  expect(workerFinalReportSchema.safeParse(base).success).toBe(true);
  expect(workerFinalReportSchema.safeParse({ ...base, lessons: [] }).success).toBe(true);
  expect(workerFinalReportSchema.safeParse({ ...base, lessons: [fact, lesson, fact].slice(0, workerReportLimits.lessons) }).success).toBe(true);
  expect(readWorkerFinalReport(line({ ...base, lessons: [lesson] }))).toMatchObject({ status: 'reported', report: { lessons: [lesson] } });
});
it('negative: too many, too long, incomplete, extra-key and wrong-kind lessons are refused at parse with the typed reason lessons-invalid', () => {
  const l = workerReportLimits;
  for (const lessons of [Array.from({ length: l.lessons + 1 }, () => fact), [{ ...fact, title: text(l.lessonTitleChars + 1) }], [{ ...fact, body: text(l.lessonBodyChars + 1) }],
    [{ ...lesson, cause: text(l.lessonFieldChars + 1) }], [{ ...lesson, correction: text(l.lessonFieldChars + 1) }],
    [{ kind: 'lesson', title: 't', body: 'b', cause: 'c' }], [{ kind: 'lesson', title: 't', body: 'b', correction: 'c' }], [{ ...fact, cause: 'c' }], [{ ...fact, grant: 'full-access' }],
    [{ ...fact, title: '   ' }], [{ ...fact, kind: 'rule' }], 'not-an-array', [null]]) {
    expect(workerFinalReportSchema.safeParse({ ...base, lessons }).success).toBe(false);
    expect(readWorkerFinalReport(line({ ...base, lessons }))).toMatchObject({ status: 'unavailable', reason: 'lessons-invalid' });
  }
});
it('negative: a structural defect wins as invalid; lessons-invalid is only for an otherwise valid report; no lessons ever invents a report', () => {
  expect(readWorkerFinalReport(line({ ...base, summary: 3, lessons: [{ kind: 'x' }] }))).toMatchObject({ reason: 'invalid' });
  expect(readWorkerFinalReport(line({ ...base, extra: 1, lessons: [{ kind: 'x' }] }))).toMatchObject({ reason: 'invalid' });
  expect(readWorkerFinalReport('')).toMatchObject({ reason: 'missing' });
});
it('lessons-invalid is its own typed refusal that fails the task, and stored evidence stays additive', () => {
  const evidence = workerReportEvidence(readWorkerFinalReport(line({ ...base, lessons: [{ kind: 'x' }] })));
  expect(evidence).toEqual({ status: 'lessons-invalid' });
  expect(workerReportRefusal(evidence)).toBe('lessons-invalid');
  expect(workerReportRefusal({ status: 'reported' })).toBeNull();
  expect(workerReportEvidenceSchema.safeParse({ status: 'lessons-invalid', acceptanceChecks: 'not-run' }).success).toBe(false);
  expect(TASK_NOT_ACCEPTED_REASONS).toContain('lessons-invalid');
  expect(taskProgressSchema.parse({ taskId: 't', phase: 'failed', unresolvedEffects: false, eligibility: { kind: 'immediate' }, notAcceptedReason: 'lessons-invalid' }).notAcceptedReason).toBe('lessons-invalid');
  expect(notAcceptedLabel('lessons-invalid', 'en')).toMatch(/lessons/i); expect(notAcceptedLabel('lessons-invalid', 'tr')).toMatch(/dersler/);
});
