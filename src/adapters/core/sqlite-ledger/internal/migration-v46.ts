import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';
/** Ledger v46 (AOF-DECISION-PORT; renumbered from the lane v45 at batch-27 integration because A1/A3 own v45): additive decision custody;
 * the service upgrade writes the normal versioned backup before this transaction. Like v39/v41/v43/v44, IF NOT EXISTS lets an object this
 * exact migration created stand; unlike their column-name check, the stored CREATE text must match byte for byte, so a same-name table
 * of any other shape (even with matching column names) is refused and the caller rolls the whole migration transaction back. */
const TABLES = Object.freeze({
  decision_cases: `CREATE TABLE IF NOT EXISTS decision_cases(scope_id TEXT NOT NULL,decision_id TEXT NOT NULL,snapshot TEXT NOT NULL,
  PRIMARY KEY(scope_id,decision_id))`,
  decision_command_receipts: `CREATE TABLE IF NOT EXISTS decision_command_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,decision_id TEXT NOT NULL,receipt TEXT NOT NULL,
  PRIMARY KEY(scope_id,command_id),FOREIGN KEY(scope_id,decision_id) REFERENCES decision_cases(scope_id,decision_id))`,
});
export function migrateDecisionPort(db:DatabaseSync):void {
 for(const [name,sql] of Object.entries(TABLES)){
  try{db.exec(sql);}catch{throw new AttemptStoreError('ATTEMPT_STORE_VERSION');}
  // SQLite stores the CREATE text without IF NOT EXISTS (verified on node:sqlite, 2026-10-02).
  if(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql!==sql.replace('IF NOT EXISTS ',''))throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
 }
}
