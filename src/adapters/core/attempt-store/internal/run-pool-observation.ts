import type { DatabaseSync } from 'node:sqlite';
import { identitySchema } from '#domain/index.js';
import { RunStoreError, runExecutionPolicySchema, type RunPoolEvidence } from '#engine/index.js';
import { sqliteFailure, requireLedgerVersion, POOL_HOLD_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { readRunSnapshot } from './runs.js';
import { SqliteExecutionPools } from './pools.js';
/** Run, policy, pool and occupancy from a single deferred read transaction. Never persist a per-poll wait. */
export async function readRunPoolEvidence(db: DatabaseSync, scopeId: string, runId: string): Promise<RunPoolEvidence> {
  identitySchema.parse(scopeId); identitySchema.parse(runId); let active = false;
  try {
    db.exec('BEGIN'); active = true;
    const snapshot = await readRunSnapshot(db, scopeId, runId);
    let pool: RunPoolEvidence['pool'] = null;
    const row = snapshot ? db.prepare('SELECT policy FROM runs WHERE scope_id=? AND run_id=?').get(scopeId, runId) : null;
    if (row?.policy) {
      let policy; try { policy = runExecutionPolicySchema.parse(JSON.parse(String(row.policy))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
      const pools = new SqliteExecutionPools(db), current = pools.require(policy.poolId);
      const admitted = requireLedgerVersion(db, 0) >= 25 && !!db.prepare('SELECT 1 FROM run_execution_intents WHERE scope_id=? AND run_id=?').get(scopeId, runId);
      pool = { poolId: current.poolId, capacity: current.capacity, runCapacity: policy.capacity, occupancy: pools.occupancy(current.poolId), hold: requireLedgerVersion(db, 0) >= POOL_HOLD_LEDGER_VERSION ? pools.hold(current.poolId) : null, admitted };
    }
    db.exec('COMMIT'); active = false; return { snapshot, pool };
  } catch (error) { if (active) db.exec('ROLLBACK'); throw sqliteFailure(error); }
}
