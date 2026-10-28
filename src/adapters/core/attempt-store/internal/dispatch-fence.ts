import type { DatabaseSync } from 'node:sqlite';
import { assertDispatchFenceCommand, assertDispatchFenceReceipt, assertLostDispatchReplay, DispatchError, type DispatchRecord, dispatchFenceReceiptId } from '#engine/index.js';
import { runSnapshotSchema } from '#domain/index.js';
/** Every reader verifies both immutable journals and the persisted audit under its transaction. */
export function readDispatchFence(db: DatabaseSync, record: DispatchRecord) {
  const scopeId = record.request.identity.scopeId, commandId = dispatchFenceReceiptId(record.request.identity, record.owner);
  const joined = db.prepare('SELECT r.command AS rc,r.snapshot AS rs,a.command AS ac,a.snapshot AS ats,e.record AS audit FROM (SELECT ? AS s,? AS c) q LEFT JOIN run_receipts r ON r.scope_id=q.s AND r.command_id=q.c LEFT JOIN attempt_receipts a ON a.scope_id=q.s AND a.command_id=q.c LEFT JOIN audit_events e ON e.scope_id=q.s AND e.event_id=q.c').get(scopeId, commandId)!;
  const run = joined.rc === null ? undefined : { command: joined.rc, snapshot: joined.rs };
  const attempt = joined.ac === null ? undefined : { command: joined.ac, snapshot: joined.ats };
  if (!run && !attempt) return null;
  for (const row of [run, attempt]) if (row) assertDispatchFenceCommand(record, row.command);
  if (!run || !attempt || run.command !== attempt.command) throw new DispatchError('DISPATCH_CORRUPT');
  const fence = assertDispatchFenceReceipt(record, attempt, joined.audit);
  let snapshot;
  try { snapshot = runSnapshotSchema.parse(JSON.parse(String(run.snapshot))); } catch { throw new DispatchError('DISPATCH_CORRUPT'); }
  if (snapshot.identity.scopeId !== scopeId || snapshot.identity.runId !== record.request.identity.runId) throw new DispatchError('DISPATCH_FENCE_CONFLICT');
  const receipt = { commandId, command: String(run.command), snapshot };
  assertLostDispatchReplay(attempt, receipt, fence.write);
  return { ...fence, receipt };
}
