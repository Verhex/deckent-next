import type { DatabaseSync } from 'node:sqlite';
import { createProviderSpendCheckpoint, parseProviderSpendCheckpoint, initializeProviderSpendPeriod } from '#engine/index.js';

/** v72: no spend records or limits change. The first local month boundary is pinned at the explicit writer upgrade. */
export function migrateProviderSpendPeriods(db: DatabaseSync, nowMs = Date.now()): void {
  db.exec(`CREATE TABLE provider_spend_period_history(scope_id TEXT NOT NULL,checkpoint_revision INTEGER NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,checkpoint_revision));
    CREATE TRIGGER provider_spend_period_history_no_update BEFORE UPDATE ON provider_spend_period_history BEGIN SELECT RAISE(ABORT,'append-only'); END;
    CREATE TRIGGER provider_spend_period_history_no_delete BEFORE DELETE ON provider_spend_period_history BEGIN SELECT RAISE(ABORT,'append-only'); END;`);
  const rows = db.prepare('SELECT scope_id,record,revision,reservation_count,digest FROM provider_spend_accounts').iterate();
  const archive = db.prepare('INSERT INTO provider_spend_period_history(scope_id,checkpoint_revision,record) VALUES(?,?,?)');
  const update = db.prepare('UPDATE provider_spend_accounts SET record=?,revision=?,digest=? WHERE scope_id=?');
  for (const row of rows) {
    const prior = parseProviderSpendCheckpoint({ schemaVersion: 2, revision: row.revision, reservationCount: row.reservation_count,
      account: JSON.parse(String(row.record)), digest: row.digest });
    const next = createProviderSpendCheckpoint(initializeProviderSpendPeriod(prior.account, nowMs, true), prior.revision + 1, prior.reservationCount);
    archive.run(row.scope_id!, prior.revision, JSON.stringify(prior));
    update.run(JSON.stringify(next.account), next.revision, next.digest, row.scope_id!);
  }
}
