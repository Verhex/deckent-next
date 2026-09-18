import { counterSchema, preventRunAttempt, sameAttemptIdentity, verifiedPrincipalSchema,
  type AttemptSnapshot, type RunSnapshot } from '#domain/index.js';
import { sameSandboxRequest } from '#engine/core/supervisor/index.js';
import { dispatchClaimSchema, dispatchRecordSchema, DispatchError,
  type DispatchRecord, type LaunchDecision, type LaunchRequest } from './port.js';

export interface DispatchLaunchState {
  readonly run: RunSnapshot;
  readonly attempt: AttemptSnapshot | null;
  readonly dispatch: DispatchRecord;
}
export type DispatchLaunchTransition = Readonly<{ decision: LaunchDecision; projectedRun: RunSnapshot | null }>;

export function validateLaunchRequest(input: LaunchRequest): LaunchRequest {
  return Object.freeze({ claim: dispatchClaimSchema.parse(input.claim), principal: verifiedPrincipalSchema.parse(input.principal),
    now: counterSchema.parse(input.now) });
}

/** Pure launch authority. Persistence supplies one transactionally consistent state snapshot and
 * atomically writes the returned transition; adapters do not decide whether cancellation wins. */
export function decideDispatchLaunch(input: LaunchRequest, state: DispatchLaunchState): DispatchLaunchTransition {
  const { claim, principal, now } = validateLaunchRequest(input);
  const identity = claim.request.identity; const { run, attempt, dispatch } = state;
  if (!principal.scopeIds.includes(identity.scopeId)) throw new DispatchError('DISPATCH_NOT_ADMITTED');
  if (run.identity.runId !== identity.runId || run.identity.scopeId !== identity.scopeId || run.identity.layoutRevision !== identity.layoutRevision
    || !run.bindings.some(binding => sameAttemptIdentity(binding.identity, identity))) throw new DispatchError('DISPATCH_CONFLICT');
  if (dispatch.owner !== claim.owner || !sameSandboxRequest(dispatch.request, claim.request)) throw new DispatchError('DISPATCH_CONFLICT');
  if (dispatch.launch === 'granted') throw new DispatchError('DISPATCH_CONFLICT');
  if (dispatch.launch === 'prevented-before-launch') {
    return Object.freeze({ decision: Object.freeze({ kind: 'prevented', record: dispatch }), projectedRun: null });
  }
  if (!attempt) throw new DispatchError('DISPATCH_CORRUPT');
  if (!sameAttemptIdentity(attempt.identity, identity) || attempt.lastObservation !== null) throw new DispatchError('DISPATCH_CONFLICT');
  const cancelled = run.cancelRequested || attempt.cancelRequested || !!dispatch.cancellation;
  if (cancelled && !dispatch.cancellation) throw new DispatchError('DISPATCH_CORRUPT');
  if (cancelled && !attempt.cancelRequested) throw new DispatchError('DISPATCH_CORRUPT');
  const record = dispatchRecordSchema.parse(cancelled
    ? { ...dispatch, launch: 'prevented-before-launch', prevention: { reason: 'cancel-requested' } }
    : { ...dispatch, launch: 'granted', grant: { generation: identity.generation, grantedAt: now,
      principal: { id: principal.id, issuer: principal.issuer, subject: principal.subject } } });
  const decision = Object.freeze({ kind: cancelled ? 'prevented' as const : 'granted' as const, record });
  return Object.freeze({ decision, projectedRun: cancelled ? preventRunAttempt(run, run.revision, attempt) : null });
}
