import { userInfo } from 'node:os';
import { SystemTrustedClock, getConfigKnownSecrets, resolveLocale } from '#platform/index.js';
import { openLocalIntegrityAuthority, openSqliteApprovalStore, openSqliteAuditStore } from '#adapters/index.js';
import { configuredProposalRegistry, createRunCreationAuthority, type RunCreationAuthority } from '#engine/index.js';
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
      return await work(createRunCreationAuthority(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes), audit, journal.store, integrity, clock, config.approvals.requestTtlMs, { locale: resolveLocale(undefined, {}, config.language), known: getConfigKnownSecrets(config), registry: configuredProposalRegistry(config.admission) }));
    } finally { journal.close(); }
  } finally { audit.close(); }
}
