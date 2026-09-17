import { propagateRunCancellation } from './run-cancellation.js';
import { SqliteExecutionPools } from './pools.js';
import type { DatabaseSync } from 'node:sqlite';
import { requestRunCancellation, createRun, reserveRunTasks, runSnapshotSchema, createAttempt, attemptSnapshotSchema, observeRunAttempt } from '#domain/index.js';
import { runCancellationSchema, type RunCancellation, runCreateSchema, runReservationSchema, runProjectionSchema, RunStoreError, AttemptStoreError, planSchedulingWave,
  type ExecutionPool, runExecutionPolicySchema, type RunCreate, type RunReservation, type RunProjection, type RunReceipt } from '#engine/index.js';
import { sqliteFailure } from './options.js';
export class SqliteRunJournal {
  constructor(private readonly db: DatabaseSync) {}
  private transaction<T>(work: () => T): T {
    let active = false;
    try { this.db.exec('BEGIN IMMEDIATE'); active = true; const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) {
      if (active) { try { this.db.exec('ROLLBACK'); } catch { throw new AttemptStoreError('ATTEMPT_STORE_OUTCOME_UNKNOWN'); } }
      throw sqliteFailure(error);
    }
  }
  private decode(snapshot: unknown, scopeId: string, runId: string) {
    try {
      const value = runSnapshotSchema.parse(JSON.parse(String(snapshot)));
      if (value.identity.scopeId !== scopeId || value.identity.runId !== runId) throw new RunStoreError('RUN_STORE_CORRUPT');
      return value;
    } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
  }
  private receipt(scopeId: string, runId: string, commandId: string, command: string): RunReceipt | null {
    const row = this.db.prepare('SELECT command,snapshot FROM run_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    if (!row) return null;
    if (row.command !== command) throw new RunStoreError('RUN_COMMAND_CONFLICT');
    return Object.freeze({ commandId, command, snapshot: this.decode(row.snapshot, scopeId, runId) });
  }
  private record(receipt: RunReceipt): RunReceipt {
    this.db.prepare('INSERT INTO run_receipts(scope_id,command_id,command,snapshot) VALUES(?,?,?,?)')
      .run(receipt.snapshot.identity.scopeId, receipt.commandId, receipt.command, JSON.stringify(receipt.snapshot));
    return Object.freeze(receipt);
  }
  async createExecutionPool(input: ExecutionPool) { return this.transaction(() => new SqliteExecutionPools(this.db).create(input)); }
  async loadRun(scopeId: string, runId: string) {
    try {
      const row = this.db.prepare('SELECT revision,snapshot FROM runs WHERE scope_id=? AND run_id=?').get(scopeId, runId);
      if (!row) return null;
      const snapshot = this.decode(row.snapshot, scopeId, runId);
      if (snapshot.revision !== row.revision) throw new RunStoreError('RUN_STORE_CORRUPT');
      return snapshot;
    } catch (error) { throw sqliteFailure(error); }
  }
  async projectRunAttempt(input: RunProjection): Promise<RunReceipt> {
    const parsed = runProjectionSchema.parse(input); const command = JSON.stringify({ action: 'project-run-attempt', ...parsed });
    const { scopeId, runId } = parsed;
    return this.transaction(() => {
      const replay = this.receipt(scopeId, runId, parsed.commandId, command); if (replay) return replay;
      const row = this.db.prepare('SELECT revision,snapshot FROM runs WHERE scope_id=? AND run_id=?').get(scopeId, runId);
      if (!row || row.revision !== parsed.expectedRevision) throw new RunStoreError('RUN_STORE_CONFLICT');
      const current = this.decode(row.snapshot, scopeId, runId);
      if (current.revision !== row.revision) throw new RunStoreError('RUN_STORE_CORRUPT');
      const evidence = this.db.prepare('SELECT revision,snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(scopeId, parsed.attemptId);
      if (!evidence) throw new RunStoreError('RUN_STORE_CONFLICT');
      let attempt;
      try { attempt = attemptSnapshotSchema.parse(JSON.parse(String(evidence.snapshot))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
      if (attempt.revision !== evidence.revision || attempt.identity.scopeId !== scopeId || attempt.identity.attemptId !== parsed.attemptId) throw new RunStoreError('RUN_STORE_CORRUPT');
      const snapshot = observeRunAttempt(current, parsed.expectedRevision, attempt);
      const updated = this.db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?')
        .run(snapshot.revision, JSON.stringify(snapshot), scopeId, runId, parsed.expectedRevision);
      if (updated.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
      return this.record({ commandId: parsed.commandId, command, snapshot });
    });
  }
  async cancelRun(input: RunCancellation): Promise<RunReceipt> {
    const parsed = runCancellationSchema.parse(input); const command = JSON.stringify({ action: 'cancel-run', ...parsed });
    const { scopeId, runId } = parsed;
    return this.transaction(() => {
      const replay = this.receipt(scopeId, runId, parsed.commandId, command); if (replay) return replay;
      const row = this.db.prepare('SELECT revision,snapshot FROM runs WHERE scope_id=? AND run_id=?').get(scopeId, runId);
      if (!row || row.revision !== parsed.expectedRevision) throw new RunStoreError('RUN_STORE_CONFLICT');
      const current = this.decode(row.snapshot, scopeId, runId);
      if (current.revision !== row.revision) throw new RunStoreError('RUN_STORE_CORRUPT');
      const snapshot = requestRunCancellation(current, parsed.expectedRevision);
      propagateRunCancellation(this.db, current, parsed.actor);
      const updated = this.db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?')
        .run(snapshot.revision, JSON.stringify(snapshot), scopeId, runId, parsed.expectedRevision);
      if (updated.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
      return this.record({ commandId: parsed.commandId, command, snapshot });
    });
  }
  async createRun(input: RunCreate): Promise<RunReceipt> {
    const parsed = runCreateSchema.parse(input); const command = JSON.stringify({ action: 'create-run', ...parsed });
    const { scopeId, runId } = parsed.identity;
    return this.transaction(() => {
      const replay = this.receipt(scopeId, runId, parsed.commandId, command); if (replay) return replay;
      const snapshot = createRun(parsed.identity, parsed.graph, parsed.now);
      new SqliteExecutionPools(this.db).require(parsed.policy.poolId);
      planSchedulingWave(snapshot.graph, { schemaVersion: 1, capacity: parsed.policy.capacity, ordering: parsed.policy.ordering, snapshot: { graphRevision: snapshot.graph.revision, now: parsed.now, progress: snapshot.progress } });
      const row = this.db.prepare('INSERT INTO runs(scope_id,run_id,revision,snapshot,policy) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING')
        .run(scopeId, runId, snapshot.revision, JSON.stringify(snapshot), JSON.stringify(parsed.policy));
      if (row.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
      return this.record({ commandId: parsed.commandId, command, snapshot });
    });
  }
  async reserveRunTasks(input: RunReservation): Promise<RunReceipt> {
    const parsed = runReservationSchema.parse(input); const command = JSON.stringify({ action: 'reserve-run-tasks', ...parsed });
    const { scopeId, runId } = parsed;
    return this.transaction(() => {
      const replay = this.receipt(scopeId, runId, parsed.commandId, command); if (replay) return replay;
      const row = this.db.prepare('SELECT revision,snapshot,policy FROM runs WHERE scope_id=? AND run_id=?').get(scopeId, runId);
      if (!row || row.revision !== parsed.expectedRevision) throw new RunStoreError('RUN_STORE_CONFLICT');
      const current = this.decode(row.snapshot, scopeId, runId);
      if (current.revision !== row.revision) throw new RunStoreError('RUN_STORE_CORRUPT');
      let policy;
      try { policy = runExecutionPolicySchema.parse(JSON.parse(String(row.policy))); } catch { throw new RunStoreError('RUN_POOL_REQUIRED'); }
      let wave;
      try { wave = planSchedulingWave(current.graph, { schemaVersion: 1, capacity: policy.capacity, ordering: policy.ordering, snapshot: { graphRevision: current.graph.revision, now: parsed.now, progress: current.progress } }); }
      catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
      if (parsed.identities.length > wave.selectedTaskIds.length || parsed.identities.some((id, i) => id.taskId !== wave.selectedTaskIds[i])) throw new RunStoreError('RUN_CAPACITY_OR_ORDER');
      new SqliteExecutionPools(this.db).assertAvailable(policy.poolId, parsed.identities.length);
      const snapshot = reserveRunTasks(current, parsed.expectedRevision, parsed.identities, parsed.now);
      for (const identity of parsed.identities) {
        const attempt = createAttempt(identity);
        const inserted = this.db.prepare('INSERT INTO attempts(scope_id,attempt_id,revision,snapshot) VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
          .run(scopeId, identity.attemptId, attempt.revision, JSON.stringify(attempt));
        if (inserted.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
      }
      const updated = this.db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?')
        .run(snapshot.revision, JSON.stringify(snapshot), scopeId, runId, parsed.expectedRevision);
      if (updated.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
      return this.record({ commandId: parsed.commandId, command, snapshot });
    });
  }
}
