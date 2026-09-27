import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { AUDIT_EVENT_SCHEMA_VERSION, auditEventSchema, auditRecordSchema, AuditError } from '#domain/index.js';
import { AuditApplication, sealAuditRecord, verifyAuditRecord, type AuditStore } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';

const integrity = createHmacIntegrity('audit-key', randomBytes(32));
const base = {
  schemaVersion: 1, eventId: 'evt-1', scopeId: 'scope', principal: { issuer: 'local-os', subject: 'alperen' }, policyRevision: 'p1', atMs: 10,
  subject: { kind: 'permission-mode', mode: 'full-auto', cell: 'shell-modify', tool: { name: 'shell', version: 2 },
    call: { turnId: 't', round: 1, index: 0, callId: 'c' }, grants: { company: 'g-company', person: 'g-person' },
    decision: { previous: 'require-approval', next: 'allow' }, summary: { kind: 'shell', head: 'rm build/out.txt', argsDigest: 'f'.repeat(64) } },
} as const;

it('audit event v1 is a bounded summary: strict shape, no raw command or content fields, shell head at most 200 characters', () => {
  expect(AUDIT_EVENT_SCHEMA_VERSION).toBe(1);
  expect(auditEventSchema.parse(base)).toEqual(base);
  expect(auditEventSchema.safeParse({ ...base, command: 'rm -rf /' }).success).toBe(false);
  expect(auditEventSchema.safeParse({ ...base, subject: { ...base.subject, summary: { ...base.subject.summary, content: 'x' } } }).success).toBe(false);
  expect(auditEventSchema.safeParse({ ...base, subject: { ...base.subject, summary: { kind: 'shell', head: 'x'.repeat(201), argsDigest: 'f'.repeat(64) } } }).success).toBe(false);
  expect(auditEventSchema.safeParse({ ...base, subject: { ...base.subject, summary: { kind: 'edit', path: 'src/a.ts' } } }).success).toBe(true);
  expect(auditEventSchema.safeParse({ ...base, subject: { ...base.subject, decision: { previous: 'deny', next: 'allow' } } }).success).toBe(false);
  expect(auditEventSchema.safeParse({ ...base, subject: { ...base.subject, mode: 'ask' } }).success).toBe(false);
  expect(auditEventSchema.safeParse({ ...base, principal: { issuer: 'local-os', subject: 'alperen', persona: 'x' } }).success).toBe(false);
  expect(auditEventSchema.safeParse({ ...base, schemaVersion: 2 }).success).toBe(false);
});

it('seals the event with its scope-local sequence and key, and verification binds all three', () => {
  const record = sealAuditRecord(base, 3, integrity);
  expect(auditRecordSchema.parse(record)).toEqual(record);
  expect(record).toMatchObject({ sequence: 3, keyId: 'audit-key', event: base });
  expect(verifyAuditRecord(record, integrity)).toEqual(record);
  expect(() => verifyAuditRecord({ ...record, sequence: 4 }, integrity)).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
  expect(() => verifyAuditRecord({ ...record, event: { ...base, atMs: 11 } }, integrity)).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
  expect(() => verifyAuditRecord(record, createHmacIntegrity('audit-key', randomBytes(32)))).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
  expect(() => verifyAuditRecord({ ...record, keyId: 'other' }, integrity)).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
  expect(() => sealAuditRecord(base, 0, integrity)).toThrow(AuditError);
});

it('the application seals inside the store append, verifies every listed record and reports a sequence gap as integrity loss', () => {
  const rows: ReturnType<typeof sealAuditRecord>[] = [];
  const store: AuditStore = {
    append: (event, seal) => { const record = seal(rows.length + 1); rows.push(record); return record; },
    page: (scopeId, after, limit) => rows.filter(r => r.event.scopeId === scopeId && r.sequence > after).slice(0, limit),
    increment: () => { throw new Error('unused'); }, counters: () => [],
  };
  const audit = new AuditApplication(store, integrity);
  const one = audit.record(base), two = audit.record({ ...base, eventId: 'evt-2' });
  expect([one.sequence, two.sequence]).toEqual([1, 2]);
  expect(audit.list('scope', 0, 10)).toEqual([one, two]);
  rows.splice(0, 1);
  expect(() => audit.list('scope', 0, 10)).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
  expect(() => audit.record({ ...base, eventId: '' })).toThrow(expect.objectContaining({ code: 'AUDIT_INVALID' }));
  // A store failure of any shape is the typed unavailable error: the caller applies no effect.
  const failing = new AuditApplication({ ...store, append: () => { throw new Error('disk'); } }, integrity);
  expect(() => failing.record(base)).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
});
