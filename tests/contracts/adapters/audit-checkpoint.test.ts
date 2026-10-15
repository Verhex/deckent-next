import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { type AuditEvent } from '#domain/index.js';
import { AuditApplication, sealAuditRecord, AuditCheckpointApplication, AuditCheckpointMonitor, auditPolicyDigest, auditProducersDigest, PermissionModeApplication } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { CORE_SCHEMA } from '#platform/core/config/index.js';
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
const writer = { principal: { issuer: 'local-os', subject: 'service' }, policyRevision: 'p' };
const event = (scopeId: string, n: number): AuditEvent => ({ schemaVersion: 1, eventId: `event-${n}`, scopeId, principal: { issuer: 'local-os', subject: 'test' },
  policyRevision: 'p', atMs: n, subject: { kind: 'full-access-turn', turnId: `turn-${n}`, sessionId: null, decision: { effect: 'allow', ruleId: 'rule' } } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-checkpoint-')); roots.push(root);
  const path = join(root, 'ledger.db'), db = openSqliteLedger(path, options), store = new SqliteAuditStore(db);
  return { root, path, db, store, audit: new AuditApplication(store, integrity), app: new AuditCheckpointApplication(store, integrity, limits) };
}

it('chains checkpoints whose head is their own sealed marker; a cycle without a new event does not duplicate history', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); const first = f.app.checkpoint('s', context, 10, writer);
    expect(first).toMatchObject({ status: 'match', head: { sequence: 2 }, checkpoint: { kind: 'deckent-audit-checkpoint', checkpoint: { sequence: 1, previousDigest: null } } });
    expect(f.audit.list('s', 1, 1)[0]?.event).toMatchObject({ principal: writer.principal, subject: { kind: 'audit-checkpoint', checkpointSequence: 1, previousDigest: null } });
    expect(f.app.checkpoint('s', context, 10, writer)).toEqual(first); expect(f.app.checkpoint('s', context, 11, writer)).toEqual(first);
    expect(f.store.checkpointPage('s', 0, 10)).toHaveLength(1);
    f.audit.record(event('s', 2)); const second = f.app.checkpoint('s', context, 12, writer);
    expect(second.checkpoint?.checkpoint.previousDigest).toBe(first.checkpoint?.digest);
    expect(f.app.verify('s', context, first.checkpoint!)).toMatchObject({ status: 'match', head: { sequence: 4 } });
    expect(() => f.db.exec("DELETE FROM audit_checkpoints")).toThrow(/AUDIT_CHECKPOINT_APPEND_ONLY/);
    expect(() => f.db.exec("UPDATE audit_checkpoints SET record='{}'")).toThrow(/AUDIT_CHECKPOINT_APPEND_ONLY/);
  } finally { f.store.close(); }
});

it.each([1, 0])('detects tail truncation down to %s records, including deletion of every event', async retained => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); f.audit.record(event('s', 2)); const cp = f.app.checkpoint('s', context, 10, writer);
    expect(() => f.db.exec('DELETE FROM audit_events')).toThrow(/AUDIT_APPEND_ONLY/);
    f.db.exec('DROP TRIGGER audit_events_no_delete'); f.db.prepare('DELETE FROM audit_events WHERE sequence>?').run(retained);
    expect(f.app.verify('s', context)).toMatchObject({ status: 'truncated' });
    expect(f.app.verify('s', context, cp.checkpoint!)).toMatchObject({ status: 'truncated' });
    expect(f.app.checkpoint('s', context, 11, writer).status).toBe('truncated');
    expect(f.store.checkpointPage('s', 0, 10)).toHaveLength(1);
  } finally { f.store.close(); }
});

it('removing the checkpoint tail or every checkpoint row is a possible wipe through the sealed markers; no cycle re-baselines it', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); f.app.checkpoint('s', context, 10, writer);
    f.audit.record(event('s', 2)); const witness = f.app.checkpoint('s', context, 12, writer).checkpoint!;
    f.db.exec('DROP TRIGGER audit_checkpoints_no_delete; DELETE FROM audit_checkpoints WHERE sequence=2');
    expect(f.app.verify('s', context)).toMatchObject({ status: 'possible-wipe', reason: 'checkpoints-missing' });
    expect(f.app.verify('s', context, witness).status).toBe('truncated');
    f.audit.record(event('s', 3));
    expect(f.app.checkpoint('s', context, 13, writer)).toMatchObject({ status: 'possible-wipe', reason: 'checkpoints-missing' });
    expect(f.store.checkpointPage('s', 0, 10)).toHaveLength(1);
    f.db.exec('DELETE FROM audit_checkpoints');
    expect(f.app.verify('s', context)).toMatchObject({ status: 'possible-wipe', reason: 'checkpoints-missing' });
    expect(f.app.checkpoint('s', context, 14, writer).status).toBe('possible-wipe');
    expect(f.store.checkpointPage('s', 0, 10)).toHaveLength(0);
    expect(f.app.verify('s', context, witness).status).toBe('truncated');
  } finally { f.store.close(); }
});

it('a dropped checkpoint table on a current ledger is a broken chain, never no-checkpoint-yet, and is not recreated', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); f.app.checkpoint('s', context, 10, writer);
    f.db.exec('DROP TABLE audit_checkpoints');
    expect(f.app.verify('s', context)).toMatchObject({ status: 'chain-broken', reason: 'integrity' });
    expect(f.app.checkpoint('s', context, 11, writer)).toMatchObject({ status: 'chain-broken', reason: 'integrity' });
    expect(f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='audit_checkpoints'").get()?.n).toBe(0);
  } finally { f.store.close(); }
});

it('same-account limit: deleting markers and checkpoints together leaves a quiet scope, which only a retained witness exposes', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); const firstWitness = f.app.checkpoint('s', context, 10, writer).checkpoint!;
    f.audit.record(event('s', 2)); const witness = f.app.checkpoint('s', context, 12, writer).checkpoint!;
    f.db.exec('DROP TRIGGER audit_checkpoints_no_delete; DELETE FROM audit_checkpoints; DROP TRIGGER audit_events_no_delete; DELETE FROM audit_events WHERE sequence>=2');
    expect(f.app.verify('s', context)).toMatchObject({ status: 'unknown', reason: 'no-checkpoint-yet' });
    expect(f.app.checkpoint('s', context, 13, writer).status).toBe('match');
    expect(f.app.verify('s', context, witness)).toMatchObject({ status: 'truncated', reason: 'head-missing' });
    expect(f.app.verify('s', context, firstWitness)).toMatchObject({ status: 'chain-broken', reason: 'integrity' });
  } finally { f.store.close(); }
});

it('a failed checkpoint write commits nothing, reports unknown and degrades the service monitor', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1));
    f.store.appendCheckpoint = () => { throw new Error('disk full'); };
    expect(f.app.checkpoint('s', context, 10, writer)).toMatchObject({ status: 'unknown', reason: 'unavailable' });
    expect(f.audit.list('s', 0, 10)).toHaveLength(1); expect(f.store.checkpointPage('s', 0, 10)).toHaveLength(0);
    const monitor = new AuditCheckpointMonitor(async () => [f.app.checkpoint('s', context, 11, writer)], () => undefined);
    await monitor.check(); expect(monitor.status).toMatchObject({ status: 'degraded', verifications: [{ status: 'unknown', reason: 'unavailable' }] });
  } finally { f.store.close(); }
});

it.each(['event-payload', 'middle-deletion', 'checkpoint-payload'])('detects chain break: %s without publishing a replacement baseline', async kind => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); f.audit.record(event('s', 2)); f.app.checkpoint('s', context, 10, writer);
    if (kind === 'event-payload') f.db.exec("DROP TRIGGER audit_events_no_update; UPDATE audit_events SET record='{}' WHERE sequence=1");
    if (kind === 'middle-deletion') f.db.exec('DROP TRIGGER audit_events_no_delete; DELETE FROM audit_events WHERE sequence=1');
    if (kind === 'checkpoint-payload') f.db.exec("DROP TRIGGER audit_checkpoints_no_update; UPDATE audit_checkpoints SET record='{}'");
    expect(f.app.verify('s', context)).toMatchObject({ status: 'chain-broken', reason: 'integrity' });
    expect(f.app.checkpoint('s', context, 12, writer).status).toBe('chain-broken');
  } finally { f.store.close(); }
});

it.skipIf(process.platform === 'win32')('a policy file rewritten with the same revision reports policy-changed and keeps the original checkpoint', async () => {
  const f = await fixture();
  try {
    const policyPath = join(f.root, 'policy.json'), document = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [] };
    await writeFile(policyPath, JSON.stringify(document), { mode: 0o600 });
    const policy = new FilePolicySource({ path: policyPath, ownerUid: userInfo().uid, maxBytes: 65536 });
    f.audit.record(event('s', 1)); const original = { ...context, policyDigest: auditPolicyDigest(await policy.load()) };
    const cp = f.app.checkpoint('s', original, 10, writer);
    await writeFile(policyPath, JSON.stringify({ ...document, grants: [{ id: 'changed', effect: 'allow', actions: ['inspect'], scopes: ['s'],
      principals: [{ issuer: 'test', subject: 'test' }], resource: { kind: 'approval', ids: 'all' } }] }));
    const changed = { ...original, policyDigest: auditPolicyDigest(await policy.load()) };
    expect(changed.policyDigest).not.toBe(original.policyDigest);
    expect(f.app.verify('s', changed, cp.checkpoint!).status).toBe('policy-changed');
    expect(f.app.checkpoint('s', changed, 12, writer).status).toBe('policy-changed');
    expect(f.store.checkpointPage('s', 0, 10)).toEqual([cp.checkpoint!.checkpoint]);
  } finally { f.store.close(); }
});

it('reports changed producer inventories independently from policy changes', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); f.app.checkpoint('s', context, 10, writer);
    expect(f.app.verify('s', { ...context, producersDigest: auditProducersDigest([{ id: 'new-producer' }]) })).toMatchObject({ status: 'producers-changed' });
  } finally { f.store.close(); }
});

it('refuses foreign/tampered witness and preserves unknown for an unavailable original key or bounded scan', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); const witness = f.app.checkpoint('s', context, 10, writer).checkpoint!;
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
    expect(app.checkpoint('s', context, 10, writer).status).toBe('match');
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
    f.audit.record(event('s', 1)); f.app.checkpoint('s', context, 10, writer);
    f.db.exec('DROP TRIGGER audit_events_no_delete; DELETE FROM audit_events');
    let cycles = 0; const controller = new AbortController(), waits: number[] = [];
    const monitor = new AuditCheckpointMonitor(async () => { cycles++; return [f.app.checkpoint('s', context, 11, writer)]; }, () => { throw new Error('observer'); });
    await monitor.check(); expect(monitor.status).toMatchObject({ status: 'degraded', verifications: [{ status: 'truncated' }] });
    await monitor.run(1234, controller.signal, async interval => { waits.push(interval); if (waits.length === 2) controller.abort(); });
    expect(waits).toEqual([1234, 1234]); expect(cycles).toBe(2);
    expect(f.store.checkpointPage('s', 0, 10)).toHaveLength(1);
  } finally { f.store.close(); }
});

it('a read snapshot stays consistent when another connection appends between pages; the next read sees the new head', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); f.app.checkpoint('s', context, 10, writer);
    const other = openSqliteLedger(f.path, options, 'forbid'), otherStore = new SqliteAuditStore(other), otherWriter = new AuditApplication(otherStore, integrity);
    const original = f.store.page.bind(f.store); let appended = false;
    f.store.page = (scope, after, limit) => {
      const rows = original(scope, after, limit);
      if (!appended) { appended = true; otherWriter.record(event('s', 2)); }
      return rows;
    };
    try {
      expect(f.app.verify('s', context)).toMatchObject({ status: 'match', head: { sequence: 2 } });
      expect(f.app.verify('s', context)).toMatchObject({ status: 'match', head: { sequence: 3 } });
    } finally { otherStore.close(); }
  } finally { f.store.close(); }
});

it('backward clock refuses checkpoint publication and preserves the last known-good anchor', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); const cp = f.app.checkpoint('s', context, 10, writer); f.audit.record(event('s', 2));
    expect(f.app.checkpoint('s', context, 9, writer).status).toBe('unknown');
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
    f.audit.record(event('s', 1)); f.app.checkpoint('s', context, 10, writer);
    const replacement = sealAuditRecord({ ...event('s', 1), policyRevision: 'changed' }, 1, integrity);
    f.db.exec('DROP TRIGGER audit_events_no_update');
    f.db.prepare('UPDATE audit_events SET record=?,mac=? WHERE scope_id=? AND sequence=1').run(JSON.stringify(replacement), replacement.mac, 's');
    expect(f.audit.list('s', 0, 1)).toEqual([replacement]);
    expect(f.app.verify('s', context)).toMatchObject({ status: 'chain-broken', reason: 'integrity' });
  } finally { f.store.close(); }
});

it('a service monitor that has not run, or verified no scope, is never ready', async () => {
  const idle = new AuditCheckpointMonitor(async () => [], () => undefined);
  expect(idle.status).toEqual({ status: 'degraded', reason: 'not-verified', verifications: [] });
  await idle.check(); expect(idle.status).toEqual({ status: 'degraded', reason: 'not-verified', verifications: [] });
  const throwing = new AuditCheckpointMonitor(async () => { throw new TypeError('verifier bug'); }, () => undefined);
  await throwing.check(); expect(throwing.status).toMatchObject({ status: 'degraded', reason: 'unavailable' });
});

it('checkpoints cannot be disabled or skipped by configuration', () => {
  for (const checkpointIntervalMs of [0, -1, 999, null, false]) expect(CORE_SCHEMA.safeParse({ audit: { checkpointIntervalMs } }).success, String(checkpointIntervalMs)).toBe(false);
  for (const limit of [{ maxRecords: 0 }, { maxScopes: 0 }, { pageSize: 0 }, { enabled: false }, { skip: true }]) expect(CORE_SCHEMA.safeParse({ audit: limit }).success, JSON.stringify(limit)).toBe(false);
});

const operator = { principal: { issuer: 'local-os', subject: 'owner' }, policyRevision: 'p' };
type Ctx = typeof context;
/** What a person confirmed: the verified state and the digests it was computed over. */
const shown = (app: AuditCheckpointApplication, ctx: Ctx) => { const v = app.verify('s', ctx); return { status: v.status, head: v.head, policyDigest: ctx.policyDigest, producersDigest: ctx.producersDigest }; };
it.each(['every row', 'the tail'])('an explicit re-baseline after a possible wipe (%s) is audited with its reason, continues the chain and still fails an older witness', async rows => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); const first = f.app.checkpoint('s', context, 10, writer).checkpoint!;
    f.audit.record(event('s', 2)); const witness = f.app.checkpoint('s', context, 12, writer).checkpoint!;
    f.db.exec(`DROP TRIGGER audit_checkpoints_no_delete; DELETE FROM audit_checkpoints${rows === 'the tail' ? ' WHERE sequence=2' : ''}`);
    expect(f.app.verify('s', context).status).toBe('possible-wipe');
    const rebased = f.app.rebaseline('s', context, 20, operator, 'restored host after disk failure', shown(f.app, context));
    expect(rebased).toMatchObject({ status: 'match', reason: 'verified' });
    const marker = f.audit.list('s', rebased.head!.sequence - 1, 1)[0]!;
    expect(marker.event).toMatchObject({ principal: operator.principal, subject: { kind: 'audit-checkpoint', rebaseline: { reason: 'restored host after disk failure' } } });
    expect(f.app.verify('s', context)).toMatchObject({ status: 'match' });
    f.audit.record(event('s', 3)); expect(f.app.checkpoint('s', context, 21, writer).status).toBe('match');
    expect(f.app.verify('s', context).status).toBe('match');
    expect(f.app.verify('s', context, witness).status).not.toBe('match');
    if (rows === 'every row') expect(f.app.verify('s', context, first).status).not.toBe('match');
  } finally { f.store.close(); }
});

it('re-baseline accepts an out-of-band policy drift only explicitly, and refuses healthy, broken or truncated history without writing', async () => {
  const f = await fixture();
  try {
    f.audit.record(event('s', 1)); f.app.checkpoint('s', context, 10, writer);
    expect(() => f.app.rebaseline('s', context, 11, operator, 'nothing to do', shown(f.app, context))).toThrow(expect.objectContaining({ code: 'AUDIT_REBASELINE_REFUSED' }));
    const drift = { ...context, policyDigest: auditPolicyDigest({ revision: 'p', grants: ['edited by hand'] }) };
    expect(f.app.verify('s', drift).status).toBe('policy-changed'); expect(f.app.checkpoint('s', drift, 11, writer).status).toBe('policy-changed');
    const confirmed = shown(f.app, drift); f.audit.record(event('s', 9));
    // Bound to what was shown: the audit head moved after the confirmation, so the write refuses and nothing is written.
    const count = f.audit.list('s', 0, 100).length;
    expect(() => f.app.rebaseline('s', drift, 12, operator, 'reviewed hand edit', confirmed)).toThrow(expect.objectContaining({ code: 'AUDIT_REBASELINE_STALE' }));
    expect(() => f.app.rebaseline('s', { ...drift, producersDigest: auditProducersDigest(['other']) }, 12, operator, 'reviewed hand edit', shown(f.app, drift))).toThrow(expect.objectContaining({ code: 'AUDIT_REBASELINE_STALE' }));
    expect(f.audit.list('s', 0, 100)).toHaveLength(count);
    expect(f.app.rebaseline('s', drift, 12, operator, 'reviewed hand edit', shown(f.app, drift)).status).toBe('match');
    expect(f.app.verify('s', drift).status).toBe('match'); expect(f.app.verify('s', context).status).toBe('policy-changed');
    const events = f.audit.list('s', 0, 100).length;
    f.db.exec('DROP TRIGGER audit_events_no_delete; DELETE FROM audit_events WHERE sequence=1');
    expect(() => f.app.rebaseline('s', drift, 13, operator, 'hide it', shown(f.app, drift))).toThrow(expect.objectContaining({ code: 'AUDIT_INTEGRITY' }));
    expect(f.db.prepare('SELECT count(*) AS n FROM audit_events').get()?.n).toBe(events - 1);
  } finally { f.store.close(); }
});

it.skipIf(process.platform === 'win32')('a governed /mode change through the real authority writer keeps verify at match; a later hand edit reads policy-changed', async () => {
  const f = await fixture();
  try {
    const actor = { issuer: 'host', subject: '1000' }, principal = { ...actor, id: 'os:1000', assurance: 'os-user' as const, scopeIds: ['s'] };
    const policyPath = join(f.root, 'policy.json'), bindingsPath = join(f.root, 'bindings.json');
    await writeFile(policyPath, JSON.stringify({ schemaVersion: 2, revision: 'p1', roles: [], restrictions: [], separationOfDuties: [], grants: [{ id: 'mode', effect: 'allow',
      actions: ['set'], scopes: ['s'], principals: [actor], resource: { kind: 'permission-mode', ids: ['full-auto'] } }] }), { mode: 0o600 });
    await writeFile(bindingsPath, JSON.stringify({ schemaVersion: 2, revision: 'b1', bindings: [], modes: [] }), { mode: 0o600 });
    const source = new FilePolicySource({ path: policyPath, bindingsPath, ownerUid: userInfo().uid, maxBytes: 65536 });
    const contextOf = async () => ({ ...context, policyDigest: auditPolicyDigest(await source.load()) });
    const before = await contextOf(); f.audit.record(event('s', 1)); expect(f.app.checkpoint('s', before, 10, writer).status).toBe('match');
    const modes = new PermissionModeApplication(source, audit => { f.audit.record(audit); }, () => 11);
    await modes.set(principal, { schemaVersion: 1, scopeId: 's', mode: 'full-auto', expectedRevision: 'p1+b1' });
    const governed = await contextOf();
    expect(governed.policyDigest).not.toBe(before.policyDigest);
    expect(f.audit.list('s', 0, 100).map(record => record.event.subject).find(subject => subject.kind === 'permission-mode-change')).toMatchObject({ policyDigest: governed.policyDigest });
    expect(f.app.verify('s', governed)).toMatchObject({ status: 'match', reason: 'verified' });
    expect(f.app.checkpoint('s', governed, 12, writer).status).toBe('match');
    const bindings = JSON.parse(await readFile(bindingsPath, 'utf8'));
    await writeFile(bindingsPath, JSON.stringify({ ...bindings, modes: [] }));
    expect(f.app.verify('s', await contextOf()).status).toBe('policy-changed');
    // Drift laundering: a legitimate governed change after that hand edit continues from the edited policy, not from the checkpoint, so it
    // never turns the drift into a match and no automatic checkpoint is written; only an explicit re-baseline moves it on.
    const checkpoints = f.store.checkpointPage('s', 0, 100).length, revision = (await source.load()).revision;
    const relaxed = await modes.set(principal, { schemaVersion: 1, scopeId: 's', mode: 'full-auto', expectedRevision: revision }); expect(relaxed.changed).toBe(true);
    const laundered = await contextOf();
    expect(f.audit.list('s', 0, 100).map(record => record.event.subject).filter(subject => subject.kind === 'permission-mode-change' && subject.policyDigest).at(-1)).toMatchObject({ policyDigest: laundered.policyDigest });
    expect(f.app.verify('s', laundered).status).toBe('policy-changed');
    expect(f.app.checkpoint('s', laundered, 13, writer).status).toBe('policy-changed');
    expect(f.store.checkpointPage('s', 0, 100)).toHaveLength(checkpoints);
    expect(f.app.rebaseline('s', laundered, 14, operator, 'reviewed the hand edit', shown(f.app, laundered)).status).toBe('match');
  } finally { f.store.close(); }
});
