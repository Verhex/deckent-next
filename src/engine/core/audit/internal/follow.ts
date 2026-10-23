import { auditFollowPageSchema, auditFollowQuerySchema, AuditError, type AuditFollowPage } from '#domain/index.js';
import type { IntegrityAuthority } from '#platform/index.js';
import { verifyAuditRecord } from './integrity.js';
import type { AuditStore } from './store.js';
/**
 * S5 D2 (AUDITOR-MODEL 2026-10-17): the AuditFollow read port. The service side verifies every seal with its key; the reader receives
 * verified events, their sequences and the gaps between them, never a key, MAC or key id. A sequence missing between `after` and the last
 * returned record (a deleted row) is a typed gap and the read goes on; a record that fails its seal, names another scope or goes backwards
 * stops the read (`AUDIT_INTEGRITY`): a forgery is never a gap. Read-only: nothing here writes, migrates or creates a key.
 */
export class AuditFollow {
  constructor(private readonly store: AuditStore, private readonly integrity: IntegrityAuthority) {}
  read(input: unknown): AuditFollowPage {
    const parsed = auditFollowQuerySchema.safeParse(input);
    if (!parsed.success) throw new AuditError('AUDIT_INVALID');
    const { scopeId, after, limit } = parsed.data;
    let rows;
    try { rows = this.store.page(scopeId, after, limit); }
    catch (error) { if (error instanceof AuditError) throw error; throw new AuditError('AUDIT_UNAVAILABLE'); }
    const records: AuditFollowPage['records'][number][] = [], gaps: AuditFollowPage['gaps'][number][] = [];
    let last = after;
    for (const row of rows) {
      const record = verifyAuditRecord(row, this.integrity);
      if (record.event.scopeId !== scopeId || record.sequence <= last) throw new AuditError('AUDIT_INTEGRITY');
      if (record.sequence > last + 1) gaps.push({ afterSequence: last, beforeSequence: record.sequence });
      records.push({ sequence: record.sequence, event: record.event }); last = record.sequence;
    }
    return auditFollowPageSchema.parse({ schemaVersion: 1, scopeId, records, gaps, after: last, more: rows.length === limit });
  }
}
