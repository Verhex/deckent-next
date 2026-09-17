import type { DatabaseSync } from 'node:sqlite';
import { runSnapshotSchema } from '#domain/index.js';
import { executionPoolSchema, RunStoreError, measureTaskOccupancy, type ExecutionPool } from '#engine/index.js';
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
      return pool;
    } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
  }
  assertAvailable(poolId: string, requested: number): void {
    const pool = this.require(poolId); let execution = 0; let inFlight = 0;
    const rows = this.db.prepare("SELECT scope_id,run_id,revision,snapshot,json_extract(policy,'$.poolId') AS assigned_pool FROM runs WHERE json_extract(policy,'$.poolId')=? OR json_extract(policy,'$.poolId') IS NULL").all(poolId);
    for (const row of rows) {
      let run;
      try { run = runSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
      if (run.revision !== row.revision || run.identity.scopeId !== row.scope_id || run.identity.runId !== row.run_id) throw new RunStoreError('RUN_STORE_CORRUPT');
      const occupancy = measureTaskOccupancy(run.progress);
      if (row.assigned_pool === null && (occupancy.execution > 0 || occupancy.inFlight > 0)) throw new RunStoreError('RUN_POOL_REQUIRED');
      execution += occupancy.execution; inFlight += occupancy.inFlight;
    }
    if (requested > pool.capacity.executionSlots - execution || requested > pool.capacity.inFlightSlots - inFlight) throw new RunStoreError('RUN_POOL_FULL');
  }
}
