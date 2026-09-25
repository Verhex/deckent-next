import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError, createModelAllocationCheckpoint, parseModelAllocation,
  verifyModelInvocationReceipt } from '#engine/index.js';

type Row = Readonly<Record<string, unknown>>;
function invalid(): never { throw new AttemptStoreError('LEDGER_MIGRATION_EVIDENCE_REQUIRED'); }
function decode(input: unknown): unknown {
  if (typeof input !== 'string') return invalid();
  try { return JSON.parse(input) as unknown; } catch { return invalid(); }
}
const key = (scopeId: string, allocationId: string) => JSON.stringify([scopeId, allocationId]);

/** Ledger18 allocation rows predate independently checkable allocation checkpoints. */
export function migrateModelAllocationCheckpoints(db: DatabaseSync): void {
  try {
    const allocations = new Map<string, { row: Row; record: ReturnType<typeof parseModelAllocation> }>();
    for (const row of db.prepare(`SELECT scope_id,allocation_id,max_calls,max_in_flight,lifetime_calls,in_flight,record
      FROM model_invocation_allocations`).iterate() as Iterable<Row>) {
      const record = parseModelAllocation(decode(row['record']));
      if (row['scope_id'] !== record.scopeId || row['allocation_id'] !== record.allocationId
        || row['max_calls'] !== record.maxCalls || row['max_in_flight'] !== record.maxInFlight
        || row['lifetime_calls'] !== record.lifetimeCalls || row['in_flight'] !== record.inFlight
        || record.inFlight > record.lifetimeCalls || (record.maxCalls !== null && record.lifetimeCalls > record.maxCalls) || record.inFlight > record.maxInFlight
        || JSON.stringify(record) !== row['record']) invalid();
      const identity = key(record.scopeId, record.allocationId);
      if (allocations.has(identity)) invalid();
      allocations.set(identity, { row, record });
    }
    const counts = new Map<string, { lifetimeCalls: number; inFlight: number }>();
    // Validate one receipt at a time instead of materializing the entire retained history.
    const invocations = db.prepare(`SELECT scope_id,command_id,invocation_id,allocation_id,state,record
      FROM model_invocations`).iterate() as Iterable<Row>;
    let invocationCount = 0;
    for (const row of invocations) {
      const receipt = verifyModelInvocationReceipt(decode(row['record'])), state = receipt.outcome?.state ?? 'claimed';
      if (row['scope_id'] !== receipt.claim.scopeId || row['scope_id'] !== receipt.request.scopeId
        || row['command_id'] !== receipt.request.commandId || row['invocation_id'] !== receipt.claim.invocationId
        || row['allocation_id'] !== receipt.profile.allocation.id || row['state'] !== state
        || JSON.stringify(receipt) !== row['record']) invalid();
      const identity = key(receipt.claim.scopeId, receipt.profile.allocation.id), allocation = allocations.get(identity);
      if (!allocation || allocation.record.maxCalls !== receipt.profile.allocation.maxCalls
        || allocation.record.maxInFlight !== receipt.profile.allocation.maxInFlight) invalid();
      const count = counts.get(identity) ?? { lifetimeCalls: 0, inFlight: 0 };
      count.lifetimeCalls++;
      if (state !== 'responded' && state !== 'rejected' && state !== 'not-sent') count.inFlight++;
      if (count.lifetimeCalls > allocation.record.lifetimeCalls || count.inFlight > allocation.record.inFlight) invalid();
      counts.set(identity, count);
      invocationCount++;
    }
    if (db.prepare('SELECT count(*) AS count FROM model_invocations').get()?.count !== invocationCount) invalid();
    for (const [identity, allocation] of allocations) {
      const count = counts.get(identity) ?? { lifetimeCalls: 0, inFlight: 0 };
      if (allocation.record.lifetimeCalls !== count.lifetimeCalls || allocation.record.inFlight !== count.inFlight) invalid();
      counts.delete(identity);
    }
    if (counts.size !== 0) invalid();

    db.exec(`CREATE TABLE model_invocation_allocation_checkpoints(scope_id TEXT NOT NULL,allocation_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>=1),digest TEXT NOT NULL,PRIMARY KEY(scope_id,allocation_id),
      FOREIGN KEY(scope_id,allocation_id) REFERENCES model_invocation_allocations(scope_id,allocation_id));
      CREATE INDEX model_invocations_allocation_identity
      ON model_invocations(scope_id,allocation_id,invocation_id COLLATE BINARY);`);
    const insert = db.prepare(`INSERT INTO model_invocation_allocation_checkpoints(scope_id,allocation_id,revision,digest)
      VALUES(?,?,?,?)`);
    for (const { record } of allocations.values()) {
      const checkpoint = createModelAllocationCheckpoint(record, 1);
      insert.run(record.scopeId, record.allocationId, checkpoint.revision, checkpoint.digest);
    }
    if (db.prepare('SELECT count(*) AS count FROM model_invocation_allocation_checkpoints').get()?.count !== allocations.size
      || db.prepare('PRAGMA foreign_key_check').all().length !== 0) invalid();
  } catch (error) {
    if (error instanceof AttemptStoreError && error.code === 'LEDGER_MIGRATION_EVIDENCE_REQUIRED') throw error;
    invalid();
  }
}
