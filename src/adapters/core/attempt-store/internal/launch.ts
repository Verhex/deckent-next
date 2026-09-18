import type { DatabaseSync } from 'node:sqlite';
import { attemptSnapshotSchema } from '#domain/index.js';
import { decideDispatchLaunch, validateLaunchRequest, DispatchError, type LaunchRequest, type LaunchDecision } from '#engine/index.js';
import { readRunBoundDispatch } from './run-dispatch-lookup.js';

/** Caller owns BEGIN IMMEDIATE. The persisted decision is the launch linearization point,
 * not evidence that a process started. No expiry, retry or replay issues a second grant. */
export function grantDispatchLaunch(db: DatabaseSync, input: LaunchRequest): LaunchDecision {
  const request = validateLaunchRequest(input); const identity = request.claim.request.identity;
  const { run, dispatch } = readRunBoundDispatch(db, identity);
  if (!dispatch) throw new DispatchError('DISPATCH_CONFLICT');
  if (dispatch.launch === 'prevented-before-launch') return decideDispatchLaunch(request, { run, attempt: null, dispatch }).decision;
  const row = db.prepare('SELECT revision,snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
  if (!row) throw new DispatchError('DISPATCH_CORRUPT');
  let attempt;
  try { attempt = attemptSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new DispatchError('DISPATCH_CORRUPT'); }
  if (attempt.revision !== row.revision) throw new DispatchError('DISPATCH_CONFLICT');
  const transition = decideDispatchLaunch(request, { run, attempt, dispatch });
  if (transition.projectedRun) {
    const projected = transition.projectedRun;
    const changed = db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?')
      .run(projected.revision, JSON.stringify(projected), identity.scopeId, identity.runId, run.revision);
    if (changed.changes !== 1) throw new DispatchError('DISPATCH_CONFLICT');
  }
  db.prepare('UPDATE dispatches SET record=? WHERE scope_id=? AND attempt_id=?').run(JSON.stringify(transition.decision.record), identity.scopeId, identity.attemptId);
  return transition.decision;
}
