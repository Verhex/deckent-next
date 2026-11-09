import { persistedNumber, persistedInteger, identitySchema } from '#domain/index.js';
import { z } from 'zod';
import asset from '../../../../../assets/beuser/limits.json' with { type: 'json' };

const bound = persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
/** An admission ceiling is not a spend-account grant; no implicit or unbounded defaults. */
export const beuserLimitsSchema = z.strictObject({ schemaVersion: z.literal(1), revision: identitySchema, source: identitySchema,
  provisional: z.boolean(), maxSteps: bound, maxWallMs: bound, maxWaitMs: bound, maxCalls: bound, maxTokens: bound,
  maxCost: z.number().positive().finite(), currency: identitySchema, maxReruns: bound, maxTranscriptBytes: bound,
  maxArtifactBytes: bound, cleanupDeadlineMs: bound, criticalRepetitions: bound,
}).refine(value => value.maxWaitMs <= value.maxWallMs && value.cleanupDeadlineMs <= value.maxWallMs, 'BEUSER_LIMITS_INVALID').readonly();
export type BeuserLimits = z.infer<typeof beuserLimitsSchema>;
/** Walk-wide stuck rules (walk17/18): the Nth identical action on one (digit-masked) screen is a loop, the Nth consecutive look/wait on one is `observing`;
 * (walk19R) on a screen unchanged since the last action either holds only once that screen has stayed unchanged for `settleMs`. */
const walkRulesSchema = z.strictObject({ loopStop: bound.min(2), observeStop: bound.min(2), settleMs: bound }).readonly();
const registrySchema = z.strictObject({ schemaVersion: z.literal(1), revision: identitySchema, walk: walkRulesSchema, evaluator: z.strictObject({ maxInputBytes: bound, maxStyleSamples: bound }).readonly(), profiles: z.array(beuserLimitsSchema).readonly() })
  .refine(value => new Set(value.profiles.map(profile => profile.revision)).size === value.profiles.length).readonly();
export const BEUSER_LIMITS_REGISTRY = registrySchema.parse(asset);
export const BEUSER_WALK_RULES = BEUSER_LIMITS_REGISTRY.walk;
type BeuserSurfaceFailure = 'BEUSER_SURFACE_UNAVAILABLE' | 'BEUSER_SURFACE_INVALID' | 'BEUSER_SURFACE_LIMIT'
  | 'BEUSER_SURFACE_BUSY' | 'BEUSER_CAPTURE_BLOCKED' | 'BEUSER_SURFACE_EOF' | 'BEUSER_ACTION_INVALID';
export class BeuserContractError extends Error {
  constructor(readonly code: BeuserSurfaceFailure | 'BEUSER_INPUT_INVALID' | 'BEUSER_CANDIDATE_MISMATCH' | 'BEUSER_TARGET_NOT_SANDBOX' | 'BEUSER_LIMITS_UNAVAILABLE' | 'BEUSER_EVALUATOR_INPUT_TOO_LARGE' | 'BEUSER_MODEL_INPUT_TOO_LARGE' | 'BEUSER_CALL_BUDGET_EXCEEDED' | 'BEUSER_MODEL_PROFILE_LIMIT' | 'BEUSER_SPEND_UNAVAILABLE' | 'BEUSER_MODEL_UNAVAILABLE' | 'BEUSER_MODEL_OUTPUT_INVALID' | 'BEUSER_PROFILE_REQUIRED' | 'BEUSER_REPORT_NOT_FOUND' | 'BEUSER_START_STATE_UNMET' | 'BEUSER_START_STATE_UNREACHABLE') { super(code); this.name = 'BeuserContractError'; }
}
export function pinBeuserLimits(input: unknown): BeuserLimits {
  const parsed = beuserLimitsSchema.safeParse(input);
  if (!parsed.success) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE');
  return parsed.data;
}
export function assertBeuserLimits(input: unknown): void { pinBeuserLimits(input); }

/** Versioned persisted profile invariant, not configurable business policy. */
export const BEUSER_JOURNEY_PROFILE_VERSION = 4;
type LimitProfile = { readonly schemaVersion: number; readonly limitsRevision: string; readonly limits?: BeuserLimits | undefined };
/** The four configurable budgets may narrow; every other ceiling and metadata field keeps its versioned meaning. */
export function validPinnedBeuserLimits(revision: string, limits: BeuserLimits): boolean {
  const ceiling = BEUSER_LIMITS_REGISTRY.profiles.find(row => row.revision === revision);
  if (!ceiling) return false;
  const keys = ['maxWallMs', 'maxReruns', 'maxSteps', 'maxCost'] as const;
  if (keys.some(key => limits[key] > ceiling[key])) return false;
  const expected = { ...ceiling, ...Object.fromEntries(keys.map(key => [key, limits[key]])),
    maxWaitMs: Math.min(ceiling.maxWaitMs, limits.maxWallMs), cleanupDeadlineMs: Math.min(ceiling.cleanupDeadlineMs, limits.maxWallMs),
    source: keys.some(key => limits[key] < ceiling[key]) ? 'config' : ceiling.source };
  return Object.entries(expected).every(([key, value]) => limits[key as keyof BeuserLimits] === value);
}
/** Recorded execution/recovery never re-read mutable config. v2/v3 keep their original registry lookup. */
export function beuserProfileLimits(data: LimitProfile): BeuserLimits {
  const limits = data.schemaVersion === BEUSER_JOURNEY_PROFILE_VERSION ? data.limits : BEUSER_LIMITS_REGISTRY.profiles.find(row => row.revision === data.limitsRevision);
  if (!limits) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE');
  return limits;
}
/** Pin budget data at setup/new Attempt admission; recorded recovery uses beuserProfileLimits directly. */
export type BeuserLimitOverrides = { readonly [K in 'maxWallMs' | 'maxReruns' | 'maxSteps' | 'maxCost']?: number | undefined };
export function narrowBeuserLimits(data: LimitProfile, overrides: BeuserLimitOverrides): BeuserLimits {
  const base = beuserProfileLimits(data), keys = ['maxWallMs', 'maxReruns', 'maxSteps', 'maxCost'] as const;
  const budgets = Object.fromEntries(keys.map(key => [key, Math.min(base[key], overrides[key] ?? base[key])]));
  const maxWallMs = budgets['maxWallMs']!;
  const limits = { ...base, ...budgets, maxWaitMs: Math.min(base.maxWaitMs, maxWallMs), cleanupDeadlineMs: Math.min(base.cleanupDeadlineMs, maxWallMs) };
  const ceiling = BEUSER_LIMITS_REGISTRY.profiles.find(row => row.revision === data.limitsRevision)!;
  limits.source = keys.some(key => limits[key] < ceiling[key]) ? 'config' : ceiling.source;
  return beuserLimitsSchema.parse(limits);
}
/** New snapshot only: callers validate the profile and config at their trust boundaries before pinning. */
export function pinBeuserProfile<T extends LimitProfile>(data: T, overrides: BeuserLimitOverrides): Omit<T, 'schemaVersion' | 'limits'> & { schemaVersion: typeof BEUSER_JOURNEY_PROFILE_VERSION; limits: BeuserLimits } {
  return { ...data, schemaVersion: BEUSER_JOURNEY_PROFILE_VERSION, limits: narrowBeuserLimits(data, overrides) };
}
const monitorModel = z.strictObject({ channelId: z.string(), modelId: z.string() });
/** Read-only observation snapshot; not authority or process liveness. Optional limits preserve old monitor records. */
export const beuserMonitorRecord = z.strictObject({ schemaVersion: z.literal(1), runId: z.string(), journey: z.string(), startedAt: persistedNumber(z.number()),
  walkers: z.array(z.strictObject({ id: z.string(), walker: monitorModel, judge: monitorModel, limitsRevision: z.string(), limits: beuserLimitsSchema.optional() })) });
