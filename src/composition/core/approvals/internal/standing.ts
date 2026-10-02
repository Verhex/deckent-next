import { userInfo } from 'node:os';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { ApprovalApplication, AuditApplication, PersistentStanding, PolicyAdministrationApplication, type StandingGrantView } from '#engine/index.js';
import { LocalOsSessionAuthority, openLocalIntegrityAuthority, openSqliteApprovalStore, openSqliteAttemptStore, openSqliteAuditStore } from '#adapters/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** The caller's own standing approvals for `deckent policy grants --mine` / `revoke` (G6): local OS person; a revoke is the governed `policy.administer@1` change, `confirm` is the person's own answer. */
async function withStanding<T>(root: string, scopeId: string, options: ConfigLoadOptions, access: 'read' | 'write',
  use: (standing: PersistentStanding, person: Awaited<ReturnType<typeof loadConfiguredScopeContext>>['principal']) => Promise<T>): Promise<T> {
  try {
    const { config, layout, principal, path } = await loadConfiguredScopeContext(root, scopeId, options, access);
    const source = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes);
    const denied = () => Promise.reject(new Error('read-only'));
    if (access === 'read') return await use(new PersistentStanding({ policy: source, administration: { submit: denied }, approve: denied }), principal);
    const clock = new SystemTrustedClock(), sessions = await LocalOsSessionAuthority.create(principal.scopeIds, config.approvals.sessionTtlMs, clock);
    const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true), ledger = await path();
    const effects = await openSqliteAttemptStore(ledger, config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid'), journal = openSqliteApprovalStore(ledger, config.storage.sqlite);
    const auditStore = await openSqliteAuditStore(ledger, config.storage.sqlite, 'forbid');
    try {
      const audit = new AuditApplication(auditStore, integrity);
      const administration = new PolicyAdministrationApplication({ authority: source, policy: source, effects, approvals: journal.store, integrity, sessions, clock,
        requestTtlMs: config.approvals.requestTtlMs, audit: event => { audit.record(event); } });
      const approve = (approval: { approvalId: string; revision: number }, commandId: string, reason: string) => new ApprovalApplication(journal.store,
        { verify: async () => principal }, sessions, source, integrity, clock, 'local-sdk', config.approvals.pageSize)
        .decide({ schemaVersion: 1, scopeId, approvalId: approval.approvalId, commandId, expectedRevision: approval.revision, decision: 'allow', reason });
      return await use(new PersistentStanding({ administration, approve, policy: source }), principal);
    } finally { journal.close(); effects.close(); auditStore.close(); }
  } catch (error) { throw queryFailure(error); }
}
export function listConfiguredStandingGrants(root: string, scopeId: string, options: ConfigLoadOptions = {}): Promise<readonly StandingGrantView[]> {
  return withStanding(root, scopeId, options, 'read', (standing, person) => standing.list(scopeId, person));
}
/** Removes one of the caller's own standing grants after `confirm` (shown the grant); false = the person declined, nothing changed. */
export function revokeConfiguredStandingGrant(root: string, input: { readonly scopeId: string; readonly id: string; readonly reason: string;
  readonly confirm: (grant: StandingGrantView) => Promise<boolean> }, options: ConfigLoadOptions = {}): Promise<{ readonly revoked: boolean; readonly grant: StandingGrantView | null }> {
  return withStanding(root, input.scopeId, options, 'write', async (standing, person) => {
    const grant = (await standing.list(input.scopeId, person)).find(entry => entry.id === input.id) ?? null;
    if (!grant || !await input.confirm(grant)) return { revoked: false, grant };
    await standing.revoke({ scopeId: input.scopeId, principal: person, id: input.id, reason: input.reason });
    return { revoked: true, grant };
  });
}
