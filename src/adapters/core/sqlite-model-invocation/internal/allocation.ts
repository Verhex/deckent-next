import type { DatabaseSync } from 'node:sqlite';
import { ModelInvocationStoreError, parseModelAllocation, parseModelAllocationCheckpoint, createModelAllocationCheckpoint,
  type ModelAllocation, type ModelAllocationCheckpoint } from '#engine/index.js';

function invalid(): never { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
/** Fixed indexed reads only. Whole-history verification belongs to the separate integrity reader. */
export function readModelAllocationCheckpoint(db: DatabaseSync, scopeId: string, allocationId: string): ModelAllocationCheckpoint | null {
  const row = db.prepare(`SELECT a.*,c.revision AS checkpoint_revision,c.digest AS checkpoint_digest
    FROM model_invocation_allocations a LEFT JOIN model_invocation_allocation_checkpoints c
    ON c.scope_id=a.scope_id AND c.allocation_id=a.allocation_id WHERE a.scope_id=? AND a.allocation_id=?`).get(scopeId, allocationId);
  if (!row) {
    if (db.prepare('SELECT 1 FROM model_invocations WHERE scope_id=? AND allocation_id=? LIMIT 1').get(scopeId, allocationId)
      || db.prepare('SELECT 1 FROM model_invocation_allocation_checkpoints WHERE scope_id=? AND allocation_id=?').get(scopeId, allocationId)) invalid();
    return null;
  }
  try {
    if (typeof row.record !== 'string') return invalid();
    const allocation = parseModelAllocation(JSON.parse(row.record));
    if (allocation.scopeId !== scopeId || allocation.allocationId !== allocationId || row.max_calls !== allocation.maxCalls
      || row.max_in_flight !== allocation.maxInFlight || row.lifetime_calls !== allocation.lifetimeCalls
      || row.in_flight !== allocation.inFlight || JSON.stringify(allocation) !== row.record) invalid();
    return parseModelAllocationCheckpoint({ schemaVersion: 1, revision: row.checkpoint_revision, allocation, digest: row.checkpoint_digest });
  } catch { return invalid(); }
}
/** Caller owns BEGIN IMMEDIATE and rollback, including the receipt/control/money writes. */
export function writeModelAllocation(db: DatabaseSync, previous: ModelAllocationCheckpoint | null, input: ModelAllocation): void {
  if (!db.isTransaction) invalid();
  const next = createModelAllocationCheckpoint(input, (previous?.revision ?? 0) + 1), after = next.allocation;
  if (previous) {
    const before = previous.allocation;
    if (before.scopeId !== after.scopeId || before.allocationId !== after.allocationId
      || before.maxCalls !== after.maxCalls || before.maxInFlight !== after.maxInFlight) invalid();
    const updated = db.prepare(`UPDATE model_invocation_allocations SET lifetime_calls=?,in_flight=?,record=?
      WHERE scope_id=? AND allocation_id=? AND lifetime_calls=? AND in_flight=? AND record=?`)
      .run(after.lifetimeCalls, after.inFlight, JSON.stringify(after), before.scopeId, before.allocationId,
        before.lifetimeCalls, before.inFlight, JSON.stringify(before));
    if (updated.changes !== 1) invalid();
    const checked = db.prepare(`UPDATE model_invocation_allocation_checkpoints SET revision=?,digest=?
      WHERE scope_id=? AND allocation_id=? AND revision=? AND digest=?`)
      .run(next.revision, next.digest, before.scopeId, before.allocationId, previous.revision, previous.digest);
    if (checked.changes !== 1) invalid();
  } else {
    db.prepare(`INSERT INTO model_invocation_allocations(scope_id,allocation_id,max_calls,max_in_flight,lifetime_calls,in_flight,record)
      VALUES(?,?,?,?,?,?,?)`).run(after.scopeId, after.allocationId, after.maxCalls, after.maxInFlight,
      after.lifetimeCalls, after.inFlight, JSON.stringify(after));
    db.prepare('INSERT INTO model_invocation_allocation_checkpoints(scope_id,allocation_id,revision,digest) VALUES(?,?,?,?)')
      .run(after.scopeId, after.allocationId, next.revision, next.digest);
  }
}
