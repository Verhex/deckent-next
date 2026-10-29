import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import asset from '../../../../../assets/beuser/limits.json' with { type: 'json' };

const bound = z.number().int().positive().safe();
/** An admission ceiling is not a spend-account grant; no implicit or unbounded defaults. */
export const beuserLimitsSchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema, source: identitySchema,
  provisional: z.boolean(), maxSteps: bound, maxWallMs: bound, maxWaitMs: bound, maxCalls: bound, maxTokens: bound,
  maxCost: z.number().positive().finite(), currency: identitySchema, maxReruns: bound, maxTranscriptBytes: bound,
  maxArtifactBytes: bound, cleanupDeadlineMs: bound, criticalRepetitions: bound,
}).strict().refine(value => value.maxWaitMs <= value.maxWallMs && value.cleanupDeadlineMs <= value.maxWallMs, 'BEUSER_LIMITS_INVALID').readonly();
export type BeuserLimits = z.infer<typeof beuserLimitsSchema>;
const registrySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema, profiles: z.array(beuserLimitsSchema).readonly() }).strict()
  .refine(value => new Set(value.profiles.map(profile => profile.revision)).size === value.profiles.length).readonly();
export const BEUSER_LIMITS_REGISTRY = registrySchema.parse(asset);
type BeuserSurfaceFailure = 'BEUSER_SURFACE_UNAVAILABLE' | 'BEUSER_SURFACE_INVALID' | 'BEUSER_SURFACE_LIMIT'
  | 'BEUSER_SURFACE_BUSY' | 'BEUSER_CAPTURE_BLOCKED' | 'BEUSER_SURFACE_EOF';
export class BeuserContractError extends Error {
  constructor(readonly code: BeuserSurfaceFailure | 'BEUSER_INPUT_INVALID' | 'BEUSER_CANDIDATE_MISMATCH' | 'BEUSER_TARGET_NOT_SANDBOX' | 'BEUSER_LIMITS_UNAVAILABLE' | 'BEUSER_MODEL_UNAVAILABLE' | 'BEUSER_PROFILE_REQUIRED' | 'BEUSER_REPORT_NOT_FOUND') { super(code); this.name = 'BeuserContractError'; }
}
export function pinBeuserLimits(input: unknown): BeuserLimits {
  const parsed = beuserLimitsSchema.safeParse(input);
  if (!parsed.success) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE');
  return parsed.data;
}
