import { refusalSubject } from '../../fixtures/audit-refusal.js';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AuditError, auditEventSchema, auditFollowPageSchema, auditFollowQuerySchema, encodeCommandProjection, auditRefusalMatchesPolicy, type AuditEvent } from '#domain/index.js';
import { AuditApplication, AuditFollow, AuditCheckpointApplication, relatedAuditRecords, sealAuditRecord } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { openSqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';

// S5 D2 (AUDITOR-MODEL 2026-10-17): the AuditFollow read port. The service verifies every seal; the reader gets events, sequences and gaps,
// never a key, a MAC or a key id. A lost (deleted) record is a typed gap, never silence; a forged record stops the read.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('audit-key', randomBytes(32));
const event = (scopeId: string, n: number): AuditEvent => ({ schemaVersion: 1, eventId: `${scopeId}-evt-${n}`, scopeId, principal: { issuer: 'local-os', subject: 'alperen' },
  policyRevision: 'p7', atMs: 1_700_000_000_000 + n, subject: { kind: 'model-ingress', fieldDigest: 'a'.repeat(64), projectedDigest: 'b'.repeat(64), decodedDigest: null, codePoints: n, disposition: 'note' } });
async function ledger(count: number, scopeId = 'scope') {
  const root = await mkdtemp(join(tmpdir(), 'dn-audit-follow-')); roots.push(root);
  const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close();
  const store = await openSqliteAuditStore(path, options), audit = new AuditApplication(store, integrity);
  for (let n = 1; n <= count; n++) audit.record(event(scopeId, n));
  return { path, store, follow: new AuditFollow(store, integrity) };
}

it('pages a scope after a sequence with verified events and no key material', async () => {
  const { store, follow } = await ledger(5);
  try {
    const first = follow.read(auditFollowQuerySchema.parse({ schemaVersion: 1, scopeId: 'scope', after: 0, limit: 2 }));
    expect(auditFollowPageSchema.parse(first)).toEqual(first);
    expect(first.records.map(record => record.sequence)).toEqual([1, 2]);
    expect(first).toMatchObject({ scopeId: 'scope', after: 2, more: true, gaps: [] });
    expect(JSON.stringify(first)).not.toMatch(/"mac"|"keyId"/u);
    const rest = follow.read({ schemaVersion: 1, scopeId: 'scope', after: first.after, limit: 10 });
    expect(rest.records.map(record => record.event.eventId)).toEqual(['scope-evt-3', 'scope-evt-4', 'scope-evt-5']);
    expect(rest).toMatchObject({ after: 5, more: false, gaps: [] });
    // At the head: an empty page keeps the position (the reader polls again later).
    expect(follow.read({ schemaVersion: 1, scopeId: 'scope', after: 5, limit: 10 })).toEqual({ schemaVersion: 1, scopeId: 'scope', records: [], gaps: [], after: 5, more: false });
    // Another scope is never visible.
    expect(follow.read({ schemaVersion: 1, scopeId: 'other', after: 0, limit: 10 }).records).toEqual([]);
  } finally { store.close(); }
});

it('reports a deleted record as a typed gap and keeps following after it', async () => {
  const { path, store, follow } = await ledger(5);
  try {
    const db = new DatabaseSync(path);
    try { db.exec('DROP TRIGGER IF EXISTS audit_events_no_delete'); for (const name of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='audit_events'").all()) db.exec(`DROP TRIGGER "${String(name['name'])}"`);
      db.prepare('DELETE FROM audit_events WHERE scope_id=? AND sequence IN (2,3)').run('scope'); }
    finally { db.close(); }
    const page = follow.read({ schemaVersion: 1, scopeId: 'scope', after: 0, limit: 10 });
    expect(page.records.map(record => record.sequence)).toEqual([1, 4, 5]);
    expect(page.gaps).toEqual([{ afterSequence: 1, beforeSequence: 4 }]);
    expect(page.after).toBe(5);
    // A starting point inside the gap still names it.
    expect(follow.read({ schemaVersion: 1, scopeId: 'scope', after: 2, limit: 10 }).gaps).toEqual([{ afterSequence: 2, beforeSequence: 4 }]);
  } finally { store.close(); }
});

it('stops on a forged or foreign-key record (integrity), and refuses an unbounded or invalid page', async () => {
  const { path, store, follow } = await ledger(2);
  try {
    const foreign = new AuditFollow(store, createHmacIntegrity('audit-key', randomBytes(32)));
    expect(() => foreign.read({ schemaVersion: 1, scopeId: 'scope', after: 0, limit: 10 })).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
    for (const query of [{ after: -1, limit: 1 }, { after: 0, limit: 0 }, { after: 0, limit: 1001 }, { after: 1.5, limit: 1 }])
      expect(() => follow.read({ schemaVersion: 1, scopeId: 'scope', ...query })).toThrow(AuditError);
    const db = new DatabaseSync(path);
    try { for (const name of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='audit_events'").all()) db.exec(`DROP TRIGGER "${String(name['name'])}"`);
      const row = db.prepare('SELECT record FROM audit_events WHERE sequence=2').get()!;
      const record = JSON.parse(String(row['record'])); record.event.policyRevision = 'forged';
      db.prepare('UPDATE audit_events SET record=? WHERE sequence=2').run(JSON.stringify(record)); }
    finally { db.close(); }
    expect(() => follow.read({ schemaVersion: 1, scopeId: 'scope', after: 0, limit: 10 })).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
  } finally { store.close(); }
});

it('never accepts an event attributed to the auditor principal (the auditor writes nothing until its own finding stream exists)', async () => {
  const { store } = await ledger(0);
  try {
    const audit = new AuditApplication(store, integrity);
    expect(() => audit.record({ ...event('scope', 1), principal: { issuer: 'host/auditor', subject: '1000' } })).toThrow(expect.objectContaining({ code: 'AUDIT_INVALID' }));
    expect(audit.list('scope', 0, 10)).toEqual([]);
  } finally { store.close(); }
});

it('reads a future refusal beside old records without enabling any writer, and joins only the exact scoped call across pages', async () => {
  const { path, store, follow } = await ledger(1);
  try {
    const audit = new AuditApplication(store, integrity), old = audit.list('scope', 0, 1)[0]!;
    const bytes = JSON.stringify(old);
    expect(JSON.stringify(old.event)).toBe(JSON.stringify(event('scope', 1)));
    const refusal: AuditEvent = { ...event('scope', 2), subject: refusalSubject };
    expect(auditEventSchema.parse(refusal)).toEqual(refusal);
    expect(() => audit.record(refusal)).toThrow(expect.objectContaining({ code: 'AUDIT_INVALID' }));
    expect(() => sealAuditRecord(refusal, 2, integrity)).toThrow(expect.objectContaining({ code: 'AUDIT_INVALID' }));
    expect(audit.list('scope', 0, 10)).toHaveLength(1);
    // Only this test installs a future-writer fixture, using the existing canonical HMAC format.
    const signed = { event: refusal, sequence: 2, keyId: integrity.keyId };
    const record = { ...signed, mac: integrity.sign(encodeCommandProjection('audit-record:1', signed)) };
    const db = new DatabaseSync(path);
    try { db.prepare('INSERT INTO audit_events(scope_id,sequence,event_id,kind,at_ms,key_id,mac,record) VALUES(?,?,?,?,?,?,?,?)')
      .run('scope', 2, refusal.eventId, refusal.subject.kind, refusal.atMs, record.keyId, record.mac, JSON.stringify(record)); }
    finally { db.close(); }
    expect(audit.list('scope', 0, 10)).toEqual([old, record]);
    expect(audit.load('scope', refusal.eventId)).toEqual(record);
    expect(JSON.stringify(audit.list('scope', 0, 1)[0])).toBe(bytes);
    const page = follow.read({ schemaVersion: 1, scopeId: 'scope', after: 0, limit: 10 });
    expect(auditFollowPageSchema.parse(page).records[1]?.event).toEqual(refusal);
    expect(JSON.parse(JSON.stringify(page)).records[1].event).toEqual(refusal);
    const checkpoints = new AuditCheckpointApplication(store, integrity, { pageSize: 1, maxRecords: 100 });
    const context = { installationId: 'test', policyDigest: 'a'.repeat(64), producersDigest: 'b'.repeat(64) };
    const checkpoint = checkpoints.checkpoint('scope', context, refusal.atMs + 1, { principal: refusal.principal, policyRevision: 'p7' });
    expect(checkpoint.status).toBe('match');
    expect(checkpoints.verify('scope', context).status).toBe('match');
    const policy: AuditEvent = { ...event('scope', 3), subject: { kind: 'policy-turn', turnId: 'turn', ceiling: false,
      refused: { count: 0, calls: [] }, allowed: { count: 1, calls: [{ tool: { name: 'read_file', version: 1 },
        call: { round: 1, index: 0, callId: 'call' }, cell: 'read', argsDigest: 'a'.repeat(64), revision: 'p7' }] } } };
    const policyRow = audit.record(policy);
    expect(relatedAuditRecords(audit, [record], { pageSize: 1, maxRecords: 100 })).toEqual({ related: [{ sequence: policyRow.sequence, event: policy }] });
    expect(relatedAuditRecords(audit, [policyRow], { pageSize: 1, maxRecords: 100 })).toEqual({ related: [{ sequence: 2, event: refusal }] });
    expect(relatedAuditRecords(audit, [record], { pageSize: 1, maxRecords: 1 }).correlationLimited).toBe(true);
    expect(auditRefusalMatchesPolicy(refusal, policy)).toBe(true);
    expect(auditRefusalMatchesPolicy({ ...refusal, scopeId: 'other' }, policy)).toBe(false);
    expect(auditRefusalMatchesPolicy({ ...refusal, principal: { issuer: 'other', subject: 'alperen' } }, policy)).toBe(false);
    if (policy.subject.kind !== 'policy-turn') throw new Error('fixture');
    for (const mismatch of [{ round: 2 }, { index: 1 }, { callId: 'other' }]) {
      const entry = policy.subject.allowed.calls[0]!;
      expect(auditRefusalMatchesPolicy(refusal, { ...policy, subject: { ...policy.subject, allowed: { count: 1, calls: [{ ...entry, call: { ...entry.call, ...mismatch } }] } } })).toBe(false);
    }
    // One unknown future subject still poisons the page rather than being silently skipped.
    const raw = new DatabaseSync(path);
    try { raw.prepare('INSERT INTO audit_events(scope_id,sequence,event_id,kind,at_ms,key_id,mac,record) VALUES(?,?,?,?,?,?,?,?)')
      .run('scope', policyRow.sequence + 1, 'future', 'future-subject', 30, record.keyId, record.mac,
        JSON.stringify({ ...record, sequence: policyRow.sequence + 1, event: { ...refusal, eventId: 'future', subject: { kind: 'future-subject' } } })); }
    finally { raw.close(); }
    expect(() => audit.list('scope', 0, 10)).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
    expect(() => follow.read({ schemaVersion: 1, scopeId: 'scope', after: 0, limit: 10 })).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
    expect(JSON.stringify(audit.list('scope', 0, 1)[0])).toBe(bytes);
  } finally { store.close(); }
});
