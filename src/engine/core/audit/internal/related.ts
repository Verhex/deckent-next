import { auditRefusalMatchesPolicy, type AuditListView } from '#domain/index.js';
import type { AuditApplication } from './application.js';
/** Bounded, verified lookup across page boundaries. The original rows stay byte-for-byte intact. */
export function relatedAuditRecords(audit: AuditApplication, records: AuditListView['records'], limits: { readonly pageSize: number; readonly maxRecords: number }): Pick<AuditListView, 'related' | 'correlationLimited'> {
  const refusals = records.filter(row => row.event.subject.kind === 'access-refusal-summary');
  const policies = records.filter(row => row.event.subject.kind === 'policy-turn');
  const related = new Map<number, AuditListView['records'][number]>();
  let left = limits.maxRecords, limited = false;
  for (const [kind, focus] of [['policy-turn', refusals], ['access-refusal-summary', policies]] as const) {
    if (!focus.length) continue;
    let after = 0;
    while (left > 0) {
      const size = Math.min(limits.pageSize, left), page = audit.listKind(records[0]!.event.scopeId, kind, after, size);
      left -= page.length;
      for (const row of page) if (focus.some(item => kind === 'policy-turn' ? auditRefusalMatchesPolicy(item.event, row.event) : auditRefusalMatchesPolicy(row.event, item.event))) {
        related.set(row.sequence, { sequence: row.sequence, event: row.event });
      }
      if (page.length < size) break;
      after = page.at(-1)!.sequence;
      if (left === 0) limited = true;
    }
    if (left === 0) limited = true;
  }
  return { ...(related.size ? { related: [...related.values()] } : {}), ...(limited ? { correlationLimited: true } : {}) };
}
