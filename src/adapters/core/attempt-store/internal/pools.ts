import type { DatabaseSync } from 'node:sqlite';
import { decodeLedgerRunSnapshot, requireLedgerVersion, POOL_CAPACITY_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { poolCapacityReceiptSchema, type PoolCapacityReceipt, executionPoolSchema, poolHoldRecordSchema, RunStoreError, measureTaskOccupancy, type ExecutionPool, type PoolHoldRecord } from '#engine/index.js';
/** Called within the caller's existing write transaction. Run progress is the sole occupancy truth;
 * no expiring lease or second mutable counter can silently release uncertain work.
 */
export class SqliteExecutionPools {
  constructor(private readonly db: DatabaseSync) {}
  create(input: ExecutionPool) {
    const pool = executionPoolSchema.parse(input); const encoded = JSON.stringify(pool);
    this.db.prepare('INSERT INTO execution_pools(pool_id,policy) VALUES(?,?) ON CONFLICT DO NOTHING').run(pool.poolId, encoded);
    const row = this.db.prepare('SELECT policy FROM execution_pools WHERE pool_id=?').get(pool.poolId);
    if (row?.policy !== encoded) throw new RunStoreError('RUN_POOL_CONFLICT');
    return pool;
  }
  require(poolId: string) {
    const row = this.db.prepare('SELECT policy FROM execution_pools WHERE pool_id=?').get(poolId);
    if (!row) throw new RunStoreError('RUN_POOL_REQUIRED');
    try {
      const pool = executionPoolSchema.parse(JSON.parse(String(row.policy)));
      if (pool.poolId !== poolId) throw new RunStoreError('RUN_STORE_CORRUPT');
      const receipt = this.capacityReceipt(poolId);
      return receipt ? { ...pool, capacity: receipt.next } : pool;
    } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
  }
  capacityReceipt(poolId: string): PoolCapacityReceipt | null {
    if (requireLedgerVersion(this.db, 0) < POOL_CAPACITY_LEDGER_VERSION) return null;
    const row = this.db.prepare('SELECT record FROM execution_pool_capacities WHERE pool_id=?').get(poolId);
    if (!row) return null;
    try {
      const receipt = poolCapacityReceiptSchema.parse(JSON.parse(String(row.record)));
      if (receipt.poolId !== poolId || !receipt.changed) throw new Error();
      return receipt;
    } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
  }
  assertAvailable(poolId: string, requested: number): void {
    if (requested > this.available(poolId)) throw new RunStoreError('RUN_POOL_FULL');
  }
  available(poolId: string, ceiling = Infinity): number {
    const pool = this.require(poolId), { execution, inFlight } = this.occupancy(poolId);
    return Math.min(Math.min(pool.capacity.executionSlots, ceiling) - execution, Math.min(pool.capacity.inFlightSlots, ceiling) - inFlight);
  }
  /** K5: the pool's typed hold (null = never held). A row that disagrees with its sealed record is corruption, never "open". */
  hold(poolId: string): PoolHoldRecord | null {
    const row = this.db.prepare('SELECT pool_id,revision,state,record FROM execution_pool_holds WHERE pool_id=?').get(poolId);
    if (!row) return null;
    let record: PoolHoldRecord;
    try { record = poolHoldRecordSchema.parse(JSON.parse(String(row.record))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
    if (record.poolId !== row.pool_id || record.revision !== row.revision || record.state !== row.state) throw new RunStoreError('RUN_STORE_CORRUPT');
    return record;
  }
  /** Reservation-only gate: already reserved attempts still pass dispatch admission (`assertAvailable`) while held. */
  assertNotHeld(poolId: string): void {
    if (this.hold(poolId)?.state === 'held') throw new RunStoreError('RUN_POOL_HELD');
  }
  /** Run progress is the sole occupancy truth, summed over every scope's Runs of the pool. */
  occupancy(poolId: string): { execution: number; inFlight: number } {
    let execution = 0; let inFlight = 0;
    const rows = this.db.prepare("SELECT scope_id,run_id,revision,snapshot,json_extract(policy,'$.poolId') AS assigned_pool FROM runs WHERE json_extract(policy,'$.poolId')=? OR json_extract(policy,'$.poolId') IS NULL").all(poolId);
    for (const row of rows) {
      const run = decodeLedgerRunSnapshot(row.snapshot, String(row.scope_id), String(row.run_id));
      if (run.revision !== row.revision) throw new RunStoreError('RUN_STORE_CORRUPT');
      const occupancy = measureTaskOccupancy(run.progress);
      if (row.assigned_pool === null && (occupancy.execution > 0 || occupancy.inFlight > 0)) throw new RunStoreError('RUN_POOL_REQUIRED');
      execution += occupancy.execution; inFlight += occupancy.inFlight;
    }
    return { execution, inFlight };
  }
}
