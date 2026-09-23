import type { DatabaseSync } from 'node:sqlite';
import { integrationDeliveryIntentSchema, WorkspacePatchError, type IntegrationDeliveryCommand,
  type IntegrationDeliveryIntent, type IntegrationDeliveryRecord } from '#engine/index.js';
import { readIntegration } from './integration.js';
export class SqliteDeliveryJournal {
  constructor(private readonly db: DatabaseSync) {}
  async loadDelivery(command: IntegrationDeliveryCommand): Promise<IntegrationDeliveryRecord | null> {
    const row = this.db.prepare('SELECT intent,delivered FROM workspace_deliveries WHERE scope_id=? AND command_id=?').get(command.identity.scopeId, command.commandId);
    if (!row) return null;
    let intent: IntegrationDeliveryIntent;
    try { intent = integrationDeliveryIntentSchema.parse(JSON.parse(String(row.intent))); }
    catch { throw new WorkspacePatchError('PATCH_CORRUPT'); }
    if (JSON.stringify(intent.command) !== JSON.stringify(command)) throw new WorkspacePatchError('PATCH_CONFLICT');
    if (row.delivered !== 0 && row.delivered !== 1) throw new WorkspacePatchError('PATCH_CORRUPT');
    this.bound(intent);
    return { intent, delivered: row.delivered === 1 };
  }
  /** Adoption lookup by the delivery's own command id; the stored intent is re-bound to its integration manifest and patch. */
  async findDelivery(scopeId: string, commandId: string): Promise<IntegrationDeliveryRecord | null> {
    const row = this.db.prepare('SELECT intent FROM workspace_deliveries WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    if (!row) return null;
    let intent: IntegrationDeliveryIntent;
    try { intent = integrationDeliveryIntentSchema.parse(JSON.parse(String(row.intent))); }
    catch { throw new WorkspacePatchError('PATCH_CORRUPT'); }
    if (intent.command.identity.scopeId !== scopeId || intent.command.commandId !== commandId) throw new WorkspacePatchError('PATCH_CORRUPT');
    return this.loadDelivery(intent.command);
  }
  private bound(intent: IntegrationDeliveryIntent) {
    const original = readIntegration(this.db, { schemaVersion: 1, identity: intent.command.identity, commandId: intent.command.integrationCommandId });
    if (!original?.manifest || JSON.stringify(original.manifest) !== JSON.stringify(intent.manifest)
      || JSON.stringify(original.intent.patch) !== JSON.stringify(intent.patch)) throw new WorkspacePatchError('PATCH_CONFLICT');
  }
  async claimDelivery(input: IntegrationDeliveryIntent) {
    const intent = integrationDeliveryIntentSchema.parse(input);
    // All checks/mutations in the transaction are synchronous; no await while holding the writer.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.bound(intent);
      const existing = this.db.prepare('SELECT intent,delivered FROM workspace_deliveries WHERE scope_id=? AND command_id=?').get(intent.command.identity.scopeId, intent.command.commandId);
      if (existing) {
        if (String(existing.intent) !== JSON.stringify(intent)) throw new WorkspacePatchError('PATCH_CONFLICT');
        if (existing.delivered !== 0 && existing.delivered !== 1) throw new WorkspacePatchError('PATCH_CORRUPT');
        this.db.exec('COMMIT'); return { intent, delivered: existing.delivered === 1 };
      }
      this.db.prepare('INSERT INTO workspace_deliveries(scope_id,command_id,intent,delivered) VALUES(?,?,?,0)')
        .run(intent.command.identity.scopeId, intent.command.commandId, JSON.stringify(intent));
      this.db.exec('COMMIT'); return { intent, delivered: false };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async finishDelivery(input: IntegrationDeliveryIntent) {
    const intent = integrationDeliveryIntentSchema.parse(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.bound(intent);
      const changed = this.db.prepare('UPDATE workspace_deliveries SET delivered=1 WHERE scope_id=? AND command_id=? AND intent=?')
        .run(intent.command.identity.scopeId, intent.command.commandId, JSON.stringify(intent));
      if (changed.changes !== 1) throw new WorkspacePatchError('PATCH_CONFLICT');
      this.db.exec('COMMIT'); return { intent, delivered: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
