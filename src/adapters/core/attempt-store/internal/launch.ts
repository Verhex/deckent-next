import type { DatabaseSync } from 'node:sqlite';
import { preventRunAttempt, verifiedPrincipalSchema, counterSchema, attemptSnapshotSchema, sameAttemptIdentity } from '#domain/index.js';
import { dispatchClaimSchema, dispatchRecordSchema, sameSandboxRequest, DispatchError, type LaunchRequest, type LaunchDecision } from '#engine/index.js';
import { readRunBoundDispatch } from './run-dispatch-lookup.js';

/** Caller owns BEGIN IMMEDIATE. The persisted decision is the launch linearization point,
 * not evidence that a process started. No expiry, retry or replay issues a second grant. */
export function grantDispatchLaunch(db: DatabaseSync, input: LaunchRequest): LaunchDecision {
  const claim = dispatchClaimSchema.parse(input.claim);
  const principal = verifiedPrincipalSchema.parse(input.principal); const now = counterSchema.parse(input.now);
  const identity = claim.request.identity;
  if (!principal.scopeIds.includes(identity.scopeId)) throw new DispatchError('DISPATCH_NOT_ADMITTED');
  const { run, dispatch } = readRunBoundDispatch(db, identity);
  if (!dispatch || dispatch.owner !== claim.owner || !sameSandboxRequest(dispatch.request, claim.request)) throw new DispatchError('DISPATCH_CONFLICT');
  if (dispatch.launch === 'granted') throw new DispatchError('DISPATCH_CONFLICT');
  if (dispatch.launch === 'prevented-before-launch') return Object.freeze({ kind: 'prevented', record: dispatch });
  const row = db.prepare('SELECT revision,snapshot FROM attempts WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
  if (!row) throw new DispatchError('DISPATCH_CORRUPT');
  let attempt;
  try { attempt = attemptSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new DispatchError('DISPATCH_CORRUPT'); }
  if (attempt.revision !== row.revision || !sameAttemptIdentity(attempt.identity, identity) || attempt.lastObservation !== null) throw new DispatchError('DISPATCH_CONFLICT');
  const cancelled = run.cancelRequested || attempt.cancelRequested || !!dispatch.cancellation;
  // Cancellation must carry durable actor evidence; never attribute an unknown issuer to the launcher.
  if (cancelled && !dispatch.cancellation) throw new DispatchError('DISPATCH_CORRUPT');
  const record = dispatchRecordSchema.parse(cancelled
    ? { ...dispatch, launch: 'prevented-before-launch', prevention: { reason: 'cancel-requested' } }
    : { ...dispatch, launch: 'granted', grant: { generation: identity.generation, grantedAt: now,
      principal: { id: principal.id, issuer: principal.issuer, subject: principal.subject } } });
  if (cancelled) {
    const projected = preventRunAttempt(run, run.revision, attempt);
    const changed = db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?')
      .run(projected.revision, JSON.stringify(projected), identity.scopeId, identity.runId, run.revision);
    if (changed.changes !== 1) throw new DispatchError('DISPATCH_CONFLICT');
  }
  db.prepare('UPDATE dispatches SET record=? WHERE scope_id=? AND attempt_id=?').run(JSON.stringify(record), identity.scopeId, identity.attemptId);
  return Object.freeze({ kind: cancelled ? 'prevented' : 'granted', record });
}
