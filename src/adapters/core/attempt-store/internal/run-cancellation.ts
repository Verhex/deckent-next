import type { DatabaseSync } from 'node:sqlite';
import { attemptIdentitySchema, runSnapshotSchema, attemptPhase, attemptSnapshotSchema, sameAttemptIdentity, requestAttemptCancellation, type RunSnapshot } from '#domain/index.js';
import { dispatchRecordSchema, RunStoreError, type RunCancellation } from '#engine/index.js';
/** Called only inside the Run cancellation transaction. Intent does not imply process termination. */
export function propagateRunCancellation(db: DatabaseSync, run: RunSnapshot, actor: RunCancellation['actor']): void {
  for (const binding of run.bindings) {
    const identity = binding.identity;
    const row = db.prepare('SELECT revision,snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
    if (!row) throw new RunStoreError('RUN_STORE_CORRUPT');
    let attempt;
    try { attempt = attemptSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
    if (attempt.revision !== row.revision || !sameAttemptIdentity(attempt.identity, identity)) throw new RunStoreError('RUN_STORE_CORRUPT');
    const dispatchRow = db.prepare('SELECT record FROM dispatches WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
    let dispatch;
    if (dispatchRow) {
      try { dispatch = dispatchRecordSchema.parse(JSON.parse(String(dispatchRow.record))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
      if (!sameAttemptIdentity(dispatch.request.identity, identity)) throw new RunStoreError('RUN_STORE_CORRUPT');
    }
    if (attemptPhase(attempt) === 'finished') continue;
    if (dispatch?.terminal) throw new RunStoreError('RUN_STORE_CORRUPT');
    const next = requestAttemptCancellation(attempt, attempt.revision);
    const changed = db.prepare('UPDATE attempts SET revision=?,snapshot=? WHERE scope_id=? AND attempt_id=? AND revision=?')
      .run(next.revision, JSON.stringify(next), identity.scopeId, identity.attemptId, attempt.revision);
    if (changed.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
    if (dispatch && !dispatch.cancellation) {
      const record = dispatchRecordSchema.parse({ ...dispatch, cancellation: actor });
      db.prepare('UPDATE dispatches SET record=? WHERE scope_id=? AND attempt_id=?').run(JSON.stringify(record), identity.scopeId, identity.attemptId);
    }
  }
}

/** Internal trusted lookup for a cancellation coordinator, never a public request/argv query. */
export function loadCancellationDispatch(db: DatabaseSync, identityInput: unknown) {
  const identity = attemptIdentitySchema.parse(identityInput);
  const row = db.prepare('SELECT revision,snapshot FROM runs WHERE scope_id=? AND run_id=?').get(identity.scopeId, identity.runId);
  if (!row) throw new RunStoreError('RUN_STORE_CONFLICT');
  let run;
  try { run = runSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
  if (run.revision !== row.revision || run.identity.scopeId !== identity.scopeId || run.identity.runId !== identity.runId) throw new RunStoreError('RUN_STORE_CORRUPT');
  if (!run.cancelRequested || !run.bindings.some(binding => sameAttemptIdentity(binding.identity, identity))) throw new RunStoreError('RUN_STORE_CONFLICT');
  const recordRow = db.prepare('SELECT record FROM dispatches WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
  if (!recordRow) return null;
  let record;
  try { record = dispatchRecordSchema.parse(JSON.parse(String(recordRow.record))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
  if (!sameAttemptIdentity(record.request.identity, identity)) throw new RunStoreError('RUN_STORE_CORRUPT');
  return record;
}
