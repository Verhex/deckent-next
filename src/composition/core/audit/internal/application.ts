import { hostname, userInfo } from 'node:os';
import { auditVerifyQuerySchema, type AuditVerification } from '#domain/index.js';
import { AuditCheckpointCycleError, AuditCheckpointApplication, auditPolicyDigest, auditProducersDigest, authorizeApproval, coreApprovalAssuranceInventory } from '#engine/index.js';
import { openReadOnlyAuditStore, openSqliteAuditStore, openLocalIntegrityAuthority, LOCAL_AUTHENTICATOR_INVENTORY } from '#adapters/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { inspectProductFile, type ConfigLoadOptions } from '#platform/index.js';
const unavailable = (scopeId: string, reason: AuditVerification['reason'] = 'unavailable'): AuditVerification =>
  Object.freeze({ schemaVersion: 1, scopeId, status: 'unknown', reason, head: null, checkpoint: null });
const producersDigest = () => auditProducersDigest({ authenticators: LOCAL_AUTHENTICATOR_INVENTORY, assurance: coreApprovalAssuranceInventory() });
/** All public consumers use this scoped, policy-authorized read. No migration, healing, key or checkpoint publication. */
export async function verifyConfiguredAudit(root: string, input: unknown, options: ConfigLoadOptions = {}): Promise<AuditVerification> {
  try {
    const query = auditVerifyQuerySchema.parse(input), context = await loadConfiguredScopeContext(root, query.scopeId, options, 'read');
    authorizeApproval(context.document, 'inspect', query.scopeId, query.scopeId, context.principal);
    if (!context.installationId) return unavailable(query.scopeId);
    try {
      const integrity = await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile), store = await openReadOnlyAuditStore(await context.path(), context.config.storage.sqlite);
      try { return new AuditCheckpointApplication(store, integrity, context.config.audit).verify(query.scopeId,
        { installationId: context.installationId, policyDigest: auditPolicyDigest(context.document), producersDigest: producersDigest() }, query.witness); }
      finally { store.close(); }
    } catch { return unavailable(query.scopeId); }
  } catch (error) { throw queryFailure(error); }
}
/** Trusted service-only writer. This function is not an SDK/MCP mutation and never invents scope identities. */
export async function checkpointConfiguredAudit(root: string, installationId: string | null, options: ConfigLoadOptions = {}): Promise<readonly AuditVerification[]> {
  let store: Awaited<ReturnType<typeof openSqliteAuditStore>> | undefined;
  try {
    const config = await loadComposedConfig(root, { ...options, heal: false });
    if (!installationId) throw new AuditCheckpointCycleError('unavailable');
    const document = await createLayoutPolicySource(config.productLayout, userInfo().uid, config.inspection.policyMaxBytes).load();
    const integrity = await openLocalIntegrityAuthority(config.productLayout, config.approvals.keyFile);
    store = await openSqliteAuditStore(await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']), config.storage.sqlite);
    const scopes = store.scopeIds(config.audit.maxScopes);
    if (scopes.length > config.audit.maxScopes) throw new AuditCheckpointCycleError('limit');
    const app = new AuditCheckpointApplication(store, integrity, config.audit), context = { installationId,
      policyDigest: auditPolicyDigest(document), producersDigest: producersDigest() };
    // The service's own OS principal authors each checkpoint's sealed wipe marker under the policy revision in force.
    const writer = { principal: { issuer: hostname(), subject: String(userInfo().uid) }, policyRevision: document.revision };
    return scopes.map(scopeId => app.checkpoint(scopeId, context, Date.now(), writer));
  } catch (error) { throw error instanceof AuditCheckpointCycleError ? error : new AuditCheckpointCycleError('unavailable'); }
  finally { store?.close(); }
}
