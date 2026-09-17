import { userInfo } from 'node:os';
import { loadConfig, inspectProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { LocalOsPrincipalVerifier, openSqliteInventoryReader } from '#adapters/index.js';
import { DispatchInventoryApplication, DispatchInventoryPolicyAuthorization, type DispatchInventoryStore } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';

/** Direct local CLI/SDK only; remote transports require their own authenticated principal.
 * One pinned config/layout snapshot, fresh policy, and authorization before any ledger opening.
 */
export async function inspectConfiguredInventory(projectRoot: string, query: unknown, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const layout = config.productLayout;
  const store: DispatchInventoryStore = {
    async listDispatches(admitted) {
      const path = await inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
      const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
      try { return await reader.listDispatches(admitted); } finally { reader.close(); }
    },
  };
  const verifier = new LocalOsPrincipalVerifier(config.local_access.scopeIds);
  const policy = new DispatchInventoryPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes));
  const app = new DispatchInventoryApplication(store, verifier, policy, config.inspection.maxPageSize);
  const page = await app.inspect(query);
  return Object.freeze({ schemaVersion: 1 as const, layout, page });
}
