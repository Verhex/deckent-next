import { userInfo } from 'node:os';
import { loadConfig, inspectProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { readLocalOsIdentity, openSqliteInventoryReader } from '#adapters/index.js';
import { policySchema, policyScopeMembership } from '#domain/index.js';
import { DispatchInventoryApplication, DispatchInventoryError, dispatchInventoryQuerySchema, DispatchInventoryPolicyAuthorization, PolicyAuthorizationError, type DispatchInventoryStore } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';

/** Direct local CLI/SDK only, not remote peer authentication. Each invocation pins one config/layout
 * and fresh trusted policy snapshot. Project configuration cannot assign principal membership.
 */
export async function inspectConfiguredInventory(projectRoot: string, input: unknown, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const query = dispatchInventoryQuerySchema.parse(input);
  if (query.limit > config.inspection.maxPageSize) throw new DispatchInventoryError();
  const layout = config.productLayout;
  const identity = readLocalOsIdentity();
  let document;
  try { document = policySchema.parse(await createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes).load()); }
  catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
  const scopeIds = policyScopeMembership(document, identity, [query.scopeId]);
  if (!scopeIds.length) throw new PolicyAuthorizationError('POLICY_DENIED');
  const principal = Object.freeze({ ...identity, scopeIds });
  const store: DispatchInventoryStore = {
    async listDispatches(admitted) {
      const path = await inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
      const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
      try { return await reader.listDispatches(admitted); } finally { reader.close(); }
    },
  };
  const policy = new DispatchInventoryPolicyAuthorization({ async load() { return document; } });
  const app = new DispatchInventoryApplication(store, { async verify() { return principal; } }, policy, config.inspection.maxPageSize);
  const page = await app.inspect(query);
  return Object.freeze({ schemaVersion: 1 as const, layout, page });
}
