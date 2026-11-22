import { readInvocationPlanUsage } from './plan-usage.js';
import { ledgerTransaction, MODEL_INVOCATION_LEDGER_VERSION, requireLedgerVersion } from '#adapters/core/sqlite-ledger/index.js';
import { decodeInvocationControl, invocationControlSelect } from './control.js';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { identitySchema, type ModelInvocationReceipt } from '#domain/index.js';
import { ModelInvocationStoreError, verifyModelInvocationReceipt, verifyModelInvocationRecord, type ModelInvocationRecord } from '#engine/index.js';

type InvocationRow = Readonly<Record<string, unknown>>;
export function invocationIdentity(input: unknown): string {
  const parsed = identitySchema.safeParse(input);
  if (!parsed.success) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  return parsed.data;
}
function decodeInvocationReceipt(row: InvocationRow, scopeId: string, id: string, key: 'command_id' | 'invocation_id') {
  if (row['scope_id'] !== scopeId || row[key] !== id || typeof row['record'] !== 'string') throw new Error();
  const receipt = verifyModelInvocationReceipt(JSON.parse(row['record']));
  if (receipt.request.scopeId !== scopeId || (key === 'command_id' ? receipt.request.commandId : receipt.claim.invocationId) !== id) throw new Error();
  if (row['command_id'] !== receipt.request.commandId || row['invocation_id'] !== receipt.claim.invocationId) throw new Error();
  const state = receipt.outcome?.state ?? 'claimed';
  if (row['allocation_id'] !== receipt.profile.allocation.id || row['state'] !== state) throw new Error();
  return receipt;
}
export function decodeInvocationRecord(row: InvocationRow | undefined, scopeId: string, id: string,
  key: 'command_id' | 'invocation_id'): ModelInvocationRecord | null {
  if (!row) return null;
  try {
    const receipt = decodeInvocationReceipt(row, scopeId, id, key);
    const raw = row['content_record'];
    if (raw !== null && typeof raw !== 'string') throw new Error();
    const content = raw === null ? null : JSON.parse(raw as string);
    const purgeValue = row['purge_record'], purgeCommandId = row['purge_command_id'];
    if (purgeValue !== null && typeof purgeValue !== 'string') throw new Error();
    const purge = purgeValue === null ? null : JSON.parse(purgeValue as string);
    if ((purgeCommandId !== null) !== (purge !== null)) throw new Error();
    if (purge && (row['purge_scope_id'] !== scopeId || row['purge_invocation_id'] !== receipt.claim.invocationId
      || row['purge_id'] !== purgeCommandId || purge.command.commandId !== purgeCommandId)) throw new Error();
    const record = verifyModelInvocationRecord({ receipt, content, purge });
    decodeInvocationControl(row, record);
    return record;
  } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}
const invocationColumns = 'i.scope_id,i.command_id,i.invocation_id,i.allocation_id,i.state,i.record';
const invocationJoins = `FROM model_invocations i LEFT JOIN model_invocation_contents c
    ON c.scope_id=i.scope_id AND c.invocation_id=i.invocation_id`;
/** One invocation row with every joined record the decoder verifies (content, purge, control, cancellation). */
const invocationRowSelect = `SELECT ${invocationColumns},c.record AS content_record,
      c.purge_command_id,p.record AS purge_record,p.scope_id AS purge_scope_id,
      p.command_id AS purge_id,p.invocation_id AS purge_invocation_id,${invocationControlSelect}
    ${invocationJoins}
    LEFT JOIN model_invocation_content_purges p ON p.scope_id=c.scope_id AND p.command_id=c.purge_command_id
    LEFT JOIN model_invocation_controls k ON k.scope_id=i.scope_id AND k.invocation_id=i.invocation_id
    LEFT JOIN model_invocation_cancellations a ON a.scope_id=i.scope_id AND a.invocation_id=i.invocation_id`;
export function invocationRow(db: DatabaseSync, scopeId: string, invocationId: string): InvocationRow | undefined {
  return db.prepare(`${invocationRowSelect} WHERE i.scope_id=? AND i.invocation_id=?`).get(scopeId, invocationId) as InvocationRow | undefined;
}
export function invocationCommandRow(db: DatabaseSync, scopeId: string, commandId: string): InvocationRow | undefined {
  return db.prepare(`${invocationRowSelect} WHERE i.scope_id=? AND i.command_id=?`).get(scopeId, commandId) as InvocationRow | undefined;
}
/** Visits every retained invocation of one allocation, each decoded and verified (Astra 2143 R1: repair trusts no bare column). */
export function visitAllocationInvocations(db: DatabaseSync, scopeId: string, allocationId: string,
  visit: (record: ModelInvocationRecord) => void): void {
  for (const row of db.prepare(`${invocationRowSelect} WHERE i.scope_id=? AND i.allocation_id=?`).iterate(scopeId, allocationId)) {
    visit(decodeInvocationRecord(row as InvocationRow, scopeId, invocationIdentity(row['invocation_id']), 'invocation_id')!);
  }
}
/** A receipt and its additive usage record must come from one snapshot, including during concurrent settlement/purge. */
function readSnapshot<T>(db: DatabaseSync, read: () => T, join = true): T {
  return ledgerTransaction(db, read, { mode: 'read', join,
    unknown: () => new ModelInvocationStoreError('MODEL_INVOCATION_OUTCOME_UNKNOWN'), failure: error => error });
}
/** Metadata match shared by the precheck and the final snapshot. Only the presence of the body is evaluated here. */
export function matchesRetainedResponse(db: DatabaseSync, expected: ModelInvocationReceipt): boolean {
  const { scopeId, invocationId } = expected.claim;
  const row = db.prepare(`SELECT ${invocationColumns} ${invocationJoins}
    WHERE i.scope_id=? AND i.invocation_id=? AND i.state='responded'
    AND c.record IS NOT NULL AND c.purge_command_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM model_invocation_content_purges p
      WHERE p.scope_id=i.scope_id AND p.invocation_id=i.invocation_id)`).get(scopeId, invocationId);
  if (!row) return false;
  try { return isDeepStrictEqual(decodeInvocationReceipt(row, scopeId, invocationId, 'invocation_id'), expected); }
  catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}
export function readMatchedResponse(db: DatabaseSync, expected: ModelInvocationReceipt, isCurrent: () => boolean): ModelInvocationRecord | null {
  const { scopeId, invocationId } = expected.claim;
  // A fresh snapshot orders the read against purge. The final custody check and the single body SELECT are synchronous.
  return readSnapshot(db, () => {
    if (!matchesRetainedResponse(db, expected) || !isCurrent()) return null;
    const record = decodeInvocationRecord(invocationRow(db, scopeId, invocationId), scopeId, invocationId, 'invocation_id');
    if (record) readInvocationPlanUsage(db, requireLedgerVersion(db, MODEL_INVOCATION_LEDGER_VERSION), record);
    return record;
  }, false);
}
export function loadInvocationRecord(db: DatabaseSync, scopeInput: unknown, invocationInput: unknown): ModelInvocationRecord | null {
  return readSnapshot(db, () => {
    const scopeId = invocationIdentity(scopeInput), invocationId = invocationIdentity(invocationInput);
    const record = decodeInvocationRecord(invocationRow(db, scopeId, invocationId), scopeId, invocationId, 'invocation_id');
    if (record && record.receipt.profile.schemaVersion !== 1) readInvocationPlanUsage(db, requireLedgerVersion(db, MODEL_INVOCATION_LEDGER_VERSION), record);
    return record;
  });
}
export function loadInvocationCommandRecord(db: DatabaseSync, scopeInput: string, commandInput: string): ModelInvocationRecord | null {
  return readSnapshot(db, () => {
    const scopeId = invocationIdentity(scopeInput), commandId = invocationIdentity(commandInput);
    const record = decodeInvocationRecord(invocationCommandRow(db, scopeId, commandId), scopeId, commandId, 'command_id');
    if (record && record.receipt.profile.schemaVersion !== 1) readInvocationPlanUsage(db, requireLedgerVersion(db, MODEL_INVOCATION_LEDGER_VERSION), record);
    return record;
  });
}
