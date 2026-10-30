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
/** Walk-wide stuck rules (walk17/18): the Nth identical action on one (digit-masked) screen is a loop, the Nth consecutive look/wait on one is `observing`;
 * (walk19R) on a screen unchanged since the last action either holds only once that screen has stayed unchanged for `settleMs`. */
const walkRulesSchema = z.object({ loopStop: bound.min(2), observeStop: bound.min(2), settleMs: bound }).strict().readonly();
const registrySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema, walk: walkRulesSchema, profiles: z.array(beuserLimitsSchema).readonly() }).strict()
  .refine(value => new Set(value.profiles.map(profile => profile.revision)).size === value.profiles.length).readonly();
export const BEUSER_LIMITS_REGISTRY = registrySchema.parse(asset);
export const BEUSER_WALK_RULES = BEUSER_LIMITS_REGISTRY.walk;
type BeuserSurfaceFailure = 'BEUSER_SURFACE_UNAVAILABLE' | 'BEUSER_SURFACE_INVALID' | 'BEUSER_SURFACE_LIMIT'
  | 'BEUSER_SURFACE_BUSY' | 'BEUSER_CAPTURE_BLOCKED' | 'BEUSER_SURFACE_EOF' | 'BEUSER_ACTION_INVALID';
export class BeuserContractError extends Error {
  constructor(readonly code: BeuserSurfaceFailure | 'BEUSER_INPUT_INVALID' | 'BEUSER_CANDIDATE_MISMATCH' | 'BEUSER_TARGET_NOT_SANDBOX' | 'BEUSER_LIMITS_UNAVAILABLE' | 'BEUSER_MODEL_UNAVAILABLE' | 'BEUSER_MODEL_OUTPUT_INVALID' | 'BEUSER_PROFILE_REQUIRED' | 'BEUSER_REPORT_NOT_FOUND' | 'BEUSER_START_STATE_UNMET' | 'BEUSER_START_STATE_UNREACHABLE') { super(code); this.name = 'BeuserContractError'; }
}
export function pinBeuserLimits(input: unknown): BeuserLimits {
  const parsed = beuserLimitsSchema.safeParse(input);
  if (!parsed.success) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE');
  return parsed.data;
}
