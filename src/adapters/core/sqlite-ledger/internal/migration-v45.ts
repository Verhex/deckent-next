import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';
/** Additive decision custody; the service upgrade writes the normal versioned backup before this transaction. */
export function migrateDecisionPort(db:DatabaseSync):void {
 try {db.exec(`CREATE TABLE decision_cases(scope_id TEXT NOT NULL,decision_id TEXT NOT NULL,snapshot TEXT NOT NULL,
  PRIMARY KEY(scope_id,decision_id));
  CREATE TABLE decision_command_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,decision_id TEXT NOT NULL,receipt TEXT NOT NULL,
  PRIMARY KEY(scope_id,command_id),FOREIGN KEY(scope_id,decision_id) REFERENCES decision_cases(scope_id,decision_id));`);} catch {throw new AttemptStoreError('ATTEMPT_STORE_VERSION');}
 for(const [name,columns] of Object.entries({decision_cases:['scope_id','decision_id','snapshot'],decision_command_receipts:['scope_id','command_id','decision_id','receipt']})){
  if(db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all(name).map(row=>row.name).join(',')!==columns.join(','))throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
 }
}
