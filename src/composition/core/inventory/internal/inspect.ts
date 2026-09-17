import { inventoryFailure } from './errors.js';
import { userInfo } from 'node:os';
import { loadConfig, inspectProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { registerProviderConfig, readLocalOsIdentity, openSqliteInventoryReader } from '#adapters/index.js';
import { policySchema, policyScopeMembership } from '#domain/index.js';
import { DispatchInventoryApplication, DispatchInventoryError, dispatchInventoryQuerySchema, dispatchInventoryInputSchema, DispatchInventoryPolicyAuthorization, PolicyAuthorizationError, type DispatchInventoryInput, type DispatchInventoryStore } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';

/** Direct local CLI/SDK only, not remote peer authentication. Each invocation pins one config/layout
 * and fresh trusted policy snapshot. Project configuration cannot assign principal membership.
 */
export async function inspectConfiguredInventory(projectRoot: string, input: DispatchInventoryInput, options: ConfigLoadOptions = {}) {
  try { return await inspect(projectRoot, input, options); } catch (error) { throw inventoryFailure(error); }
}
async function inspect(projectRoot: string, input: unknown, options: ConfigLoadOptions) {
  registerProviderConfig();
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const parsed = dispatchInventoryInputSchema.parse(input);
  const query = dispatchInventoryQuerySchema.parse({ ...parsed, limit: parsed.limit ?? config.inspection.maxPageSize });
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
