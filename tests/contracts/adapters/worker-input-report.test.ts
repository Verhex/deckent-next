import { expect, it } from 'vitest';
import { validateFinalReport } from '#adapters/core/native-connection/index.js';
import { workerFinalReportSchema, readWorkerFinalReport, workerReportLimits } from '#domain/index.js';
const report = { schemaVersion: 1, summary: 'Need input', changedFiles: [], checks: [], openIssues: [],
  exit: { schemaVersion: 1, kind: 'needs-input', question: 'Which region?' } };
it('validates a bounded typed needs-input exit and redacts its question before the retained stdout record', () => {
  expect(workerFinalReportSchema.parse(report)).toEqual(report);
  expect(validateFinalReport(report, [])).toEqual({ status: 'reported', report });
  const scrubbed = validateFinalReport({ ...report, exit: { ...report.exit, question: 'Use fixture-secret?' } }, ['fixture-secret']);
  expect(JSON.stringify(scrubbed)).not.toContain('fixture-secret');
  expect(scrubbed.status).toBe('reported');
  expect(readWorkerFinalReport(JSON.stringify({ schemaVersion: 1, kind: 'native-worker-report', ...scrubbed }))).toEqual({ schemaVersion: 1, kind: 'native-worker-report', ...scrubbed });
});
it.each([
  { schemaVersion: 1, kind: 'needs-input', question: '' },
  { schemaVersion: 1, kind: 'needs-input', question: '   ' },
  { schemaVersion: 2, kind: 'needs-input', question: 'Which?' },
  { schemaVersion: 1, kind: 'needs-input', question: 'x'.repeat(workerReportLimits.handoffOpenQuestionChars + 1) },
  { schemaVersion: 1, kind: 'needs-input', question: 'Which?', accepted: true },
])('refuses malformed input exit %j', exit => {
  expect(workerFinalReportSchema.safeParse({ ...report, exit }).success).toBe(false);
  expect(validateFinalReport({ ...report, exit }, [])).toEqual({ status: 'unavailable', reason: 'invalid' });
});
it('duplicate records never manufacture an input decision', () => {
  const line = JSON.stringify({ schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report });
  expect(readWorkerFinalReport(`${line}\n${line}`)).toMatchObject({ status: 'unavailable', reason: 'invalid' });
});
