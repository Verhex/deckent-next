import type { DatabaseSync } from 'node:sqlite';
import { ModelCatalogError, identitySchema, parseModelCatalogActivationRecord, parseModelCatalogChannelRecord, parseModelCatalogModelRecord,
  parseModelCatalogReceipt, planModelCatalogRegistration, transitionModelCatalogActivation, exactModelIdSchema,
  type ModelCatalogActivationRecord, type ModelCatalogChannelRecord, type ModelCatalogChange, type ModelCatalogModelRecord,
  type ModelCatalogReceipt } from '#domain/index.js';
import { sameModelCatalogRequest, type ModelCatalogAdmission, type ModelCatalogReader, type ModelCatalogResult,
  type ModelCatalogStore } from '#engine/index.js';
import { sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';

type Row = Readonly<Record<string, unknown>>;
const CHANNEL_ROW = ''; // SQLite keys cannot hold NULL: the channel-level activation row uses the empty model id.
const corrupt = (): never => { throw new ModelCatalogError('MODEL_CATALOG_CORRUPT'); };
function decode<T>(row: Row | undefined, parse: (value: unknown) => T, matches: (value: T) => boolean): T | null {
  if (!row) return null;
  try {
    if (typeof row['record'] !== 'string') return corrupt();
    const value = parse(JSON.parse(row['record']));
    return matches(value) ? value : corrupt();
  } catch { return corrupt(); }
}
function failure(error: unknown): never {
  if (error instanceof ModelCatalogError) throw error;
  const mapped = sqliteFailure(error);
  if (mapped && typeof mapped === 'object' && 'code' in mapped && mapped.code === 'ATTEMPT_STORE_BUSY') throw mapped;
  throw new ModelCatalogError('MODEL_CATALOG_UNAVAILABLE');
}
const id = (value: unknown) => { const parsed = identitySchema.safeParse(value); return parsed.success ? parsed.data : failure(new ModelCatalogError('MODEL_CATALOG_INVALID')); };
const modelKey = (value: unknown) => { const parsed = exactModelIdSchema.safeParse(value); return parsed.success ? parsed.data : failure(new ModelCatalogError('MODEL_CATALOG_INVALID')); };

/** Row access shared by the writer and the admission reader; every row is verified against its key columns. */
class CatalogRows {
  constructor(protected readonly db: DatabaseSync) {}
  channelRow(channelId: string): ModelCatalogChannelRecord | null {
    const row = this.db.prepare('SELECT channel_id,revision,record FROM model_catalog_channels WHERE channel_id=?').get(channelId) as Row | undefined;
    return decode(row, parseModelCatalogChannelRecord, value => value.channelId === row!['channel_id'] && value.revision === row!['revision']);
  }
  modelRows(channelId: string): ModelCatalogModelRecord[] {
    const rows = this.db.prepare('SELECT channel_id,model_id,revision,lifecycle,record FROM model_catalog_models WHERE channel_id=? ORDER BY model_id').all(channelId) as Row[];
    return rows.map(row => decode(row, parseModelCatalogModelRecord, value => value.channelId === row['channel_id'] && value.modelId === row['model_id']
      && value.revision === row['revision'] && value.model.lifecycle.state === row['lifecycle'])!);
  }
  activationRow(scopeId: string, channelId: string, modelId: string | null): ModelCatalogActivationRecord | null {
    const row = this.db.prepare(`SELECT scope_id,channel_id,model_id,revision,state,record FROM model_catalog_activations
      WHERE scope_id=? AND channel_id=? AND model_id=?`).get(scopeId, channelId, modelId ?? CHANNEL_ROW) as Row | undefined;
    return decode(row, parseModelCatalogActivationRecord, value => value.scopeId === scopeId && value.channelId === channelId
      && value.modelId === modelId && value.revision === row!['revision'] && value.state === row!['state']);
  }
}

export class SqliteModelCatalogReader extends CatalogRows implements ModelCatalogReader {
  async channel(channelId: string) { try { return this.channelRow(id(channelId)); } catch (error) { return failure(error); } }
  async models(channelId: string) { try { return Object.freeze(this.modelRows(id(channelId))); } catch (error) { return failure(error); } }
  async activation(scopeId: string, channelId: string, modelId: string | null) {
    try { return this.activationRow(id(scopeId), id(channelId), modelId === null ? null : modelKey(modelId)); } catch (error) { return failure(error); }
  }
  close(): void { this.db.close(); }
}

export class SqliteModelCatalogStore extends CatalogRows implements ModelCatalogStore {
  private receipt(scopeId: string, commandId: string): ModelCatalogReceipt | null {
    const row = this.db.prepare('SELECT record FROM model_catalog_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId) as Row | undefined;
    return decode(row, parseModelCatalogReceipt, value => value.command.scopeId === scopeId && value.command.commandId === commandId);
  }
  async apply(admission: ModelCatalogAdmission): Promise<ModelCatalogResult> {
    let active = false;
    try {
      const { command, actor } = admission;
      this.db.exec('BEGIN IMMEDIATE'); active = true;
      const prior = this.receipt(command.scopeId, command.commandId);
      if (prior) {
        if (!sameModelCatalogRequest(prior, command, actor)) throw new ModelCatalogError('MODEL_CATALOG_COMMAND_CONFLICT');
        this.db.exec('COMMIT'); active = false; return Object.freeze({ replayed: true, receipt: prior });
      }
      const changes: ModelCatalogChange[] = [];
      if (command.action === 'register') {
        const plan = planModelCatalogRegistration(command, { channel: channelId => this.channelRow(channelId),
          model: (channelId, modelId) => this.modelRows(channelId).find(entry => entry.modelId === modelId) ?? null });
        for (const record of plan.channels) {
          const written = this.db.prepare(`INSERT INTO model_catalog_channels(channel_id,revision,record) VALUES(?,?,?)
            ON CONFLICT(channel_id) DO UPDATE SET revision=excluded.revision,record=excluded.record WHERE revision=excluded.revision-1`)
            .run(record.channelId, record.revision, JSON.stringify(record));
          if (written.changes !== 1) throw new ModelCatalogError('MODEL_CATALOG_REVISION_CONFLICT');
          changes.push({ kind: 'channel', channelId: record.channelId, modelId: null, revision: record.revision });
        }
        for (const record of plan.models) {
          const written = this.db.prepare(`INSERT INTO model_catalog_models(channel_id,model_id,revision,lifecycle,record) VALUES(?,?,?,?,?)
            ON CONFLICT(channel_id,model_id) DO UPDATE SET revision=excluded.revision,lifecycle=excluded.lifecycle,record=excluded.record
            WHERE revision=excluded.revision-1`).run(record.channelId, record.modelId, record.revision, record.model.lifecycle.state, JSON.stringify(record));
          if (written.changes !== 1) throw new ModelCatalogError('MODEL_CATALOG_REVISION_CONFLICT');
          changes.push({ kind: 'model', channelId: record.channelId, modelId: record.modelId, revision: record.revision });
        }
      } else {
        // Hierarchy: an activation row exists only for a registered channel and, for a model row, a registered model of that channel.
        if (!this.channelRow(command.channelId)) throw new ModelCatalogError('MODEL_CATALOG_NOT_FOUND');
        if (command.modelId !== null && !this.modelRows(command.channelId).some(entry => entry.modelId === command.modelId)) {
          throw new ModelCatalogError('MODEL_CATALOG_NOT_FOUND');
        }
        const current = this.activationRow(command.scopeId, command.channelId, command.modelId);
        const record = transitionModelCatalogActivation(current, command);
        const written = this.db.prepare(`INSERT INTO model_catalog_activations(scope_id,channel_id,model_id,revision,state,record) VALUES(?,?,?,?,?,?)
          ON CONFLICT(scope_id,channel_id,model_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,record=excluded.record
          WHERE revision=excluded.revision-1`).run(record.scopeId, record.channelId, record.modelId ?? CHANNEL_ROW, record.revision, record.state, JSON.stringify(record));
        if (written.changes !== 1) throw new ModelCatalogError('MODEL_CATALOG_REVISION_CONFLICT');
        changes.push({ kind: 'activation', channelId: record.channelId, modelId: record.modelId, revision: record.revision });
      }
      const receipt = parseModelCatalogReceipt({ schemaVersion: 1, command, actor, authorizations: admission.authorizations,
        changes, admittedAtMs: admission.admittedAtMs });
      this.db.prepare('INSERT INTO model_catalog_receipts(scope_id,command_id,record) VALUES(?,?,?)').run(command.scopeId, command.commandId, JSON.stringify(receipt));
      this.db.exec('COMMIT'); active = false;
      return Object.freeze({ replayed: false, receipt });
    } catch (error) {
      if (active) {
        try { this.db.exec('ROLLBACK'); } catch { throw new ModelCatalogError('MODEL_CATALOG_OUTCOME_UNKNOWN'); }
      }
      return failure(error);
    }
  }
  close(): void { this.db.close(); }
}
