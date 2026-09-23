import { parseInferenceServingConfig, resolveActiveInferenceProfile, type InferenceServingConfig, type InferenceServingProfile } from '#domain/index.js';

export function readInferenceServingConfig(config: Record<string, unknown>): InferenceServingConfig | null {
  const raw = config.inference_serving;
  if (raw === undefined) return null;
  return parseInferenceServingConfig(raw);
}

export function readInferenceServingProfile(config: Record<string, unknown>): InferenceServingProfile | null {
  return selectInferenceProfile(config);
}

export function selectInferenceProfile(config: Record<string, unknown>, profileId?: string): InferenceServingProfile | null {
  const serving = readInferenceServingConfig(config);
  if (!serving) return null;
  if (!profileId) return resolveActiveInferenceProfile(serving);
  return serving.profiles.find(entry => entry.id === profileId) ?? null;
}
