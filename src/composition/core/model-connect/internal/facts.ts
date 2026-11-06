import type { ModelReference } from '#domain/index.js';
import { ModelActivationInspectionApplication, ModelActivationPolicyAuthorization, ModelCatalogApplication, ModelCatalogPolicyAuthorization } from '#engine/index.js';
import { openSqliteModelActivationReader, openSqliteModelCatalogReader } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';

/** Connect needs authorized catalog/activation facts before a legacy profile can be repaired, never invocation permission. */
export function connectionFacts(root: string, scopeId: string, options: ConfigLoadOptions) {
  const context = () => loadConfiguredScopeContext(root, scopeId, options, 'read');
  return {
    async catalog(channelId: string) {
      const { config, document, principal, path } = await context();
      const app = new ModelCatalogApplication({ verify: async () => principal }, new ModelCatalogPolicyAuthorization({ load: async () => document }),
        async () => { throw new Error('CONNECT_FACTS_READ_ONLY'); }, Date.now,
        async () => openSqliteModelCatalogReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs }));
      return app.inspect({ schemaVersion: 1, scopeId, channelId });
    },
    async activation(reference: ModelReference) {
      const { config, document, principal, path } = await context();
      const app = new ModelActivationInspectionApplication({ verify: async () => principal }, new ModelActivationPolicyAuthorization({ load: async () => document }),
        async () => openSqliteModelActivationReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs }));
      return app.inspect({ schemaVersion: 1, scopeId, reference });
    },
  };
}
