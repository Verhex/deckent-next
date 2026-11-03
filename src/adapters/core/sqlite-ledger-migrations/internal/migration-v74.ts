import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';
/** Additive v74: opaque installation resources and immutable task bindings. No old record is rewritten.
 * Caller owns the migration transaction. Down is allowed only before any new binding was admitted;
 * after use, rollback restores the pre-switch backup and reconciles work rather than forgetting custody. */
export function migrateCapacityResources(db: DatabaseSync): void {
  try { db.exec(`CREATE TABLE capacity_resources(resource_key TEXT PRIMARY KEY NOT NULL,binding_kind TEXT NOT NULL,binding_id TEXT NOT NULL,
    execution_slots INTEGER NOT NULL CHECK(execution_slots>0),in_flight_slots INTEGER NOT NULL CHECK(in_flight_slots>0),UNIQUE(binding_kind,binding_id));
    CREATE TABLE run_capacity_resources(scope_id TEXT NOT NULL,run_id TEXT NOT NULL,task_id TEXT NOT NULL,resource_key TEXT NOT NULL,
      PRIMARY KEY(scope_id,run_id,task_id),FOREIGN KEY(scope_id,run_id) REFERENCES runs(scope_id,run_id),FOREIGN KEY(resource_key) REFERENCES capacity_resources(resource_key));
    CREATE INDEX run_capacity_resources_key ON run_capacity_resources(resource_key);
    CREATE TRIGGER capacity_resources_no_update BEFORE UPDATE ON capacity_resources BEGIN SELECT RAISE(ABORT,'immutable capacity resource'); END;
    CREATE TRIGGER capacity_resources_no_delete BEFORE DELETE ON capacity_resources BEGIN SELECT RAISE(ABORT,'immutable capacity resource'); END;
    CREATE TRIGGER run_capacity_resources_no_update BEFORE UPDATE ON run_capacity_resources BEGIN SELECT RAISE(ABORT,'immutable resource binding'); END;
    CREATE TRIGGER run_capacity_resources_no_delete BEFORE DELETE ON run_capacity_resources BEGIN SELECT RAISE(ABORT,'immutable resource binding'); END;`); } catch { throw new AttemptStoreError('ATTEMPT_STORE_VERSION'); }
}
export function revertCapacityResources(db: DatabaseSync): void {
  if (db.prepare('SELECT 1 FROM capacity_resources LIMIT 1').get() || db.prepare('SELECT 1 FROM run_capacity_resources LIMIT 1').get()) {
    throw new Error('CAPACITY_RESOURCE_ROLLBACK_REQUIRES_BACKUP');
  }
  db.exec(`DROP TABLE run_capacity_resources; DROP TABLE capacity_resources;`);
}
