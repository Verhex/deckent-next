import { persistedNumber, persistedInteger, persistedUrl, counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import { z } from 'zod';


export const INFERENCE_SERVING_SCHEMA_VERSION = 1;
export const inferenceTopologySchema = z.enum(['single', 'tp', 'dp']);
export const inferenceBackendSchema = z.enum(['vllm', 'sglang', 'openai-compatible']);
export const inferenceKvDtypeSchema = z.enum(['bf16', 'fp8']);

export const inferenceServingProfileSchema = z.strictObject({
  schemaVersion: z.literal(INFERENCE_SERVING_SCHEMA_VERSION),
  id: identitySchema,
  scopeId: identitySchema,
  hardware: z.strictObject({
    gpus: counterSchema.positive(),
    vramGbPerGpu: persistedNumber(z.number().positive()),
    arch: z.string().min(1),
    topology: inferenceTopologySchema,
  }).readonly(),
  model: z.strictObject({
    modelId: z.string().min(1),
    weightGb: persistedNumber(z.number().positive()),
    kvBytesPerTokenBf16: persistedNumber(z.number().positive()),
    kvBytesPerTokenFp8: persistedNumber(z.number().positive()),
    deltaNetStateGbPerSeq: persistedNumber(z.number().nonnegative()),
  }).readonly(),
  serving: z.strictObject({
    backend: inferenceBackendSchema,
    openaiBaseUrl: persistedUrl().optional(),
    weightQuant: z.string().min(1),
    kvDtype: inferenceKvDtypeSchema,
    gpuMemUtil: z.number().min(0.5).max(0.99),
    overheadGb: persistedNumber(z.number().nonnegative()),
    imageRef: z.string().min(1).optional(),
    modelPath: z.string().min(1).optional(),
  }).readonly(),
  workload: z.strictObject({
    maxCtx: counterSchema.positive(),
    avgActiveCtx: counterSchema.positive(),
    roleMaxCtx: z.strictObject({
      brain: counterSchema.positive(),
      worker: counterSchema.positive(),
      auditor: counterSchema.positive(),
    }).readonly(),
  }).readonly(),
  calibration: z.strictObject({
    computeCap: counterSchema.positive(),
    observedTokenCapacity: counterSchema.positive().optional(),
  }).readonly(),
  /** Loopback /metrics read limits. Absent means the read is refused; the adapter does not invent them. */
  metrics: z.strictObject({
    timeoutMs: persistedInteger().positive().max(2_147_483_647),
    responseMaxBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  }).readonly().optional(),
}).readonly();

export const inferenceServingConfigSchema = z.strictObject({
  schemaVersion: z.literal(INFERENCE_SERVING_SCHEMA_VERSION),
  activeProfileId: identitySchema,
  profiles: z.array(inferenceServingProfileSchema).min(1),
});

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
