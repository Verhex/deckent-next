import { registerProviderConfig } from '#adapters/index.js';
import { ModelBindingApplication, type ModelBindingInspection } from '#engine/index.js';
import { loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import type { ModelReference } from '#domain/index.js';

/** Inspect one immutable config snapshot with the same local OS file access as catalog inspection. */
export async function inspectModelBinding(projectRoot: string, reference: ModelReference,
  options: ConfigLoadOptions = {}): Promise<ModelBindingInspection> {
  registerProviderConfig();
  return new ModelBindingApplication({ read: async () => {
    const config = await loadConfig(projectRoot, { ...options, heal: false });
    return config['provider_catalog'];
  } }).inspect(reference);
}
