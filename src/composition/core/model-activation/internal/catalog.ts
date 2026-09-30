import { ModelCatalogError, modelCatalogCommandSchema, type ModelCatalogQuery } from '#domain/index.js';
import { ModelCatalogApplication, ModelCatalogPolicyAuthorization } from '#engine/index.js';
import { openSqliteModelCatalogReader, openSqliteModelCatalogStore } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** Governed ledger model catalog write (WORKER-CURRENCY-1): register facts, activate/deactivate a channel or model in a scope. */
export async function applyConfiguredModelCatalog(projectRoot: string, input: unknown, options: ConfigLoadOptions = {}) {
  try {
    const parsed = modelCatalogCommandSchema.safeParse(input);
    if (!parsed.success) throw new ModelCatalogError('MODEL_CATALOG_INVALID');
    return await (await catalog(projectRoot, parsed.data.scopeId, options, 'write')).apply(parsed.data);
  } catch (error) { throw queryFailure(error); }
}
export async function inspectConfiguredModelCatalog(projectRoot: string, query: ModelCatalogQuery, options: ConfigLoadOptions = {}) { // read-only listing (WORKER-CURRENCY-2)
  try { return await (await catalog(projectRoot, query.scopeId, options, 'read')).inspect(query); } catch (error) { throw queryFailure(error); }
}
async function catalog(projectRoot: string, scopeId: string, options: ConfigLoadOptions, access: 'read' | 'write') {
  const { config, document, principal, path } = await loadConfiguredScopeContext(projectRoot, scopeId, options, access);
  return new ModelCatalogApplication({ async verify() { return principal; } }, new ModelCatalogPolicyAuthorization({ async load() { return document; } }),
    async () => openSqliteModelCatalogStore(await path(), config.storage.sqlite, 'forbid'), Date.now, async () => openSqliteModelCatalogReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs }));
}
