import type { DatabaseSync } from 'node:sqlite';
import { attemptIdentitySchema } from '#domain/index.js';
import { CancellationDeliveryError, cancellationDeliverySchema, decideCancellationDeliveryClaim, decideCancellationDeliveryFinish,
  type CancellationDelivery, type CancellationDeliveryClaim, type CancellationDeliveryClaimResult, type CancellationDeliveryOutcome, type CancellationDeliveryStore } from '#engine/index.js';
import { sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';
import { readRunBoundDispatch } from './run-dispatch-lookup.js';

/** Durable cancellation retry leases. This journal never grants launch authority. */
export class SqliteCancellationDeliveryJournal implements CancellationDeliveryStore {
  constructor(private readonly db: DatabaseSync) {}

  private transaction<T>(work: () => T): T {
    let active = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); active = true;
      const result = work(); this.db.exec('COMMIT'); return result;
    } catch (error) {
      if (active) {
        try { this.db.exec('ROLLBACK'); }
        catch { throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CORRUPT'); }
      }
      throw sqliteFailure(error);
    }
  }

  private requireCancelledDispatch(identityInput: unknown) {
    const identity = attemptIdentitySchema.parse(identityInput);
    const { run, dispatch } = readRunBoundDispatch(this.db, identity);
    if (!run.cancelRequested || !dispatch?.cancellation) throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CONFLICT');
    return identity;
  }

  private read(identity: CancellationDeliveryClaim['identity']): { readonly raw: string; readonly record: CancellationDelivery } | null {
    const row = this.db.prepare('SELECT record FROM cancellation_deliveries WHERE scope_id=? AND attempt_id=?')
      .get(identity.scopeId, identity.attemptId);
    if (!row) return null;
    const raw = String(row.record);
    try {
      const record = cancellationDeliverySchema.parse(JSON.parse(raw));
      if (record.identity.scopeId !== identity.scopeId || record.identity.attemptId !== identity.attemptId) throw new Error('IDENTITY_MISMATCH');
      return Object.freeze({ raw, record });
    } catch { throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CORRUPT'); }
  }

  private persist(identity: CancellationDeliveryClaim['identity'], previous: { readonly raw: string; readonly record: CancellationDelivery } | null, record: CancellationDelivery): void {
    const encoded = JSON.stringify(record);
    if (!previous) {
      const written = this.db.prepare('INSERT INTO cancellation_deliveries(scope_id,attempt_id,record) VALUES(?,?,?)')
        .run(identity.scopeId, identity.attemptId, encoded);
      if (written.changes !== 1) throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CONFLICT');
      return;
    }
    const written = this.db.prepare('UPDATE cancellation_deliveries SET record=? WHERE scope_id=? AND attempt_id=? AND record=?')
      .run(encoded, identity.scopeId, identity.attemptId, previous.raw);
    if (written.changes !== 1) throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CONFLICT');
  }

  async claimCancellationDelivery(input: CancellationDeliveryClaim): Promise<CancellationDeliveryClaimResult> {
    return this.transaction(() => {
      const identity = this.requireCancelledDispatch(input.identity);
      const previous = this.read(identity);
      const decision = decideCancellationDeliveryClaim({ ...input, identity }, previous?.record ?? null);
      this.persist(identity, previous, decision.record);
      return decision;
    });
  }

  async finishCancellationDelivery(input: CancellationDeliveryClaim & { readonly outcome: CancellationDeliveryOutcome }): Promise<CancellationDelivery> {
    return this.transaction(() => {
      const identity = this.requireCancelledDispatch(input.identity);
      const previous = this.read(identity);
      if (!previous) throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CONFLICT');
      const record = decideCancellationDeliveryFinish({ ...input, identity }, previous.record);
      this.persist(identity, previous, record);
      return record;
    });
  }
}
