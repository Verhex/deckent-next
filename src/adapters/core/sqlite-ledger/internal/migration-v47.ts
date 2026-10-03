import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';
/** Forward-only additive override preserves the installer pool's byte-exact replay. Receipt and override share one transaction. */
const TABLES = Object.freeze({
  execution_pool_capacities: `CREATE TABLE IF NOT EXISTS execution_pool_capacities(pool_id TEXT NOT NULL PRIMARY KEY REFERENCES execution_pools(pool_id),record TEXT NOT NULL)`,
  execution_pool_capacity_receipts: `CREATE TABLE IF NOT EXISTS execution_pool_capacity_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id))`,
});
export function migratePoolCapacity(db: DatabaseSync): void {
  for (const [name, sql] of Object.entries(TABLES)) {
    try { db.exec(sql); } catch { throw new AttemptStoreError('ATTEMPT_STORE_VERSION'); }
    if (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql !== sql.replace('IF NOT EXISTS ', '')) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
  }
}
