import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { type AuditEvent } from '#domain/index.js';
import { AuditApplication, sealAuditRecord, AuditCheckpointApplication, AuditCheckpointMonitor, auditPolicyDigest, auditProducersDigest } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { SqliteAuditStore, openReadOnlyAuditStore } from '#adapters/core/audit-store/index.js';
import { openSqliteLedger, upgradeExistingLedger, CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { FilePolicySource } from '#adapters/core/file-policy/index.js';
import { DOWNGRADE_TO_V54_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('audit-key', randomBytes(32));
const context = { installationId: 'installation-a', policyDigest: auditPolicyDigest({ revision: 'p', grants: [] }), producersDigest: auditProducersDigest([]) };
const limits = { pageSize: 1, maxRecords: 100 };
const event = (scopeId: string, n: number): AuditEvent => ({ schemaVersion: 1, eventId: `event-${n}`, scopeId, principal: { issuer: 'local-os', subject: 'test' },
  policyRevision: 'p', atMs: n, subject: { kind: 'full-access-turn', turnId: `turn-${n}`, sessionId: null, decision: { effect: 'allow', ruleId: 'rule' } } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-checkpoint-')); roots.push(root);
  const path = join(root, 'ledger.db'), db = openSqliteLedger(path, options), store = new SqliteAuditStore(db);
  return { root, path, db, store, audit: new AuditApplication(store, integrity), app: new AuditCheckpointApplication(store, integrity, limits) };
}

it('chains checkpoints and exports exact signed heads; same scheduled timestamp does not duplicate history', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); const first = f.app.checkpoint('s', context, 10);
    expect(first).toMatchObject({ status: 'match', head: { sequence: 1 }, checkpoint: { kind: 'deckent-audit-checkpoint', checkpoint: { sequence: 1, previousDigest: null } } });
    expect(f.app.checkpoint('s', context, 10)).toEqual(first);
    f.audit.record(event('s', 2)); const second = f.app.checkpoint('s', context, 12);
    expect(second.checkpoint?.checkpoint.previousDigest).toBe(first.checkpoint?.digest);
    expect(f.app.verify('s', context, first.checkpoint!)).toMatchObject({ status: 'match', head: { sequence: 2 } });
    expect(() => f.db.exec("DELETE FROM audit_checkpoints")).toThrow(/AUDIT_CHECKPOINT_APPEND_ONLY/);
    expect(() => f.db.exec("UPDATE audit_checkpoints SET record='{}'")).toThrow(/AUDIT_CHECKPOINT_APPEND_ONLY/);
  } finally { f.store.close(); }
});

it.each([1, 0])('detects tail truncation down to %s records, including deletion of every event', async retained => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); f.audit.record(event('s', 2)); const cp = f.app.checkpoint('s', context, 10);
    expect(() => f.db.exec('DELETE FROM audit_events')).toThrow(/AUDIT_APPEND_ONLY/);
    f.db.exec('DROP TRIGGER audit_events_no_delete'); f.db.prepare('DELETE FROM audit_events WHERE sequence>?').run(retained);
    expect(f.app.verify('s', context)).toMatchObject({ status: 'truncated' });
    expect(f.app.verify('s', context, cp.checkpoint!)).toMatchObject({ status: 'truncated' });
    expect(f.app.checkpoint('s', context, 11).status).toBe('truncated');
    expect(f.store.checkpointPage('s', 0, 10)).toHaveLength(1);
  } finally { f.store.close(); }
});

it('a retained witness detects removal of the checkpoint tail even when all event records survive', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); f.app.checkpoint('s', context, 10);
    f.audit.record(event('s', 2)); const witness = f.app.checkpoint('s', context, 12).checkpoint!;
    f.db.exec('DROP TRIGGER audit_checkpoints_no_delete; DELETE FROM audit_checkpoints WHERE sequence=2');
    expect(f.app.verify('s', context).status).toBe('match');
    expect(f.app.verify('s', context, witness).status).toBe('truncated');
    f.db.exec('DELETE FROM audit_checkpoints');
    expect(f.app.verify('s', context).reason).toBe('no-checkpoint-yet');
    expect(f.app.verify('s', context, witness).status).toBe('truncated');
  } finally { f.store.close(); }
});

it.each(['event-payload', 'middle-deletion', 'checkpoint-payload'])('detects chain break: %s without publishing a replacement baseline', async kind => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); f.audit.record(event('s', 2)); f.app.checkpoint('s', context, 10);
    if (kind === 'event-payload') f.db.exec("DROP TRIGGER audit_events_no_update; UPDATE audit_events SET record='{}' WHERE sequence=1");
    if (kind === 'middle-deletion') f.db.exec('DROP TRIGGER audit_events_no_delete; DELETE FROM audit_events WHERE sequence=1');
    if (kind === 'checkpoint-payload') f.db.exec("DROP TRIGGER audit_checkpoints_no_update; UPDATE audit_checkpoints SET record='{}'");
    expect(f.app.verify('s', context)).toMatchObject({ status: 'chain-broken', reason: 'integrity' });
    expect(f.app.checkpoint('s', context, 12).status).toBe('chain-broken');
  } finally { f.store.close(); }
});

it.skipIf(process.platform === 'win32')('a policy file rewritten with the same revision reports policy-changed and keeps the original checkpoint', async () => {
  const f = await fixture();
  try {
    const policyPath = join(f.root, 'policy.json'), document = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [] };
    await writeFile(policyPath, JSON.stringify(document), { mode: 0o600 });
    const policy = new FilePolicySource({ path: policyPath, ownerUid: userInfo().uid, maxBytes: 65536 });
    f.audit.record(event('s', 1)); const original = { ...context, policyDigest: auditPolicyDigest(await policy.load()) };
    const cp = f.app.checkpoint('s', original, 10);
    await writeFile(policyPath, JSON.stringify({ ...document, grants: [{ id: 'changed', effect: 'allow', actions: ['inspect'], scopes: ['s'],
      principals: [{ issuer: 'test', subject: 'test' }], resource: { kind: 'approval', ids: 'all' } }] }));
    const changed = { ...original, policyDigest: auditPolicyDigest(await policy.load()) };
    expect(changed.policyDigest).not.toBe(original.policyDigest);
    expect(f.app.verify('s', changed, cp.checkpoint!).status).toBe('policy-changed');
    expect(f.app.checkpoint('s', changed, 12).status).toBe('policy-changed');
    expect(f.store.checkpointPage('s', 0, 10)).toEqual([cp.checkpoint!.checkpoint]);
  } finally { f.store.close(); }
});

it('reports changed producer inventories independently from policy changes', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); f.app.checkpoint('s', context, 10);
    expect(f.app.verify('s', { ...context, producersDigest: auditProducersDigest([{ id: 'new-producer' }]) })).toMatchObject({ status: 'producers-changed' });
  } finally { f.store.close(); }
});

it('refuses foreign/tampered witness and preserves unknown for an unavailable original key or bounded scan', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); const witness = f.app.checkpoint('s', context, 10).checkpoint!;
    expect(f.app.verify('other', context, witness)).toMatchObject({ status: 'unknown', reason: 'foreign-witness' });
    expect(f.app.verify('s', context, { ...witness, digest: 'f'.repeat(64) }).status).toBe('chain-broken');
    expect(f.app.verify('s', { ...context, installationId: 'foreign' }).status).toBe('chain-broken');
    const otherKey = new AuditCheckpointApplication(f.store, createHmacIntegrity('other-key', randomBytes(32)), limits);
    expect(otherKey.verify('s', context)).toMatchObject({ status: 'unknown', reason: 'key-unavailable' });
    f.audit.record(event('s', 2));
    expect(new AuditCheckpointApplication(f.store, integrity, { ...limits, maxRecords: 1 }).verify('s', context)).toMatchObject({ status: 'unknown', reason: 'limit' });
  } finally { f.store.close(); }
});

it('migrates a copied real-shaped v54 ledger, backs up first, retains audit/approval rows exactly and reads old ledgers without checkpoints', async () => {
  const f = await fixture(); f.audit.record(event('s', 1));
  f.db.prepare('INSERT INTO approvals(scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot) VALUES(?,?,?,?,?,?,?,?)')
    .run('s', 'approval', 'operation', null, null, 'b'.repeat(64), 0, '{"stored":"approval-row"}');
  const events = f.db.prepare('SELECT * FROM audit_events').all(), approvals = f.db.prepare('SELECT * FROM approvals').all();
  f.db.exec(DOWNGRADE_TO_V54_LEDGER_SQL); f.store.close();
  const old = await openReadOnlyAuditStore(f.path, options);
  try { expect(new AuditCheckpointApplication(old, integrity, limits).verify('s', context)).toMatchObject({ status: 'unknown', reason: 'no-checkpoint-yet', head: { sequence: 1 } }); }
  finally { old.close(); }
  const copy = join(f.root, 'copy.db'); await copyFile(f.path, copy); const backups = join(f.root, 'backups'); await mkdir(backups);
  const migrated = upgradeExistingLedger(copy, options, backups, new Date('2026-10-15T00:00:00Z'))!;
  expect(migrated).toMatchObject({ from: 54, to: CURRENT_LEDGER_VERSION });
  const backup = new DatabaseSync(migrated.backupPath, { readOnly: true });
  expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(54); backup.close();
  const db = openSqliteLedger(copy, options, 'forbid');
  try {
    expect(db.prepare('SELECT * FROM audit_events').all()).toEqual(events);
    expect(db.prepare('SELECT * FROM approvals').all()).toEqual(approvals);
    const app = new AuditCheckpointApplication(new SqliteAuditStore(db), integrity, limits);
    expect(app.verify('s', context).reason).toBe('no-checkpoint-yet');
    expect(app.checkpoint('s', context, 10).status).toBe('match');
  } finally { db.close(); }
  expect((await readFile(f.path)).byteLength).toBeGreaterThan(0);
});

it('migration rejects foreign checkpoint table shape and rolls back to v54', async () => {
  const f = await fixture(); f.db.exec(DOWNGRADE_TO_V54_LEDGER_SQL + 'CREATE TABLE audit_checkpoints(foreign_column TEXT);'); f.store.close();
  expect(() => openSqliteLedger(f.path, options)).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  const db = new DatabaseSync(f.path, { readOnly: true });
  try { expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(54); } finally { db.close(); }
});

it('service monitor exposes degraded start, contains observer failure, uses the configured interval and drains on abort', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); f.app.checkpoint('s', context, 10);
    f.db.exec('DROP TRIGGER audit_events_no_delete; DELETE FROM audit_events');
    let cycles = 0; const controller = new AbortController(), waits: number[] = [];
    const monitor = new AuditCheckpointMonitor(async () => { cycles++; return [f.app.checkpoint('s', context, 11)]; }, () => { throw new Error('observer'); });
    await monitor.check(); expect(monitor.status).toMatchObject({ status: 'degraded', verifications: [{ status: 'truncated' }] });
    await monitor.run(1234, controller.signal, async interval => { waits.push(interval); if (waits.length === 2) controller.abort(); });
    expect(waits).toEqual([1234, 1234]); expect(cycles).toBe(2);
    expect(f.store.checkpointPage('s', 0, 10)).toHaveLength(1);
  } finally { f.store.close(); }
});

it('a read snapshot stays consistent when another connection appends between pages; the next read sees the new head', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); f.app.checkpoint('s', context, 10);
    const other = openSqliteLedger(f.path, options, 'forbid'), otherStore = new SqliteAuditStore(other), writer = new AuditApplication(otherStore, integrity);
    const original = f.store.page.bind(f.store); let appended = false;
    f.store.page = (scope, after, limit) => {
      const rows = original(scope, after, limit);
      if (!appended) { appended = true; writer.record(event('s', 2)); }
      return rows;
    };
    try {
      expect(f.app.verify('s', context)).toMatchObject({ status: 'match', head: { sequence: 1 } });
      expect(f.app.verify('s', context)).toMatchObject({ status: 'match', head: { sequence: 2 } });
    } finally { otherStore.close(); }
  } finally { f.store.close(); }
});

it('backward clock refuses checkpoint publication and preserves the last known-good anchor', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); const cp = f.app.checkpoint('s', context, 10);
    expect(f.app.checkpoint('s', context, 9).status).toBe('unknown');
    expect(f.app.verify('s', context).checkpoint).toEqual(cp.checkpoint);
  } finally { f.store.close(); }
});

it('an unavailable service cycle reports degraded without fabricating a scope or stopping the monitor', async () => {
  const monitor = new AuditCheckpointMonitor(async () => { throw new Error('unavailable'); }, () => undefined);
  await monitor.check(); expect(monitor.status).toEqual({ status: 'degraded', reason: 'unavailable', verifications: [] });
});

it('detects replacement by a validly sealed record through the retained canonical head', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); f.app.checkpoint('s', context, 10);
    const replacement = sealAuditRecord({ ...event('s', 1), policyRevision: 'changed' }, 1, integrity);
    f.db.exec('DROP TRIGGER audit_events_no_update');
    f.db.prepare('UPDATE audit_events SET record=?,mac=? WHERE scope_id=? AND sequence=1').run(JSON.stringify(replacement), replacement.mac, 's');
    expect(f.audit.list('s', 0, 1)).toEqual([replacement]);
    expect(f.app.verify('s', context)).toMatchObject({ status: 'chain-broken', reason: 'integrity' });
  } finally { f.store.close(); }
});
