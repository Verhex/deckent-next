import type { DatabaseSync } from 'node:sqlite';
import { identitySchema } from '#domain/index.js';
import { ModelActivationError, parseModelActivationReference, transitionModelActivation,
  type ModelActivationReceipt, type ModelActivationRecord } from '#domain/index.js';
import type { ModelReference } from '#domain/index.js';
import { ModelActivationStoreError, parseModelActivationAdmission, sameModelActivationRequest,
  verifyModelActivationReceipt, verifyModelActivationRecord, type ModelActivationAdmission,
  type ModelActivationResult, type ModelActivationStore } from '#engine/index.js';
import { sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';

type Row = Readonly<Record<string, unknown>>;
const unavailable = (): never => { throw new ModelActivationStoreError('MODEL_ACTIVATION_UNAVAILABLE'); };
function encoded(value: unknown): string { return JSON.stringify(value); }
function identity(value: unknown): string {
  const parsed = identitySchema.safeParse(value);
  if (!parsed.success) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
  return parsed.data;
}

export class SqliteModelActivationStore implements ModelActivationStore {
  constructor(private readonly db: DatabaseSync) {}

  private receiptRow(scopeId: string, commandId: string): Row | undefined {
    return this.db.prepare('SELECT scope_id,command_id,record FROM model_activation_receipts WHERE scope_id=? AND command_id=?')
      .get(scopeId, commandId) as Row | undefined;
  }
  private recordRow(scopeId: string, reference: ModelReference): Row | undefined {
    return this.db.prepare(`SELECT scope_id,provider_id,provider_version,model_id,model_version,revision,record
      FROM model_activations WHERE scope_id=? AND provider_id=? AND provider_version=? AND model_id=? AND model_version=?`)
      .get(scopeId, reference.providerId, reference.providerVersion, reference.modelId, reference.modelVersion) as Row | undefined;
  }
  private decodeReceipt(row: Row, scopeId: string, commandId: string): ModelActivationReceipt {
    try {
      if (row['scope_id'] !== scopeId || row['command_id'] !== commandId || typeof row['record'] !== 'string') throw new Error();
      const receipt = verifyModelActivationReceipt(JSON.parse(row['record']));
      if (receipt.command.scopeId !== scopeId || receipt.command.commandId !== commandId) throw new Error();
      return receipt;
    } catch { throw new ModelActivationStoreError('MODEL_ACTIVATION_CORRUPT'); }
  }
  private decodeRecord(row: Row, scopeId: string, reference: ModelReference): ModelActivationRecord {
    try {
      if (typeof row['record'] !== 'string') throw new Error();
      const record = verifyModelActivationRecord(JSON.parse(row['record']));
      if (row['scope_id'] !== scopeId || row['provider_id'] !== reference.providerId || row['provider_version'] !== reference.providerVersion
        || row['model_id'] !== reference.modelId || row['model_version'] !== reference.modelVersion || row['revision'] !== record.revision
        || record.scopeId !== scopeId || encoded(record.reference) !== encoded(reference)) throw new Error();
      return record;
    } catch { throw new ModelActivationStoreError('MODEL_ACTIVATION_CORRUPT'); }
  }
  async loadReceipt(scopeInput: string, commandInput: string): Promise<ModelActivationReceipt | null> {
    try {
      const scopeId = identity(scopeInput), commandId = identity(commandInput);
      const row = this.receiptRow(scopeId, commandId); return row ? this.decodeReceipt(row, scopeId, commandId) : null;
    } catch (error) { return this.failure(error); }
  }
  async loadRecord(scopeInput: string, referenceInput: ModelReference): Promise<ModelActivationRecord | null> {
    try {
      const scopeId = identity(scopeInput), reference = parseModelActivationReference(referenceInput);
      const row = this.recordRow(scopeId, reference); return row ? this.decodeRecord(row, scopeId, reference) : null;
    } catch (error) { return this.failure(error); }
  }
  async admit(input: ModelActivationAdmission): Promise<ModelActivationResult> {
    let active = false;
    try {
      const admission = parseModelActivationAdmission(input), { command, actor } = admission;
      this.db.exec('BEGIN IMMEDIATE'); active = true;
      const priorReceipt = this.receiptRow(command.scopeId, command.commandId);
      if (priorReceipt) {
        const receipt = this.decodeReceipt(priorReceipt, command.scopeId, command.commandId);
        if (!sameModelActivationRequest(receipt, command, actor)) throw new ModelActivationStoreError('MODEL_ACTIVATION_COMMAND_CONFLICT');
        this.db.exec('COMMIT'); active = false; return Object.freeze({ replayed: true, receipt });
      }
      const row = this.recordRow(command.scopeId, command.reference);
      const current = row ? this.decodeRecord(row, command.scopeId, command.reference) : null;
      const record = transitionModelActivation(current, command, admission.definition);
      const receipt = verifyModelActivationReceipt({ schemaVersion: 1, command, actor, authorization: admission.authorization,
        previousRevision: current?.revision ?? null, record, admittedAtMs: admission.admittedAtMs });
      if (current) {
        const updated = this.db.prepare(`UPDATE model_activations SET revision=?,record=? WHERE scope_id=? AND provider_id=?
          AND provider_version=? AND model_id=? AND model_version=? AND revision=?`).run(record.revision, encoded(record), command.scopeId,
          command.reference.providerId, command.reference.providerVersion, command.reference.modelId, command.reference.modelVersion, current.revision);
        if (updated.changes !== 1) throw new ModelActivationStoreError('MODEL_ACTIVATION_COMMAND_CONFLICT');
      } else {
        this.db.prepare(`INSERT INTO model_activations(scope_id,provider_id,provider_version,model_id,model_version,revision,record)
          VALUES(?,?,?,?,?,?,?)`).run(command.scopeId, command.reference.providerId,
          command.reference.providerVersion, command.reference.modelId, command.reference.modelVersion, record.revision, encoded(record));
      }
      this.db.prepare('INSERT INTO model_activation_receipts(scope_id,command_id,record) VALUES(?,?,?)')
        .run(command.scopeId, command.commandId, encoded(receipt));
      this.db.exec('COMMIT'); active = false;
      return Object.freeze({ replayed: false, receipt });
    } catch (error) {
      if (active) {
        try { this.db.exec('ROLLBACK'); active = false; }
        catch { throw new ModelActivationStoreError('MODEL_ACTIVATION_OUTCOME_UNKNOWN'); }
      }
      return this.failure(error);
    }
  }
  private failure(error: unknown): never {
    if (error instanceof ModelActivationStoreError || error instanceof ModelActivationError) throw error;
    const mapped = sqliteFailure(error);
    if (mapped && typeof mapped === 'object' && 'code' in mapped && mapped.code === 'ATTEMPT_STORE_BUSY') throw mapped;
    return unavailable();
  }
  close(): void { this.db.close(); }
}
