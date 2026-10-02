import { parseProviderCatalog, providerCatalogObjectSchema } from '#domain/index.js';
import { ConfigValidationError, registerConfigSection, CONFIG_CONTRACT_SINCE } from '#platform/index.js';

import { nativeWorkerEventRetentionBytes } from '#adapters/core/native-connection/index.js';
import { WORKER_EVENT_SEAL_RESERVE_BYTES } from '#adapters/core/worker-observation/index.js';

function validate(value: unknown): void {
  if (value === undefined) return;
  try { parseProviderCatalog(value); }
  catch { throw new ConfigValidationError([{ path: 'provider_catalog', reason: 'PROVIDER_CATALOG_INVALID' }]); }
}
/** Each authored layer is a complete declaration snapshot; arrays replace, never merge identities. */
export function registerProviderCatalogConfig(): void {
  registerConfigSection('provider_catalog', providerCatalogObjectSchema, {
    optional: true, secretReferences: 'forbid',
    metadata: { descriptionKey: 'config.field.provider_catalog', tier: 'core', since: CONFIG_CONTRACT_SINCE, binding: { state: 'bound', consumers: ['src/composition/core/provider-catalog'] }, apply: 'restart' },
    validateLayers: (global, project) => { validate(global); validate(project); },
    validateValue: validate,
    // Effective validation also runs when the optional catalog is absent and on cache hits.
    validateEffective: config => {
      if (config.artifacts.maxBytes < nativeWorkerEventRetentionBytes() + WORKER_EVENT_SEAL_RESERVE_BYTES) {
        throw new ConfigValidationError([{ path: 'artifacts.maxBytes', reason: 'ARTIFACT_WORKER_EVENT_BUDGET' }], config.language);
      }
    },
  });
}
