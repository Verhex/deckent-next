import type { DatabaseSync } from 'node:sqlite';
import { attemptSnapshotSchema, preventRunAttempt, sameAttemptIdentity, settleCancelledRunAttempt, type AttemptIdentity, type AttemptSnapshot, type RunSnapshot } from '#domain/index.js';
import { dispatchRecordSchema, RunStoreError, type DispatchRecord, type RunCancellationSettlement } from '#engine/index.js';
import { readRunBoundDispatch } from './run-dispatch-lookup.js';

/** Caller owns the write transaction. Settlement consumes durable cancellation intent and recorded
 * terminal evidence only: an unlaunched attempt is prevented, an exited one is settled, everything
 * else (running, unknown, unresolved effects, accepted/failed) is left to its existing owner. */
function readAttempt(db: DatabaseSync, identity: AttemptIdentity): AttemptSnapshot {
  const row = db.prepare('SELECT revision,snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
  if (!row) throw new RunStoreError('RUN_STORE_CORRUPT');
  let attempt;
  try { attempt = attemptSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
  if (attempt.revision !== row.revision || !sameAttemptIdentity(attempt.identity, identity)) throw new RunStoreError('RUN_STORE_CORRUPT');
  return attempt;
}
function readDispatch(db: DatabaseSync, identity: AttemptIdentity): DispatchRecord | null {
  const row = db.prepare('SELECT record FROM dispatches WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
  if (!row) return null;
  let record;
  try { record = dispatchRecordSchema.parse(JSON.parse(String(row.record))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
  if (!sameAttemptIdentity(record.request.identity, identity)) throw new RunStoreError('RUN_STORE_CORRUPT');
  return record;
}
/** `evidence.dispatched`: a dispatch record exists (claimed, granted or prevented); `evidence.terminal`: terminal exit is recorded for it. */
export function settleBoundAttempt(run: RunSnapshot, attempt: AttemptSnapshot, evidence: Readonly<{ dispatched: boolean; terminal: boolean }>): Readonly<{ status: RunCancellationSettlement['status']; run: RunSnapshot }> {
  const identity = attempt.identity;
  const binding = run.bindings.find(value => sameAttemptIdentity(value.identity, identity));
  const task = run.progress.find(value => value.taskId === identity.taskId);
  if (!binding || !task) throw new RunStoreError('RUN_STORE_CORRUPT');
  if (task.phase === 'cancelled') return Object.freeze({ status: 'already-cancelled', run });
  if (task.unresolvedEffects || !['active', 'evaluating'].includes(task.phase)) return Object.freeze({ status: 'not-settleable', run });
  if (!evidence.dispatched && attempt.cancelRequested && attempt.lastObservation === null && binding.observedRevision === null && task.phase === 'active') {
    return Object.freeze({ status: 'prevented', run: preventRunAttempt(run, run.revision, attempt) });
  }
  if (evidence.terminal && (run.cancelRequested || attempt.cancelRequested) && task.phase === 'evaluating' && binding.observedKind === 'exited'
    && binding.observedRevision === attempt.revision && attempt.lastObservation?.result.kind === 'exited') {
    return Object.freeze({ status: 'settled', run: settleCancelledRunAttempt(run, run.revision, attempt) });
  }
  return Object.freeze({ status: 'not-settleable', run });
}
/** Applies prevention/settlement to every binding of a cancel-requested Run snapshot. */
export function settleRunCancellation(db: DatabaseSync, run: RunSnapshot): RunSnapshot {
  let current = run;
  for (const binding of run.bindings) {
    const identity = binding.identity;
    const dispatch = readDispatch(db, identity);
    current = settleBoundAttempt(current, readAttempt(db, identity), { dispatched: !!dispatch, terminal: !!dispatch?.terminal }).run;
  }
  return current;
}
/** Settles one attempt and persists the Run when it changed. */
export function settleAttemptCancellation(db: DatabaseSync, identityInput: unknown): RunCancellationSettlement {
  const { run, dispatch } = readRunBoundDispatch(db, identityInput);
  const identity = run.bindings.find(value => value.identity.attemptId === (identityInput as AttemptIdentity).attemptId)!.identity;
  const attempt = readAttempt(db, identity);
  const result = settleBoundAttempt(run, attempt, { dispatched: !!dispatch, terminal: !!dispatch?.terminal });
  if (result.run !== run) {
    const written = db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?')
      .run(result.run.revision, JSON.stringify(result.run), run.identity.scopeId, run.identity.runId, run.revision);
    if (written.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
  }
  const phase = result.run.progress.find(value => value.taskId === identity.taskId)!.phase;
  return Object.freeze({ status: result.status, phase });
}
