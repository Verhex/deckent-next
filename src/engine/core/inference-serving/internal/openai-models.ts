import type { InferenceServingProfile } from '#domain/index.js';
import { modelsListUrl } from './openai-endpoints.js';

export async function listOpenAiCompatibleModelIds(profile: InferenceServingProfile, signal?: AbortSignal): Promise<readonly string[]> {
  const response = await fetch(modelsListUrl(profile), signal ? { signal } : {});
  if (!response.ok) throw new Error('INFERENCE_MODELS_HTTP_FAILED');
  const payload = await response.json() as {
    data?: Array<{ id?: string }>;
    models?: Array<{ id?: string; name?: string; model?: string }>;
  };
  const fromData = (payload.data ?? []).map(entry => entry.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (fromData.length) return Object.freeze(fromData);
  const fromLlama = (payload.models ?? [])
    .map(entry => entry.id ?? entry.name ?? entry.model)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return Object.freeze(fromLlama);
}

export function pickServedModelId(configured: string, published: readonly string[]): string {
  if (published.includes(configured)) return configured;
  throw new Error('INFERENCE_MODEL_ID_MISMATCH');
}

export async function resolveServedModelId(profile: InferenceServingProfile, signal?: AbortSignal): Promise<string> {
  const published = await listOpenAiCompatibleModelIds(profile, signal);
  if (!published.length) return profile.model.modelId;
  return pickServedModelId(profile.model.modelId, published);
}
