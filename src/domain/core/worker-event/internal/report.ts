import { z } from 'zod';
import registry from './report-limits.json' with { type: 'json' };

/** Mutable report/delivery policy: one versioned registry, also injected into the standalone worker bootstrap. */
export const workerReportLimits = Object.freeze(registry.limits);
export type WorkerReportLimits = typeof workerReportLimits;
const limits = workerReportLimits;
export const workerHandoffNoteSchema = z.object({ toTask: z.string().min(1).max(limits.handoffTaskIdChars).optional(),
  summary: z.string().max(limits.handoffSummaryChars),
  artifacts: z.array(z.object({ name: z.string().min(1).max(limits.handoffArtifactNameChars), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(limits.handoffArtifacts),
  openQuestions: z.array(z.string().max(limits.handoffOpenQuestionChars)).max(limits.handoffOpenQuestions),
}).strict();
export type WorkerHandoffNote = z.infer<typeof workerHandoffNoteSchema>;

/** Claims only: this report never grants task acceptance or execution authority. The enclosing dispatch artifact seals its bytes. */
export const workerFinalReportSchema = z.object({ schemaVersion: z.literal(1), summary: z.string().max(limits.summaryChars),
  changedFiles: z.array(z.string().max(limits.changedFileChars)).max(limits.changedFiles),
  checks: z.array(z.object({ command: z.string().max(limits.checkCommandChars), outcome: z.enum(['passed', 'failed', 'not-run', 'unknown']) }).strict()).max(limits.checks),
  openIssues: z.array(z.string().max(limits.openIssueChars)).max(limits.openIssues),
  handoff: workerHandoffNoteSchema.optional(), sharedNotes: z.array(z.string().max(limits.sharedNoteChars)).max(limits.sharedNotes).optional(),
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
