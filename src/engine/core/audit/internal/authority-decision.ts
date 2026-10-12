import { AUDIT_EVENT_SCHEMA_VERSION, authorityDecisionSubjectSchema, AuditError, encodeCommandProjection,
  type AuthorityDecisionSubject, type AuditRecord } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { AuditApplication } from './application.js';
/** Thin producer over the one audit writer: immutable evidence identity, never another policy evaluator. */
export class AuthorityDecisionRecords {
  constructor(private readonly audit: AuditApplication) {}
  load(scopeId: string, eventId: string) { return this.audit.load(scopeId, eventId); }
  record(input: AuthorityDecisionSubject, atMs: number): AuditRecord {
    const subject = authorityDecisionSubjectSchema.parse(input), { envelope } = subject;
    const eventId = `decision:${sha256(encodeCommandProjection('authority-decision:1', subject))}`;
    const existing = this.audit.load(envelope.scopeId, eventId);
    if (existing) return this.check(existing, subject);
    try {
      return this.audit.record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId, scopeId: envelope.scopeId,
        principal: { issuer: envelope.principalRef.issuer, subject: envelope.principalRef.subject },
        policyRevision: subject.verdict.revision, atMs, subject });
    } catch (error) {
      // Concurrent producers may sample different clocks; the first committed timestamp is immutable.
      if (!(error instanceof AuditError) || error.code !== 'AUDIT_CONFLICT') throw error;
      const winner = this.audit.load(envelope.scopeId, eventId);
      if (!winner) throw error;
      return this.check(winner, subject);
    }
  }
  verify(record: AuditRecord): void {
    const stored = this.audit.load(record.event.scopeId, record.event.eventId);
    if (!stored || encodeCommandProjection('audit-record:1', stored) !== encodeCommandProjection('audit-record:1', record)) throw new AuditError('AUDIT_INTEGRITY');
  }
  private check(record: AuditRecord, subject: AuthorityDecisionSubject) {
    if (encodeCommandProjection('authority-decision:1', record.event.subject) !== encodeCommandProjection('authority-decision:1', subject)
      || record.event.policyRevision !== subject.verdict.revision || record.event.principal.issuer !== subject.envelope.principalRef.issuer
      || record.event.principal.subject !== subject.envelope.principalRef.subject) throw new AuditError('AUDIT_INTEGRITY');
    return record;
  }
}
