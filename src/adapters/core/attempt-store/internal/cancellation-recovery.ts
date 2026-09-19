import type { DatabaseSync } from 'node:sqlite';
import { attemptSnapshotSchema, sameAttemptIdentity } from '#domain/index.js';
import { cancellationDeliverySchema, cancellationRecoveryPage, cancellationRecoveryQuerySchema, CancellationDeliveryError,
  type CancellationRecoveryQuery, type CancellationRecoveryQueryStore } from '#engine/index.js';
import { dispatchRecordSchema } from '#engine/index.js';
import { sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';
import { readRunBoundDispatch } from './run-dispatch-lookup.js';

export class SqliteCancellationRecoveryQuery implements CancellationRecoveryQueryStore {
  constructor(private readonly db: DatabaseSync) {}
  async discoverCancellationRecovery(input: CancellationRecoveryQuery) {
    const query = cancellationRecoveryQuerySchema.parse(input);
    try {
      const rows = this.db.prepare(`SELECT d.attempt_id,d.record,a.snapshot,a.revision AS attempt_revision,c.record AS cancellation_record
        FROM dispatches d LEFT JOIN attempts a ON a.scope_id=d.scope_id AND a.attempt_id=d.attempt_id
        LEFT JOIN cancellation_deliveries c ON c.scope_id=d.scope_id AND c.attempt_id=d.attempt_id
        WHERE d.scope_id=? AND (? IS NULL OR d.attempt_id>?) ORDER BY d.attempt_id LIMIT ?`)
        .all(query.scopeId, query.afterAttemptId, query.afterAttemptId, query.limit);
      const identities = [];
      for (const row of rows) {
        let dispatch; let attempt;
        try {
          dispatch = dispatchRecordSchema.parse(JSON.parse(String(row.record)));
          attempt = attemptSnapshotSchema.parse(JSON.parse(String(row.snapshot)));
        } catch { throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CORRUPT'); }
        const identity = dispatch.request.identity;
        if (row.attempt_id !== identity.attemptId || identity.scopeId !== query.scopeId || attempt.revision !== row.attempt_revision
          || !sameAttemptIdentity(identity, attempt.identity)) {
          throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CORRUPT');
        }
        let journal = null;
        if (row.cancellation_record !== null) {
          try { journal = cancellationDeliverySchema.parse(JSON.parse(String(row.cancellation_record))); }
          catch { throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CORRUPT'); }
          if (!sameAttemptIdentity(journal.identity, identity)) throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CORRUPT');
        }
        let bound;
        try { bound = readRunBoundDispatch(this.db, identity); }
        catch { throw new CancellationDeliveryError('CANCELLATION_DELIVERY_CORRUPT'); }
        if (!bound.dispatch || !sameAttemptIdentity(bound.dispatch.request.identity, identity) || !bound.run.cancelRequested
          || !attempt.cancelRequested || !dispatch.cancellation || dispatch.terminal || dispatch.launch === 'prevented-before-launch') continue;
        const eligible = journal === null || (journal.state === 'queued' && journal.nextEligibleAt <= query.now)
          || (journal.state === 'claimed' && journal.claimUntil <= query.now);
        if (eligible) identities.push(identity);
      }
      return cancellationRecoveryPage(identities, rows.length ? String(rows.at(-1)!.attempt_id) : null);
    } catch (error) { throw sqliteFailure(error); }
  }
}
