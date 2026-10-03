import { expect, it } from 'vitest';
import { workerFinalReportSchema, workerReportLimits } from '#domain/index.js';
import { validateFinalReport } from '#adapters/core/native-connection/index.js';

const digest = 'a'.repeat(64);
const handoff = { toTask: 'next', summary: 'Continue here', artifacts: [{ name: 'result', digest }], openQuestions: ['Review this'] };
const report = { schemaVersion: 1, summary: 'Done', changedFiles: [], checks: [], openIssues: [], handoff, sharedNotes: ['Run context'] };
it('keeps optional handoff/shared notes in the exact structured report and accepts older reports', () => {
  expect(workerFinalReportSchema.safeParse(report).success).toBe(true);
  expect(validateFinalReport(report, [])).toEqual({ status: 'reported', report });
  const { handoff: omitted, sharedNotes: notes, ...legacy } = report;
  expect(workerFinalReportSchema.safeParse(legacy).success).toBe(true);
  expect(validateFinalReport(legacy, [])).toEqual({ status: 'reported', report: legacy });
  expect(omitted).toBeDefined(); expect(notes).toBeDefined();
});
it('redacts every handoff/shared string before retention without changing artifact digests', () => {
  const secret = 'fixture-secret';
  const value = { ...report, handoff: { toTask: secret, summary: secret, artifacts: [{ name: secret, digest }], openQuestions: ['Bearer abc.def.ghi'] }, sharedNotes: [secret] };
  const final = validateFinalReport(value, [secret]);
  const bytes = JSON.stringify(final);
  expect(bytes).not.toContain(secret); expect(bytes).not.toContain('abc.def.ghi'); expect(bytes).toContain('[REDACTED]');
  expect(final).toMatchObject({ report: { handoff: { artifacts: [{ digest }] } } });
  expect(final.status === 'reported' && workerFinalReportSchema.safeParse(final.report).success).toBe(true);
});
it('refuses malformed handoff authority fields and non-sha256 digests', () => {
  for (const value of [{ ...report, handoff: { ...handoff, accepted: true } },
    { ...report, handoff: { ...handoff, artifacts: [{ name: 'result', digest: 'exists' }] } },
    { ...report, sharedNotes: [3] }, { ...report, handoff: { ...handoff, openQuestions: null } }]) {
    expect(workerFinalReportSchema.safeParse(value).success).toBe(false);
    expect(validateFinalReport(value, [])).toEqual({ status: 'unavailable', reason: 'invalid' });
  }
});
it('enforces registry handoff bounds for text, arrays and UTF-8 bytes', () => {
  const limit = workerReportLimits;
  for (const value of [{ ...report, handoff: { ...handoff, summary: 'a'.repeat(limit.handoffSummaryChars + 1) } },
    { ...report, handoff: { ...handoff, toTask: 'a'.repeat(limit.handoffTaskIdChars + 1) } },
    { ...report, handoff: { ...handoff, artifacts: [{ name: 'a'.repeat(limit.handoffArtifactNameChars + 1), digest }] } },
    { ...report, handoff: { ...handoff, openQuestions: ['a'.repeat(limit.handoffOpenQuestionChars + 1)] } },
    { ...report, handoff: { ...handoff, artifacts: Array.from({ length: limit.handoffArtifacts + 1 }, () => ({ name: 'result', digest })) } },
    { ...report, handoff: { ...handoff, openQuestions: Array(limit.handoffOpenQuestions + 1).fill('question') } },
    { ...report, sharedNotes: Array(limit.sharedNotes + 1).fill('note') },
    { ...report, sharedNotes: ['x'.repeat(limit.sharedNoteChars + 1)] }]) {
    expect(workerFinalReportSchema.safeParse(value).success).toBe(false);
    expect(validateFinalReport(value, [])).toEqual({ status: 'unavailable', reason: 'invalid' });
  }
  const large = { ...report, sharedNotes: Array(limit.sharedNotes).fill('漢'.repeat(limit.sharedNoteChars)) };
  expect(workerFinalReportSchema.safeParse(large).success).toBe(false);
  expect(validateFinalReport(large, [])).toEqual({ status: 'unavailable', reason: 'oversized' });
});

it('refuses a digest that redaction changes instead of leaking secret-shaped artifact identity', () => {
  const final = validateFinalReport(report, [digest]);
  expect(final).toEqual({ status: 'unavailable', reason: 'invalid' });
  expect(JSON.stringify(final)).not.toContain(digest);
});
