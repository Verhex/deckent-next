import { z } from 'zod';
import { immutableJsonObjectSchema, beuserBindingSchema, beuserWalkerSummarySchema, beuserSealedRubricSchema, beuserCandidateManifestSchema } from '#domain/index.js';
import { beuserParametersSchema, beuserCalibrationSchema } from '#capabilities/index.js';
import { supervisorProfileSchema, BeuserContractError, beuserStartStateSchema, beuserStartStateFits, type SupervisorProfile } from '#engine/index.js';
import { BEUSER_REALM_RECIPE } from '#adapters/index.js';

const positive = z.number().int().positive().safe();
/** Installed profile data, selected by id from the governed execution registry. Never accepted as CLI JSON. v3 adds a required catalogued start state; v2 keeps today's unarranged realm. */
export const beuserJourneyProfileSchema = z.object({ schemaVersion: z.union([z.literal(2), z.literal(3)]), startState: beuserStartStateSchema.optional(), binding: beuserBindingSchema, summary: beuserWalkerSummarySchema,
  limitsRevision: z.string().min(1), candidateRoot: z.string().min(1), packageDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  candidateManifest: beuserCandidateManifestSchema,
  size: z.object({ columns: positive, rows: positive, scrollback: positive }).strict(),
  bounds: z.object({ quietMs: positive, inactivityMs: positive, maxInputBytes: positive }).strict(),
  completionTokens: positive, rubric: beuserSealedRubricSchema,
  choices: z.object({ 'beuser-walker': z.object({ channelId: z.string(), modelId: z.string() }).strict(), 'beuser-evaluator': z.object({ channelId: z.string(), modelId: z.string() }).strict() }).strict(),
  contributorModels: z.array(immutableJsonObjectSchema).min(1),
  entry: z.object({ mode: z.enum(['pty', 'argv']), nodeExecutable: z.literal(BEUSER_REALM_RECIPE.nodeExecutable), args: z.array(z.string()) }).strict(),
  probes: beuserParametersSchema.unwrap().innerType().shape.probes, calibration: beuserCalibrationSchema,
}).strict().refine(data => data.candidateManifest.version === data.binding.candidate.version)
  .refine(data => data.probes.every(probe => probe.readbackRef === data.probes[0]?.readbackRef))
  .refine(data => data.entry.mode !== 'argv' || data.entry.args.length > 0).refine(data => (data.schemaVersion === 3) === (data.startState !== undefined))
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
