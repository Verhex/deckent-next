import { modelActivationQuerySchema, type ModelActivationQuery } from '#domain/index.js';
import { ModelActivationInspectionApplication, ModelActivationPolicyAuthorization } from '#engine/index.js';
import { openSqliteModelActivationReader } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** No catalog prerequisite or writable connection: observation cannot create or migrate activation state. */
export async function inspectConfiguredModelActivation(projectRoot: string, input: ModelActivationQuery, options: ConfigLoadOptions = {}) {
  try {
    const query = modelActivationQuerySchema.parse(input);
    const { config, document, principal, path } = await loadConfiguredScopeContext(projectRoot, query.scopeId, options);
    const app = new ModelActivationInspectionApplication({ async verify() { return principal; } },
      new ModelActivationPolicyAuthorization({ async load() { return document; } }),
      async () => openSqliteModelActivationReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs }));
    return await app.inspect(query);
  } catch (error) { throw queryFailure(error); }
}
