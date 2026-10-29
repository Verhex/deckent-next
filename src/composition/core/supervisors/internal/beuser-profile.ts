import { z } from 'zod';
import { immutableJsonObjectSchema, beuserBindingSchema, beuserWalkerSummarySchema, beuserSealedRubricSchema } from '#domain/index.js';
import { beuserParametersSchema, beuserCalibrationSchema } from '#capabilities/index.js';
import { supervisorProfileSchema, BeuserContractError, type SupervisorProfile } from '#engine/index.js';

const positive = z.number().int().positive().safe();
/** Installed profile data, selected by id from the governed execution registry. Never accepted as CLI JSON. */
export const beuserJourneyProfileSchema = z.object({ schemaVersion: z.literal(1), binding: beuserBindingSchema, summary: beuserWalkerSummarySchema,
  limitsRevision: z.string().min(1), candidateRoot: z.string().min(1), packageDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  files: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().nonnegative().safe() }).strict()).min(1),
  size: z.object({ columns: positive, rows: positive, scrollback: positive }).strict(),
  bounds: z.object({ quietMs: positive, inactivityMs: positive, maxInputBytes: positive }).strict(),
  completionTokens: positive, rubric: beuserSealedRubricSchema,
  choices: z.object({ 'beuser-walker': z.object({ channelId: z.string(), modelId: z.string() }).strict(), 'beuser-evaluator': z.object({ channelId: z.string(), modelId: z.string() }).strict() }).strict(),
  contributorModels: z.array(immutableJsonObjectSchema).min(1),
  entry: z.object({ mode: z.enum(['pty', 'argv']), nodeExecutable: z.string().startsWith('/'), args: z.array(z.string()) }).strict(),
  probes: beuserParametersSchema.unwrap().innerType().shape.probes, calibration: beuserCalibrationSchema,
}).strict().refine(data => data.probes.every(probe => probe.readbackRef === data.probes[0]?.readbackRef));
export type BeuserJourneyProfile = z.infer<typeof beuserJourneyProfileSchema>;
export const beuserSupervisorProfileSchema = supervisorProfileSchema.unwrap().extend({ adapterId: z.literal('beuser'),
  adapterVersion: z.literal(1), parameters: beuserJourneyProfileSchema }).strict().readonly();
export const profileData = (profile: SupervisorProfile) => {
  const parsed = beuserSupervisorProfileSchema.safeParse(profile);
  if (!parsed.success) throw new BeuserContractError('BEUSER_INPUT_INVALID');
  return parsed.data.parameters;
};

export function validateBeuserSupervisorProfile(profile: SupervisorProfile): undefined { profileData(profile); return undefined; }
