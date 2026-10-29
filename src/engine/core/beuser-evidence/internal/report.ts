import { z } from 'zod';
import { identitySchema as id, counterSchema } from '#domain/index.js';
import { beuserVerdictSchema, type BeuserVerdict } from '#domain/index.js';
import { beuserCalibrationSchema } from '#capabilities/index.js';
const measured = z.number().finite().nonnegative().nullable();
export const beuserReportSchema = z.object({ schemaVersion: z.literal(1), simulated: z.literal(true), calibrationClaim: z.literal('uncalibrated'),
  cohort: id, calibration: beuserCalibrationSchema,
  counts: z.object({ defined: counterSchema, selected: counterSchema, walked: counterSchema, concurrent: counterSchema }).strict(),
  segments: z.array(z.object({ segment: id, verdict: beuserVerdictSchema.nullable(),
    broken: z.array(id), friction: z.array(id), delight: z.array(id), evidenceRefs: z.array(id), nextOwner: id }).strict()),
  unwalked: z.array(z.object({ branch: id, reason: id }).strict()), unknown: z.array(z.object({ branch: id, reason: id }).strict()),
  criticalCoverage: z.array(z.object({ criterion: id, walked: counterSchema, valid: counterSchema, invalid: counterSchema, unknown: counterSchema }).strict()
    .refine(v => v.valid + v.invalid <= v.walked && v.walked <= v.valid + v.invalid + v.unknown)),
  reliability: z.object({ completed: counterSchema, attempted: counterSchema }).strict(),
  cost: measured, currency: id, elapsedMs: measured,
}).strict().refine(v => v.counts.concurrent <= v.counts.walked && v.counts.walked <= v.counts.selected && v.counts.selected <= v.counts.defined
  && v.reliability.completed <= v.reliability.attempted && v.calibration.cohort === v.cohort
  && new Set(v.segments.map(s => s.segment)).size === v.segments.length
  && new Set(v.criticalCoverage.map(c => c.criterion)).size === v.criticalCoverage.length
  && v.criticalCoverage.every(c => c.walked <= v.counts.walked && c.valid + c.invalid + c.unknown <= v.counts.selected));
export type BeuserReport = z.infer<typeof beuserReportSchema>;
/** One frozen cohort per report. Reruns remain retries; another seed/model cohort is never pooled here. */
export function createBeuserReport(input: unknown): BeuserReport { return beuserReportSchema.parse(input); }

/** Missing verdicts are unknown coverage; they never count as a walked persona. */
export function beuserPersonaCoverage(criterion: string, verdict: BeuserVerdict | null | undefined): BeuserReport['criticalCoverage'][number] {
  return { criterion, walked: verdict ? 1 : 0, valid: verdict?.validity === 'valid' && verdict.outcome !== 'unknown' ? 1 : 0,
    invalid: verdict && verdict.validity !== 'valid' ? 1 : 0, unknown: !verdict || verdict.validity === 'valid' && verdict.outcome === 'unknown' ? 1 : 0 };
}
