import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError, type SupervisorProfileValidator } from '#engine/index.js';
import { requireLedgerV5Custody } from './migration-v5.js';
import { requireLedgerV6ProfileCompatibility } from './migration-v6.js';
// Persisted Next schema history. Versions are protocol invariants, not customer configuration.
export const DISPATCH_LEDGER_VERSION = 6;
export const RUN_LEDGER_VERSION = 6;
export const CURRENT_LEDGER_VERSION = 6;
const migrations: Readonly<Record<number, string>> = Object.freeze({
  1: `CREATE TABLE attempts(scope_id TEXT NOT NULL, attempt_id TEXT NOT NULL, revision INTEGER NOT NULL,
    snapshot TEXT NOT NULL, PRIMARY KEY(scope_id, attempt_id));
    CREATE TABLE attempt_receipts(scope_id TEXT NOT NULL, command_id TEXT NOT NULL, command TEXT NOT NULL,
    snapshot TEXT NOT NULL, PRIMARY KEY(scope_id, command_id)); PRAGMA user_version=1;`,
  2: 'CREATE TABLE dispatches(scope_id TEXT NOT NULL, attempt_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(scope_id, attempt_id)); PRAGMA user_version=2;',
  3: `CREATE TABLE runs(scope_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, policy TEXT NOT NULL, PRIMARY KEY(scope_id,run_id));
    CREATE TABLE run_receipts(scope_id TEXT NOT NULL, command_id TEXT NOT NULL, command TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(scope_id,command_id)); PRAGMA user_version=3;`,
  4: 'CREATE TABLE execution_pools(pool_id TEXT PRIMARY KEY NOT NULL, policy TEXT NOT NULL); PRAGMA user_version=4;',
});
export function requireLedgerVersion(db: DatabaseSync, minimum: number) {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < minimum || version > CURRENT_LEDGER_VERSION) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
  return version;
}
/** Caller owns BEGIN IMMEDIATE / rollback. Never migrate from read-only surface composition. */
export function migrateLedger(db: DatabaseSync, mode: 'allow' | 'forbid', profiles?: SupervisorProfileValidator): void {
  const version = requireLedgerVersion(db, 0);
  if (mode === 'forbid' && version !== CURRENT_LEDGER_VERSION) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
  for (let next = version + 1; next <= CURRENT_LEDGER_VERSION; next++) {
    if (next === 5) {
      requireLedgerV5Custody(db);
      db.exec('PRAGMA user_version=5;');
      continue;
    }
    if (next === 6) {
      requireLedgerV6ProfileCompatibility(db, profiles);
      db.exec('PRAGMA user_version=6;');
      continue;
    }
    const sql = migrations[next];
    if (!sql) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
    db.exec(sql);
  }
}
