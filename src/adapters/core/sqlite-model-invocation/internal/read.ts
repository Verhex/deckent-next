import type { DatabaseSync } from 'node:sqlite';
import { identitySchema } from '#domain/index.js';
import { ModelInvocationStoreError, verifyModelInvocationReceipt, verifyModelInvocationRecord, type ModelInvocationRecord } from '#engine/index.js';

export type InvocationRow = Readonly<Record<string, unknown>>;
export function invocationIdentity(input: unknown): string {
  const parsed = identitySchema.safeParse(input);
  if (!parsed.success) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  return parsed.data;
}
export function decodeInvocationRecord(row: InvocationRow | undefined, scopeId: string, id: string,
  key: 'command_id' | 'invocation_id'): ModelInvocationRecord | null {
  if (!row) return null;
  try {
    if (row['scope_id'] !== scopeId || row[key] !== id || typeof row['record'] !== 'string') throw new Error();
    const receipt = verifyModelInvocationReceipt(JSON.parse(row['record']));
    if (receipt.request.scopeId !== scopeId || (key === 'command_id' ? receipt.request.commandId : receipt.claim.invocationId) !== id) throw new Error();
    if (row['command_id'] !== receipt.request.commandId || row['invocation_id'] !== receipt.claim.invocationId) throw new Error();
    const state = receipt.outcome?.state ?? 'claimed';
    if (row['allocation_id'] !== receipt.profile.allocation.id || row['state'] !== state) throw new Error();
    const raw = row['content_record'];
    if (raw !== null && typeof raw !== 'string') throw new Error();
    const content = raw === null ? null : JSON.parse(raw as string);
    return verifyModelInvocationRecord({ receipt, content });
  } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}
export function invocationRow(db: DatabaseSync, scopeId: string, invocationId: string): InvocationRow | undefined {
  return db.prepare(`SELECT i.scope_id,i.command_id,i.invocation_id,i.allocation_id,i.state,i.record,c.record AS content_record
    FROM model_invocations i LEFT JOIN model_invocation_contents c
    ON c.scope_id=i.scope_id AND c.invocation_id=i.invocation_id
    WHERE i.scope_id=? AND i.invocation_id=?`)
    .get(scopeId, invocationId) as InvocationRow | undefined;
}
export function invocationCommandRow(db: DatabaseSync, scopeId: string, commandId: string): InvocationRow | undefined {
  return db.prepare(`SELECT i.scope_id,i.command_id,i.invocation_id,i.allocation_id,i.state,i.record,c.record AS content_record
    FROM model_invocations i LEFT JOIN model_invocation_contents c
    ON c.scope_id=i.scope_id AND c.invocation_id=i.invocation_id
    WHERE i.scope_id=? AND i.command_id=?`)
    .get(scopeId, commandId) as InvocationRow | undefined;
}
export function loadInvocationRecord(db: DatabaseSync, scopeInput: unknown, invocationInput: unknown): ModelInvocationRecord | null {
  const scopeId = invocationIdentity(scopeInput), invocationId = invocationIdentity(invocationInput);
  return decodeInvocationRecord(invocationRow(db, scopeId, invocationId), scopeId, invocationId, 'invocation_id');
}
