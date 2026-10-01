import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { SqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';
import { AttemptStoreError, decidePoolHold, poolHoldReceiptSchema, RunStoreError, type AuditStore, type PoolHoldReceipt, type PoolHoldTransition,
  type PoolHoldWrite } from '#engine/index.js';
import { SqliteExecutionPools } from './pools.js';

const receiptRecordSchema = z.object({ schemaVersion: z.literal(1), fingerprint: z.string().min(1), receipt: poolHoldReceiptSchema }).strict();
const fingerprint = (write: PoolHoldWrite) => JSON.stringify({ command: write.command, actor: write.actor });

/**
 * K5 pool hold journal (ledger v44). `execution_pool_holds` has one writer: {@link applyPoolHold}, which in one BEGIN IMMEDIATE
 * transaction replays the (scope, command) receipt, requires the provisioned pool, runs the engine transition, writes the row, the
 * receipt and the sealed `pool-hold` audit event on the same connection (no record, no change). A reservation that commits first was
 * admitted before the hold; one that starts after sees the row (SQLite serializes the writers).
 */
export class SqlitePoolHoldJournal {
  constructor(private readonly db: DatabaseSync) {}
  private transaction<T>(work: () => T): T {
    let active = false;
    try { this.db.exec('BEGIN IMMEDIATE'); active = true; const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) {
      if (active) { try { this.db.exec('ROLLBACK'); } catch { throw new AttemptStoreError('ATTEMPT_STORE_OUTCOME_UNKNOWN'); } }
      throw sqliteFailure(error);
    }
  }
  async readPoolHold(poolId: string) {
    try {
      const pools = new SqliteExecutionPools(this.db); pools.require(poolId);
      return Object.freeze({ hold: pools.hold(poolId), occupancy: Object.freeze(pools.occupancy(poolId)) });
    } catch (error) { throw sqliteFailure(error); }
  }
  async applyPoolHold(write: PoolHoldWrite, audit: (store: AuditStore, transition: PoolHoldTransition) => void): Promise<PoolHoldReceipt> {
    const { scopeId, commandId, poolId } = write.command, expected = fingerprint(write);
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT record FROM execution_pool_hold_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
      if (prior) {
        let stored;
        try { stored = receiptRecordSchema.parse(JSON.parse(String(prior.record))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
        if (stored.fingerprint !== expected) throw new RunStoreError('RUN_COMMAND_CONFLICT');
        return stored.receipt;
      }
      const pools = new SqliteExecutionPools(this.db); pools.require(poolId);
      const current = pools.hold(poolId), decided = decidePoolHold(current, write);
      if (decided.receipt.changed && decided.record) {
        const record = JSON.stringify(decided.record);
        const written = current
          ? this.db.prepare('UPDATE execution_pool_holds SET revision=?,state=?,record=? WHERE pool_id=? AND revision=?')
            .run(decided.record.revision, decided.record.state, record, poolId, current.revision)
          : this.db.prepare('INSERT INTO execution_pool_holds(pool_id,revision,state,record) VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
            .run(poolId, decided.record.revision, decided.record.state, record);
        if (written.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
      }
      this.db.prepare('INSERT INTO execution_pool_hold_receipts(scope_id,command_id,record) VALUES(?,?,?)')
        .run(scopeId, commandId, JSON.stringify({ schemaVersion: 1, fingerprint: expected, receipt: decided.receipt }));
      audit(new SqliteAuditStore(this.db), decided.transition);
      return decided.receipt;
    });
  }
  /** A refused hold/resume: only its sealed audit event is written. */
  async recordPoolHoldRefusal(audit: (store: AuditStore) => void): Promise<void> {
    this.transaction(() => audit(new SqliteAuditStore(this.db)));
  }
}
