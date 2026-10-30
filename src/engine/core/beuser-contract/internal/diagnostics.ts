import { z } from 'zod';
import { identitySchema as id, beuserBindingSchema, beuserTranscriptEntrySchema } from '#domain/index.js';

/** Diagnostic observation, never a replacement for acceptance, calibration or cleanup evidence. Walk20: a persona out of wait patience
 * is `persona-patience` (reason `patience`); a loop or only observing is `persona-stuck`. */
export const beuserStuckFindingSchema = z.object({ schemaVersion: z.literal(1), binding: beuserBindingSchema,
  branch: id, persona: id, code: z.enum(['persona-stuck', 'persona-patience']), reason: z.enum(['loop', 'observing', 'patience']), outcome: z.literal('RED'),
  screen: z.string(), screenRef: id, screenDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  evidenceRefs: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/u)).min(1),
  controllerValidity: z.enum(['valid', 'invalid', 'unknown']),
}).strict().refine(v => v.branch === v.binding.identity.taskId && (v.code === 'persona-patience') === (v.reason === 'patience')).readonly();
export const beuserDiagnosticSchema = z.object({ schemaVersion: z.literal(1),
  trace: z.array(z.object({ evidenceRef: id, kind: beuserTranscriptEntrySchema.unwrap().shape.kind,
    artifactRef: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }).strict().readonly()),
  finding: beuserStuckFindingSchema.nullable(),
}).strict().refine(v => new Set(v.trace.map(row => row.evidenceRef)).size === v.trace.length
  && (!v.finding || v.trace.some(row => row.kind === 'screen' && row.evidenceRef === v.finding!.screenRef)
    && v.finding.evidenceRefs.every(ref => v.trace.some(row => row.artifactRef === ref)))).readonly();
export type BeuserDiagnostic = z.infer<typeof beuserDiagnosticSchema>;
