import { persistedString } from '#domain/core/primitives/index.js';
import { z } from 'zod';
import { REASONING_EFFORTS } from './catalog-values.js';
/** Immutable requested CLI reasoning setting, not attestation of provider-side reasoning or work-size budget. */
export const workerEffortSchema = z.strictObject({ schemaVersion: z.literal(1), level: z.enum(REASONING_EFFORTS).nullable(),
  source: z.enum(['explicit', 'policy-default', 'cli-default']), status: z.enum(['selected', 'unsupported', 'cli-default', 'ultra-opt-in-required']),
  workClass: persistedString(z.string().min(1).max(256)).optional(), policyRevision: persistedString(z.string().min(1).max(256)).optional(),
  target: z.enum(REASONING_EFFORTS).optional(),
}).refine(value => (value.status === 'selected') === (value.level !== null)
  && (value.source === 'cli-default' || value.status === 'selected')
  && (value.source !== 'policy-default' || (value.workClass !== undefined && value.policyRevision !== undefined))).readonly();
export type WorkerEffort = z.infer<typeof workerEffortSchema>;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
