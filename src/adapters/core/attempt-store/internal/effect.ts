import type { DatabaseSync } from 'node:sqlite';
import { effectIntentSchema, effectRecordSchema, EffectError, type EffectIntent, type EffectRecord } from '#domain/index.js';

/** Generic effect intents (ledger v34). Intent is durable before the effect; state moves only by compare-and-swap on the stored record. */
export class SqliteEffectJournal {
  constructor(private readonly db: DatabaseSync) {}
  private read(scopeId: string, commandId: string): EffectRecord | null {
    const row = this.db.prepare('SELECT target_kind,target_id,state,idempotency_key_hash,record FROM effect_intents WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    if (!row) return null;
    let record: EffectRecord;
    try { record = effectRecordSchema.parse(JSON.parse(String(row.record))); } catch { throw new EffectError('EFFECT_CORRUPT'); }
    const { command } = record.intent;
    if (command.scopeId !== scopeId || command.commandId !== commandId || command.target.kind !== row.target_kind || command.target.id !== row.target_id
      || record.state !== row.state || record.intent.idempotencyKeyHash !== row.idempotency_key_hash) throw new EffectError('EFFECT_CORRUPT');
    return record;
  }
  async loadEffect(scopeId: string, commandId: string) { return this.read(scopeId, commandId); }
  async claimEffect(input: EffectIntent): Promise<EffectRecord> {
    const intent = effectIntentSchema.parse(input);
    const { scopeId, commandId, target } = intent.command;
    // All checks and mutations are synchronous inside the writer transaction.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.read(scopeId, commandId);
      if (existing) {
        if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) throw new EffectError('EFFECT_CONFLICT');
        this.db.exec('COMMIT'); return existing;
      }
      if (this.db.prepare('SELECT 1 FROM effect_intents WHERE scope_id=? AND idempotency_key_hash=?').get(scopeId, intent.idempotencyKeyHash)) {
        throw new EffectError('EFFECT_CONFLICT');
      }
      if (this.db.prepare("SELECT 1 FROM effect_intents WHERE target_kind=? AND target_id=? AND state IN('claimed','unknown')").get(target.kind, target.id)) {
        throw new EffectError('EFFECT_TARGET_BUSY');
      }
      const latest = this.db.prepare('SELECT MAX(sequence) AS sequence FROM effect_intents WHERE target_kind=? AND target_id=?').get(target.kind, target.id);
      const sequence = Number(latest?.sequence ?? 0) + 1;
      if (!Number.isSafeInteger(sequence)) throw new EffectError('EFFECT_CORRUPT');
      const record = effectRecordSchema.parse({ intent, sequence, state: 'claimed', evidence: null, refusal: null });
      this.db.prepare('INSERT INTO effect_intents(scope_id,command_id,target_kind,target_id,sequence,idempotency_key_hash,state,record) VALUES(?,?,?,?,?,?,?,?)')
        .run(scopeId, commandId, target.kind, target.id, sequence, intent.idempotencyKeyHash, record.state, JSON.stringify(record));
      this.db.exec('COMMIT'); return record;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async saveEffect(previousInput: EffectRecord, nextInput: EffectRecord): Promise<EffectRecord> {
    const previous = effectRecordSchema.parse(previousInput), next = effectRecordSchema.parse(nextInput);
    if (JSON.stringify(previous.intent) !== JSON.stringify(next.intent) || previous.sequence !== next.sequence) throw new EffectError('EFFECT_CONFLICT');
    const { scopeId, commandId } = next.intent.command;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare('UPDATE effect_intents SET state=?,record=? WHERE scope_id=? AND command_id=? AND record=?')
        .run(next.state, JSON.stringify(next), scopeId, commandId, JSON.stringify(previous));
      if (changed.changes !== 1) throw new EffectError('EFFECT_CONFLICT');
      this.db.exec('COMMIT'); return next;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
