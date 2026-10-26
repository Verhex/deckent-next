import { DatabaseSync } from 'node:sqlite';
import { requireLedgerVersion, EFFECT_PRODUCER_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteInventoryReader } from '#adapters/core/attempt-store/index.js';
import { ErrorRegistry } from '#platform/index.js';
/** Whole-installation observation: revoked scope grants never hide unresolved business effects or active work from lifecycle custody. */
export function hasUnsettledInstallationWork(path: string, busyTimeoutMs: number): boolean {
  const db = new DatabaseSync(path, { readOnly: true, timeout: busyTimeoutMs });
  try {
    requireLedgerVersion(db, EFFECT_PRODUCER_LEDGER_VERSION);
    return !!db.prepare("SELECT 1 FROM effect_intents WHERE state NOT IN ('settled','refused') LIMIT 1").get()
      || !!db.prepare("SELECT 1 FROM model_invocations WHERE state IN ('claimed','unknown') LIMIT 1").get()
      || !!db.prepare("SELECT 1 FROM dispatches WHERE CASE WHEN json_valid(record)=0 THEN 1 ELSE json_extract(record,'$.terminal') IS NULL END LIMIT 1").get()
      || !!db.prepare("SELECT 1 FROM model_invocation_spend_reservations WHERE CASE WHEN json_valid(record)=0 THEN 1 ELSE json_extract(record,'$.disposition.state')='held' AND json_extract(record,'$.reconciliation') IS NULL END LIMIT 1").get();
  } finally { db.close(); }
}
/** Under lifecycle custody: every scope the ledger recorded data for joins the policy-named ones, each must be quiescent, and the
 * union is what the lifecycle decision covers. An unreadable or unbounded scope record keeps the installation (typed refusal). */
export async function quiescentInstallationScopes(path: string, limits: { readonly busyTimeoutMs: number; readonly pageSize: number; readonly maxScopes: number },
  scopeIds: readonly string[]): Promise<readonly string[]> {
  if (hasUnsettledInstallationWork(path, limits.busyTimeoutMs)) throw ErrorRegistry.createError('UNINSTALL_WORK_ACTIVE');
  let recorded: string[];
  try {
    const db = new DatabaseSync(path, { readOnly: true, timeout: limits.busyTimeoutMs });
    try { recorded = db.prepare('SELECT scope_id FROM scope_registry ORDER BY scope_id LIMIT ?').all(limits.maxScopes + 1).map(row => String(row['scope_id'])); }
    finally { db.close(); }
  } catch { throw ErrorRegistry.createError('UNINSTALL_SCOPE_UNVERIFIED', { params: { path } }); }
  if (recorded.length > limits.maxScopes) throw ErrorRegistry.createError('UNINSTALL_SCOPE_UNVERIFIED', { params: { path } });
  const affected = [...new Set([...scopeIds, ...recorded])], inventory = await openSqliteInventoryReader(path, { busyTimeoutMs: limits.busyTimeoutMs });
  try {
    for (const scopeId of affected) {
      const page = await inventory.listDispatches({ schemaVersion: 1, scopeId, after: null, limit: limits.pageSize });
      if (page.nextAfter || page.entries.some(entry => entry.terminal === null)) throw ErrorRegistry.createError('UNINSTALL_WORK_ACTIVE');
    }
  } finally { inventory.close(); }
  return Object.freeze(affected);
}
