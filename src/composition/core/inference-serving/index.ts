import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfig } from '#platform/index.js';
import { readInferenceServingConfig, readInferenceServingProfile } from '#engine/index.js';
import type { InferenceServingConfig, InferenceServingProfile } from '#domain/index.js';

export { createInferenceRunAdmission } from './internal/admission.js';

export async function loadConfiguredInferenceProfile(projectRoot: string, options: ConfigLoadOptions = {}): Promise<InferenceServingProfile | null> {
  const config = await loadConfig(projectRoot, options);
  return readInferenceServingProfile(config as Record<string, unknown>);
}

export async function loadConfiguredInferenceServing(projectRoot: string, options: ConfigLoadOptions = {}): Promise<InferenceServingConfig | null> {
  const config = await loadConfig(projectRoot, options);
  return readInferenceServingConfig(config as Record<string, unknown>);
}
