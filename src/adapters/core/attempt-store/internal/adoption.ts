import type { DatabaseSync } from 'node:sqlite';
import { integrationAdoptionIntentSchema, WorkspaceAdoptionError, type IntegrationAdoptionIntent, type IntegrationAdoptionRecord } from '#engine/index.js';

/** Adoption/rollback intents with a per-target sequence fence. Git CAS guards the reference itself; this journal serializes
 * Deckent's own commands on a target and records which adoption a rollback may still undo. */
export class SqliteAdoptionJournal {
  constructor(private readonly db: DatabaseSync) {}
  private decode(row: Record<string, unknown>, scopeId: string, commandId: string): IntegrationAdoptionRecord {
    let intent: IntegrationAdoptionIntent;
    try { intent = integrationAdoptionIntentSchema.parse(JSON.parse(String(row.intent))); }
    catch { throw new WorkspaceAdoptionError('ADOPTION_CORRUPT'); }
    if (intent.command.identity.scopeId !== scopeId || intent.command.commandId !== commandId || intent.kind !== row.kind
      || intent.targetRef !== row.target_ref || !Number.isSafeInteger(row.sequence) || (row.settled !== 0 && row.settled !== 1)) {
      throw new WorkspaceAdoptionError('ADOPTION_CORRUPT');
    }
    return { intent, sequence: Number(row.sequence), settled: row.settled === 1 };
  }
  private read(scopeId: string, commandId: string) {
    const row = this.db.prepare('SELECT target_ref,sequence,kind,intent,settled FROM workspace_adoptions WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    return row ? this.decode(row, scopeId, commandId) : null;
  }
  async loadAdoption(scopeId: string, commandId: string) { return this.read(scopeId, commandId); }
  async claimAdoption(input: IntegrationAdoptionIntent): Promise<IntegrationAdoptionRecord> {
    const intent = integrationAdoptionIntentSchema.parse(input);
    const { scopeId } = intent.command.identity, { commandId } = intent.command;
    // All checks/mutations in the transaction are synchronous; no await while holding the writer.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.read(scopeId, commandId);
      if (existing) {
        if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
        this.db.exec('COMMIT'); return existing;
      }
      if (this.db.prepare('SELECT 1 FROM workspace_adoptions WHERE target_ref=? AND settled=0').get(intent.targetRef)) {
        throw new WorkspaceAdoptionError('ADOPTION_TARGET_BUSY');
      }
      const latest = this.db.prepare('SELECT scope_id,command_id,sequence FROM workspace_adoptions WHERE target_ref=? ORDER BY sequence DESC LIMIT 1').get(intent.targetRef);
      if (intent.kind === 'rollback') {
        const adopted = this.read(scopeId, intent.command.adoptionCommandId);
        if (!adopted || adopted.intent.kind !== 'adopt' || !adopted.settled || adopted.intent.targetRef !== intent.targetRef
          || adopted.intent.toCommit !== intent.fromCommit || adopted.intent.fromCommit !== intent.toCommit) throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
        if (latest?.scope_id !== scopeId || latest?.command_id !== adopted.intent.command.commandId) throw new WorkspaceAdoptionError('ADOPTION_SUPERSEDED');
      }
      const sequence = latest ? Number(latest.sequence) + 1 : 1;
      if (!Number.isSafeInteger(sequence)) throw new WorkspaceAdoptionError('ADOPTION_CORRUPT');
      this.db.prepare('INSERT INTO workspace_adoptions(scope_id,command_id,target_ref,sequence,kind,intent,settled) VALUES(?,?,?,?,?,?,0)')
        .run(scopeId, commandId, intent.targetRef, sequence, intent.kind, JSON.stringify(intent));
      this.db.exec('COMMIT'); return { intent, sequence, settled: false };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async finishAdoption(input: IntegrationAdoptionIntent): Promise<IntegrationAdoptionRecord> {
    const intent = integrationAdoptionIntentSchema.parse(input);
    const { scopeId } = intent.command.identity, { commandId } = intent.command;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare('UPDATE workspace_adoptions SET settled=1 WHERE scope_id=? AND command_id=? AND intent=?')
        .run(scopeId, commandId, JSON.stringify(intent));
      const record = this.read(scopeId, commandId);
      if (!record?.settled || (changed.changes !== 1 && JSON.stringify(record.intent) !== JSON.stringify(intent))) throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
      this.db.exec('COMMIT'); return record;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
