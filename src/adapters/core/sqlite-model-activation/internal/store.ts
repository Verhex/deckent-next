import type { DatabaseSync } from 'node:sqlite';
import { ModelActivationError, transitionModelActivation,
  type ModelActivationRecord, type ModelReference } from '#domain/index.js';
import { ModelActivationStoreError, parseModelActivationAdmission, sameModelActivationRequest,
  verifyModelActivationReceipt, type ModelActivationAdmission,
  type ModelActivationResult, type ModelActivationStore } from '#engine/index.js';
import { ledgerTransaction, sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';
import { activationRecordRow, decodeActivationRecord, loadActivationRecord, loadActivationReceipt } from './read.js';

const unavailable = (): never => { throw new ModelActivationStoreError('MODEL_ACTIVATION_UNAVAILABLE'); };
function encoded(value: unknown): string { return JSON.stringify(value); }

export class SqliteModelActivationStore implements ModelActivationStore {
  constructor(private readonly db: DatabaseSync) {}

  async loadReceipt(scopeId: string, commandId: string) { return loadActivationReceipt(this.db, scopeId, commandId); }
  async loadRecord(scopeInput: string, referenceInput: ModelReference): Promise<ModelActivationRecord | null> {
    try {
      return loadActivationRecord(this.db, scopeInput, referenceInput);
    } catch (error) { return this.failure(error); }
  }
  async admit(input: ModelActivationAdmission): Promise<ModelActivationResult> {
    try {
      const admission = parseModelActivationAdmission(input), { command, actor } = admission;
      return ledgerTransaction(this.db, () => {
        const prior = loadActivationReceipt(this.db, command.scopeId, command.commandId);
        if (prior) {
          if (!sameModelActivationRequest(prior, command, actor)) throw new ModelActivationStoreError('MODEL_ACTIVATION_COMMAND_CONFLICT');
          return Object.freeze({ replayed: true, receipt: prior });
        }
        const row = activationRecordRow(this.db, command.scopeId, command.reference);
        const current = row ? decodeActivationRecord(row, command.scopeId, command.reference) : null;
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
        return Object.freeze({ replayed: false, receipt });
      }, { unknown: () => new ModelActivationStoreError('MODEL_ACTIVATION_OUTCOME_UNKNOWN'), failure: error => this.failure(error) });
    } catch (error) { return this.failure(error); }
  }
  private failure(error: unknown): never {
    if (error instanceof ModelActivationStoreError || error instanceof ModelActivationError) throw error;
    const mapped = sqliteFailure(error);
    if (mapped && typeof mapped === 'object' && 'code' in mapped && mapped.code === 'ATTEMPT_STORE_BUSY') throw mapped;
    return unavailable();
  }
  close(): void { this.db.close(); }
}
