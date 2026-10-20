import type { DatabaseSync } from 'node:sqlite';
import { attemptSnapshotSchema, identitySchema, runSnapshotSchema, sameAttemptIdentity, settleEnvironmentProbe, type AttemptIdentity, type RunSnapshot } from '#domain/index.js';
import { RunStoreError, type RunReceipt } from '#engine/index.js';
import { ledgerTransaction, sqliteFailure } from './options.js';
export type EnvironmentProbeHold = Readonly<{ identity: AttemptIdentity; probe: string; runRevision: number }>;
const decode = (snapshot: unknown) => { try { return runSnapshotSchema.parse(JSON.parse(String(snapshot))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); } };
const attemptOf = (db: DatabaseSync, identity: AttemptIdentity) => {
  const row = db.prepare('SELECT snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
  try { const attempt = row ? attemptSnapshotSchema.parse(JSON.parse(String(row.snapshot))) : null; return attempt && sameAttemptIdentity(attempt.identity, identity) ? attempt : null; } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
};
const holdsOf = (db: DatabaseSync, run: RunSnapshot): EnvironmentProbeHold[] => run.bindings.flatMap(binding => {
  const task = run.progress.find(row => row.taskId === binding.identity.taskId), result = binding.observedKind === 'launch-refused' && task?.phase === 'pending' && task.unresolvedEffects
    ? attemptOf(db, binding.identity)?.lastObservation?.result : undefined;
  return result?.kind === 'launch-refused' && result.probe ? [{ identity: binding.identity, probe: result.probe, runRevision: run.revision }] : [];
});
/** REVISE 2693: the uncertain-probe holds (a task kept pending with an unresolved effect by a launch refusal that names its probe), of one Run or all. */
export function readEnvironmentProbeHolds(db: DatabaseSync, filter?: Readonly<{ scopeId: string; runId: string }>): readonly EnvironmentProbeHold[] {
  try {
    const rows = filter ? db.prepare('SELECT snapshot FROM runs WHERE scope_id=? AND run_id=?').all(identitySchema.parse(filter.scopeId), identitySchema.parse(filter.runId))
      : db.prepare("SELECT snapshot FROM runs WHERE instr(snapshot,'\"launch-refused\"')>0").all();
    return rows.flatMap(row => holdsOf(db, decode(row.snapshot)));
  } catch (error) { throw sqliteFailure(error); }
}
/** REVISE 2693: the one release of a hold, after the adapter proved that probe container gone. CAS on the Run revision; a replay of the same
 * command returns its receipt; the attempt must name exactly this probe. */
export function commitEnvironmentProbeSettlement(db: DatabaseSync, hold: EnvironmentProbeHold, timing: Readonly<{ now: () => number; timeoutMs: number }>): RunReceipt {
  const { scopeId, runId } = hold.identity, commandId = 'settle-probe-' + hold.identity.attemptId, command = JSON.stringify({ action: 'settle-environment-probe', ...hold });
  return ledgerTransaction(db, () => {
    const prior = db.prepare('SELECT command,snapshot FROM run_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    if (prior) { if (prior.command !== command) throw new RunStoreError('RUN_COMMAND_CONFLICT'); return Object.freeze({ commandId, command, snapshot: decode(prior.snapshot) }); }
    const row = db.prepare('SELECT revision,snapshot FROM runs WHERE scope_id=? AND run_id=?').get(scopeId, runId);
    if (!row || row.revision !== hold.runRevision || !holdsOf(db, decode(row.snapshot)).some(value => value.probe === hold.probe && sameAttemptIdentity(value.identity, hold.identity))) throw new RunStoreError('RUN_STORE_CONFLICT');
    const snapshot = settleEnvironmentProbe(decode(row.snapshot), hold.runRevision, hold.identity, timing.now(), timing.timeoutMs);
    if (db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?').run(snapshot.revision, JSON.stringify(snapshot), scopeId, runId, hold.runRevision).changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
    db.prepare('INSERT INTO run_receipts(scope_id,command_id,command,snapshot) VALUES(?,?,?,?)').run(scopeId, commandId, command, JSON.stringify(snapshot));
    return Object.freeze({ commandId, command, snapshot });
  });
}
