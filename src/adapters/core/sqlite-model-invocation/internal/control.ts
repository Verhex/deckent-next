import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { parseModelInvocationControlRecord, parseModelInvocationCancellationReceipt,
  type ModelInvocationControlRecord } from '#domain/index.js';
import { ModelInvocationStoreError, type ModelInvocationRecord } from '#engine/index.js';

type ControlRow = Readonly<Record<string, unknown>>;
export const invocationControlSelect = `k.record AS control_record,k.scope_id AS control_scope_id,
  k.invocation_id AS control_invocation_id,k.send_state,a.record AS cancellation_record,
  a.scope_id AS cancellation_scope_id,a.command_id AS cancellation_command_id,a.invocation_id AS cancellation_invocation_id`;
export function decodeInvocationControl(row: ControlRow | undefined, record: ModelInvocationRecord): ModelInvocationControlRecord {
  try {
    const claim = record.receipt.claim;
    if (!row || typeof row.control_record !== 'string') throw new Error();
    const control = parseModelInvocationControlRecord(JSON.parse(row.control_record as string));
    if (row.control_scope_id !== claim.scopeId || row.control_invocation_id !== claim.invocationId || row.send_state !== control.send.state
      || !isDeepStrictEqual(control.claim, claim) || !isDeepStrictEqual(control.reference, record.receipt.request.reference)) throw new Error();
    if (control.cancellation) {
      if (typeof row.cancellation_record !== 'string' || row.cancellation_scope_id !== claim.scopeId
        || row.cancellation_invocation_id !== claim.invocationId || row.cancellation_command_id !== control.cancellation.command.commandId
        || !isDeepStrictEqual(parseModelInvocationCancellationReceipt(JSON.parse(row.cancellation_record)), control.cancellation)) throw new Error();
    } else if (row.cancellation_record !== null) throw new Error();
    const outcome = record.receipt.outcome;
    if (control.send.state === 'pending' && outcome !== null) throw new Error();
    if ((control.send.state === 'prevented') !== (outcome?.state === 'not-sent')) throw new Error();
    if (outcome?.state === 'not-sent' && (outcome.cancellationCommandId !== control.cancellation?.command.commandId
      || outcome.observedAtMs !== control.cancellation.requestedAtMs)) throw new Error();
    if (control.cancellation?.disposition === 'already-terminal' && outcome?.state !== 'responded' && outcome?.state !== 'rejected') throw new Error();
    return control;
  } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}

export function invocationControl(db: DatabaseSync, record: ModelInvocationRecord): ModelInvocationControlRecord {
  const claim = record.receipt.claim;
  const row = db.prepare(`SELECT ${invocationControlSelect} FROM model_invocation_controls k
    LEFT JOIN model_invocation_cancellations a ON a.scope_id=k.scope_id AND a.invocation_id=k.invocation_id
    WHERE k.scope_id=? AND k.invocation_id=?`).get(claim.scopeId, claim.invocationId);
  return decodeInvocationControl(row, record);
}

/** Transaction ownership belongs to the store. Exact prior JSON guards accidental stale updates. */
export function writeInvocationControl(db: DatabaseSync, before: ModelInvocationControlRecord, after: ModelInvocationControlRecord): void {
  const changed = db.prepare(`UPDATE model_invocation_controls SET send_state=?,record=?
    WHERE scope_id=? AND invocation_id=? AND send_state=? AND record=?`).run(after.send.state, JSON.stringify(after),
    before.claim.scopeId, before.claim.invocationId, before.send.state, JSON.stringify(before));
  if (changed.changes !== 1) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
}
