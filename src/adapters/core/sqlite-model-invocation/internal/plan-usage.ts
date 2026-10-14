import type { DatabaseSync } from 'node:sqlite';
import { createModelInvocationPlanUsage, verifyModelInvocationPlanUsage, modelInvocationPlanUsageDigest,
  ModelInvocationStoreError, type ModelInvocationRecord } from '#engine/index.js';
import { MODEL_INVOCATION_PLAN_USAGE_LEDGER_VERSION, requireLedgerVersion } from '#adapters/core/sqlite-ledger/index.js';

export function recordInvocationPlanUsage(db: DatabaseSync, record: ModelInvocationRecord): void {
  const usage = createModelInvocationPlanUsage(record);
  if (!usage) return;
  if (!db.isTransaction) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  db.prepare('INSERT INTO model_invocation_plan_usage(scope_id,invocation_id,record,digest) VALUES(?,?,?,?)')
    .run(usage.scopeId, usage.invocationId, JSON.stringify(usage), modelInvocationPlanUsageDigest(usage));
}
export function readInvocationPlanUsage(db: DatabaseSync, version: number, record: ModelInvocationRecord) {
  const profile = record.receipt.profile, subscription = profile.schemaVersion === 2 && profile.billingAxis === 'subscription';
  if (version < MODEL_INVOCATION_PLAN_USAGE_LEDGER_VERSION) {
    if (subscription) requireLedgerVersion(db, MODEL_INVOCATION_PLAN_USAGE_LEDGER_VERSION);
    return null;
  }
  const row = db.prepare('SELECT record,digest FROM model_invocation_plan_usage WHERE scope_id=? AND invocation_id=?')
    .get(record.receipt.claim.scopeId, record.receipt.claim.invocationId);
  try {
    const usage = verifyModelInvocationPlanUsage(row ? JSON.parse(String(row.record)) : null, record);
    if (usage && row?.digest !== modelInvocationPlanUsageDigest(usage)) throw new Error();
    return usage;
  } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}
