import type { DatabaseSync } from 'node:sqlite';
import { readWorkerModelPin, sameAttemptIdentity, type AttemptSnapshot, type RunSnapshot } from '#domain/index.js';
import { RunStoreError } from '#engine/index.js';
/** Installation ledger is the subscription custody boundary; pool/scope changes never evade a held channel. */
export function readQuotaHolds(db: DatabaseSync, run: RunSnapshot, now: number) {
  return run.execution.tasks.flatMap(task => {
    const pin = readWorkerModelPin(task.profile.parameters);
    if (!pin) return [];
    const hold = db.prepare(`SELECT since_ms,deadline_ms,resets_at_ms FROM run_quota_waits
      WHERE channel_id=? AND deadline_ms>? AND released_at_ms IS NULL AND channel_held=1 ORDER BY deadline_ms DESC LIMIT 1`)
      .get(pin.pin.channelId, now);
    return hold ? [{ taskId: task.taskId, since: Number(hold.since_ms), deadline: Number(hold.deadline_ms), resetsAtMs: Number(hold.resets_at_ms) }] : [];
  });
}
export function quotaHeldTasks(db: DatabaseSync, run: RunSnapshot, now: number): readonly string[] { return readQuotaHolds(db, run, now).map(row => row.taskId); }
/** Caller owns the evaluation transaction. The definite exit is enriched once, with exact identity and revision custody. */
export function persistQuotaAttempt(db: DatabaseSync, current: AttemptSnapshot, next: AttemptSnapshot) {
  if (!sameAttemptIdentity(current.identity, next.identity) || next.revision !== current.revision + 1 || next.lastObservation?.result.kind !== 'quota-exhausted') throw new RunStoreError('RUN_STORE_CONFLICT');
  const changed = db.prepare('UPDATE attempts SET revision=?,snapshot=? WHERE scope_id=? AND attempt_id=? AND revision=?')
    .run(next.revision, JSON.stringify(next), current.identity.scopeId, current.identity.attemptId, current.revision);
  if (changed.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
}
