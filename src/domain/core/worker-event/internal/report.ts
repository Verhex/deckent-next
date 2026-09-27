import { z } from 'zod';

/** Claims only: this report never grants task acceptance or execution authority. The enclosing dispatch artifact seals its bytes. */
export const workerFinalReportSchema = z.object({ schemaVersion: z.literal(1), summary: z.string().max(4000),
  changedFiles: z.array(z.string().max(256)).max(100),
  checks: z.array(z.object({ command: z.string().max(512), outcome: z.enum(['passed', 'failed', 'not-run', 'unknown']) }).strict()).max(50),
  openIssues: z.array(z.string().max(1000)).max(50),
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32768);
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
    if (line.length > 65536) continue;
    let value: unknown; try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'native-worker-report') continue;
    if (result) return { ...unavailable, reason: 'invalid' };
    const parsed = workerFinalReportResultSchema.safeParse(value);
    result = parsed.success ? parsed.data : { ...unavailable, reason: 'invalid' };
  }
  return result ?? unavailable;
}
