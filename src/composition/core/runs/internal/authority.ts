import { userInfo } from 'node:os';
import { SystemTrustedClock, getConfigKnownSecrets, resolveLocale } from '#platform/index.js';
import { openLocalIntegrityAuthority, openSqliteApprovalStore, openSqliteAuditStore } from '#adapters/index.js';
import { AuditApplication, AuthorityDecisionRecords, RunCreateApprovalBroker, RunCreationAuthority } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import type { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
/** Connections live through the Run's last in-transaction authority check; no caller-supplied keys, clocks or policies. */
export async function withRunCreationAuthority<T>(context: Awaited<ReturnType<typeof loadConfiguredScopeContext>>, work: (authority: RunCreationAuthority) => Promise<T>): Promise<T> {
  const { config, layout } = context, clock = new SystemTrustedClock();
  const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
  const path = await context.path(), audit = await openSqliteAuditStore(path, config.storage.sqlite, 'forbid');
  try {
    const journal = openSqliteApprovalStore(path, config.storage.sqlite, 'forbid');
    try {
      return await work(new RunCreationAuthority(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes),
        new AuthorityDecisionRecords(new AuditApplication(audit, integrity)), new RunCreateApprovalBroker(journal.store, integrity, clock,
          { requestTtlMs: config.approvals.requestTtlMs, admitWithinMs: config.approvals.requestTtlMs }), clock,
        { locale: resolveLocale(undefined, {}, config.language), known: getConfigKnownSecrets(config) }));
    } finally { journal.close(); }
  } finally { audit.close(); }
}
