import { z } from 'zod';
import registry from './report-limits.json' with { type: 'json' };

/** Mutable report/delivery policy: one versioned registry, also injected into the standalone worker bootstrap. */
export const workerReportLimits = Object.freeze(registry.limits);
export type WorkerReportLimits = typeof workerReportLimits;
const limits = workerReportLimits;
/** A stopped worker requests a new attempt with human input; this never accepts work. */
export const workerNeedsInputSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('needs-input'),
  question: z.string().trim().min(1).max(limits.handoffOpenQuestionChars) }).strict().readonly();
export const workerHandoffNoteSchema = z.object({ toTask: z.string().min(1).max(limits.handoffTaskIdChars).optional(),
  summary: z.string().max(limits.handoffSummaryChars),
  artifacts: z.array(z.object({ name: z.string().min(1).max(limits.handoffArtifactNameChars), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(limits.handoffArtifacts),
  openQuestions: z.array(z.string().max(limits.handoffOpenQuestionChars)).max(limits.handoffOpenQuestions),
}).strict();
export type WorkerHandoffNote = z.infer<typeof workerHandoffNoteSchema>;

/** R5 (owner D5a): a check claim may carry a `checkId` and a `role`. An `acceptance` check that did not pass fails the task; an
 * `exploratory` or untyped check never does. A passed check stays a claim and never grants acceptance by itself. */
const workerReportCheckSchema = z.object({ command: z.string().max(limits.checkCommandChars), outcome: z.enum(['passed', 'failed', 'not-run', 'unknown']),
  checkId: z.string().min(1).max(limits.checkIdChars).optional(), role: z.enum(['acceptance', 'exploratory']).optional() }).strict();
/** Claims only: this report never grants task acceptance or execution authority. The enclosing dispatch artifact seals its bytes. */
export const workerFinalReportSchema = z.object({ schemaVersion: z.literal(1), summary: z.string().max(limits.summaryChars),
  changedFiles: z.array(z.string().max(limits.changedFileChars)).max(limits.changedFiles),
  checks: z.array(workerReportCheckSchema).max(limits.checks),
  openIssues: z.array(z.string().max(limits.openIssueChars)).max(limits.openIssues),
  handoff: workerHandoffNoteSchema.optional(), sharedNotes: z.array(z.string().max(limits.sharedNoteChars)).max(limits.sharedNotes).optional(),
  exit: workerNeedsInputSchema.optional(),
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= limits.reportBytes);
export type WorkerFinalReport = z.infer<typeof workerFinalReportSchema>;
export const workerFinalReportResultSchema = z.discriminatedUnion('status', [
  z.object({ schemaVersion: z.literal(1), kind: z.literal('native-worker-report'), status: z.literal('reported'), report: workerFinalReportSchema }).strict(),
  z.object({ schemaVersion: z.literal(1), kind: z.literal('native-worker-report'), status: z.literal('unavailable'),
    reason: z.enum(['invalid', 'oversized', 'missing', 'unsupported']) }).strict(),
]);
export type WorkerFinalReportResult = z.infer<typeof workerFinalReportResultSchema>;
/** A single bounded record in the existing retained stdout. Missing/truncated/duplicate records never invent a report. */
export function readWorkerFinalReport(stdout: string): WorkerFinalReportResult {
  const unavailable = { schemaVersion: 1, kind: 'native-worker-report', status: 'unavailable', reason: 'missing' } as const;
  let result: WorkerFinalReportResult | undefined;
  for (const line of stdout.split('\n')) {
    if (line.length > limits.recordChars) continue;
    let value: unknown; try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'native-worker-report') continue;
    if (result) return { ...unavailable, reason: 'invalid' };
    const parsed = workerFinalReportResultSchema.safeParse(value);
    result = parsed.success ? parsed.data : { ...unavailable, reason: 'invalid' };
  }
  return result ?? unavailable;
}
/** R5 (owner D5a): the host-read status of a worker's structured result report, recorded with the evaluation. Generic: the report
 * of a coding patch and of a business operation alike. `acceptanceChecks: 'not-passed'` is the last outcome of an acceptance check. */
export const workerReportEvidenceSchema = z.object({ status: z.enum(['reported', 'missing', 'invalid', 'oversized', 'unsupported']),
  acceptanceChecks: z.literal('not-passed').optional() }).strict().refine(value => value.status === 'reported' || value.acceptanceChecks === undefined).readonly();
export type WorkerReportEvidence = z.infer<typeof workerReportEvidenceSchema>;
export function workerReportEvidence(result: WorkerFinalReportResult): WorkerReportEvidence {
  if (result.status !== 'reported') return { status: result.reason };
  const last = new Map<string, string>(); let notPassed = false;
  for (const check of result.report.checks) if (check.role === 'acceptance') {
    if (check.checkId === undefined) notPassed ||= check.outcome !== 'passed'; else last.set(check.checkId, check.outcome);
  }
  return notPassed || [...last.values()].some(outcome => outcome !== 'passed') ? { status: 'reported', acceptanceChecks: 'not-passed' } : { status: 'reported' };
}
/** The typed refusal of a work task's report evidence. Absence of a valid report fails (missing evidence, never a claim of success);
 * `unsupported` (the worker CLI declares no structured result channel) is not gated and stays visible on the evaluation. */
export function workerReportRefusal(evidence: WorkerReportEvidence): 'report-missing' | 'report-invalid' | 'declared-check-not-passed' | null {
  if (evidence.status === 'missing') return 'report-missing';
  if (evidence.status === 'invalid' || evidence.status === 'oversized') return 'report-invalid';
  return evidence.acceptanceChecks === 'not-passed' ? 'declared-check-not-passed' : null;
}
