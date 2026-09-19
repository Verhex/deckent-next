import type { DatabaseSync } from 'node:sqlite';
import { identitySchema, type ModelInvocationReceipt } from '#domain/index.js';
import { ModelInvocationStoreError, verifyModelInvocationReceipt } from '#engine/index.js';

export type InvocationRow = Readonly<Record<string, unknown>>;
export function invocationIdentity(input: unknown): string {
  const parsed = identitySchema.safeParse(input);
  if (!parsed.success) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  return parsed.data;
}
export function decodeInvocationReceipt(row: InvocationRow | undefined, scopeId: string, id: string,
  key: 'command_id' | 'invocation_id'): ModelInvocationReceipt | null {
  if (!row) return null;
  try {
    if (row['scope_id'] !== scopeId || row[key] !== id || typeof row['record'] !== 'string') throw new Error();
    const receipt = verifyModelInvocationReceipt(JSON.parse(row['record']));
    if (receipt.request.scopeId !== scopeId || (key === 'command_id' ? receipt.request.commandId : receipt.claim.invocationId) !== id) throw new Error();
    if (row['command_id'] !== receipt.request.commandId || row['invocation_id'] !== receipt.claim.invocationId) throw new Error();
    const state = receipt.outcome?.state ?? 'claimed';
    if (row['allocation_id'] !== receipt.profile.allocation.id || row['state'] !== state) throw new Error();
    return receipt;
  } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}
export function invocationRow(db: DatabaseSync, scopeId: string, invocationId: string): InvocationRow | undefined {
  return db.prepare(`SELECT scope_id,command_id,invocation_id,allocation_id,state,record FROM model_invocations
    WHERE scope_id=? AND invocation_id=?`)
    .get(scopeId, invocationId) as InvocationRow | undefined;
}
export function invocationCommandRow(db: DatabaseSync, scopeId: string, commandId: string): InvocationRow | undefined {
  return db.prepare(`SELECT scope_id,command_id,invocation_id,allocation_id,state,record FROM model_invocations
    WHERE scope_id=? AND command_id=?`)
    .get(scopeId, commandId) as InvocationRow | undefined;
}
export function loadInvocationReceipt(db: DatabaseSync, scopeInput: unknown, invocationInput: unknown): ModelInvocationReceipt | null {
  const scopeId = invocationIdentity(scopeInput), invocationId = invocationIdentity(invocationInput);
  return decodeInvocationReceipt(invocationRow(db, scopeId, invocationId), scopeId, invocationId, 'invocation_id');
}
