import type { DatabaseSync } from 'node:sqlite';
import { attemptIdentitySchema, sameAttemptIdentity } from '#domain/index.js';
import { decodeLedgerRunSnapshot, decodeStored } from '#adapters/core/sqlite-ledger/index.js';
import { dispatchRecordSchema, RunStoreError } from '#engine/index.js';
/** Trusted internal lookup: exact Run binding selects stored argv/workspace, never caller paths.
 * This grants no authority; composition must authenticate and authorize before access. */
export function readRunBoundDispatch(db: DatabaseSync, identityInput: unknown) {
  const identity = attemptIdentitySchema.parse(identityInput);
  const row = db.prepare('SELECT revision,snapshot FROM runs WHERE scope_id=? AND run_id=?').get(identity.scopeId, identity.runId);
  if (!row) throw new RunStoreError('RUN_STORE_CONFLICT');
  const run = decodeLedgerRunSnapshot(row.snapshot, identity.scopeId, identity.runId);
  if (run.revision !== row.revision) throw new RunStoreError('RUN_STORE_CORRUPT');
  if (![...run.bindings, ...run.previousBindings ?? []].some(binding => sameAttemptIdentity(binding.identity, identity))) throw new RunStoreError('RUN_STORE_CONFLICT');
  const recordRow = db.prepare('SELECT record FROM dispatches WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
  if (!recordRow) return Object.freeze({ run, dispatch: null });
  const record = decodeStored(dispatchRecordSchema, recordRow.record, () => new RunStoreError('RUN_STORE_CORRUPT'), value => sameAttemptIdentity(value.request.identity, identity));
  return Object.freeze({ run, dispatch: record });
}
/** The bound task's definition from the same exact Run binding (K6: its declared work input scope); no authority is granted. */
export function readRunBoundTask(db: DatabaseSync, identityInput: unknown) {
  const { run } = readRunBoundDispatch(db, identityInput);
  const task = run.graph.tasks.find(entry => entry.id === attemptIdentitySchema.parse(identityInput).taskId);
  if (!task) throw new RunStoreError('RUN_STORE_CORRUPT');
  return task;
}
