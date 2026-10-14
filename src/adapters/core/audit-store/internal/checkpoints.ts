import type { DatabaseSync } from 'node:sqlite';
import { auditCheckpointSchema, AuditError, type AuditCheckpoint } from '#domain/index.js';
export function checkpointPage(db: DatabaseSync, scopeId: string, afterSequence: number, limit: number): readonly AuditCheckpoint[] {
  const exists = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='audit_checkpoints'").get();
  if (!exists) return [];
  return db.prepare('SELECT scope_id,sequence,record FROM audit_checkpoints WHERE scope_id=? AND sequence>? ORDER BY sequence LIMIT ?')
    .all(scopeId, afterSequence, limit).map(row => {
      let value: AuditCheckpoint;
      try { value = auditCheckpointSchema.parse(JSON.parse(String(row.record))); } catch { throw new AuditError('AUDIT_INTEGRITY'); }
      if (value.scopeId !== row.scope_id || value.sequence !== row.sequence) throw new AuditError('AUDIT_INTEGRITY');
      return value;
    });
}
export function appendCheckpoint(db: DatabaseSync, value: AuditCheckpoint): void {
  const cp = auditCheckpointSchema.parse(value);
  const last = db.prepare('SELECT coalesce(max(sequence),0) AS sequence FROM audit_checkpoints WHERE scope_id=?').get(cp.scopeId);
  if (Number(last?.sequence) + 1 !== cp.sequence) throw new AuditError('AUDIT_CONFLICT');
  db.prepare('INSERT INTO audit_checkpoints(scope_id,sequence,record) VALUES(?,?,?)').run(cp.scopeId, cp.sequence, JSON.stringify(cp));
}
