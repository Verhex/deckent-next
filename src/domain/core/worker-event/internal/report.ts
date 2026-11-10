import { persistedString } from '#domain/core/primitives/index.js';
import { z } from 'zod';
import registry from './report-limits.json' with { type: 'json' };

/** Mutable report/delivery policy: one versioned registry, also injected into the standalone worker bootstrap. */
export const workerReportLimits = Object.freeze(registry.limits);
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type WorkerReportLimits = typeof workerReportLimits;
const limits = workerReportLimits;
/** A stopped worker requests a new attempt with human input; this never accepts work. */
export const workerNeedsInputSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('needs-input'),
  question: persistedString(z.string().trim().min(1).max(limits.handoffOpenQuestionChars)) }).readonly();
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export const workerHandoffNoteSchema = z.strictObject({ toTask: persistedString(z.string().min(1).max(limits.handoffTaskIdChars)).optional(),
  summary: persistedString(z.string().max(limits.handoffSummaryChars)),
  artifacts: z.array(z.strictObject({ name: persistedString(z.string().min(1).max(limits.handoffArtifactNameChars)), digest: z.string().regex(/^[a-f0-9]{64}$/) })).max(limits.handoffArtifacts),
  openQuestions: z.array(persistedString(z.string().max(limits.handoffOpenQuestionChars))).max(limits.handoffOpenQuestions),
});
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type WorkerHandoffNote = z.infer<typeof workerHandoffNoteSchema>;

/** R5 (owner D5a): a check claim may carry a `checkId` and a `role`. An `acceptance` check that did not pass fails the task; an
 * `exploratory` or untyped check never does. A passed check stays a claim and never grants acceptance by itself. */
const workerReportCheckSchema = z.strictObject({ command: persistedString(z.string().max(limits.checkCommandChars)), outcome: z.enum(['passed', 'failed', 'not-run', 'unknown']),
  checkId: persistedString(z.string().min(1).max(limits.checkIdChars)).optional(), role: z.enum(['acceptance', 'exploratory']).optional() });
/** S4B-2 (§4.4): one durable-lesson claim of the worker. Claims only, never verified here; a `lesson` names its cause and its correction, an
 * incomplete one is refused (never coerced). Bounds come from the report registry. */
const lessonText = (max: number) => persistedString(z.string().trim().min(1).max(max));
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export const workerReportLessonSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fact'), title: lessonText(limits.lessonTitleChars), body: lessonText(limits.lessonBodyChars) }),
  z.strictObject({ kind: z.literal('lesson'), title: lessonText(limits.lessonTitleChars), body: lessonText(limits.lessonBodyChars),
    cause: lessonText(limits.lessonFieldChars), correction: lessonText(limits.lessonFieldChars) }),
]);
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type WorkerReportLesson = z.infer<typeof workerReportLessonSchema>;
/** Claims only: this report never grants task acceptance or execution authority. The enclosing dispatch artifact seals its bytes. */
export const workerFinalReportSchema = z.strictObject({ schemaVersion: z.literal(1), summary: persistedString(z.string().max(limits.summaryChars)),
  changedFiles: z.array(persistedString(z.string().max(limits.changedFileChars))).max(limits.changedFiles),
  checks: z.array(workerReportCheckSchema).max(limits.checks),
  openIssues: z.array(persistedString(z.string().max(limits.openIssueChars))).max(limits.openIssues),
  handoff: workerHandoffNoteSchema.optional(), sharedNotes: z.array(persistedString(z.string().max(limits.sharedNoteChars))).max(limits.sharedNotes).optional(),
  exit: workerNeedsInputSchema.optional(), lessons: z.array(workerReportLessonSchema).max(limits.lessons).optional(),
}).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= limits.reportBytes);
export type WorkerFinalReport = z.infer<typeof workerFinalReportSchema>;
export const workerFinalReportResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('native-worker-report'), status: z.literal('reported'), report: workerFinalReportSchema,
    /** The worker's optional `lessons` claim was malformed and dropped; the rest of the report stands. */ lessons: z.literal('invalid').optional() }),
  z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('native-worker-report'), status: z.literal('unavailable'),
    reason: z.enum(['invalid', 'oversized', 'missing', 'unsupported']) }),
]);
export type WorkerFinalReportResult = z.infer<typeof workerFinalReportResultSchema>;
/** S4B-2: a `reported` record whose only defect is its optional `lessons` claim (everything else parses) is read without the claim and marked
 * `lessons: 'invalid'`; the claim never rejects the report. A structural defect still makes the whole report `invalid`. */
function withoutInvalidLessons(value: object): WorkerFinalReportResult | null {
  const record = 'report' in value && value.report && typeof value.report === 'object' && !Array.isArray(value.report) ? { ...value.report } as Record<string, unknown> : null;
  if (!record || !('lessons' in record) || !('status' in value) || value.status !== 'reported') return null;
  delete record.lessons;
  const report = workerFinalReportSchema.safeParse(record);
  return report.success ? { schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report: report.data, lessons: 'invalid' } : null;
}
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
    result = parsed.success ? parsed.data : withoutInvalidLessons(value) ?? { ...unavailable, reason: 'invalid' };
  }
  return result ?? unavailable;
}
/** R5 (owner D5a): the host-read status of a worker's structured result report, recorded with the evaluation. Generic: the report
 * of a coding patch and of a business operation alike. `acceptanceChecks` summarises the last outcome of the acceptance checks:
 * `not-passed` when one ran and did not pass (`failed`, or `unknown` = ran with an unreadable outcome), else `not-run` (PRE-7) when one
 * was reported as not run. Both refuse the task; `not-run` is an observed worker claim, never an environment verdict (Law 1). */
export const workerReportEvidenceSchema = z.strictObject({ status: z.enum(['reported', 'missing', 'invalid', 'oversized', 'unsupported']),
  acceptanceChecks: z.enum(['not-passed', 'not-run']).optional(), /** S4B-2: a malformed optional `lessons` claim was dropped; acceptance is unaffected. */ lessons: z.literal('invalid').optional(),
}).refine(value => value.status === 'reported' || (value.acceptanceChecks === undefined && value.lessons === undefined)).readonly();
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type WorkerReportEvidence = z.infer<typeof workerReportEvidenceSchema>;
export function workerReportEvidence(result: WorkerFinalReportResult): WorkerReportEvidence {
  if (result.status !== 'reported') return { status: result.reason };
  const last = new Map<string, string>(), untyped: string[] = [];
  for (const check of result.report.checks) if (check.role === 'acceptance') {
    if (check.checkId === undefined) untyped.push(check.outcome); else last.set(check.checkId, check.outcome);
  }
  const outcomes = [...untyped, ...last.values()];
  const marker = result.lessons ? { lessons: 'invalid' as const } : {};
  if (outcomes.some(outcome => outcome === 'failed' || outcome === 'unknown')) return { status: 'reported', acceptanceChecks: 'not-passed', ...marker };
  return outcomes.includes('not-run') ? { status: 'reported', acceptanceChecks: 'not-run', ...marker } : { status: 'reported', ...marker };
}
/** The typed refusal of a work task's report evidence. Absence of a valid report fails (missing evidence, never a claim of success);
 * `unsupported` (the worker CLI declares no structured result channel) is not gated and stays visible on the evaluation. */
export function workerReportRefusal(evidence: WorkerReportEvidence): 'report-missing' | 'report-invalid' | 'declared-check-not-passed' | 'acceptance-check-not-run' | null {
  if (evidence.status === 'missing') return 'report-missing';
  if (evidence.status === 'invalid' || evidence.status === 'oversized') return 'report-invalid';
  return evidence.acceptanceChecks === 'not-passed' ? 'declared-check-not-passed' : evidence.acceptanceChecks === 'not-run' ? 'acceptance-check-not-run' : null;
}
