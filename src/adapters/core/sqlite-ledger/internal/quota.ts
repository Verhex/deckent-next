import type { DatabaseSync } from 'node:sqlite';
import { runSnapshotSchema, readWorkerModelPin, sameAttemptIdentity, type AttemptSnapshot, type RunSnapshot } from '#domain/index.js';
import { RunStoreError } from '#engine/index.js';
/** Installation ledger is the subscription custody boundary; pool/scope changes never evade a held channel. */
export function readQuotaHolds(db: DatabaseSync, run: RunSnapshot, now: number) {
  const channels = new Map<string, { since: number; deadline: number; resetsAtMs: number | null }>();
  const rows = db.prepare(`SELECT snapshot FROM runs WHERE EXISTS (SELECT 1 FROM json_each(snapshot,'$.quotaWaits') q
    WHERE json_extract(q.value,'$.deadline')>?)`).all(now);
  for (const row of rows) {
    let snapshot; try { snapshot = runSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
    for (const wait of snapshot.quotaWaits ?? []) if (wait.deadline > now) { const prior = channels.get(wait.channelId); if (!prior || prior.deadline < wait.deadline) channels.set(wait.channelId, { since: wait.since, deadline: wait.deadline, resetsAtMs: wait.quota.resetsAtMs !== null && wait.quota.resetsAtMs > wait.since ? wait.quota.resetsAtMs : null }); }
  }
  return run.execution.tasks.flatMap(task => { const pin = readWorkerModelPin(task.profile.parameters), hold = pin ? channels.get(pin.pin.channelId) : null; return hold ? [{ taskId: task.taskId, ...hold }] : []; });
}
export function quotaHeldTasks(db: DatabaseSync, run: RunSnapshot, now: number): readonly string[] { return readQuotaHolds(db, run, now).map(row => row.taskId); }
/** Caller owns the evaluation transaction. The definite exit is enriched once, with exact identity and revision custody. */
export function persistQuotaAttempt(db: DatabaseSync, current: AttemptSnapshot, next: AttemptSnapshot) {
  if (!sameAttemptIdentity(current.identity, next.identity) || next.revision !== current.revision + 1 || next.lastObservation?.result.kind !== 'quota-exhausted') throw new RunStoreError('RUN_STORE_CONFLICT');
  const changed = db.prepare('UPDATE attempts SET revision=?,snapshot=? WHERE scope_id=? AND attempt_id=? AND revision=?')
    .run(next.revision, JSON.stringify(next), current.identity.scopeId, current.identity.attemptId, current.revision);
  if (changed.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
}
