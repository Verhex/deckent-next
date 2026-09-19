import { parseProviderCatalog, providerCatalogObjectSchema } from '#domain/index.js';
import { ConfigValidationError, registerConfigSection, CONFIG_CONTRACT_SINCE } from '#platform/index.js';

function validate(value: unknown): void {
  if (value === undefined) return;
  try { parseProviderCatalog(value); }
  catch { throw new ConfigValidationError([{ path: 'provider_catalog', reason: 'PROVIDER_CATALOG_INVALID' }]); }
}
/** Each authored layer is a complete declaration snapshot; arrays replace, never merge identities. */
export function registerProviderCatalogConfig(): void {
  registerConfigSection('provider_catalog', providerCatalogObjectSchema, {
    optional: true, secretReferences: 'forbid',
    metadata: { descriptionKey: 'config.field.provider_catalog', tier: 'core', since: CONFIG_CONTRACT_SINCE },
    validateLayers: (global, project) => { validate(global); validate(project); },
    validateValue: validate,
  });
}
