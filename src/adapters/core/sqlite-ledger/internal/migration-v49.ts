import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError, parseProviderSpendReservation, providerSpendReservationDigest, verifyModelInvocationReceipt,
  verifyInvocationSpendReservation, parseProviderSpendCheckpoint, addProviderSpendExactMinorUnits, type ProviderSpendCheckpoint } from '#engine/index.js';

/** Prove byte-exact v2 records before translating. Service-start upgrade writes its private backup first. */
export function migrateMeasuredTariffSpend(db: DatabaseSync): void {
  try {
    const histories = new Map<string, { checkpoint: ProviderSpendCheckpoint; count: number; reserved: bigint; exact: string; frozen: boolean }>();
    for (const row of db.prepare('SELECT * FROM provider_spend_accounts').iterate()) {
      if (typeof row.record !== 'string' || typeof row.scope_id !== 'string') throw new Error();
      const checkpoint = parseProviderSpendCheckpoint({ schemaVersion: 2, account: JSON.parse(row.record), revision: row.revision,
        reservationCount: row.reservation_count, digest: row.digest });
      if (checkpoint.account.budgetRevisionCommandId || checkpoint.account.unfrozenAtBudgetRevision || checkpoint.account.budget.scopeId !== row.scope_id) throw new Error();
      histories.set(row.scope_id, { checkpoint, count: 0, reserved: 0n, exact: '0', frozen: false });
    }
    for (const row of db.prepare(`SELECT s.scope_id,s.invocation_id,s.record,s.digest,i.record AS invocation_record
      FROM model_invocation_spend_reservations s LEFT JOIN model_invocations i
      ON i.scope_id=s.scope_id AND i.invocation_id=s.invocation_id`).iterate()) {
      if (typeof row.record !== 'string' || typeof row.invocation_record !== 'string') throw new Error();
      const receipt = verifyModelInvocationReceipt(JSON.parse(row.invocation_record));
      const old = verifyInvocationSpendReservation(JSON.parse(row.record), receipt);
      if (old.schemaVersion !== 2 || JSON.stringify(old) !== row.record || providerSpendReservationDigest(old) !== row.digest
        || old.descriptor.scopeId !== row.scope_id || old.descriptor.invocationId !== row.invocation_id) throw new Error();
      const history = histories.get(old.descriptor.scopeId), d = old.descriptor, state = old.disposition;
      if (!history || d.budgetId !== history.checkpoint.account.budget.budgetId
        || d.budgetRevision !== history.checkpoint.account.budget.revision || d.currency !== history.checkpoint.account.budget.currency) throw new Error();
      history.count++;
      if (state.state === 'reserved' || state.state === 'held') history.reserved += BigInt(d.quote.maxChargeMinorUnits);
      if (state.state === 'held' && state.reason === 'overrun') history.frozen = true;
      if (state.state === 'settled-local') history.exact = addProviderSpendExactMinorUnits(history.exact, String(state.amountMinorUnits));
      if (state.state === 'settled-provider-reported') history.exact = addProviderSpendExactMinorUnits(history.exact, old.measurement!.exactMinorUnits);
      const next = parseProviderSpendReservation({ ...old, schemaVersion: 3 });
      const updated = db.prepare('UPDATE model_invocation_spend_reservations SET record=?,digest=? WHERE scope_id=? AND invocation_id=? AND digest=?')
        .run(JSON.stringify(next), providerSpendReservationDigest(next), row.scope_id!, row.invocation_id!, row.digest!);
      if (updated.changes !== 1) throw new Error();
    }
    for (const history of histories.values()) {
      const account = history.checkpoint.account;
      if (history.count !== history.checkpoint.reservationCount || history.reserved !== BigInt(account.reservedMinorUnits)
        || history.exact !== account.settledExactMinorUnits || history.frozen !== account.frozen) throw new Error();
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error();
    db.exec(`CREATE TABLE provider_spend_management(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,record TEXT NOT NULL,digest TEXT NOT NULL,
      PRIMARY KEY(scope_id,command_id));
      CREATE TRIGGER provider_spend_management_no_update BEFORE UPDATE ON provider_spend_management BEGIN SELECT RAISE(ABORT,'PROVIDER_SPEND_APPEND_ONLY'); END;
      CREATE TRIGGER provider_spend_management_no_delete BEFORE DELETE ON provider_spend_management BEGIN SELECT RAISE(ABORT,'PROVIDER_SPEND_APPEND_ONLY'); END;`);
  } catch { throw new AttemptStoreError('LEDGER_MIGRATION_EVIDENCE_REQUIRED'); }
}
