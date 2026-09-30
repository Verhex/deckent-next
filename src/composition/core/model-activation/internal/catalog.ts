import { ModelCatalogError, modelCatalogCommandSchema } from '#domain/index.js';
import { ModelCatalogApplication, ModelCatalogPolicyAuthorization } from '#engine/index.js';
import { openSqliteModelCatalogStore } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** Governed ledger model catalog write (WORKER-CURRENCY-1): register facts, activate/deactivate a channel or model in a scope. */
export async function applyConfiguredModelCatalog(projectRoot: string, input: unknown, options: ConfigLoadOptions = {}) {
  try {
    const parsed = modelCatalogCommandSchema.safeParse(input);
    if (!parsed.success) throw new ModelCatalogError('MODEL_CATALOG_INVALID');
    const command = parsed.data;
    const { config, document, principal, path } = await loadConfiguredScopeContext(projectRoot, command.scopeId, options, 'write');
    return await new ModelCatalogApplication({ async verify() { return principal; } }, new ModelCatalogPolicyAuthorization({ async load() { return document; } }),
      async () => openSqliteModelCatalogStore(await path(), config.storage.sqlite, 'forbid'), Date.now).apply(command);
  } catch (error) { throw queryFailure(error); }
}
