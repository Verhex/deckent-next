import type { DatabaseSync } from 'node:sqlite';
import { attemptSnapshotSchema, classifyCancelledAttempt, preventRunAttempt, sameAttemptIdentity, settleCancelledRunAttempt, type CancelledAttemptDispatch, type RunLifecycleTiming, type AttemptIdentity,
  type AttemptSnapshot, type RunSnapshot } from '#domain/index.js';
import { dispatchRecordSchema, RunStoreError, type DispatchRecord, type RunCancellationSettlement } from '#engine/index.js';
import { readRunBoundDispatch } from './run-dispatch-lookup.js';
import { decodeStored } from '#adapters/core/sqlite-ledger/index.js';
const corrupt = () => new RunStoreError('RUN_STORE_CORRUPT');

export function readAttempt(db: DatabaseSync, identity: AttemptIdentity): AttemptSnapshot {
  const row = db.prepare('SELECT revision,snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
  if (!row) throw corrupt();
  return decodeStored(attemptSnapshotSchema, row.snapshot, corrupt, attempt => attempt.revision === row.revision && sameAttemptIdentity(attempt.identity, identity));
}
export function readDispatch(db: DatabaseSync, identity: AttemptIdentity): DispatchRecord | null {
  const row = db.prepare('SELECT record FROM dispatches WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
  return row ? decodeStored(dispatchRecordSchema, row.record, corrupt, record => sameAttemptIdentity(record.request.identity, identity)) : null;
}
/** The dispatch evidence the domain classifier reads: the record's launch decision, or `none` without a claim. */
const dispatchOf = (dispatch: DispatchRecord | null): CancelledAttemptDispatch => !dispatch ? 'none' : dispatch.terminal ? 'exited'
  : dispatch.launch === 'prevented-before-launch' ? 'denied' : dispatch.launch;
/** Caller owns the write transaction. The domain classifier decides from durable cancellation intent and the recorded
 * dispatch evidence only: an unlaunched attempt is prevented, an exited one is settled, everything
 * else (running, unknown, unresolved effects, accepted/failed) is left to its existing owner. */
export function settleBoundAttempt(run: RunSnapshot, attempt: AttemptSnapshot, dispatch: CancelledAttemptDispatch,
  timing: RunLifecycleTiming): Readonly<{ status: RunCancellationSettlement['status']; run: RunSnapshot }> {
  if (!run.bindings.some(value => sameAttemptIdentity(value.identity, attempt.identity)) || !run.progress.some(value => value.taskId === attempt.identity.taskId)) throw corrupt();
  const verdict = classifyCancelledAttempt(run, attempt, dispatch);
  if (verdict === 'prevent') return Object.freeze({ status: 'prevented', run: preventRunAttempt(run, run.revision, attempt, dispatch, timing) });
  if (verdict === 'settle') return Object.freeze({ status: 'settled', run: settleCancelledRunAttempt(run, run.revision, attempt, dispatch, timing) });
  return Object.freeze({ status: verdict, run });
}
export function settleRunCancellation(db: DatabaseSync, run: RunSnapshot, timing: RunLifecycleTiming): RunSnapshot {
  let current = run;
  for (const binding of run.bindings) {
    const identity = binding.identity;
    const dispatch = readDispatch(db, identity);
    current = settleBoundAttempt(current, readAttempt(db, identity), dispatchOf(dispatch), timing).run;
  }
  return current;
}
export function settleAttemptCancellation(db: DatabaseSync, identityInput: unknown, timing: RunLifecycleTiming): RunCancellationSettlement {
  const { run, dispatch } = readRunBoundDispatch(db, identityInput);
  const identity = run.bindings.find(value => value.identity.attemptId === (identityInput as AttemptIdentity).attemptId)!.identity;
  const attempt = readAttempt(db, identity);
  const result = settleBoundAttempt(run, attempt, dispatchOf(dispatch), timing);
  if (result.run !== run) {
    const written = db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?')
      .run(result.run.revision, JSON.stringify(result.run), run.identity.scopeId, run.identity.runId, run.revision);
    if (written.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
  }
  const phase = result.run.progress.find(value => value.taskId === identity.taskId)!.phase;
  return Object.freeze({ status: result.status, phase });
}
