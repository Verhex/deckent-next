import type { DatabaseSync } from 'node:sqlite';
import { attemptIdentitySchema, attemptSnapshotSchema, holdEnvironmentProbes, identitySchema, releaseEnvironmentProbes, RunError, sameAttemptIdentity, settleEnvironmentProbe, type AttemptIdentity, type RunSnapshot } from '#domain/index.js';
import { RunStoreError, type RunReceipt } from '#engine/index.js';
import { decodeStored, ledgerTransaction, sqliteFailure } from './options.js';
import { decodeLedgerRunSnapshot } from './run-snapshot.js';
/** `probing` (REVISE 2695): the custody written before the probe (its controller may still be probing); otherwise the 2693 uncertain hold. */
export type EnvironmentProbeHold = Readonly<{ identity: AttemptIdentity; probes: readonly string[]; runRevision: number; probing: boolean }>;
const corrupt = () => new RunStoreError('RUN_STORE_CORRUPT');
/** Another Attempt's row under this id is not this Attempt: null, not corrupt. */
const attemptOf = (db: DatabaseSync, identity: AttemptIdentity) => {
  const row = db.prepare('SELECT snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
  const attempt = row ? decodeStored(attemptSnapshotSchema, row.snapshot, corrupt) : null;
  return attempt && sameAttemptIdentity(attempt.identity, identity) ? attempt : null;
};
const holdsOf = (db: DatabaseSync, run: RunSnapshot): EnvironmentProbeHold[] => run.bindings.flatMap((binding): EnvironmentProbeHold[] => {
  const task = run.progress.find(row => row.taskId === binding.identity.taskId), { scopeId, attemptId } = binding.identity;
  if (binding.probes && task?.phase === 'active' && task.unresolvedEffects && !db.prepare('SELECT 1 FROM dispatches WHERE scope_id=? AND attempt_id=?').get(scopeId, attemptId)) return [{ identity: binding.identity, probes: binding.probes, runRevision: run.revision, probing: true }];
  const result = binding.observedKind === 'launch-refused' && task?.phase === 'pending' && task.unresolvedEffects ? attemptOf(db, binding.identity)?.lastObservation?.result : undefined;
  return result?.kind === 'launch-refused' && result.probe ? [{ identity: binding.identity, probes: [result.probe], runRevision: run.revision, probing: false }] : [];
});
/** REVISE 2693/2695: the probe holds of all Runs (service start: no probe is live) or of one Run (its turn: only uncertain holds, never a custody
 * whose controller may still be probing). */
export function readEnvironmentProbeHolds(db: DatabaseSync, filter?: Readonly<{ scopeId: string; runId: string }>): readonly EnvironmentProbeHold[] {
  try {
    const rows = filter ? db.prepare('SELECT scope_id,run_id,snapshot FROM runs WHERE scope_id=? AND run_id=?').all(identitySchema.parse(filter.scopeId), identitySchema.parse(filter.runId))
      : db.prepare("SELECT scope_id,run_id,snapshot FROM runs WHERE instr(snapshot,'\"launch-refused\"')>0 OR instr(snapshot,'\"probes\"')>0").all();
    return rows.flatMap(row => holdsOf(db, decodeLedgerRunSnapshot(row.snapshot, String(row.scope_id), String(row.run_id), corrupt))).filter(hold => !filter || !hold.probing);
  } catch (error) { throw sqliteFailure(error); }
}
const writeRun = (db: DatabaseSync, before: number, snapshot: RunSnapshot) => {
  if (db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?').run(snapshot.revision, JSON.stringify(snapshot), snapshot.identity.scopeId, snapshot.identity.runId, before).changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
  return snapshot;
};
const currentRun = (db: DatabaseSync, identity: AttemptIdentity) => {
  const row = db.prepare('SELECT revision,snapshot FROM runs WHERE scope_id=? AND run_id=?').get(identity.scopeId, identity.runId);
  if (!row) throw new RunStoreError('RUN_STORE_CONFLICT');
  return { revision: Number(row.revision), run: decodeLedgerRunSnapshot(row.snapshot, identity.scopeId, identity.runId, corrupt) };
};
/** A custody transition refused by the domain (cancelled meanwhile, already released, stale controller) is a typed store conflict. */
const custodyConflict = <T>(work: () => T): T => { try { return work(); } catch (error) { throw error instanceof RunError ? new RunStoreError('RUN_STORE_CONFLICT') : error; } };
/** REVISE 2695: one CAS transaction before the first probe container can start: the attempt's task holds its slot naming every covered probe. */
export function writeEnvironmentProbeCustody(db: DatabaseSync, identityInput: unknown, probes: readonly string[]): void {
  const identity = attemptIdentitySchema.parse(identityInput);
  ledgerTransaction(db, () => { const { revision, run } = currentRun(db, identity); writeRun(db, revision, custodyConflict(() => holdEnvironmentProbes(run, revision, identity, probes))); });
}
/** REVISE 2695: the controller's release once the probe path ended with every covered probe proven gone; the task's phase after it. */
export function releaseEnvironmentProbeCustody(db: DatabaseSync, identityInput: unknown, timing: Readonly<{ now: () => number; timeoutMs: number }>) {
  const identity = attemptIdentitySchema.parse(identityInput);
  return ledgerTransaction(db, () => {
    const { revision, run } = currentRun(db, identity), attempt = attemptOf(db, identity);
    if (!attempt) throw new RunStoreError('RUN_STORE_CONFLICT');
    return writeRun(db, revision, custodyConflict(() => releaseEnvironmentProbes(run, revision, attempt, timing.now(), timing.timeoutMs))).progress.find(row => row.taskId === identity.taskId)!.phase;
  });
}
/** REVISE 2693: the one release of a hold, after the adapter proved that probe container gone. CAS on the Run revision; a replay of the same
 * command (attempt + listed revision) returns its receipt; the current Run must still hold exactly this hold. */
export function commitEnvironmentProbeSettlement(db: DatabaseSync, hold: EnvironmentProbeHold, timing: Readonly<{ now: () => number; timeoutMs: number }>): RunReceipt {
  const { scopeId } = hold.identity, commandId = `settle-probe-${hold.identity.attemptId}-${hold.runRevision}`, command = JSON.stringify({ action: 'settle-environment-probe', ...hold });
  return ledgerTransaction(db, () => {
    const prior = db.prepare('SELECT command,snapshot FROM run_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    if (prior) { if (prior.command !== command) throw new RunStoreError('RUN_COMMAND_CONFLICT'); return Object.freeze({ commandId, command, snapshot: decodeLedgerRunSnapshot(prior.snapshot, scopeId, hold.identity.runId, corrupt) }); }
    // REVISE 2698: against the Run's CURRENT revision (another hold of the same Run may have settled since the listing), with this exact hold
    // (identity, probe set, kind) re-checked in this transaction; the update below stays a CAS on that revision.
    const { revision, run } = currentRun(db, hold.identity), attempt = attemptOf(db, hold.identity);
    if (revision < hold.runRevision || !attempt || !holdsOf(db, run).some(value => value.probing === hold.probing && JSON.stringify(value.probes) === JSON.stringify(hold.probes) && sameAttemptIdentity(value.identity, hold.identity))) throw new RunStoreError('RUN_STORE_CONFLICT');
    // REVISE 2695: a custody (controller gone at a start) clears like the controller's own release; a 2693 uncertain hold settles as before.
    const snapshot = writeRun(db, revision, hold.probing ? releaseEnvironmentProbes(run, revision, attempt, timing.now(), timing.timeoutMs) : settleEnvironmentProbe(run, revision, hold.identity, timing.now(), timing.timeoutMs));
    db.prepare('INSERT INTO run_receipts(scope_id,command_id,command,snapshot) VALUES(?,?,?,?)').run(scopeId, commandId, command, JSON.stringify(snapshot));
    return Object.freeze({ commandId, command, snapshot });
  });
}
