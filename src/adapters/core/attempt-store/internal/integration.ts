import type { DatabaseSync } from 'node:sqlite';
import { artifactReceiptSchema, type ArtifactReceipt } from '#capabilities/index.js';
import { integrationIntentSchema, WorkspacePatchError, type IntegrationIntent, type IntegrationRecord } from '#engine/index.js';
import { readRunBoundDispatch } from './run-dispatch-lookup.js';
export class SqliteIntegrationJournal {
  constructor(private readonly db: DatabaseSync) {}
  private read(intent: IntegrationIntent): IntegrationRecord | null {
    const row = this.db.prepare('SELECT intent,manifest FROM workspace_integrations WHERE scope_id=? AND command_id=?').get(intent.command.identity.scopeId, intent.command.commandId);
    if (!row) return null;
    try {
      const recorded = integrationIntentSchema.parse(JSON.parse(String(row.intent)));
      if (JSON.stringify(recorded) !== JSON.stringify(intent)) throw new WorkspacePatchError('PATCH_CONFLICT');
      const manifest = row.manifest === null ? null : artifactReceiptSchema.parse(JSON.parse(String(row.manifest)));
      if (manifest && manifest.scopeId !== intent.command.identity.scopeId) throw new WorkspacePatchError('PATCH_CORRUPT');
      return { intent: recorded, manifest };
    } catch (error) { if (error instanceof WorkspacePatchError) throw error; throw new WorkspacePatchError('PATCH_CORRUPT'); }
  }
  private bound(intent: IntegrationIntent) {
    const record = readRunBoundDispatch(this.db, intent.command.identity).dispatch;
    if (!record?.terminal || JSON.stringify(record.patch) !== JSON.stringify(intent.patch)) throw new WorkspacePatchError('PATCH_CONFLICT');
  }
  async claimIntegration(input: IntegrationIntent) {
    const intent = integrationIntentSchema.parse(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.bound(intent); const existing = this.read(intent);
      if (existing) { this.db.exec('COMMIT'); return { acquired: false, record: existing }; }
      this.db.prepare('INSERT INTO workspace_integrations(scope_id,command_id,intent,manifest) VALUES(?,?,?,NULL)')
        .run(intent.command.identity.scopeId, intent.command.commandId, JSON.stringify(intent));
      this.db.exec('COMMIT'); return { acquired: true, record: { intent, manifest: null } };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async finishIntegration(input: IntegrationIntent, receipt: ArtifactReceipt) {
    const intent = integrationIntentSchema.parse(input); const manifest = artifactReceiptSchema.parse(receipt);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.bound(intent); const existing = this.read(intent);
      if (!existing || manifest.scopeId !== intent.command.identity.scopeId || (existing.manifest && JSON.stringify(existing.manifest) !== JSON.stringify(manifest)))
        throw new WorkspacePatchError('PATCH_CONFLICT');
      this.db.prepare('UPDATE workspace_integrations SET manifest=? WHERE scope_id=? AND command_id=?')
        .run(JSON.stringify(manifest), intent.command.identity.scopeId, intent.command.commandId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
