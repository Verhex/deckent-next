import { expect, it } from 'vitest';
import { readWorkerFinalReport, workerFinalReportSchema, workerReportEvidence, workerReportEvidenceSchema, workerReportLimits, workerReportRefusal, TASK_NOT_ACCEPTED_REASONS } from '#domain/index.js';

// S4B-2 (S4B-DESIGN §4.4, owner S-M1..S-M14 2026-10-23): the optional bounded `lessons` claim of the worker report. Limits are registry data; a malformed or
// oversized claim is dropped and marked, never coerced and never a reason to reject the work; an old report without the field stays valid.
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
it('negative: too many, too long, incomplete, extra-key and wrong-kind lessons never reject the report: the claim is dropped and marked lessons: invalid', () => {
  const l = workerReportLimits;
  for (const lessons of [Array.from({ length: l.lessons + 1 }, () => fact), [{ ...fact, title: text(l.lessonTitleChars + 1) }], [{ ...fact, body: text(l.lessonBodyChars + 1) }],
    [{ ...lesson, cause: text(l.lessonFieldChars + 1) }], [{ ...lesson, correction: text(l.lessonFieldChars + 1) }],
    [{ kind: 'lesson', title: 't', body: 'b', cause: 'c' }], [{ kind: 'lesson', title: 't', body: 'b', correction: 'c' }], [{ ...fact, cause: 'c' }], [{ ...fact, grant: 'full-access' }],
    [{ ...fact, title: '   ' }], [{ ...fact, kind: 'rule' }], 'not-an-array', [null]]) {
    expect(workerFinalReportSchema.safeParse({ ...base, lessons }).success).toBe(false);
    expect(readWorkerFinalReport(line({ ...base, lessons }))).toEqual({ schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report: base, lessons: 'invalid' });
  }
});
it('negative: a structural defect still wins as invalid; no lessons ever invents a report', () => {
  expect(readWorkerFinalReport(line({ ...base, summary: 3, lessons: [{ kind: 'x' }] }))).toMatchObject({ status: 'unavailable', reason: 'invalid' });
  expect(readWorkerFinalReport(line({ ...base, extra: 1, lessons: [{ kind: 'x' }] }))).toMatchObject({ reason: 'invalid' });
  expect(readWorkerFinalReport('')).toMatchObject({ reason: 'missing' });
});
it('bad lessons do not change acceptance: the evidence carries only the marker, the refusal path is unchanged, and no new Task reason exists', () => {
  const bad = readWorkerFinalReport(line({ ...base, lessons: [{ kind: 'x' }] }));
  expect(workerReportEvidence(bad)).toEqual({ status: 'reported', lessons: 'invalid' });
  expect(workerReportRefusal(workerReportEvidence(bad))).toBeNull();
  const check = { command: 'npm test', outcome: 'failed', checkId: 'unit', role: 'acceptance' };
  const failing = workerReportEvidence(readWorkerFinalReport(line({ ...base, checks: [check], lessons: [{ kind: 'x' }] })));
  expect(failing).toEqual({ status: 'reported', acceptanceChecks: 'not-passed', lessons: 'invalid' });
  expect(workerReportRefusal(failing)).toBe('declared-check-not-passed');
  expect(workerReportEvidence(readWorkerFinalReport(line(base)))).toEqual({ status: 'reported' });
  expect(workerReportEvidenceSchema.safeParse({ status: 'missing', lessons: 'invalid' }).success).toBe(false);
  expect(workerReportEvidenceSchema.safeParse({ status: 'lessons-invalid' }).success).toBe(false);
  expect(TASK_NOT_ACCEPTED_REASONS).not.toContain('lessons-invalid');
});
