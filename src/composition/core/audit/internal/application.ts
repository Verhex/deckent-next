import { hostname, userInfo } from 'node:os';
import { AuditError, auditRebaselineCommandSchema, auditVerifyQuerySchema, type AuditVerification } from '#domain/index.js';
import { AuditCheckpointCycleError, AuditCheckpointApplication, auditScopeRecorded, auditPolicyDigest, auditProducersDigest, authorizeApproval, coreApprovalAssuranceInventory } from '#engine/index.js';
import { attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, openReadOnlyAuditStore, openSqliteAuditStore, openLocalIntegrityAuthority, LOCAL_AUTHENTICATOR_INVENTORY } from '#adapters/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { ErrorRegistry, inspectProductFile, type ConfigLoadOptions } from '#platform/index.js';
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
      const store = await openReadOnlyAuditStore(await context.path(), context.config.storage.sqlite);
      try {
        // Nothing recorded yet (fresh install: no events, no checkpoint, possibly no key): honest no-checkpoint-yet, never a key read.
        if (!auditScopeRecorded(store, query.scopeId)) return unavailable(query.scopeId, 'no-checkpoint-yet');
        const integrity = await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile);
        return new AuditCheckpointApplication(store, integrity, context.config.audit).verify(query.scopeId,
        { installationId: context.installationId, policyDigest: auditPolicyDigest(context.document), producersDigest: producersDigest() }, query.witness);
      } finally { store.close(); }
    } catch { return unavailable(query.scopeId); }
  } catch (error) { throw queryFailure(error); }
}
/** Trusted service-only writer. This function is not an SDK/MCP mutation and never invents scope identities. */
export async function checkpointConfiguredAudit(root: string, installationId: string | null, options: ConfigLoadOptions = {}): Promise<readonly AuditVerification[]> {
  let store: Awaited<ReturnType<typeof openSqliteAuditStore>> | undefined;
  try {
    const config = await loadComposedConfig(root, { ...options, heal: false });
    if (!installationId) throw new AuditCheckpointCycleError('unavailable');
    store = await openSqliteAuditStore(await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']), config.storage.sqlite);
    const scopes = store.scopeIds(config.audit.maxScopes);
    if (scopes.length > config.audit.maxScopes) throw new AuditCheckpointCycleError('limit');
    if (!scopes.length) return []; // no event and no checkpoint anywhere: nothing to anchor, and no key is required yet
    const document = await createLayoutPolicySource(config.productLayout, userInfo().uid, config.inspection.policyMaxBytes).load();
    const integrity = await openLocalIntegrityAuthority(config.productLayout, config.approvals.keyFile);
    const app = new AuditCheckpointApplication(store, integrity, config.audit), context = { installationId,
      policyDigest: auditPolicyDigest(document), producersDigest: producersDigest() };
    // The service's own OS principal authors each checkpoint's sealed wipe marker under the policy revision in force.
    const writer = { principal: { issuer: hostname(), subject: String(userInfo().uid) }, policyRevision: document.revision };
    return scopes.map(scopeId => app.checkpoint(scopeId, context, Date.now(), writer));
  } catch (error) { throw error instanceof AuditCheckpointCycleError ? error : new AuditCheckpointCycleError('unavailable'); }
  finally { store?.close(); }
}
/** What the re-baseline card shows and the write is bound to: the verified state plus the policy and producer digests it was computed over. */
export type AuditRebaselineView = AuditVerification & { readonly policyDigest: string; readonly producersDigest: string };
/**
 * The explicit operator re-baseline: approval-decide authority on `audit-rebaseline` (on the AI floor), a witnessed human terminal and one
 * y/N bound to the shown state. The policy is read again after the answer; the engine re-checks state, head and digests inside the write,
 * and a change in between asks again (bounded), never writes over what the person did not see.
 */
export async function rebaselineConfiguredAudit(root: string, input: unknown, options: ConfigLoadOptions,
  confirm: (current: AuditRebaselineView) => Promise<boolean>, attempts = 3): Promise<AuditVerification | null> {
  try {
    const command = auditRebaselineCommandSchema.parse(input), context = await loadConfiguredScopeContext(root, command.scopeId, options, 'write');
    authorizeApproval(context.document, 'decide', command.scopeId, 'audit-rebaseline', context.principal);
    if (localPrincipalChannel() === 'mcp' || localPrincipalPeer() || !await attestLocalInteractiveTerminal()) throw ErrorRegistry.createError('AUDIT_REBASELINE_INTERACTIVE_REQUIRED');
    if (!context.installationId) throw new AuditError('AUDIT_UNAVAILABLE');
    const installationId = context.installationId, policy = createLayoutPolicySource(context.layout, userInfo().uid, context.config.inspection.policyMaxBytes);
    const scoped = async () => { const document = await policy.load(); return { document, value: { installationId, policyDigest: auditPolicyDigest(document), producersDigest: producersDigest() } }; };
    const integrity = await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile), store = await openSqliteAuditStore(await context.path(), context.config.storage.sqlite, 'forbid');
    try {
      const app = new AuditCheckpointApplication(store, integrity, context.config.audit);
      for (let left = attempts; ; ) {
        // Authority is decided again on every policy this flow reads (REVIEW2561 R2): each card's, the write's, and inside the write.
        const shown = await scoped(), current = app.verify(command.scopeId, shown.value), authorize = (document: unknown) => authorizeApproval(document, 'decide', command.scopeId, 'audit-rebaseline', context.principal);
        authorize(shown.document);
        if (!['policy-changed', 'producers-changed', 'possible-wipe'].includes(current.status)) throw new AuditError('AUDIT_REBASELINE_REFUSED');
        if (!await confirm({ ...current, policyDigest: shown.value.policyDigest, producersDigest: shown.value.producersDigest })) return null;
        const fresh = await scoped(); authorize(fresh.document);
        try {
          return app.rebaseline(command.scopeId, fresh.value, Date.now(), { principal: { issuer: context.principal.issuer, subject: context.principal.subject },
            policyRevision: fresh.document.revision }, command.reason, { status: current.status, head: current.head, policyDigest: shown.value.policyDigest, producersDigest: shown.value.producersDigest },
            () => authorize(fresh.document));
        } catch (error) { if (!(error instanceof AuditError && error.code === 'AUDIT_REBASELINE_STALE') || --left <= 0) throw error; }
      }
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
