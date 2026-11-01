import { persistedString, persistedInteger } from '#platform/index.js';
import { z } from 'zod';
import { immutableJsonObjectSchema, beuserBindingSchema, beuserWalkerSummarySchema, beuserSealedRubricSchema, beuserCandidateManifestSchema } from '#domain/index.js';
import { beuserParametersSchema, beuserCalibrationSchema } from '#capabilities/index.js';
import { supervisorProfileSchema, BEUSER_JOURNEY_PROFILE_VERSION, validPinnedBeuserLimits, beuserLimitsSchema, BeuserContractError, beuserStartStateSchema, beuserStartStateFits, type SupervisorProfile } from '#engine/index.js';
import { BEUSER_REALM_RECIPE } from '#adapters/index.js';

const positive = persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
/** Installed profile data, selected by id from the governed execution registry. Never accepted as CLI JSON. v4 pins budgets; v3 requires a catalogued start state; v2 keeps its unarranged realm. */
export const beuserJourneyProfileSchema = z.strictObject({ schemaVersion: z.union([z.literal(2), z.literal(3), z.literal(BEUSER_JOURNEY_PROFILE_VERSION)]), startState: beuserStartStateSchema.optional(), binding: beuserBindingSchema, summary: beuserWalkerSummarySchema,
  limits: beuserLimitsSchema.optional(), limitsRevision: persistedString(z.string().min(1)), candidateRoot: persistedString(z.string().min(1)), packageDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  candidateManifest: beuserCandidateManifestSchema,
  size: z.strictObject({ columns: positive, rows: positive, scrollback: positive }),
  bounds: z.strictObject({ quietMs: positive, inactivityMs: positive, maxInputBytes: positive }),
  completionTokens: positive, rubric: beuserSealedRubricSchema,
  choices: z.strictObject({ 'beuser-walker': z.strictObject({ channelId: z.string(), modelId: z.string() }), 'beuser-evaluator': z.strictObject({ channelId: z.string(), modelId: z.string() }) }),
  contributorModels: z.array(immutableJsonObjectSchema).min(1),
  entry: z.strictObject({ mode: z.enum(['pty', 'argv']), nodeExecutable: z.literal(BEUSER_REALM_RECIPE.nodeExecutable), args: z.array(z.string()) }),
  probes: beuserParametersSchema.unwrap().shape.probes, calibration: beuserCalibrationSchema,
}).refine(data => data.candidateManifest.version === data.binding.candidate.version)
  .refine(data => data.probes.every(probe => probe.readbackRef === data.probes[0]?.readbackRef))
  .refine(data => data.entry.mode !== 'argv' || data.entry.args.length > 0).refine(data => data.schemaVersion === BEUSER_JOURNEY_PROFILE_VERSION || (data.schemaVersion === 3) === (data.startState !== undefined))
  .refine(data => (data.schemaVersion === BEUSER_JOURNEY_PROFILE_VERSION) === (data.limits !== undefined))
  .refine(data => data.schemaVersion !== BEUSER_JOURNEY_PROFILE_VERSION || data.limits !== undefined && validPinnedBeuserLimits(data.limitsRevision, data.limits))
  .refine(data => beuserStartStateFits(data.startState, data.summary));
export type BeuserJourneyProfile = z.infer<typeof beuserJourneyProfileSchema>;
export const beuserSupervisorProfileSchema = supervisorProfileSchema.unwrap().extend({ adapterId: z.literal('beuser'),
  adapterVersion: z.literal(1), parameters: beuserJourneyProfileSchema }).strict().readonly();
export const profileData = (profile: SupervisorProfile) => {
  const parsed = beuserSupervisorProfileSchema.safeParse(profile);
  if (!parsed.success) throw new BeuserContractError('BEUSER_INPUT_INVALID');
  return parsed.data.parameters;
};

export function validateBeuserSupervisorProfile(profile: SupervisorProfile): undefined { profileData(profile); return undefined; }
