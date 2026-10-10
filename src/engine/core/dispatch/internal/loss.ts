import { createHash } from 'node:crypto';
import { attemptIdentitySchema, identitySchema, attemptSnapshotSchema, sameAttemptIdentity, decideDispatchLoss, type AttemptIdentity, type AttemptSnapshot,
  type DispatchFence, type DispatchTerminationProof, type WorkerIncarnation, type LostDispatchAction } from '#domain/index.js';
import { dispatchRecordSchema, DispatchError, type DispatchRecord } from './port.js';

/** Stable key for reusing the existing immutable Attempt receipt journal. No receipt is written here. */
export function dispatchFenceReceiptId(identity: AttemptIdentity, owner: string): string {
  const token = { identity: attemptIdentitySchema.parse(identity), owner: identitySchema.parse(owner) };
  return 'dispatch-fence-' + createHash('sha256').update(JSON.stringify(token)).digest('hex');
}

/** Bind the pure assessment to authoritative dispatch/Attempt data. Trusted custody supplies
 * the fence receipt and worker incarnation. This assessment performs no store mutation. */
export function assessLostDispatch(recordInput: DispatchRecord, attemptInput: AttemptSnapshot,
  worker: WorkerIncarnation | null, fence: DispatchFence | null, proof: DispatchTerminationProof | null,
  action: LostDispatchAction = 'release-slot') {
  const record = dispatchRecordSchema.parse(recordInput), attempt = attemptSnapshotSchema.parse(attemptInput);
  if (!sameAttemptIdentity(record.request.identity, attempt.identity)) throw new DispatchError('DISPATCH_CONFLICT');
  return decideDispatchLoss({ identity: attempt.identity, owner: record.owner, launch: record.launch,
    lost: attempt.lastObservation?.result.kind === 'unknown', worker }, fence, proof, action);
}
