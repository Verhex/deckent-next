import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ModelCatalogError, modelCatalogCommandSchema, type ModelCatalogQuery } from '#domain/index.js';
import { ModelCatalogApplication, ModelCatalogInspectionApplication, ModelCatalogPolicyAuthorization } from '#engine/index.js';
import { openSqliteModelCatalogReader, openSqliteModelCatalogStore } from '#adapters/index.js';
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
/** Read-only catalog listing for one scope (WORKER-CURRENCY-2); never migrates or writes. */
export async function inspectConfiguredModelCatalog(projectRoot: string, query: ModelCatalogQuery, options: ConfigLoadOptions = {}) {
  try {
    const { config, document, principal, path } = await loadConfiguredScopeContext(projectRoot, query.scopeId, options, 'read');
    return await new ModelCatalogInspectionApplication({ async verify() { return principal; } }, new ModelCatalogPolicyAuthorization({ async load() { return document; } }),
      async () => openSqliteModelCatalogReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs })).inspect(query);
  } catch (error) { throw queryFailure(error); }
}
/** A packaged catalog document (`assets/model-catalog/<name>.json`) for `register`, or null for an unknown name; the command validates the content. */
export async function readPackagedModelCatalog(name: string): Promise<unknown> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return null;
  const text = await readFile(fileURLToPath(new URL(`../../../../../assets/model-catalog/${name}.json`, import.meta.url)), 'utf8').catch(() => null);
  try { return text === null ? null : JSON.parse(text) as unknown; } catch { throw new ModelCatalogError('MODEL_CATALOG_INVALID'); }
}
