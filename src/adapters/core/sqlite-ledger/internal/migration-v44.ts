import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';

// K5 typed execution pool hold (owner 2026-09-30 K5 = A; lane Jev 2e7be700): one row per held-or-resumed pool (no row = open) and one
// receipt per (scope, command). The hold lives beside `execution_pools`, never inside its `policy` JSON: installer replay compares that
// JSON byte for byte. Additive: no existing table or row changes, so the upgrade is lossless by construction. IF NOT EXISTS follows
// v39/v41/v43: a real ledger below v44 never has these objects; a same-name object of another shape fails the check below and rolls the
// single migration transaction back (the ledger stays at its version, typed ATTEMPT_STORE_VERSION).
const HOLD_SQL = `CREATE TABLE IF NOT EXISTS execution_pool_holds(pool_id TEXT NOT NULL PRIMARY KEY REFERENCES execution_pools(pool_id),
    revision INTEGER NOT NULL CHECK(revision>=1),state TEXT NOT NULL CHECK(state IN('held','open')),record TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS execution_pool_hold_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,command_id));`;
const SHAPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  execution_pool_holds: ['pool_id', 'revision', 'state', 'record'],
  execution_pool_hold_receipts: ['scope_id', 'command_id', 'record'],
});

/** Creates the v44 pool hold tables and proves their exact column lists. */
export function migrateExecutionPoolHolds(db: DatabaseSync): void {
  db.exec(HOLD_SQL);
  for (const [table, columns] of Object.entries(SHAPES)) {
    const found = db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all(table).map(row => String(row.name));
    if (found.join(',') !== columns.join(',')) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
  }
}
