import type { DatabaseSync } from 'node:sqlite';
import { encodeCommandProjection, targetQueueRequestSchema, targetQueueRecordSchema, TargetQueueError,
  type TargetQueueRequest, type TargetQueueRecord } from '#domain/index.js';
import { targetQueueKey, decodeTargetQueueRow, assertTargetQueueBounds, newQueueRecord, assertQueueChange, type TargetQueueStore, type TargetQueueBounds, type TargetQueueAudit } from '#engine/index.js';
import { SqliteAuditStore } from '#adapters/core/audit-store/index.js';
const open = "state NOT IN('settled','cancelled','expired','parked')";
/** Short ledger transactions only; audit and queue CAS commit together. The service owns this writer, never the public client. */
export class SqliteTargetQueue implements TargetQueueStore {
  constructor(private readonly db: DatabaseSync) {}
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { throw new TargetQueueError('QUEUE_RECOVERY_REQUIRED'); } throw error; }
  }
  load(scopeId: string, commandId: string): TargetQueueRecord | null {
    const row = this.db.prepare('SELECT * FROM target_queue WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    return row ? decodeTargetQueueRow(row) : null;
  }
  forVerification(scopeId: string, runId: string): TargetQueueRecord | null {
    const rows = this.db.prepare("SELECT * FROM target_queue WHERE scope_id=? AND json_extract(record,'$.effectCommandIds[3]')=? LIMIT 2").all(scopeId, runId);
    if (rows.length > 1) throw new TargetQueueError('QUEUE_CORRUPT');
    return rows[0] ? decodeTargetQueueRow(rows[0]) : null;
  }
  pending(limit: number, after: Readonly<{ key: string; ordinal: number }> | null = null): readonly TargetQueueRecord[] {
    return this.db.prepare(`SELECT * FROM target_queue WHERE ${open} AND (target_key>? OR (target_key=? AND ordinal>?)) ORDER BY target_key,ordinal LIMIT ?`)
      .all(after?.key ?? '', after?.key ?? '', after?.ordinal ?? 0, limit).map(decodeTargetQueueRow);
  }
  epoch(key: string): number { return Number(this.db.prepare("SELECT coalesce(max(json_extract(record,'$.epoch')),0) AS n FROM target_queue WHERE target_key=?").get(key)?.n); }
  head(key: string): TargetQueueRecord | null {
    const row = this.db.prepare(`SELECT * FROM target_queue WHERE target_key=? AND ${open} ORDER BY ordinal LIMIT 1`).get(key);
    return row ? decodeTargetQueueRow(row) : null;
  }
  list(scopeId: string, after: string | null, limit: number): readonly TargetQueueRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TargetQueueError('QUEUE_CONFLICT');
    return this.db.prepare('SELECT * FROM target_queue WHERE scope_id=? AND command_id>? ORDER BY command_id LIMIT ?')
      .all(scopeId, after ?? '', limit).map(row => decodeTargetQueueRow(row));
  }
  forRun(scopeId: string, runId: string, limit: number): readonly TargetQueueRecord[] {
    return this.db.prepare("SELECT * FROM target_queue WHERE scope_id=? AND json_extract(record,'$.request.identity.runId')=? ORDER BY command_id LIMIT ?")
      .all(scopeId, runId, limit).map(decodeTargetQueueRow);
  }
  ahead(record: TargetQueueRecord, limit: number): readonly TargetQueueRecord[] {
    return this.db.prepare(`SELECT * FROM target_queue WHERE scope_id=? AND target_key=? AND ordinal<? AND ${open} ORDER BY ordinal LIMIT ?`)
      .all(record.request.identity.scopeId, record.key, record.ordinal, limit).map(decodeTargetQueueRow);
  }
  private retain(record: TargetQueueRecord, audit: TargetQueueAudit): TargetQueueRecord {
    audit(new SqliteAuditStore(this.db), record);
    this.db.prepare('INSERT INTO target_queue_events(scope_id,command_id,revision,record) VALUES(?,?,?,?)')
      .run(record.request.identity.scopeId, record.request.commandId, record.revision, JSON.stringify(record));
    return record;
  }
  reserve(first: TargetQueueRecord, owner: string, now: number, bounds: TargetQueueBounds, audit: TargetQueueAudit): readonly TargetQueueRecord[] {
    assertTargetQueueBounds(bounds);
    return this.transaction(() => {
      const head = this.head(first.key);
      if (!head || JSON.stringify(head) !== JSON.stringify(first) || head.state !== 'queued') throw new TargetQueueError('QUEUE_TARGET_BUSY');
      if (Number(this.db.prepare(`SELECT count(DISTINCT target_key) AS n FROM target_queue WHERE ${open} AND state!='queued'`).get()?.n) >= bounds.activeTargets)
        throw new TargetQueueError('QUEUE_CAPACITY');
      const epoch = this.epoch(first.key) + 1, records: TargetQueueRecord[] = [];
      for (const row of this.db.prepare(`SELECT * FROM target_queue WHERE target_key=? AND ${open} ORDER BY ordinal LIMIT ?`).all(first.key, bounds.batchSize)) {
        const before = decodeTargetQueueRow(row);
        if (before.request.operation !== first.request.operation || before.state !== 'queued' || before.request.identity.scopeId !== first.request.identity.scopeId || before.request.policyRevision !== first.request.policyRevision
          || JSON.stringify(before.request.actor) !== JSON.stringify(first.request.actor) || before.request.deadline <= now) break;
        const next = targetQueueRecordSchema.parse({ ...before, revision: before.revision + 1, state: 'revalidating', ownerInstance: owner, epoch, leaseDeadline: now + bounds.leaseMs });
        assertQueueChange(before, next);
        if (this.db.prepare('UPDATE target_queue SET revision=?,state=?,record=? WHERE scope_id=? AND command_id=? AND record=?')
          .run(next.revision, next.state, JSON.stringify(next), before.request.identity.scopeId, before.request.commandId, JSON.stringify(before)).changes !== 1)
          throw new TargetQueueError('QUEUE_CONFLICT');
        records.push(this.retain(next, audit));
      }
      if (!records.length) throw new TargetQueueError('QUEUE_EXPIRED');
      return records;
    });
  }
  enqueue(input: TargetQueueRequest, bounds: TargetQueueBounds, audit: TargetQueueAudit): TargetQueueRecord {
    assertTargetQueueBounds(bounds);
    const request = targetQueueRequestSchema.parse(input), scopeId = request.identity.scopeId;
    return this.transaction(() => {
      const existing = this.load(scopeId, request.commandId);
      if (existing) {
        if (encodeCommandProjection('queue-request:1', existing.request) !== encodeCommandProjection('queue-request:1', request)) throw new TargetQueueError('QUEUE_CONFLICT');
        return existing;
      }
      const key = targetQueueKey(request.target);
      const all = Number(this.db.prepare(`SELECT count(*) AS n FROM target_queue WHERE ${open}`).get()?.n);
      const count = Number(this.db.prepare(`SELECT count(*) AS n FROM target_queue WHERE target_key=? AND ${open}`).get(key)?.n);
      if (all >= bounds.capacity || count >= bounds.perTarget) throw new TargetQueueError('QUEUE_CAPACITY');
      // Historical records have no proven source binding: conservatively hold matching addresses for explicit reconciliation.
      if (this.db.prepare('SELECT 1 FROM workspace_adoptions WHERE target_ref=? AND settled=0 LIMIT 1').get(request.target.target.id)
        || this.db.prepare("SELECT 1 FROM effect_intents WHERE target_kind=? AND target_id=? AND state IN('claimed','unknown') LIMIT 1")
          .get(request.target.target.kind, request.target.target.id)) throw new TargetQueueError('QUEUE_RECOVERY_REQUIRED');
      const ordinal = Number(this.db.prepare('SELECT coalesce(max(ordinal),0)+1 AS n FROM target_queue WHERE target_key=?').get(key)?.n);
      const record = newQueueRecord(request, ordinal);
      this.db.prepare('INSERT INTO target_queue(scope_id,command_id,target_key,ordinal,revision,state,record) VALUES(?,?,?,?,?,?,?)')
        .run(scopeId, request.commandId, key, ordinal, record.revision, record.state, JSON.stringify(record));
      return this.retain(record, audit);
    });
  }
  change(before: TargetQueueRecord, after: TargetQueueRecord, bounds: TargetQueueBounds, audit: TargetQueueAudit): TargetQueueRecord {
    const previous = targetQueueRecordSchema.parse(before), next = targetQueueRecordSchema.parse(after);
    assertQueueChange(previous, next);
    return this.transaction(() => {
      const head = this.head(previous.key);
      if (next.state === 'revalidating' && (!head || head.ordinal !== previous.ordinal)) throw new TargetQueueError('QUEUE_TARGET_BUSY');
      if (next.state === 'revalidating' && Number(this.db.prepare(`SELECT count(DISTINCT target_key) AS n FROM target_queue WHERE ${open} AND state!='queued'`).get()?.n) >= bounds.activeTargets) throw new TargetQueueError('QUEUE_CAPACITY');
      const changed = this.db.prepare('UPDATE target_queue SET revision=?,state=?,record=? WHERE scope_id=? AND command_id=? AND record=?')
        .run(next.revision, next.state, JSON.stringify(next), previous.request.identity.scopeId, previous.request.commandId, JSON.stringify(previous));
      if (changed.changes !== 1) throw new TargetQueueError('QUEUE_CONFLICT');
      return this.retain(next, audit);
    });
  }
}
