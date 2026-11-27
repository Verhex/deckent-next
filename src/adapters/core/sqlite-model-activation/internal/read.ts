import type { DatabaseSync } from 'node:sqlite';
import { identitySchema, ModelActivationError, parseModelActivationReference,
  type ModelActivationRecord, type ModelReference } from '#domain/index.js';
import { ModelActivationStoreError, verifyModelActivationRecord, verifyModelActivationReceipt } from '#engine/index.js';
import { sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';

type ActivationRow = Readonly<Record<string, unknown>>;
const encoded = (value: unknown): string => JSON.stringify(value);
export function activationIdentity(value: unknown): string {
  const parsed = identitySchema.safeParse(value);
  if (!parsed.success) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
  return parsed.data;
}
export function activationRecordRow(db: DatabaseSync, scopeId: string, reference: ModelReference): ActivationRow | undefined {
  return db.prepare(`SELECT scope_id,provider_id,provider_version,model_id,model_version,revision,record
    FROM model_activations WHERE scope_id=? AND provider_id=? AND provider_version=? AND model_id=? AND model_version=?`)
    .get(scopeId, reference.providerId, reference.providerVersion, reference.modelId, reference.modelVersion) as ActivationRow | undefined;
}
export function decodeActivationRecord(row: ActivationRow, scopeId: string, reference: ModelReference): ModelActivationRecord {
  try {
    if (typeof row['record'] !== 'string') throw new Error();
    const record = verifyModelActivationRecord(JSON.parse(row['record']));
    if (row['scope_id'] !== scopeId || row['provider_id'] !== reference.providerId || row['provider_version'] !== reference.providerVersion
      || row['model_id'] !== reference.modelId || row['model_version'] !== reference.modelVersion || row['revision'] !== record.revision
      || record.scopeId !== scopeId || encoded(record.reference) !== encoded(reference)) throw new Error();
    return record;
  } catch { throw new ModelActivationStoreError('MODEL_ACTIVATION_CORRUPT'); }
}
export function activationFailure(error: unknown): never {
  if (error instanceof ModelActivationStoreError || error instanceof ModelActivationError) throw error;
  const mapped = sqliteFailure(error);
  if (mapped && typeof mapped === 'object' && 'code' in mapped && mapped.code === 'ATTEMPT_STORE_BUSY') throw mapped;
  throw new ModelActivationStoreError('MODEL_ACTIVATION_UNAVAILABLE');
}
export function loadActivationRecord(db: DatabaseSync, scopeInput: unknown, referenceInput: unknown): ModelActivationRecord | null {
  try {
    const scopeId = activationIdentity(scopeInput), reference = parseModelActivationReference(referenceInput);
    const row = activationRecordRow(db, scopeId, reference);
    return row ? decodeActivationRecord(row, scopeId, reference) : null;
  } catch (error) { return activationFailure(error); }
}

export function loadActivationReceipt(db: DatabaseSync, scopeInput: string, commandInput: string) {
  try {
    const scopeId = activationIdentity(scopeInput), commandId = activationIdentity(commandInput);
    const row = db.prepare('SELECT scope_id,command_id,record FROM model_activation_receipts WHERE scope_id=? AND command_id=?')
      .get(scopeId, commandId) as ActivationRow | undefined;
    if (!row) return null;
    try {
      if (row['scope_id'] !== scopeId || row['command_id'] !== commandId || typeof row['record'] !== 'string') throw new Error();
      const receipt = verifyModelActivationReceipt(JSON.parse(row['record']));
      if (receipt.command.scopeId !== scopeId || receipt.command.commandId !== commandId) throw new Error();
      return receipt;
    } catch { throw new ModelActivationStoreError('MODEL_ACTIVATION_CORRUPT'); }
  } catch (error) { return activationFailure(error); }
}
