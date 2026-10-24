import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';

// WORKER-CURRENCY-1 (owner 2026-09-30, Jev 55471f68): the model catalog lives in the ledger. Facts are installation-wide, keyed by
// (channel id, exact model id); activation is per scope — the channel row has model_id '' (SQLite keys cannot hold NULL); receipts per
// (scope, command). Additive: no existing table or row changes, so the upgrade is lossless by construction. IF NOT EXISTS follows
// v39/v41: a real ledger below v43 never has these objects; a same-name object of another shape fails the check below and rolls the
// single migration transaction back (the ledger stays at its version, typed ATTEMPT_STORE_VERSION).
const CATALOG_SQL = `CREATE TABLE IF NOT EXISTS model_catalog_channels(channel_id TEXT NOT NULL PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=1),
    record TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS model_catalog_models(channel_id TEXT NOT NULL REFERENCES model_catalog_channels(channel_id),
    model_id TEXT NOT NULL CHECK(model_id<>''),revision INTEGER NOT NULL CHECK(revision>=1),
    lifecycle TEXT NOT NULL CHECK(lifecycle IN('active','legacy','deprecated','retired')),record TEXT NOT NULL,PRIMARY KEY(channel_id,model_id));
  CREATE TABLE IF NOT EXISTS model_catalog_activations(scope_id TEXT NOT NULL,channel_id TEXT NOT NULL,model_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=1),state TEXT NOT NULL CHECK(state IN('active','inactive')),record TEXT NOT NULL,
    PRIMARY KEY(scope_id,channel_id,model_id));
  CREATE TABLE IF NOT EXISTS model_catalog_receipts(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id));`;
const SHAPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  model_catalog_channels: ['channel_id', 'revision', 'record'],
  model_catalog_models: ['channel_id', 'model_id', 'revision', 'lifecycle', 'record'],
  model_catalog_activations: ['scope_id', 'channel_id', 'model_id', 'revision', 'state', 'record'],
  model_catalog_receipts: ['scope_id', 'command_id', 'record'],
});

/** Creates the v43 catalog tables and proves their exact column lists. */
export function migrateModelCatalog(db: DatabaseSync): void {
  db.exec(CATALOG_SQL);
  for (const [table, columns] of Object.entries(SHAPES)) {
    const found = db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all(table).map(row => String(row.name));
    if (found.join(',') !== columns.join(',')) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
  }
}
