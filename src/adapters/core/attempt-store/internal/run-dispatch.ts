import type { DatabaseSync } from 'node:sqlite';
import { runSnapshotSchema, observeRunAttempt, sameAttemptIdentity, type AttemptIdentity, type AttemptSnapshot } from '#domain/index.js';
import { DispatchError, runExecutionPolicySchema } from '#engine/index.js';
import { SqliteExecutionPools } from './pools.js';
import { settleBoundAttempt } from './run-settlement.js';
/** All methods run inside the dispatch journal's write transaction. */
export class SqliteRunDispatch {
  constructor(private readonly db: DatabaseSync) {}
  private read(identity: AttemptIdentity) {
    const row = this.db.prepare('SELECT revision,snapshot,policy FROM runs WHERE scope_id=? AND run_id=?').get(identity.scopeId, identity.runId);
    if (!row) throw new DispatchError('DISPATCH_NOT_ADMITTED');
    let run;
    try { run = runSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new DispatchError('DISPATCH_CORRUPT'); }
    const binding = run.bindings.find(value => value.identity.taskId === identity.taskId);
    if (run.revision !== row.revision || run.identity.scopeId !== identity.scopeId || run.identity.runId !== identity.runId) throw new DispatchError('DISPATCH_CORRUPT');
    if (!binding || !sameAttemptIdentity(binding.identity, identity)) throw new DispatchError('DISPATCH_NOT_ADMITTED');
    return { run, binding, policy: row.policy };
  }
  admit(identity: AttemptIdentity): void {
    const { run, policy } = this.read(identity);
    if (run.cancelRequested || run.progress.find(task => task.taskId === identity.taskId)?.phase !== 'active') throw new DispatchError('DISPATCH_NOT_ADMITTED');
    try {
      const parsed = runExecutionPolicySchema.parse(JSON.parse(String(policy)));
      new SqliteExecutionPools(this.db).assertAvailable(parsed.poolId, 0);
    } catch { throw new DispatchError('DISPATCH_NOT_ADMITTED'); }
  }
  project(attempt: AttemptSnapshot): void {
    const { run, binding } = this.read(attempt.identity);
    if (binding.observedRevision === attempt.revision) {
      if (binding.observedKind !== attempt.lastObservation?.result.kind) throw new DispatchError('DISPATCH_CORRUPT');
      return;
    }
    const observed = observeRunAttempt(run, run.revision, attempt);
    // finishDispatch is the terminal write: a cancel-requested worker that has now exited settles to `cancelled` in the same transaction.
    const snapshot = (run.cancelRequested || attempt.cancelRequested) && attempt.lastObservation?.result.kind === 'exited'
      ? settleBoundAttempt(observed, attempt, { dispatched: true, terminal: true }).run : observed;
    const written = this.db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?')
      .run(snapshot.revision, JSON.stringify(snapshot), run.identity.scopeId, run.identity.runId, run.revision);
    if (written.changes !== 1) throw new DispatchError('DISPATCH_CONFLICT');
  }
}
