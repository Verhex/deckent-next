import { userInfo } from 'node:os';
import { ZodError } from 'zod';
import { loadConfig, inspectProductFile, DeckentError, ErrorRegistry, ManagedFileError, type ConfigLoadOptions } from '#platform/index.js';
import { registerProviderConfig, readLocalOsIdentity, openSqliteInventoryReader } from '#adapters/index.js';
import { policySchema, policyScopeMembership } from '#domain/index.js';
import { RunInspectionApplication, runQuerySchema, RunPolicyAuthorization, PolicyAuthorizationError, AuthenticationError,
  RunStoreError, AttemptStoreError, type RunQuery } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
/** Local CLI/SDK scope authority comes from trusted policy, never request/config membership. */
export async function inspectConfiguredRun(projectRoot: string, input: RunQuery, options: ConfigLoadOptions = {}) {
  try {
    registerProviderConfig();
    const query = runQuerySchema.parse(input);
    const config = await loadConfig(projectRoot, { ...options, heal: false }); const layout = config.productLayout;
    const identity = readLocalOsIdentity(); let document;
    try { document = policySchema.parse(await createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes).load()); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    const scopeIds = policyScopeMembership(document, identity, [query.scopeId]);
    if (!scopeIds.length) throw new PolicyAuthorizationError('POLICY_DENIED');
    const principal = Object.freeze({ ...identity, scopeIds });
    const store = { async loadRun(scopeId: string, runId: string) {
      const path = await inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
      const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
      try { return await reader.loadRun(scopeId, runId); } finally { reader.close(); }
    } };
    const app = new RunInspectionApplication(store, { async verify() { return principal; } }, new RunPolicyAuthorization({ async load() { return document; } }));
    return Object.freeze({ schemaVersion: 1 as const, layout, run: await app.inspect(query) });
  } catch (error) {
    if (error instanceof DeckentError) throw error;
    if (error instanceof ZodError) throw ErrorRegistry.createError('INVENTORY_QUERY_INVALID');
    if (error instanceof AuthenticationError || error instanceof PolicyAuthorizationError || error instanceof ManagedFileError || error instanceof AttemptStoreError || error instanceof RunStoreError) {
      throw ErrorRegistry.createError(ErrorRegistry.has(error.code) ? error.code : 'INVENTORY_UNAVAILABLE');
    }
    throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  }
}
