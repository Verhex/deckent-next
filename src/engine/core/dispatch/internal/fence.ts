import { attemptSnapshotSchema, sameAttemptIdentity, auditRecordSchema } from '#domain/index.js';
import { DispatchError, type DispatchRecord } from './port.js';
import { dispatchFenceReceiptId } from './loss.js';
import { lostDispatchWriteSchema, assertLostDispatchAudit } from './fence-write.js';
/** Receipt content and persisted audit establish the fence; its deterministic key alone never does. */
export function assertDispatchFenceCommand(record: DispatchRecord, command: unknown) {
  let payload;
  try { payload = JSON.parse(String(command)); } catch { throw new DispatchError('DISPATCH_CORRUPT'); }
  if (payload?.operation !== 'fence-lost-dispatch') throw new DispatchError('DISPATCH_FENCE_CONFLICT');
  delete payload.operation;
  const parsed = lostDispatchWriteSchema.safeParse({ ...payload, now: 0 });
  if (!parsed.success || parsed.data.owner !== record.owner || !sameAttemptIdentity(parsed.data.identity, record.request.identity)) throw new DispatchError('DISPATCH_FENCE_CONFLICT');
  return parsed.data;
}
export function assertDispatchFenceReceipt(record: DispatchRecord, row: { command?: unknown; snapshot?: unknown }, audit: unknown) {
  const write = assertDispatchFenceCommand(record, row.command), receiptId = dispatchFenceReceiptId(write.identity, write.owner);
  let snapshot, sealed;
  try { snapshot = attemptSnapshotSchema.parse(JSON.parse(String(row.snapshot))); sealed = auditRecordSchema.parse(JSON.parse(String(audit))); }
  catch { throw new DispatchError('DISPATCH_CORRUPT'); }
  if (!sameAttemptIdentity(snapshot.identity, write.identity) || snapshot.revision !== write.expectedAttemptRevision + 1
    || snapshot.lastObservation?.eventId !== receiptId || snapshot.lastObservation.result.kind !== 'unknown'
    || snapshot.lastObservation.result.reasonCode !== write.reasonCode) throw new DispatchError('DISPATCH_CORRUPT');
  assertLostDispatchAudit(sealed, { revision: write.expectedRunRevision + 1 }, String(row.command), { ...write, now: sealed.event.atMs });
  return { write, snapshot, receiptId };
}
export function assertDispatchNotFenced(record: DispatchRecord, row: { command?: unknown; snapshot?: unknown }, audit: unknown): never {
  assertDispatchFenceReceipt(record, row, audit);
  throw new DispatchError('DISPATCH_FENCED');
}
