import { DatabaseSync } from 'node:sqlite';
import { requireLedgerVersion, EFFECT_PRODUCER_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
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
