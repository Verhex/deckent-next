import { parseInferenceServingConfig, resolveActiveInferenceProfile, type InferenceServingConfig, type InferenceServingProfile } from '#domain/index.js';

export function readInferenceServingConfig(config: Record<string, unknown>): InferenceServingConfig | null {
  const raw = config.inference_serving;
  if (raw === undefined) return null;
  return parseInferenceServingConfig(raw);
}

export function readInferenceServingProfile(config: Record<string, unknown>): InferenceServingProfile | null {
  return selectInferenceProfile(config);
}

export class InferenceServingError extends Error {
  constructor(readonly code: 'INFERENCE_PROFILE_UNKNOWN', readonly profileId: string) { super(code); this.name = 'InferenceServingError'; }
}

/** The one profile selector for every surface: null only when inference_serving is absent;
 * an explicitly requested profile that is not configured is a typed failure, never absence. */
export function selectInferenceProfile(config: Record<string, unknown>, profileId?: string): InferenceServingProfile | null {
  const serving = readInferenceServingConfig(config);
  if (!serving) return null;
  if (profileId === undefined) return resolveActiveInferenceProfile(serving);
  const profile = serving.profiles.find(entry => entry.id === profileId);
  if (!profile) throw new InferenceServingError('INFERENCE_PROFILE_UNKNOWN', profileId);
  return profile;
}
