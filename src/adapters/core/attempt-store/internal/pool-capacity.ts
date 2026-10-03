import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { SqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';
import { AttemptStoreError, decidePoolCapacity, poolCapacityReceiptSchema, RunStoreError, type AuditStore, type PoolCapacityReceipt, type PoolCapacityWrite } from '#engine/index.js';
import { SqliteExecutionPools } from './pools.js';
const recordSchema = z.object({ fingerprint: z.string(), receipt: poolCapacityReceiptSchema }).strict();
/** One capacity writer; occupancy, replay, override, immutable receipt and sealed audit commit together. */
export class SqlitePoolCapacityJournal {
  constructor(private readonly db: DatabaseSync) {}
  private transaction<T>(mode: 'BEGIN' | 'BEGIN IMMEDIATE', work: () => T): T {
    let active = false, committing = false;
    try { this.db.exec(mode); active = true; const result = work(); committing = true; this.db.exec('COMMIT'); return result; }
    catch (error) {
      if (active) { try { this.db.exec('ROLLBACK'); } catch { throw new AttemptStoreError('ATTEMPT_STORE_OUTCOME_UNKNOWN'); } }
      if (committing) throw new AttemptStoreError('ATTEMPT_STORE_OUTCOME_UNKNOWN');
      throw sqliteFailure(error);
    }
  }
  async readPoolCapacity(poolId: string) {
    return this.transaction('BEGIN', () => {
      const pools = new SqliteExecutionPools(this.db), pool = pools.require(poolId);
      return Object.freeze({ schemaVersion: 1 as const, poolId, capacity: pool.capacity, occupancy: pools.occupancy(poolId), receipt: pools.capacityReceipt(poolId) });
    });
  }
  async applyPoolCapacity(write: PoolCapacityWrite, audit: (store: AuditStore, receipt: PoolCapacityReceipt) => void) {
    return this.transaction('BEGIN IMMEDIATE', () => {
      const { scopeId, commandId, poolId } = write.command, fingerprint = JSON.stringify({ command: write.command, actor: write.actor });
      const prior = this.db.prepare('SELECT record FROM execution_pool_capacity_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
      if (prior) {
        let record; try { record = recordSchema.parse(JSON.parse(String(prior.record))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
        if (record.fingerprint !== fingerprint) throw new RunStoreError('RUN_COMMAND_CONFLICT');
        return record.receipt;
      }
      const pools = new SqliteExecutionPools(this.db), pool = pools.require(poolId);
      const receipt = decidePoolCapacity(pool.capacity, pools.occupancy(poolId), write);
      if (receipt.changed) this.db.prepare('INSERT INTO execution_pool_capacities(pool_id,record) VALUES(?,?) ON CONFLICT(pool_id) DO UPDATE SET record=excluded.record').run(poolId, JSON.stringify(receipt));
      this.db.prepare('INSERT INTO execution_pool_capacity_receipts(scope_id,command_id,record) VALUES(?,?,?)').run(scopeId, commandId, JSON.stringify({ fingerprint, receipt }));
      audit(new SqliteAuditStore(this.db), receipt);
      return receipt;
    });
  }
}
