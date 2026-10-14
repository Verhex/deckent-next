import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';
/** Additive checkpoint history. Existing audit records/seals are never rewritten or invented. */
export function migrateAuditCheckpoints(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS audit_checkpoints(scope_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>=1),record TEXT NOT NULL,
    PRIMARY KEY(scope_id,sequence));
    CREATE TRIGGER IF NOT EXISTS audit_checkpoints_no_update BEFORE UPDATE ON audit_checkpoints BEGIN SELECT RAISE(ABORT,'AUDIT_CHECKPOINT_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS audit_checkpoints_no_delete BEFORE DELETE ON audit_checkpoints BEGIN SELECT RAISE(ABORT,'AUDIT_CHECKPOINT_APPEND_ONLY'); END;`);
  const columns = db.prepare("SELECT name,type,pk,\"notnull\" AS required FROM pragma_table_info('audit_checkpoints') ORDER BY cid").all()
    .map(row => `${row.name}:${row.type}:${row.required}:${row.pk}`);
  const triggers = db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='audit_checkpoints' ORDER BY name").all().map(row => row.name);
  if (columns.join(',') !== 'scope_id:TEXT:1:1,sequence:INTEGER:1:2,record:TEXT:1:0' || triggers.join(',') !== 'audit_checkpoints_no_delete,audit_checkpoints_no_update') throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
  db.exec('PRAGMA user_version=55');
}
