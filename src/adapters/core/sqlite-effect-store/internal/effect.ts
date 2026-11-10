import type { DatabaseSync } from 'node:sqlite';
import { assertEffectTransition, claimEffectRecord, effectIntentSchema, effectRecordSchema, EffectError, type EffectIntent, type EffectRecord } from '#domain/index.js';
import { EFFECT_OPEN_STATE_SQL, ledgerTransaction } from '#adapters/core/sqlite-ledger/index.js';

/** Generic effect intents (ledger v34; producer from S6R-1). Intent is durable before the effect; state moves only by the domain rule and CAS on the stored record. */
export class SqliteEffectJournal {
  constructor(private readonly db: DatabaseSync) {}
  read(scopeId: string, commandId: string): EffectRecord | null {
    const row = this.db.prepare('SELECT target_kind,target_id,sequence,state,idempotency_key_hash,record FROM effect_intents WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    if (!row) return null;
    let record: EffectRecord;
    try { record = effectRecordSchema.parse(JSON.parse(String(row.record))); } catch { throw new EffectError('EFFECT_CORRUPT'); }
    const { command } = record.intent;
    if (command.scopeId !== scopeId || command.commandId !== commandId || command.target.kind !== row.target_kind || command.target.id !== row.target_id
      || record.sequence !== row.sequence || record.state !== row.state || record.intent.idempotencyKeyHash !== row.idempotency_key_hash) throw new EffectError('EFFECT_CORRUPT');
    return record;
  }
  async loadEffect(scopeId: string, commandId: string) { return this.read(scopeId, commandId); }
  /** Settled compensation wins over later refusals; an open intent otherwise holds acceptance. One canonical result. */
  readCompensation(scopeId: string, commandId: string): EffectRecord | null {
    const original = this.read(scopeId, commandId);
    if (!original) return null;
    const target = original.intent.command.target;
    // A damaged indexed record with a missing JSON relation must never count as absent compensation.
    const damaged = this.db.prepare("SELECT command_id FROM effect_intents WHERE scope_id=? AND target_kind=? AND target_id=? AND sequence>? AND (json_valid(record)=0 OR json_extract(record,'$.intent.command.commandId') IS NOT command_id OR json_extract(record,'$.sequence') IS NOT sequence) LIMIT 1").get(scopeId, target.kind, target.id, original.sequence);
    if (damaged) throw new EffectError('EFFECT_CORRUPT');
    const row = this.db.prepare("SELECT command_id FROM effect_intents WHERE scope_id=? AND (CASE WHEN json_valid(record) THEN json_extract(record,'$.intent.command.compensates') END)=? AND state!='refused' ORDER BY CASE state WHEN 'settled' THEN 0 ELSE 1 END,sequence DESC LIMIT 1").get(scopeId, commandId);
    return row ? this.read(scopeId, String(row.command_id)) : null;
  }
  async loadEffectCompensation(scopeId: string, commandId: string) { return this.readCompensation(scopeId, commandId); }
  async claimEffect(input: EffectIntent): Promise<EffectRecord> {
    const intent = effectIntentSchema.parse(input), { scopeId, commandId, target } = intent.command;
    return ledgerTransaction(this.db, () => {
      const existing = this.read(scopeId, commandId), record = claimEffectRecord(intent, existing, {
        keyTaken: () => !!this.db.prepare('SELECT 1 FROM effect_intents WHERE scope_id=? AND idempotency_key_hash=?').get(scopeId, intent.idempotencyKeyHash),
        open: () => !!this.db.prepare(`SELECT 1 FROM effect_intents WHERE target_kind=? AND target_id=? AND ${EFFECT_OPEN_STATE_SQL}`).get(target.kind, target.id),
        lastSequence: () => Number(this.db.prepare('SELECT MAX(sequence) AS sequence FROM effect_intents WHERE target_kind=? AND target_id=?').get(target.kind, target.id)?.sequence ?? 0) });
      if (record !== existing) this.db.prepare('INSERT INTO effect_intents(scope_id,command_id,target_kind,target_id,sequence,idempotency_key_hash,state,record) VALUES(?,?,?,?,?,?,?,?)')
        .run(scopeId, commandId, target.kind, target.id, record.sequence, intent.idempotencyKeyHash, record.state, JSON.stringify(record));
      return record;
    });
  }
  async saveEffect(previousInput: EffectRecord, nextInput: EffectRecord): Promise<EffectRecord> {
    const previous = effectRecordSchema.parse(previousInput), next = effectRecordSchema.parse(nextInput);
    assertEffectTransition(previous, next);
    const { scopeId, commandId } = next.intent.command;
    return ledgerTransaction(this.db, () => {
      const changed = this.db.prepare('UPDATE effect_intents SET state=?,record=? WHERE scope_id=? AND command_id=? AND record=?')
        .run(next.state, JSON.stringify(next), scopeId, commandId, JSON.stringify(previous));
      if (changed.changes !== 1) throw new EffectError('EFFECT_CONFLICT');
      return next;
    });
  }
}
