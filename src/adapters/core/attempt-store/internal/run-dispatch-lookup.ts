import type { DatabaseSync } from 'node:sqlite';
import { attemptIdentitySchema, runSnapshotSchema, sameAttemptIdentity } from '#domain/index.js';
import { dispatchRecordSchema, RunStoreError } from '#engine/index.js';
/** Trusted internal lookup: exact Run binding selects stored argv/workspace, never caller paths.
 * This grants no authority; composition must authenticate and authorize before access. */
export function readRunBoundDispatch(db: DatabaseSync, identityInput: unknown) {
  const identity = attemptIdentitySchema.parse(identityInput);
  const row = db.prepare('SELECT revision,snapshot FROM runs WHERE scope_id=? AND run_id=?').get(identity.scopeId, identity.runId);
  if (!row) throw new RunStoreError('RUN_STORE_CONFLICT');
  let run;
  try { run = runSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
  if (run.revision !== row.revision || run.identity.scopeId !== identity.scopeId || run.identity.runId !== identity.runId) throw new RunStoreError('RUN_STORE_CORRUPT');
  if (!run.bindings.some(binding => sameAttemptIdentity(binding.identity, identity))) throw new RunStoreError('RUN_STORE_CONFLICT');
  const recordRow = db.prepare('SELECT record FROM dispatches WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
  if (!recordRow) return Object.freeze({ run, dispatch: null });
  let record;
  try { record = dispatchRecordSchema.parse(JSON.parse(String(recordRow.record))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
  if (!sameAttemptIdentity(record.request.identity, identity)) throw new RunStoreError('RUN_STORE_CORRUPT');
  return Object.freeze({ run, dispatch: record });
}
