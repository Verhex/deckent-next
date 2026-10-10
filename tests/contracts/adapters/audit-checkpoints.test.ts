import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { auditCheckpointVerifyCommandSchema, auditCheckpointRecordSchema, type AuditEvent } from '#domain/index.js';
import { AuditApplication, auditCheckpointDigest, sealAuditRecord, verifyAuditRecord } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { openSqliteAuditStore, openSqliteAuditReader, SqliteAuditStore } from '#adapters/core/audit-store/index.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('audit-test-key', randomBytes(32));
const event = (n: number, scopeId = 'scope'): AuditEvent => ({ schemaVersion: 1, eventId: `evt-${n}`, scopeId,
  principal: { issuer: 'os-user', subject: 'tester' }, policyRevision: 'policy-1', atMs: n,
  subject: { kind: 'model-ingress', fieldDigest: 'a'.repeat(64), projectedDigest: 'b'.repeat(64), decodedDigest: null, codePoints: 1, disposition: 'note' } });
const command = { schemaVersion: 1, scopeId: 'scope' } as const;
async function fixture(everyRecords = 2) {
  const root = await mkdtemp(join(tmpdir(), 'dn-audit-checkpoint-')); roots.push(root);
  const path = join(root, 'ledger.db'), store = await openSqliteAuditStore(path, sqlite, 'allow');
  const audit = new AuditApplication(store, integrity, { everyRecords, pageSize: 1 });
  return { path, store, audit };
}
it('seals each periodic checkpoint with the existing authority, interval, previous checkpoint and producing principal/policy', async () => {
  const f = await fixture();
  try {
    for (let n = 1; n <= 4; n++) f.audit.record(event(n));
    const rows = f.audit.list('scope', 0, 20), first = rows[2]!, second = rows[5]!;
    expect(verifyAuditRecord(first, integrity)).toEqual(first);
    expect(auditCheckpointRecordSchema.parse(first)).toEqual(first);
    expect(auditCheckpointRecordSchema.safeParse(rows[0]).success).toBe(false);
    expect(first.event).toMatchObject({ principal: event(2).principal, policyRevision: 'policy-1', subject: {
      kind: 'audit-checkpoint', schemaVersion: 1, firstSequence: 1, lastSequence: 2, records: 2, cadence: 2, previousCheckpointDigest: null } });
    expect(second.event.subject).toMatchObject({ firstSequence: 4, lastSequence: 5, previousCheckpointDigest: auditCheckpointDigest(first) });
    expect(f.audit.verifyCheckpoints(command)).toMatchObject({ status: 'verified', records: 6, checkpoints: 2, pendingRecords: 0,
      latestCheckpoint: second, anchor: { sequence: 6, digest: auditCheckpointDigest(second) } });
    expect(() => verifyAuditRecord({ ...first, event: { ...first.event, subject: { ...first.event.subject, intervalDigest: 'c'.repeat(64) } } }, integrity))
      .toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
    expect(() => f.audit.record(first.event)).toThrow(expect.objectContaining({ code: 'AUDIT_INVALID' }));
    const raw = new DatabaseSync(f.path);
    try {
      expect(() => raw.prepare("DELETE FROM audit_events WHERE kind='audit-checkpoint'").run()).toThrow(/AUDIT_APPEND_ONLY/);
      expect(() => raw.prepare("UPDATE audit_events SET at_ms=9 WHERE kind='audit-checkpoint'").run()).toThrow(/AUDIT_APPEND_ONLY/);
    } finally { raw.close(); }
  } finally { f.store.close(); }
});
it('detects tampering after a checkpoint, including an uncheckpointed tail', async () => {
  const f = await fixture();
  try {
    for (let n = 1; n <= 3; n++) f.audit.record(event(n));
    const raw = new DatabaseSync(f.path);
    try {
      raw.exec('DROP TRIGGER audit_events_no_update');
      const row = f.audit.list('scope', 3, 1)[0]!;
      raw.prepare('UPDATE audit_events SET record=?,at_ms=? WHERE scope_id=? AND sequence=4')
        .run(JSON.stringify({ ...row, event: { ...row.event, atMs: 99 } }), 99, 'scope');
      expect(() => f.audit.verifyCheckpoints(command)).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
    } finally { raw.close(); }
  } finally { f.store.close(); }
});
it('checks interval digests even when the modified event carries a valid new MAC', async () => {
  const f = await fixture();
  try {
    f.audit.record(event(1)); f.audit.record(event(2));
    const changed = sealAuditRecord({ ...event(1), atMs: 99 }, 1, integrity), raw = new DatabaseSync(f.path);
    try {
      raw.exec('DROP TRIGGER audit_events_no_update');
      raw.prepare('UPDATE audit_events SET record=?,mac=?,at_ms=99 WHERE scope_id=? AND sequence=1').run(JSON.stringify(changed), changed.mac, 'scope');
      expect(() => f.audit.verifyCheckpoints(command)).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
    } finally { raw.close(); }
  } finally { f.store.close(); }
});
it('reports a missing due checkpoint rather than silently verifying ordinary signed records', async () => {
  const f = await fixture();
  try {
    // Legacy/direct port records have valid seals, but no periodic checkpoint producer.
    for (let n = 1; n <= 2; n++) f.store.append(event(n), sequence => sealAuditRecord(event(n), sequence, integrity));
    expect(f.audit.verifyCheckpoints(command)).toMatchObject({ status: 'missing-checkpoint', checkpoints: 0, pendingRecords: 2 });
  } finally { f.store.close(); }
});
it('detects an interior missing checkpoint as a sequence gap and a truncated last checkpoint through the external anchor', async () => {
  const f = await fixture();
  try {
    for (let n = 1; n <= 4; n++) f.audit.record(event(n));
    const anchor = f.audit.verifyCheckpoints(command).anchor!;
    const raw = new DatabaseSync(f.path);
    try {
      raw.exec('DROP TRIGGER audit_events_no_delete');
      raw.prepare('DELETE FROM audit_events WHERE scope_id=? AND sequence=6').run('scope');
      expect(f.audit.verifyCheckpoints({ ...command, anchor })).toMatchObject({ status: 'missing-checkpoint' });
      raw.prepare('DELETE FROM audit_events WHERE scope_id=? AND sequence>=4').run('scope');
      expect(f.audit.verifyCheckpoints(command).status).toBe('verified'); // without an external mark, wholesale truncation is unknowable
      expect(f.audit.verifyCheckpoints({ ...command, anchor }).status).toBe('missing-checkpoint');
      raw.prepare('DELETE FROM audit_events WHERE scope_id=? AND sequence=3').run('scope');
      f.store.append(event(5), sequence => sealAuditRecord(event(5), sequence, integrity));
      // Same sequence reused for an ordinary event: the exported checkpoint anchor still detects the loss.
      expect(f.audit.verifyCheckpoints({ ...command, anchor }).status).toBe('missing-checkpoint');
    } finally { raw.close(); }
  } finally { f.store.close(); }
});
it('rejects a missing checkpoint between intact later checkpoints', async () => {
  const f = await fixture();
  try {
    for (let n = 1; n <= 4; n++) f.audit.record(event(n));
    const raw = new DatabaseSync(f.path);
    try { raw.exec('DROP TRIGGER audit_events_no_delete'); raw.prepare('DELETE FROM audit_events WHERE sequence=3').run();
      expect(() => f.audit.verifyCheckpoints(command)).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
    } finally { raw.close(); }
  } finally { f.store.close(); }
});
it('has no false positive across restart, retries, backward clock values or interleaved scopes', async () => {
  const f = await fixture(3);
  f.audit.record(event(1)); f.audit.record(event(1, 'other')); f.audit.record(event(2)); f.store.close();
  const store = await openSqliteAuditStore(f.path, sqlite, 'forbid');
  try {
    const audit = new AuditApplication(store, integrity, { everyRecords: 3, pageSize: 1 });
    expect(audit.verifyCheckpoints(command)).toMatchObject({ status: 'verified', checkpoints: 0, pendingRecords: 2 });
    audit.record({ ...event(3), atMs: 0 });
    const before = audit.verifyCheckpoints(command);
    audit.record(event(2));
    expect(audit.verifyCheckpoints(command)).toEqual(before);
    expect(before).toMatchObject({ status: 'verified', checkpoints: 1, pendingRecords: 0 });
    expect(audit.verifyCheckpoints({ ...command, scopeId: 'other' })).toMatchObject({ status: 'verified', checkpoints: 0, pendingRecords: 1 });
    expect(audit.verifyCheckpoints({ ...command, scopeId: 'other', anchor: before.anchor! }).status).toBe('missing-checkpoint');
  } finally { store.close(); }
  const reader = await openSqliteAuditReader(f.path, sqlite);
  try {
    const audit = new AuditApplication(reader, integrity, { everyRecords: 3 });
    expect(audit.verifyCheckpoints(command)).toMatchObject({ status: 'verified', checkpoints: 1 });
    expect(() => audit.record(event(4))).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
    expect(audit.verifyCheckpoints(command).records).toBe(4);
  } finally { reader.close(); }
});
it('rolls back the event and checkpoint when checkpoint publication fails, including inside an outer transaction', async () => {
  const f = await fixture(); f.store.close();
  const raw = new DatabaseSync(f.path), store = new SqliteAuditStore(raw), audit = new AuditApplication(store, integrity, { everyRecords: 1 });
  try {
    raw.exec("CREATE TRIGGER checkpoint_failure BEFORE INSERT ON audit_events WHEN NEW.kind='audit-checkpoint' BEGIN SELECT RAISE(ABORT,'injected'); END");
    for (const outer of [false, true]) {
      if (outer) raw.exec('BEGIN IMMEDIATE');
      expect(() => audit.record(event(1))).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
      if (outer) raw.exec('COMMIT');
      expect(raw.prepare('SELECT count(*) AS n FROM audit_events').get()?.n).toBe(0);
    }
    raw.exec('DROP TRIGGER checkpoint_failure'); audit.record(event(1));
    expect(audit.verifyCheckpoints(command)).toMatchObject({ status: 'verified', records: 2, checkpoints: 1 });
  } finally { store.close(); }
});
it('uses configured cadence for each scope and rejects a mismatched external checkpoint digest or authority', async () => {
  const f = await fixture(1);
  try {
    f.audit.record(event(1));
    const anchor = f.audit.verifyCheckpoints(command).anchor!;
    expect(() => f.audit.verifyCheckpoints({ ...command, anchor: { ...anchor, digest: '0'.repeat(64) } }))
      .toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
    expect(() => new AuditApplication(f.store, createHmacIntegrity('wrong', randomBytes(32))).verifyCheckpoints(command))
      .toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
    expect(auditCheckpointVerifyCommandSchema.safeParse({ ...command, anchor: { sequence: 2, digest: 'bad' } }).success).toBe(false);
    expect(() => new AuditApplication(f.store, integrity, { everyRecords: 0 })).toThrow(expect.objectContaining({ code: 'AUDIT_INVALID' }));
  } finally { f.store.close(); }
});
it('reports exhausted bounded verification and preserves the caller transaction during snapshot reads', async () => {
  const f = await fixture(1000);
  try {
    for (let n = 1; n <= 1001; n++) f.store.append(event(n), sequence => sealAuditRecord(event(n), sequence, integrity));
    expect(() => new AuditApplication(f.store, integrity, { maxRecords: 1000, pageSize: 10 }).verifyCheckpoints(command))
      .toThrow(expect.objectContaining({ code: 'AUDIT_LIMIT' }));
  } finally { f.store.close(); }
  const raw = new DatabaseSync(f.path), store = new SqliteAuditStore(raw);
  try { raw.exec('BEGIN'); expect(new AuditApplication(store, integrity).verifyCheckpoints(command).status).toBe('missing-checkpoint');
    expect(raw.isTransaction).toBe(true); raw.exec('COMMIT');
  } finally { store.close(); }
});
it('verifies one consistent snapshot while a second connection appends new events', async () => {
  const f = await fixture(); f.audit.record(event(1)); f.audit.record(event(2));
  const other = await openSqliteAuditStore(f.path, sqlite, 'forbid'), writer = new AuditApplication(other, integrity, { everyRecords: 2 });
  const originalPage = f.store.page.bind(f.store); let appended = false;
  f.store.page = (scopeId, after, limit) => {
    const rows = originalPage(scopeId, after, limit);
    if (!appended) { appended = true; writer.record(event(3)); }
    return rows;
  };
  try {
    expect(f.audit.verifyCheckpoints(command)).toMatchObject({ status: 'verified', records: 3, checkpoints: 1, pendingRecords: 0 });
    f.store.page = originalPage;
    expect(f.audit.verifyCheckpoints(command)).toMatchObject({ status: 'verified', records: 4, checkpoints: 1, pendingRecords: 1 });
  } finally { f.store.close(); other.close(); }
});
