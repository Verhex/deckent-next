import { rebindIds, rebindSubject } from '../../fixtures/audit-rebind.js';
import type { RebindAdmissionRecord } from '#domain/index.js';
import type { RebindAdmission } from '#engine/core/bootstrap-identity/index.js';
import { refusalSubject } from '../../fixtures/audit-refusal.js';
import { randomBytes } from 'node:crypto';
import { expect, expectTypeOf, it } from 'vitest';
import { AUDIT_EVENT_SCHEMA_VERSION, AUDIT_POLICY_TURN_LIMITS, AUDIT_REFUSAL_TOKEN_MAX_CHARS, auditEventSchema, auditRecordSchema, AuditError } from '#domain/index.js';
import { AuditApplication, deliveryDismissalEvent, dismissedDeliveries, runRequestRefusedEvent, sealAuditRecord, verifyAuditRecord, type AuditStore } from '#engine/index.js';
import { createHmacIntegrity, snapshotKnownSecrets } from '#platform/index.js';

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

it('U9F siwc-relay v1: bounded relay records seal and verify through the application; counters only on the closing summary, no free text', () => {
  const rows: ReturnType<typeof sealAuditRecord>[] = [];
  const audit = new AuditApplication({ append: (event, seal) => { const record = seal(rows.length + 1); rows.push(record); return record; },
    page: (scopeId, after, limit) => rows.filter(r => r.event.scopeId === scopeId && r.sequence > after).slice(0, limit), increment: () => { throw new Error('unused'); }, counters: () => [] }, integrity);
  const relay = { kind: 'siwc-relay', schemaVersion: 1, action: 'model-relayed', runId: 'run', taskId: 'task', attemptId: 'attempt', connectionId: '00000000-0000-4000-8000-000000000001',
    bindingDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), requestId: '00000000-0000-4000-8000-000000000002', status: 200, reason: null, bytes: 1024, counters: null } as const;
  const counters = { peersRefused: 1, capabilityIssued: 1, capabilityRefused: 0, relayed: 1, refused: 0, upstreamSends: 1, suppressed: 0 };
  const sealed = [audit.record({ ...base, eventId: 'r-1', subject: relay }), audit.record({ ...base, eventId: 'r-2', subject: { ...relay, action: 'closed', requestId: null, status: null, bytes: null, counters } })];
  expect(audit.list('scope', 0, 10)).toEqual(sealed);
  for (const subject of [{ ...relay, counters }, { ...relay, action: 'closed' }, { ...relay, reason: 'Bearer x' }, { ...relay, prompt: 'x' }, { ...relay, schemaVersion: 2 }])
    expect(() => audit.record({ ...base, eventId: 'r-bad', subject })).toThrow(expect.objectContaining({ code: 'AUDIT_INVALID' }));
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

it('BeUser D-08: a refused work request is sealed with a redacted one-line title (known secrets and credential patterns) and its typed code', () => {
  const known = snapshotKnownSecrets([{ name: 'ERP_TOKEN', value: 'zz-erp-secret-value-991' }]);
  const event = runRequestRefusedEvent({ scopeId: 'scope', principal: { issuer: 'local-os', subject: 'alperen' }, policyRevision: 'p1', commandId: 'c1',
    request: `Approve invoices\nwith zz-erp-secret-value-991 and sk-live-abcdef1234567890abcdef ${'x'.repeat(400)}`, code: 'RUN_ADMISSION_NOT_CONFIGURED', atMs: 5, known });
  const subject = event.subject as { kind: string; title: string; code: string; requestDigest: string };
  expect(subject).toMatchObject({ kind: 'run-request-refused', code: 'RUN_ADMISSION_NOT_CONFIGURED' });
  expect(subject.title).not.toContain('zz-erp-secret-value-991'); expect(subject.title).not.toContain('sk-live'); expect(subject.title).not.toContain('\n');
  expect(subject.title.length).toBeLessThanOrEqual(200); expect(subject.requestDigest).toMatch(/^[a-f0-9]{64}$/);
});

it('BeUser M-33: the latest dismissal record of a task wins; a restored task is offered again, the others stay set aside', () => {
  const rows: ReturnType<typeof sealAuditRecord>[] = [];
  const store: AuditStore = { append: (event, seal) => { const record = seal(rows.length + 1); rows.push(record); return record; }, page: () => rows, increment: () => { throw new Error('unused'); }, counters: () => [],
    recentOfKind: (scopeId, kind, since, limit) => rows.filter(r => r.event.scopeId === scopeId && r.event.subject.kind === kind && r.event.atMs >= since).reverse().slice(0, limit) };
  const audit = new AuditApplication(store, integrity), principal = { issuer: 'local-os', subject: 'alperen' };
  const mark = (taskId: string, action: 'dismiss' | 'restore', atMs: number) => audit.record(deliveryDismissalEvent({ scopeId: 'scope', principal, policyRevision: 'p1', runId: 'r1', taskId, attemptId: 'a-' + taskId, action, atMs }));
  mark('t1', 'dismiss', 1); mark('t2', 'dismiss', 2); mark('t1', 'restore', 3); mark('t3', 'restore', 4);
  expect(dismissedDeliveries(audit, 'scope', 200)).toEqual([{ runId: 'r1', taskId: 't2', atMs: 2 }]);
  mark('t1', 'dismiss', 5);
  expect(dismissedDeliveries(audit, 'scope', 200).map(row => row.taskId).sort()).toEqual(['t1', 't2']);
  expect(dismissedDeliveries(audit, 'other', 200)).toEqual([]);
});

it('refusal summary v1 keeps bounded open catalog tokens and strict nested shapes, opaque targets and honest observation/count facts', () => {
  const valid = { ...base, subject: refusalSubject };
  expect(auditEventSchema.parse(valid)).toEqual(valid);
  for (const decisionSource of ['deckent-decision', 'cli-reported', 'adapter-reported'])
    expect(auditEventSchema.safeParse({ ...valid, subject: { ...refusalSubject, decisionSource } }).success).toBe(true);
  expect(auditEventSchema.safeParse({ ...valid, subject: { ...refusalSubject, target: { role: 'erp:invoice', identity: { keyId: 'scope-key-v2', digest: 'e'.repeat(64) } } } }).success).toBe(true);
  for (const invalid of [
    { schemaVersion: 2 }, { operationClass: 'other' }, { decisionSource: 'other' },
    { reasonCode: 'Bearer secret' }, { evidenceBasis: 'https://customer/private' }, { reasonCode: 'x'.repeat(AUDIT_REFUSAL_TOKEN_MAX_CHARS + 1) },
    { tool: { name: 'read_file', version: 0 } }, { operation: { id: 'read', version: 1, raw: 'secret' } },
    { target: { role: '/customer/invoice', identity: null } }, { target: { role: 'credential', identity: { keyId: 'k', digest: 'guessable' } } },
    { target: { role: 'credential', identity: null, path: '/private' } }, { call: { ...refusalSubject.call, path: '/private' } },
    { samples: Array.from({ length: AUDIT_POLICY_TURN_LIMITS.refusedMax + 1 }, () => refusalSubject.call) },
    { samples: [{ ...refusalSubject.call, round: 0 }] }, { count: 0 }, { count: Number.MAX_SAFE_INTEGER + 1 },
    { countBasis: 'unknown' }, { firstObservedAtMs: 21 }, { turnId: 'other' },
    { count: 1, countBasis: 'exact', overflow: true }, { count: 1, samples: [refusalSubject.call, refusalSubject.call] },
    { runId: undefined }, { taskId: undefined }, { attemptId: undefined }, { generation: 0 }, { raw: 'secret' },
  ]) expect(auditEventSchema.safeParse({ ...valid, subject: { ...refusalSubject, ...invalid } }).success, JSON.stringify(invalid)).toBe(false);
});

it('rebind v1 reads exactly the frozen source, target and common rules and all four durable bases', () => {
  expectTypeOf<RebindAdmissionRecord['basis']>().toEqualTypeOf<RebindAdmission['basis']>();
  const source = rebindSubject(integrity, 'scope');
  const parse = (changes: Record<string, unknown>) => auditEventSchema.safeParse({ ...base, subject: { ...source, ...changes } });
  for (const admission of [{ basis: 'open-class' }, { basis: 'human-tty', witness: null }, { basis: 'human-tty', witness: source.binding },
    { basis: 'macos-plain' }, { basis: 'ai-policy', ruleId: '/synthetic/policy-rule', policyRevision: '/synthetic/revision' }]) {
    expect(parse({ admission, class: admission.basis === 'open-class' ? 'device-only' : 'moved' }).success).toBe(true);
  }
  expect(parse({ class: null, previousBinding: null, binding: null, changedFields: [], attachments: null }).success).toBe(true);
  const allFields = ['bindingVersion', 'bindingStrength', 'bindingSource', 'machineDigest', 'canonicalRoot', 'device', 'inode',
    'filesystemIdentity.kind', 'filesystemIdentity.value', 'source.projectRoot', 'source.layoutRoot', 'source.bootstrapConfigPath',
    'source.layoutRevision', 'source.location', 'attachment.location'];
  expect(parse({ changedFields: allFields, attachments: null }).success).toBe(true);
  const oversized = parse({ changedFields: [...allFields, 'device'] });
  expect(oversized.success).toBe(false);
  if (!oversized.success) expect(JSON.stringify(oversized.error.issues)).toContain('"code":"too_big"');
  expect(parse({ phase: 'intent', attachments: { waiting: 0 } }).success).toBe(true);
  expect(parse({ phase: 'failed', failure: 'WRITE_FAILED' }).success).toBe(true);
  for (const failure of [null, 'WRITE_UNKNOWN']) expect(parse({ phase: 'uncertain', failure }).success).toBe(true);
  const fresh = { transition: 'new', installationId: rebindIds.nextInstallation, class: null, admission: null, attachments: null };
  expect(parse(fresh).success).toBe(true);
  const target = { part: 'target', previousBinding: null, binding: null, projectId: rebindIds.project, changedFields: ['attachment.location'], attachments: null };
  expect(parse(target).success).toBe(true);
  expect(parse({ ...target, changedFields: [] }).success).toBe(true);
  // Each row is a separate frozen rule; no extra coupling between success/bindings or waiting/changedFields.
  for (const invalid of [
    { projectId: rebindIds.project },
    { installationId: rebindIds.nextInstallation }, { admission: null },
    { class: null, admission: { basis: 'human-tty', witness: null } }, { class: 'moved' },
    { ...fresh, installationId: rebindIds.installation }, { ...fresh, class: 'device-only' },
    { ...fresh, admission: { basis: 'open-class' } }, { ...fresh, attachments: { waiting: 0 } },
    { ...target, transition: 'new', installationId: rebindIds.nextInstallation }, { ...target, installationId: rebindIds.nextInstallation },
    { ...target, class: 'moved' }, { ...target, admission: null },
    { ...target, binding: source.binding }, { ...target, previousBinding: source.previousBinding },
    { ...target, changedFields: ['device'] }, { ...target, projectId: null }, { ...target, attachments: { waiting: 1 } },
    { ...target, admission: { basis: 'macos-plain' } },
    { phase: 'intent', failure: 'WRITE_FAILED' }, { phase: 'succeeded', failure: 'WRITE_FAILED' }, { phase: 'failed' },
    { raw: '/private' }, { admission: { basis: 'open-class', class: 'device-only' } }, { admission: { basis: 'unknown' } },
    { phase: 'unknown' }, { class: 'unknown' }, { changedFields: ['unknown'] }, { changedFields: ['device', 'device'] },
    { binding: { keyId: 'k', digest: '/private/root' } }, { previousBinding: { keyId: '/private/key', digest: 'a'.repeat(64) } },
    { admission: { basis: 'human-tty', witness: 'account-name' } },
    { admission: { basis: 'human-tty', witness: { keyId: 'k', digest: 'a'.repeat(64), account: 'private' } } },
    { attachments: { waiting: -1 } }, { attachments: { waiting: 1, path: '/private' } },
    { operationId: '/private/root' }, { previousInstallationId: 'machine-value' }, { installationId: 'account-name' },
    { ...target, projectId: '/private' }, { failure: 'Bearer private' },
  ]) expect(parse(invalid).success, JSON.stringify(invalid)).toBe(false);
});
