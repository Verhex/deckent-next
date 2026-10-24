import { RECOVERY_ROLLOUT, isAiPrincipal } from '#domain/index.js';
import { AuditApplication, NERVOUS_RULES_SEED, loadNervousRules, readRecoveryRollout, type MonitorRecoveryRollout } from '#engine/index.js';
import { inspectProductFile, type ResolvedConfig } from '#platform/index.js';
import { openReadOnlyAuditStore } from '#adapters/core/audit-store/index.js';
import { openLocalIntegrityAuthority } from '#adapters/core/local-keyring/index.js';
import { openSqliteRecoveryStore } from '#adapters/core/recovery-case-store/index.js';
import { readLocalOsIdentity } from '#adapters/core/local-principal/index.js';

/**
 * alpha.56 G4: the recovery rollout counts over the installation's scopes, from the sealed records verified with the installation key (read-only,
 * no key is created). Counts only (blind, owner Q-A5): no case and no model choice. An AI caller, or a ledger or key that cannot be read, gets none.
 */
export async function monitorRecoveryRollout(config: ResolvedConfig, scopeIds: readonly string[]): Promise<MonitorRecoveryRollout | null> {
  if (!scopeIds.length || isAiPrincipal(readLocalOsIdentity())) return null;
  const path = await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']), sqlite = config.storage.sqlite;
  const integrity = await openLocalIntegrityAuthority(config.productLayout, config.approvals.keyFile, false), audit = await openReadOnlyAuditStore(path, sqlite), runs = openSqliteRecoveryStore(path, sqlite);
  try {
    const ledger = new AuditApplication(audit, integrity), rules = loadNervousRules(NERVOUS_RULES_SEED).rules.filter(rule => RECOVERY_ROLLOUT.rules.includes(rule.id));
    const ports = { listRecentKind: ledger.listRecentKind.bind(ledger), loadRun: (scopeId: string, runId: string) => runs.loadRun(scopeId, runId) };
    const total = { rulesMet: 0, rules: 0, decided: 0, agreements: 0, waiting: 0, complete: true };
    for (const scopeId of scopeIds) {
      const view = await readRecoveryRollout(ports, scopeId, rules.map(rule => ({ id: rule.id, version: rule.version })));
      Object.assign(total, { rulesMet: total.rulesMet + view.rules.filter(rule => rule.met).length, rules: total.rules + view.rules.length, decided: total.decided + view.decisions.decided,
        agreements: total.agreements + view.decisions.agreements, waiting: total.waiting + view.decisions.waiting, complete: total.complete && view.complete });
    }
    return Object.freeze(total);
  } finally { audit.close(); runs.close(); }
}
