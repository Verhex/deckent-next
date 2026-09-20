import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';

function invalid(): never { throw new AttemptStoreError('LEDGER_MIGRATION_EVIDENCE_REQUIRED'); }

/** Ledger20 introduces empty provider-spend storage. Historical invocations never imply monetary records. */
export function migrateProviderSpend(db: DatabaseSync): void {
  try {
    db.exec(`CREATE TABLE provider_spend_accounts(scope_id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>=1),reservation_count INTEGER NOT NULL CHECK(reservation_count>=0),
      digest TEXT NOT NULL,record TEXT NOT NULL);
      CREATE TABLE model_invocation_spend_reservations(scope_id TEXT NOT NULL,invocation_id TEXT NOT NULL,digest TEXT NOT NULL,record TEXT NOT NULL,
      PRIMARY KEY(scope_id,invocation_id),FOREIGN KEY(scope_id) REFERENCES provider_spend_accounts(scope_id),
      FOREIGN KEY(scope_id,invocation_id) REFERENCES model_invocations(scope_id,invocation_id));`);
    if (db.prepare('SELECT count(*) AS count FROM provider_spend_accounts').get()?.count !== 0
      || db.prepare('SELECT count(*) AS count FROM model_invocation_spend_reservations').get()?.count !== 0
      || db.prepare('PRAGMA foreign_key_check').all().length !== 0) invalid();
  } catch (error) {
    if (error instanceof AttemptStoreError && error.code === 'LEDGER_MIGRATION_EVIDENCE_REQUIRED') throw error;
    invalid();
  }
}
