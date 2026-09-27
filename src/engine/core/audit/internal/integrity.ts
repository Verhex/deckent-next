import { auditEventSchema, auditRecordSchema, AuditError, encodeCommandProjection, type AuditEvent, type AuditRecord } from '#domain/index.js';
import type { IntegrityAuthority } from '#platform/index.js';
/** Same construction as approval records (`approval-record:1`): a domain-separated canonical projection under the HMAC authority. */
function projection(record: Omit<AuditRecord, 'mac'>) {
  return encodeCommandProjection('audit-record:1', { event: record.event, sequence: record.sequence, keyId: record.keyId });
}
export function sealAuditRecord(event: AuditEvent, sequence: number, authority: IntegrityAuthority): AuditRecord {
  const parsed = auditEventSchema.safeParse(event);
  if (!parsed.success || !Number.isSafeInteger(sequence) || sequence < 1) throw new AuditError('AUDIT_INVALID');
  const signed = { event: parsed.data, sequence, keyId: authority.keyId };
  const sealed = auditRecordSchema.safeParse({ ...signed, mac: authority.sign(projection(signed)) });
  if (!sealed.success) throw new AuditError('AUDIT_INVALID');
  return sealed.data;
}
export function verifyAuditRecord(input: unknown, authority: IntegrityAuthority): AuditRecord {
  const parsed = auditRecordSchema.safeParse(input);
  if (!parsed.success || !authority.verify(projection(parsed.data), parsed.data.mac, parsed.data.keyId)) throw new AuditError('AUDIT_INTEGRITY');
  return parsed.data;
}
