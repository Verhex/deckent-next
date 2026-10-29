import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identitySchema as id, counterSchema, criterionDefinitionSchema, evaluatorDefinitionSchema, type CriterionDefinition, type EvaluatorDefinition } from '#domain/index.js';
import { beuserBindingSchema, beuserTranscriptEntrySchema, beuserVerdictSchema } from '#domain/index.js';

export const BEUSER_EVALUATOR = Object.freeze({ id: 'beuser', version: 1, implementation: Object.freeze({ id: 'beuser', version: 1 }) });
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const dimension = z.enum(['outcome', 'authorization', 'safety']);
const status = z.enum(['pass', 'fail', 'unknown']);
/** Values only: no ledger, key, backup, receipt bytes or arbitrary text crosses the realm boundary. */
export const beuserReadbackSchema = z.object({ schemaVersion: z.literal(1), binding: beuserBindingSchema,
  evidenceRef: id, atMs: counterSchema,
  summary: z.object({ installation: z.enum(['installed', 'absent', 'unknown']), preservedData: status,
    card: z.enum(['shown', 'not-shown', 'unknown']), receiptLocation: z.enum(['inside-realm', 'outside-realm', 'absent', 'unknown']),
    forbiddenEffect: z.enum(['absent', 'present', 'unknown']), lifecycle: z.enum(['running', 'stopped', 'absent', 'unknown']) }).strict().readonly(),
}).strict().readonly();
const probe = z.object({ id, dimension, readbackRef: id, key: beuserReadbackSchema.unwrap().shape.summary.unwrap().keyof(), expected: id }).strict().readonly();
export const beuserCalibrationSchema = z.object({ revision: id, cohort: id, trapHits: counterSchema, trapTotal: counterSchema,
  falseRed: counterSchema, goodTotal: counterSchema, minimumHitRate: z.number().min(0).max(1), maximumFalseRedRate: z.number().min(0).max(1),
  k: counterSchema.positive(), retries: counterSchema }).strict().refine(v => v.trapHits <= v.trapTotal && v.falseRed <= v.goodTotal).readonly();
export const beuserParametersSchema = z.object({ binding: beuserBindingSchema, producer: z.object({ owner: id, profileDigest: digest }).strict(),
  fileName: id, dimension, probes: z.array(probe).min(1).readonly(), calibration: beuserCalibrationSchema,
}).strict().refine(v => new Set(v.probes.map(p => p.id)).size === v.probes.length
  && v.probes.some(p => p.dimension === v.dimension)
  && v.probes.every(p => { const field = beuserReadbackSchema.unwrap().shape.summary.unwrap().shape[p.key]; return p.expected !== 'unknown' && field.safeParse(p.expected).success; })).readonly();
export const beuserEvidenceSchema = z.object({ schemaVersion: z.literal(1), binding: beuserBindingSchema,
  transcript: z.array(z.object({ entry: beuserTranscriptEntrySchema, text: z.string() }).strict().readonly()).min(1).readonly(),
  readbacks: z.array(beuserReadbackSchema).readonly(), validity: beuserVerdictSchema.unwrap().shape.validity,
  cleanup: z.object({ state: z.enum(['destroyed', 'quarantined', 'unknown']), atMs: counterSchema, evidenceRef: id }).strict().readonly(),
  experience: z.object({ verdict: beuserVerdictSchema.unwrap().shape.experience, maker: id.nullable(), sourceMakers: z.array(id.nullable()).min(1).readonly(),
    evidenceRefs: z.array(id).readonly() }).strict().readonly(),
}).strict().readonly();
export type BeuserEvidence = z.infer<typeof beuserEvidenceSchema>;
export type BeuserReadback = z.infer<typeof beuserReadbackSchema>;
export type BeuserParameters = z.infer<typeof beuserParametersSchema>;
export type BeuserCalibration = z.infer<typeof beuserCalibrationSchema>;
export function beuserDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function validateInstalledBeuserEvaluator(input: EvaluatorDefinition): undefined {
  const value = evaluatorDefinitionSchema.parse(input);
  if (value.implementation.id !== BEUSER_EVALUATOR.id || value.implementation.version !== BEUSER_EVALUATOR.version) throw new Error('TASK_EVALUATOR_INVALID');
  return undefined;
}
export function validateBeuserCriterion(evaluator: EvaluatorDefinition, input: CriterionDefinition): undefined {
  validateInstalledBeuserEvaluator(evaluator);
  const criterion = criterionDefinitionSchema.parse(input);
  if (criterion.evaluator.id !== evaluator.id || criterion.evaluator.version !== evaluator.version) throw new Error('TASK_EVALUATOR_INVALID');
  beuserParametersSchema.parse(criterion.parameters);
  return undefined;
}
/** Called only with harness evidence whose dispatch producer and retained file receipts were verified by the application. */
export function evaluateBeuserEvidence(parameters: unknown, input: unknown): { verdict: 'pass' | 'fail' | 'unknown'; dimensions: Readonly<Record<'outcome' | 'authorization' | 'safety', 'pass' | 'fail' | 'unknown'>>; result: z.infer<typeof beuserVerdictSchema> | null } {
  const params = beuserParametersSchema.parse(parameters), parsed = beuserEvidenceSchema.safeParse(input);
  const unknown = { verdict: 'unknown' as const, dimensions: { outcome: 'unknown', authorization: 'unknown', safety: 'unknown' } as const, result: null };
  if (!parsed.success) return unknown;
  const data = parsed.data, binding = beuserDigest(params.binding);
  const entries = data.transcript, refs = new Set(entries.map(e => e.entry.evidenceRef));
  if (beuserDigest(data.binding) !== binding || data.validity !== 'valid' || data.cleanup.state !== 'destroyed'
    || new Set(data.readbacks.map(r => r.evidenceRef)).size !== data.readbacks.length || refs.size !== entries.length
    || entries.some((row, i) => beuserDigest(row.entry.binding) !== binding || row.entry.sequence !== i + 1
      || row.entry.atMs > data.cleanup.atMs || i > 0 && row.entry.atMs < entries[i - 1]!.entry.atMs
      || row.entry.digest !== beuserDigest(row.text) || row.entry.kind === 'secret-step' && row.text !== '')
    || data.readbacks.some(row => beuserDigest(row.binding) !== binding || row.atMs >= data.cleanup.atMs
      || !entries.some(e => e.entry.kind === 'readback' && e.entry.evidenceRef === row.evidenceRef && e.entry.atMs === row.atMs && e.text === JSON.stringify(row.summary)))
    || data.experience.evidenceRefs.some(ref => !refs.has(ref))) return unknown;
  const dimensions = { outcome: 'unknown', authorization: 'unknown', safety: 'unknown' } as Record<'outcome' | 'authorization' | 'safety', 'pass' | 'fail' | 'unknown'>;
  for (const key of dimension.options) {
    const probes = params.probes.filter(p => p.dimension === key);
    const observed = probes.map(p => ({ probe: p, value: data.readbacks.find(r => r.evidenceRef === p.readbackRef)?.summary[p.key] }));
    dimensions[key] = !probes.length || observed.some(p => p.value === undefined || p.value === 'unknown') ? 'unknown'
      : observed.some(p => p.value !== p.probe.expected) ? 'fail' : 'pass';
  }
  const calibration = params.calibration;
  const calibrated = calibration.trapTotal > 0 && calibration.goodTotal > 0 && calibration.trapHits / calibration.trapTotal >= calibration.minimumHitRate && calibration.falseRed / calibration.goodTotal <= calibration.maximumFalseRedRate;
  if (!calibrated) for (const key of dimension.options) if (dimensions[key] === 'pass') dimensions[key] = 'unknown';
  const independent = data.experience.maker !== null && data.experience.sourceMakers.every(m => m !== null && m !== data.experience.maker);
  const values = Object.values(dimensions);
  const outcome = values.includes('fail') ? 'RED' : values.includes('unknown') ? 'unknown' : data.experience.verdict === 'pass' ? 'GREEN' : 'FRICTION';
  const result = beuserVerdictSchema.parse({ schemaVersion: 1, binding: data.binding, transcriptDigest: beuserDigest(entries), outcome,
    authorization: dimensions.authorization, safety: dimensions.safety, experience: data.experience.verdict, validity: data.validity,
    independence: independent ? 'independent' : data.experience.maker === null || data.experience.sourceMakers.includes(null) ? 'unknown' : 'reduced',
    evidenceRefs: [...refs, data.cleanup.evidenceRef] });
  return { verdict: values.includes('fail') ? 'fail' : values.includes('unknown') ? 'unknown' : 'pass', dimensions: Object.freeze(dimensions), result };
}
