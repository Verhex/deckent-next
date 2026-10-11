import { attemptSnapshotSchema, sameAttemptIdentity, type LostDispatchAction } from '#domain/index.js';
import { assessLostDispatch, dispatchFenceReceiptId } from './loss.js';
import { DispatchError, type DispatchRecord } from './port.js';

/** Called with an immutable receipt snapshot read inside the writer's transaction.
 * Validating a receipt does not install a fence, settle an effect or release capacity. */
export function assertDispatchNotFenced(record: DispatchRecord, encodedSnapshot: unknown, action: Exclude<LostDispatchAction, 'release-slot'>): void {
  let snapshot;
  try { snapshot = attemptSnapshotSchema.parse(JSON.parse(String(encodedSnapshot))); }
  catch { throw new DispatchError('DISPATCH_CORRUPT'); }
  const identity = record.request.identity, receiptId = dispatchFenceReceiptId(identity, record.owner);
  if (!sameAttemptIdentity(snapshot.identity, identity) || snapshot.lastObservation?.eventId !== receiptId
    || snapshot.lastObservation.result.kind !== 'unknown') throw new DispatchError('DISPATCH_CORRUPT');
  const decision = assessLostDispatch(record, snapshot, null, { identity, owner: record.owner, receiptId }, null, action);
  if (decision.kind !== 'reject-late-write') throw new DispatchError('DISPATCH_CORRUPT');
  throw new DispatchError(decision.code);
}
