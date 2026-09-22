import type { InferenceServingProfile } from '#domain/index.js';
import { buildInferenceServingPlan } from './plan.js';

export function openAiV1Base(profile: InferenceServingProfile): string {
  const plan = buildInferenceServingPlan(profile);
  const endpoint = plan.openaiBaseUrl;
  if (!endpoint) throw new Error('INFERENCE_CHAT_ENDPOINT_MISSING');
  return endpoint.endsWith('/v1') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1`;
}

export function chatCompletionsUrl(profile: InferenceServingProfile): string {
  return `${openAiV1Base(profile)}/chat/completions`;
}

export function modelsListUrl(profile: InferenceServingProfile): string {
  return `${openAiV1Base(profile)}/models`;
}
