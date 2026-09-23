import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';

export const INFERENCE_SERVING_SCHEMA_VERSION = 1;
export const inferenceTopologySchema = z.enum(['single', 'tp', 'dp']);
export const inferenceBackendSchema = z.enum(['vllm', 'sglang', 'openai-compatible']);
export const inferenceKvDtypeSchema = z.enum(['bf16', 'fp8']);

export const inferenceServingProfileSchema = z.object({
  schemaVersion: z.literal(INFERENCE_SERVING_SCHEMA_VERSION),
  id: identitySchema,
  scopeId: identitySchema,
  hardware: z.object({
    gpus: counterSchema.positive(),
    vramGbPerGpu: z.number().positive(),
    arch: z.string().min(1),
    topology: inferenceTopologySchema,
  }).strict().readonly(),
  model: z.object({
    modelId: z.string().min(1),
    weightGb: z.number().positive(),
    kvBytesPerTokenBf16: z.number().positive(),
    kvBytesPerTokenFp8: z.number().positive(),
    deltaNetStateGbPerSeq: z.number().nonnegative(),
  }).strict().readonly(),
  serving: z.object({
    backend: inferenceBackendSchema,
    openaiBaseUrl: z.string().url().optional(),
    weightQuant: z.string().min(1),
    kvDtype: inferenceKvDtypeSchema,
    gpuMemUtil: z.number().min(0.5).max(0.99),
    overheadGb: z.number().nonnegative(),
    imageRef: z.string().min(1).optional(),
    modelPath: z.string().min(1).optional(),
  }).strict().readonly(),
  workload: z.object({
    maxCtx: counterSchema.positive(),
    avgActiveCtx: counterSchema.positive(),
    roleMaxCtx: z.object({
      brain: counterSchema.positive(),
      worker: counterSchema.positive(),
      auditor: counterSchema.positive(),
    }).strict().readonly(),
  }).strict().readonly(),
  calibration: z.object({
    computeCap: counterSchema.positive(),
    observedTokenCapacity: counterSchema.positive().optional(),
  }).strict().readonly(),
  /** Loopback /metrics read limits. Absent means the read is refused; the adapter does not invent them. */
  metrics: z.object({
    timeoutMs: z.number().int().positive().max(2_147_483_647),
    responseMaxBytes: z.number().int().positive().safe(),
  }).strict().readonly().optional(),
}).strict().readonly();

export const inferenceServingConfigSchema = z.object({
  schemaVersion: z.literal(INFERENCE_SERVING_SCHEMA_VERSION),
  activeProfileId: identitySchema,
  profiles: z.array(inferenceServingProfileSchema).min(1),
}).strict();

export type InferenceServingProfile = Readonly<z.infer<typeof inferenceServingProfileSchema>>;
export type InferenceServingConfig = Readonly<z.infer<typeof inferenceServingConfigSchema>>;
export type InferenceRole = 'brain' | 'worker' | 'auditor';

export function parseInferenceServingConfig(input: unknown): InferenceServingConfig {
  const parsed = inferenceServingConfigSchema.safeParse(input);
  if (!parsed.success) throw new Error('INFERENCE_SERVING_CONFIG_INVALID');
  const ids = new Set(parsed.data.profiles.map(profile => profile.id));
  if (ids.size !== parsed.data.profiles.length || !ids.has(parsed.data.activeProfileId)) {
    throw new Error('INFERENCE_SERVING_CONFIG_INVALID');
  }
  return parsed.data;
}

export function resolveActiveInferenceProfile(config: InferenceServingConfig): InferenceServingProfile {
  const profile = config.profiles.find(entry => entry.id === config.activeProfileId);
  if (!profile) throw new Error('INFERENCE_SERVING_PROFILE_MISSING');
  return profile;
}
